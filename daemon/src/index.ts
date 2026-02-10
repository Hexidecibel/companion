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
    // Track recent approvals per session+tool-IDs to avoid double-firing.
    // Key: "sessionId:toolId1,toolId2", Value: timestamp of last approval sent.
    // Using tool IDs (not names) means each unique tool instance gets approved exactly once,
    // while consecutive same-named tools (Bash → Bash) are correctly treated as distinct.
    const lastApprovalByKey = new Map<string, number>();

    watcher.on('pending-approval', async ({ sessionId, projectPath, tools }) => {
      // tools is now Array<{name: string, id: string}>
      const toolList = tools as Array<{name: string, id: string}>;

      // Check per-session toggle OR config-level tools
      const sessionEnabled = wsHandler.autoApproveSessions.has(sessionId);
      if (config.autoApproveTools.length === 0 && !sessionEnabled) {
        return;
      }

      // Only approve tools in the config list OR if the session toggle is on
      const autoApprovable = toolList.filter((tool) => {
        if (config.autoApproveTools.includes(tool.name)) return true;
        if (sessionEnabled) return true;
        return false;
      });

      if (autoApprovable.length === 0) {
        console.log(`[AUTO-APPROVE] No auto-approvable tools in: [${toolList.map(t => t.name).join(', ')}]`);
        return;
      }

      // Dedup by tool IDs — each unique set of tool instances gets approved exactly once.
      // Different tool_use_ids always produce a different key, so consecutive
      // same-named tools (e.g., Bash after Bash) are never blocked.
      const now = Date.now();
      const dedupKey = `${sessionId}:${autoApprovable.map(t => t.id).sort().join(',')}`;
      const lastApproval = lastApprovalByKey.get(dedupKey);
      if (lastApproval && now - lastApproval < 1000) {
        console.log(
          `[AUTO-APPROVE] Dedup: skipping [${autoApprovable.map(t => t.name).join(', ')}] (${now - lastApproval}ms ago)`
        );
        return;
      }
      lastApprovalByKey.set(dedupKey, now);

      // Clean up old entries
      for (const [key, ts] of lastApprovalByKey) {
        if (now - ts > 30000) lastApprovalByKey.delete(key);
      }

      // Resolve tmux session: sessionId IS the tmux session name now (from watcher events),
      // so use it directly. Fall back to path matching only if needed.
      let targetTmuxSession: string | undefined = sessionId;
      // Verify this is actually a tmux session name by checking if injector can target it
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
        `[AUTO-APPROVE] Approving [${autoApprovable.map(t => t.name).join(', ')}] -> tmux="${target || 'active'}" (session: ${sessionId.substring(0, 8)})`
      );

      try {
        // Check terminal for Claude Code's actual approval prompt format.
        // Match patterns like "(Y)es / (N)o" or "Do you want to proceed?"
        const approvalPromptRe = /\(Y\)es\s*\/\s*\(N\)o|Do you want to (proceed|run|allow|execute)|Approve\?|Allow this|Yes\/No/i;

        const paneContent = await injector.capturePaneContent(target);
        const hasApprovalPrompt = approvalPromptRe.test(paneContent);

        if (!hasApprovalPrompt) {
          // Prompt may not have rendered yet — wait a short time and retry once
          console.log(`[AUTO-APPROVE] No approval prompt detected, waiting 300ms...`);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const paneContent2 = await injector.capturePaneContent(target);
          const hasPrompt2 = approvalPromptRe.test(paneContent2);
          if (!hasPrompt2) {
            console.log(`[AUTO-APPROVE] Still no prompt after wait, sending anyway`);
          }
        }

        const success = await injector.sendInput('yes', target);
        if (!success) {
          console.log(`[AUTO-APPROVE] Send failed, retrying after 300ms...`);
          await new Promise((resolve) => setTimeout(resolve, 300));
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
