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
  const watcher = new SessionWatcher(config.codeHome);
  const subAgentWatcher = new SubAgentWatcher(config.codeHome);
  const injector = new InputInjector(config.tmuxSession);
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
  const workGroupManager = new WorkGroupManager(workGroupTmux, injector, watcher);

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
  {
    console.log(
      `Auto-approve tools from config: ${config.autoApproveTools.length > 0 ? config.autoApproveTools.join(', ') : '(none - client toggle only)'}`
    );
    // Track recent approvals per session+tool-set to avoid double-firing.
    // Key: "sessionId:toolsSorted", Value: timestamp of last approval sent.
    const lastApprovalByKey = new Map<string, number>();

    watcher.on('pending-approval', async ({ sessionId, projectPath, tools }) => {
      // Check per-session toggle OR config-level tools
      const sessionEnabled = wsHandler.autoApproveSessions.has(sessionId);
      if (config.autoApproveTools.length === 0 && !sessionEnabled) {
        return;
      }

      // Only approve tools in the config list OR if the session toggle is on
      const autoApprovable = tools.filter((tool: string) => {
        if (config.autoApproveTools.includes(tool)) return true;
        if (sessionEnabled) return true;
        return false;
      });

      if (autoApprovable.length === 0) {
        console.log(`[AUTO-APPROVE] No auto-approvable tools in: [${tools.join(', ')}]`);
        return;
      }

      // Per-session+tool dedup: don't re-fire within 1 second for the SAME set of tools.
      // This prevents double-sends when the watcher re-fires before CLI processes "yes".
      // Using tool-specific keys so different tools in rapid succession still get approved.
      const now = Date.now();
      const dedupKey = `${sessionId}:${autoApprovable.sort().join(',')}`;
      const lastApproval = lastApprovalByKey.get(dedupKey);
      if (lastApproval && now - lastApproval < 1000) {
        console.log(
          `[AUTO-APPROVE] Dedup: skipping [${autoApprovable.join(', ')}] (${now - lastApproval}ms ago)`
        );
        return;
      }
      lastApprovalByKey.set(dedupKey, now);

      // Clean up old entries
      for (const [key, ts] of lastApprovalByKey) {
        if (now - ts > 30000) lastApprovalByKey.delete(key);
      }

      // Resolve tmux session: prefer watcher's reverse lookup, fall back to path matching
      let targetTmuxSession = watcher.getTmuxSessionForConversation(sessionId) || undefined;
      if (!targetTmuxSession && projectPath) {
        const tmux = new TmuxManager('companion');
        const tmuxSessions = await tmux.listSessions();
        const normalizedPath = projectPath.replace(/\/+$/, '');
        const match = tmuxSessions.find(
          (ts) =>
            ts.workingDir === projectPath ||
            ts.workingDir?.replace(/\/+$/, '') === normalizedPath
        );
        if (match) {
          targetTmuxSession = match.name;
        }
      }

      const target = targetTmuxSession || undefined;
      console.log(
        `[AUTO-APPROVE] Approving [${autoApprovable.join(', ')}] -> tmux="${target || 'active'}" (session: ${sessionId.substring(0, 8)})`
      );

      try {
        // Verify terminal has an approval prompt before sending
        const paneContent = await injector.capturePaneContent(target);
        const hasApprovalPrompt = /\b(yes|no|always allow|approve|allow|deny|reject)\b/i.test(paneContent) ||
          /\?\s*$/.test(paneContent.split('\n').pop() || '');

        if (!hasApprovalPrompt) {
          console.log(`[AUTO-APPROVE] No approval prompt detected in terminal, waiting 500ms...`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          // Re-check after wait
          const paneContent2 = await injector.capturePaneContent(target);
          const hasPrompt2 = /\b(yes|no|always allow|approve|allow|deny|reject)\b/i.test(paneContent2) ||
            /\?\s*$/.test(paneContent2.split('\n').pop() || '');
          if (!hasPrompt2) {
            console.log(`[AUTO-APPROVE] Still no prompt after wait, sending anyway`);
          }
        }

        // Wait briefly for terminal to settle
        await new Promise((resolve) => setTimeout(resolve, 200));

        const success = await injector.sendInput('yes', target);
        if (!success) {
          console.log(`[AUTO-APPROVE] Send failed, retrying after 500ms...`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          await injector.sendInput('yes', target);
        } else {
          console.log(`[AUTO-APPROVE] Sent "yes" successfully`);
        }
      } catch (err) {
        console.error(`[AUTO-APPROVE] Error: ${err}`);
      }
    });
  }

  // Write PID file for CLI management
  writePidFile();

  // Start HTTP servers for all listeners
  for (const { server, listener } of servers) {
    server.listen(listener.port, () => {
      const protocol = listener.tls ? 's' : '';
      console.log(`Server listening on port ${listener.port}`);
      console.log(`WebSocket endpoint: ws${protocol}://localhost:${listener.port}`);
      console.log(`QR code setup: http${protocol}://localhost:${listener.port}/qr`);
    });
  }

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down...');

    removePidFile();
    notificationStore.flush();
    workGroupManager.stop();
    watcher.stop();
    subAgentWatcher.stop();
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
    }, 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Log status periodically
  setInterval(() => {
    const status = watcher.getStatus();
    console.log(
      `Status: ${wsHandler.getAuthenticatedClientCount()} clients, ` +
        `waiting: ${status.isWaitingForInput}, ` +
        `push devices: ${push.getRegisteredDeviceCount()}`
    );
  }, 60000);
}

// main() is called from the CLI dispatcher above
