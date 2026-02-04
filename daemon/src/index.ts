#!/usr/bin/env node
import { loadConfig } from './config';
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
  console.log(`Config: Port ${config.port}, TLS: ${config.tls}, mDNS: ${config.mdnsEnabled}`);

  // Auto-generate TLS certificates if enabled and missing
  if (config.tls) {
    const certPath = config.certPath || getDefaultCertPaths().certPath;
    const keyPath = config.keyPath || getDefaultCertPaths().keyPath;

    if (!certsExist(certPath, keyPath)) {
      console.log('TLS certificates not found, generating self-signed certificates...');
      try {
        const paths = generateAndSaveCerts(certPath, keyPath);
        config.certPath = paths.certPath;
        config.keyPath = paths.keyPath;
        console.log('Self-signed certificates generated successfully');
        console.log('Note: Clients may need to accept the self-signed certificate');
      } catch (err) {
        console.error('Failed to generate TLS certificates:', err);
        console.error('Falling back to non-TLS mode');
        config.tls = false;
      }
    }

    // Validate TLS config
    if (config.tls) {
      const tlsErrors = validateTlsConfig({
        enabled: config.tls,
        certPath: config.certPath,
        keyPath: config.keyPath,
      });
      if (tlsErrors.length > 0) {
        console.error('TLS configuration errors:');
        tlsErrors.forEach((e) => console.error(`  - ${e}`));
        process.exit(1);
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

  // Create HTTP/HTTPS server with QR code endpoint
  const qrHandler = createQRRequestHandler(config);
  const server = createServer(
    {
      enabled: config.tls,
      certPath: config.certPath,
      keyPath: config.keyPath,
    },
    qrHandler
  );

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

  // Initialize WebSocket handler
  const wsHandler = new WebSocketHandler(
    server,
    config,
    watcher,
    injector,
    push,
    undefined,
    subAgentWatcher,
    workGroupManager
  );

  // Start mDNS advertisement
  let mdns: MdnsAdvertiser | null = null;
  if (config.mdnsEnabled) {
    mdns = new MdnsAdvertiser(config.port, config.tls);
    mdns.start();
  }

  // Start file watchers
  watcher.start();
  subAgentWatcher.start();

  // Auto-approve tools (from config and/or per-session client toggle)
  {
    console.log(
      `Auto-approve tools from config: ${config.autoApproveTools.length > 0 ? config.autoApproveTools.join(', ') : '(none - client toggle only)'}`
    );
    const tmux = new TmuxManager('companion');
    // Track recent approvals per session to avoid double-firing for the same prompt.
    // Key: sessionId, Value: timestamp of last approval sent.
    const lastApprovalBySession = new Map<string, number>();

    watcher.on('pending-approval', async ({ sessionId, projectPath, tools }) => {
      // Check per-session toggle OR config-level tools
      const sessionEnabled = wsHandler.autoApproveSessions.has(sessionId);
      if (config.autoApproveTools.length === 0 && !sessionEnabled) {
        console.log(`[AUTO-APPROVE] Skipped: not enabled for session ${sessionId}`);
        return;
      }

      // Only approve tools that are in the config list OR if the session has auto-approve on.
      // Either way, only APPROVAL_TOOLS are valid (getPendingApprovalTools already filters).
      const autoApprovable = tools.filter((tool: string) => {
        if (config.autoApproveTools.includes(tool)) return true;
        if (sessionEnabled) return true;
        return false;
      });

      if (autoApprovable.length === 0) {
        console.log(`[AUTO-APPROVE] No auto-approvable tools in: [${tools.join(', ')}]`);
        return;
      }

      // Per-session dedup: don't re-fire within 3 seconds of the last approval
      // for the same session. This prevents double-sends when the file watcher
      // re-fires before the CLI has processed the previous "yes".
      // Short window (3s) so sequential tool approvals still work.
      const now = Date.now();
      const lastApproval = lastApprovalBySession.get(sessionId);
      if (lastApproval && now - lastApproval < 3000) {
        console.log(
          `[AUTO-APPROVE] Dedup: skipping (last approval ${now - lastApproval}ms ago for ${sessionId})`
        );
        return;
      }
      lastApprovalBySession.set(sessionId, now);

      // Clean up old entries
      for (const [key, ts] of lastApprovalBySession) {
        if (now - ts > 30000) lastApprovalBySession.delete(key);
      }

      try {
        // Find the tmux session that matches this conversation's project path
        let targetTmuxSession: string | undefined;
        if (projectPath) {
          const tmuxSessions = await tmux.listSessions();
          // Try exact match first
          const exactMatch = tmuxSessions.find((ts) => ts.workingDir === projectPath);
          if (exactMatch) {
            targetTmuxSession = exactMatch.name;
          } else {
            // Try normalized path match (trailing slash differences, symlinks)
            const normalizedPath = projectPath.replace(/\/+$/, '');
            const fuzzyMatch = tmuxSessions.find(
              (ts) => ts.workingDir?.replace(/\/+$/, '') === normalizedPath
            );
            if (fuzzyMatch) {
              targetTmuxSession = fuzzyMatch.name;
              console.log(
                `[AUTO-APPROVE] Fuzzy path match: "${fuzzyMatch.name}" for ${projectPath}`
              );
            }
          }
        }

        // Wait for terminal to settle before sending approval
        await new Promise((resolve) => setTimeout(resolve, 300));

        const sendApproval = async (target?: string): Promise<boolean> => {
          try {
            await injector.sendInput('yes', target);
            return true;
          } catch (err) {
            console.log(`[AUTO-APPROVE] Send failed: ${err}`);
            return false;
          }
        };

        if (targetTmuxSession) {
          console.log(
            `[AUTO-APPROVE] Sending to tmux="${targetTmuxSession}" for tools [${autoApprovable.join(', ')}] (session: ${sessionId})`
          );
          const success = await sendApproval(targetTmuxSession);
          if (!success) {
            console.log(`[AUTO-APPROVE] Retrying after 500ms...`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            await sendApproval(targetTmuxSession);
          }
        } else {
          console.log(
            `[AUTO-APPROVE] Sending to active session for tools [${autoApprovable.join(', ')}] (no tmux match for ${projectPath})`
          );
          const success = await sendApproval();
          if (!success) {
            console.log(`[AUTO-APPROVE] Retrying after 500ms...`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            await sendApproval();
          }
        }
      } catch (err) {
        console.error(`[AUTO-APPROVE] Error: ${err}`);
      }
    });
  }

  // Write PID file for CLI management
  writePidFile();

  // Start HTTP server
  server.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log(`WebSocket endpoint: ws${config.tls ? 's' : ''}://localhost:${config.port}`);
    console.log(`QR code setup: http${config.tls ? 's' : ''}://localhost:${config.port}/qr`);
  });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down...');

    removePidFile();
    notificationStore.flush();
    workGroupManager.stop();
    watcher.stop();
    subAgentWatcher.stop();
    if (mdns) mdns.stop();

    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });

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
