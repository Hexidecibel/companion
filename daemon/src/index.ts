#!/usr/bin/env node
import { loadConfig } from './config';
import { SessionWatcher } from './watcher';
import { SubAgentWatcher } from './subagent-watcher';
import { InputInjector } from './input-injector';
import { MdnsAdvertiser } from './mdns';
import { PushNotificationService } from './push';
import { WebSocketHandler } from './websocket';
import { TmuxManager } from './tmux-manager';
import { createServer, validateTlsConfig } from './tls';
import { certsExist, generateAndSaveCerts, getDefaultCertPaths } from './cert-generator';
import { createQRRequestHandler } from './qr-server';

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
  const push = new PushNotificationService(config.fcmCredentialsPath, config.pushDelayMs);

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

  // Initialize WebSocket handler
  const wsHandler = new WebSocketHandler(server, config, watcher, injector, push, undefined, subAgentWatcher);

  // Start mDNS advertisement
  let mdns: MdnsAdvertiser | null = null;
  if (config.mdnsEnabled) {
    mdns = new MdnsAdvertiser(config.port, config.tls);
    mdns.start();
  }

  // Start file watchers
  watcher.start();
  subAgentWatcher.start();

  // Auto-approve safe tools (from config and/or client toggle)
  {
    console.log(`Auto-approve tools from config: ${config.autoApproveTools.length > 0 ? config.autoApproveTools.join(', ') : '(none - client toggle only)'}`);
    const tmux = new TmuxManager('companion');
    // Track in-flight approvals using composite key (sessionId:tools) to prevent double-firing
    const pendingAutoApprovals = new Map<string, number>();

    watcher.on('pending-approval', async ({ sessionId, projectPath, tools }) => {
      // Skip if auto-approve is not enabled (neither config nor client toggle)
      if (config.autoApproveTools.length === 0 && !wsHandler.autoApproveEnabled) {
        console.log(`[AUTO-APPROVE] Skipped: auto-approve not enabled (config tools: ${config.autoApproveTools.length}, client toggle: ${wsHandler.autoApproveEnabled})`);
        return;
      }

      // Check if any pending tool should be auto-approved
      const autoApprovable = tools.filter((tool: string) => {
        if (config.autoApproveTools.includes(tool)) return true;
        if (wsHandler.autoApproveEnabled) return true;
        return false;
      });

      if (autoApprovable.length === 0) {
        console.log(`[AUTO-APPROVE] No auto-approvable tools in: [${tools.join(', ')}]`);
        return;
      }

      // Composite dedup key: session + sorted tool names
      // The watcher already deduplicates emissions (only fires on change),
      // but this provides a safety net against rapid re-fires.
      const dedupKey = `${sessionId}:${autoApprovable.sort().join(',')}`;
      const now = Date.now();
      const lastApproval = pendingAutoApprovals.get(dedupKey);
      if (lastApproval && now - lastApproval < 15000) {
        console.log(`[AUTO-APPROVE] Dedup: skipping (last approval ${now - lastApproval}ms ago for ${dedupKey})`);
        return;
      }
      pendingAutoApprovals.set(dedupKey, now);

      // Clean up old entries
      for (const [key, ts] of pendingAutoApprovals) {
        if (now - ts > 30000) pendingAutoApprovals.delete(key);
      }

      try {
        // Find the tmux session that matches this conversation's project path
        let targetTmuxSession: string | undefined;
        if (projectPath) {
          const tmuxSessions = await tmux.listSessions();
          // Try exact match first
          const exactMatch = tmuxSessions.find(ts => ts.workingDir === projectPath);
          if (exactMatch) {
            targetTmuxSession = exactMatch.name;
          } else {
            // Try normalized path match (trailing slash differences, symlinks)
            const normalizedPath = projectPath.replace(/\/+$/, '');
            const fuzzyMatch = tmuxSessions.find(ts =>
              ts.workingDir?.replace(/\/+$/, '') === normalizedPath
            );
            if (fuzzyMatch) {
              targetTmuxSession = fuzzyMatch.name;
              console.log(`[AUTO-APPROVE] Fuzzy path match: "${fuzzyMatch.name}" for ${projectPath}`);
            }
          }
        }

        // Wait for terminal to settle before sending approval
        await new Promise(resolve => setTimeout(resolve, 300));

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
          console.log(`[AUTO-APPROVE] Sending to tmux="${targetTmuxSession}" for tools [${autoApprovable.join(', ')}] (session: ${sessionId})`);
          const success = await sendApproval(targetTmuxSession);
          if (!success) {
            // Retry once after 500ms
            console.log(`[AUTO-APPROVE] Retrying after 500ms...`);
            await new Promise(resolve => setTimeout(resolve, 500));
            await sendApproval(targetTmuxSession);
          }
        } else {
          console.log(`[AUTO-APPROVE] Sending to active session for tools [${autoApprovable.join(', ')}] (no tmux match for ${projectPath})`);
          const success = await sendApproval();
          if (!success) {
            console.log(`[AUTO-APPROVE] Retrying after 500ms...`);
            await new Promise(resolve => setTimeout(resolve, 500));
            await sendApproval();
          }
        }
      } catch (err) {
        console.error(`[AUTO-APPROVE] Error: ${err}`);
      }
    });
  }

  // Start HTTP server
  server.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log(`WebSocket endpoint: ws${config.tls ? 's' : ''}://localhost:${config.port}`);
    console.log(`QR code setup: http${config.tls ? 's' : ''}://localhost:${config.port}/qr`);
  });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down...');

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

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
