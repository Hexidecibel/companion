#!/usr/bin/env node
import { loadConfig, displayFirstRunWelcome } from './config';
import { SessionWatcher } from './watcher';
import { SubAgentWatcher } from './subagent-watcher';
import { InputInjector } from './input-injector';
import { MdnsAdvertiser } from './mdns';
import { PushNotificationService } from './push';
import { NotificationStore } from './notification-store';
import { WebSocketHandler } from './websocket';
import { TmuxManager } from './tmux-manager';
import { WorkGroupManager } from './work-group-manager';
import { createServer, validateTlsConfig } from './tls';
import { certsExist, generateAndSaveCerts, getDefaultCertPaths } from './cert-generator';
import { createQRRequestHandler } from './qr-server';
import { dispatchCli, writePidFile, removePidFile } from './cli';
import { SHUTDOWN_TIMEOUT_MS, STATUS_LOG_INTERVAL_MS } from './constants';
import { AutoApprovalService } from './auto-approval';
import { registerShutdownCallback, runShutdownCallbacks } from './utils';

// Crash handlers — ensure crash reasons are always logged before exit
// EADDRINUSE errors are handled by server.on('error') retry logic — don't exit here
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.warn('Uncaught EADDRINUSE — deferring to server error handler');
    return;
  }
  console.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Check CLI commands before starting daemon
const cliArgs = process.argv.slice(2);
dispatchCli(cliArgs).then((handled) => {
  if (!handled) {
    main().catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  }
});

async function main(): Promise<void> {
  console.log('Companion Daemon v0.0.1');
  console.log('==============================');

  // Load configuration
  const config = loadConfig();

  // Display welcome message with QR code on first run
  const configAny = config as typeof config & { _isFirstRun?: boolean; _configPath?: string };
  if (configAny._isFirstRun && configAny._configPath) {
    await displayFirstRunWelcome(config, configAny._configPath);
  }

  const listenerPorts = config.listeners.map((l) => l.port).join(', ');
  console.log(`Config: Listeners on ports [${listenerPorts}], mDNS: ${config.mdnsEnabled}`);

  // Process each listener for TLS setup
  for (const listener of config.listeners) {
    if (listener.tls) {
      const certPath = listener.certPath || getDefaultCertPaths().certPath;
      const keyPath = listener.keyPath || getDefaultCertPaths().keyPath;

      if (!certsExist(certPath, keyPath)) {
        console.log(
          `TLS certificates not found for port ${listener.port}, generating self-signed certificates...`
        );
        try {
          const paths = generateAndSaveCerts(certPath, keyPath);
          listener.certPath = paths.certPath;
          listener.keyPath = paths.keyPath;
          console.log('Self-signed certificates generated successfully');
          console.log('Note: Clients may need to accept the self-signed certificate');
        } catch (err) {
          console.error('Failed to generate TLS certificates:', err);
          console.error(`Falling back to non-TLS mode for port ${listener.port}`);
          listener.tls = false;
        }
      }

      // Validate TLS config
      if (listener.tls) {
        const tlsErrors = validateTlsConfig({
          enabled: listener.tls,
          certPath: listener.certPath,
          keyPath: listener.keyPath,
        });
        if (tlsErrors.length > 0) {
          console.error(`TLS configuration errors for port ${listener.port}:`);
          tlsErrors.forEach((e) => console.error(`  - ${e}`));
          process.exit(1);
        }
      }
    }
  }

  // Initialize components
  const injector = new InputInjector(config.tmuxSession);
  const watcher = new SessionWatcher(config.codeHome, injector);
  const subAgentWatcher = new SubAgentWatcher(config.codeHome);
  const notificationStore = new NotificationStore();
  const push = new PushNotificationService(
    config.fcmCredentialsPath,
    config.pushDelayMs,
    notificationStore
  );

  // Create HTTP/HTTPS servers for each listener
  const qrHandler = createQRRequestHandler(config);
  const servers: {
    server: ReturnType<typeof createServer>;
    listener: (typeof config.listeners)[0];
  }[] = [];

  for (const listener of config.listeners) {
    const server = createServer(
      {
        enabled: listener.tls || false,
        certPath: listener.certPath,
        keyPath: listener.keyPath,
      },
      qrHandler
    );
    servers.push({ server, listener });
  }

  // Initialize work group manager for parallel /work orchestration
  const workGroupTmux = new TmuxManager('companion');
  const workGroupManager = new WorkGroupManager(workGroupTmux, injector, watcher, config.git);

  // Work group push notifications
  workGroupManager.on(
    'worker-waiting',
    ({ groupName, worker }: { groupName: string; worker: any }) => {
      const preview = worker.lastQuestion?.text
        ? `${worker.taskSlug}: ${worker.lastQuestion.text}`
        : `Worker "${worker.taskSlug}" needs input`;
      push.sendToAllDevices(preview, 'worker_waiting', worker.sessionId, groupName);
    }
  );

  workGroupManager.on(
    'worker-error',
    ({ groupName, worker }: { groupName: string; worker: any }) => {
      const preview = worker.error
        ? `${worker.taskSlug}: ${worker.error}`
        : `Worker "${worker.taskSlug}" encountered an error`;
      push.sendToAllDevices(preview, 'worker_error', worker.sessionId, groupName);
    }
  );

  workGroupManager.on('group-ready-to-merge', ({ name }: { groupId: string; name: string }) => {
    push.sendToAllDevices(
      `All workers complete. Ready to merge.`,
      'work_group_ready',
      undefined,
      name
    );
  });

  // Initialize WebSocket handler with all servers
  const wsHandler = new WebSocketHandler(
    servers,
    config,
    watcher,
    injector,
    push,
    undefined,
    subAgentWatcher,
    workGroupManager
  );

  // Start mDNS advertisement (advertise first listener)
  let mdns: MdnsAdvertiser | null = null;
  if (config.mdnsEnabled && config.listeners.length > 0) {
    const primaryListener = config.listeners[0];
    mdns = new MdnsAdvertiser(primaryListener.port, primaryListener.tls || false);
    mdns.start();
  }

  // Start file watchers (await so tmux paths are loaded before chokidar scans)
  await watcher.start();
  subAgentWatcher.start();

  // Auto-approve tools (from config and/or per-session client toggle)
  const autoApproval = new AutoApprovalService({
    autoApproveTools: config.autoApproveTools,
    isSessionAutoApproveEnabled: (sessionId) => wsHandler.autoApproveSessions.has(sessionId),
    injector,
  });

  watcher.on('pending-approval', async ({ sessionId, projectPath, tools }) => {
    const toolList = tools as Array<{ name: string; id: string }>;
    await autoApproval.handlePendingApproval(sessionId, projectPath, toolList);
  });

  // Write PID file for CLI management
  writePidFile();

  // Start HTTP servers for all listeners (with EADDRINUSE retry)
  const LISTEN_MAX_RETRIES = 10;
  const LISTEN_RETRY_DELAY_MS = 2000;

  for (const { server, listener } of servers) {
    let attempt = 0;
    const tryListen = (): void => {
      attempt++;
      server.listen(listener.port, () => {
        const protocol = listener.tls ? 's' : '';
        console.log(`Server listening on port ${listener.port}`);
        console.log(`WebSocket endpoint: ws${protocol}://localhost:${listener.port}`);
        console.log(`QR code setup: http${protocol}://localhost:${listener.port}/qr`);
      });
    };

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < LISTEN_MAX_RETRIES) {
        console.warn(
          `Port ${listener.port} in use, retrying in ${LISTEN_RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${LISTEN_MAX_RETRIES})...`
        );
        // Close the failed server before retrying so the socket is cleaned up
        server.close(() => {
          setTimeout(tryListen, LISTEN_RETRY_DELAY_MS);
        });
      } else {
        console.error(`Failed to start server on port ${listener.port}:`, err);
        process.exit(1);
      }
    });

    tryListen();
  }

  // Register status log interval and track for shutdown
  const statusInterval = setInterval(() => {
    const status = watcher.getStatus();
    console.log(
      `Status: ${wsHandler.getAuthenticatedClientCount()} clients, ` +
        `waiting: ${status.isWaitingForInput}, ` +
        `push devices: ${push.getRegisteredDeviceCount()}`
    );
  }, STATUS_LOG_INTERVAL_MS);
  registerShutdownCallback(() => clearInterval(statusInterval));

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down...');

    // Clear all registered timers (status interval, etc.)
    runShutdownCallbacks();

    removePidFile();
    notificationStore.flush();
    workGroupManager.stop();
    watcher.stop();
    subAgentWatcher.stop();
    wsHandler.shutdown();
    if (mdns) mdns.stop();

    // Close all servers
    let closedCount = 0;
    for (const { server } of servers) {
      server.close(() => {
        closedCount++;
        if (closedCount === servers.length) {
          console.log('All servers closed');
          process.exit(0);
        }
      });
    }

    // Force exit after 5 seconds
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// main() is called from the CLI dispatcher above
