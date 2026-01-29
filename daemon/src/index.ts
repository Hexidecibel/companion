import { loadConfig } from './config';
import { ClaudeWatcher } from './watcher';
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
  console.log('Claude Companion Daemon v1.0.0');
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
  const watcher = new ClaudeWatcher(config.claudeHome);
  const subAgentWatcher = new SubAgentWatcher(config.claudeHome);
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
    const tmux = new TmuxManager('claude');
    // Track in-flight approvals to prevent double-firing
    const pendingAutoApprovals = new Set<string>();

    watcher.on('pending-approval', async ({ sessionId, projectPath, tools }) => {
      // Skip if auto-approve is not enabled (neither config nor client toggle)
      if (config.autoApproveTools.length === 0 && !wsHandler.autoApproveEnabled) {
        return;
      }

      // Check if any pending tool should be auto-approved
      const autoApprovable = tools.filter((tool: string) => {
        // Config-level auto-approve for specific tools
        if (config.autoApproveTools.includes(tool)) return true;
        // Client toggle enables ALL tools to be auto-approved
        if (wsHandler.autoApproveEnabled) return true;
        return false;
      });

      if (autoApprovable.length > 0) {
        // Skip if we already have an auto-approval in flight for this session
        if (pendingAutoApprovals.has(sessionId)) {
          return;
        }
        pendingAutoApprovals.add(sessionId);

        try {
          // Find the tmux session that matches this conversation's project path
          let targetTmuxSession: string | undefined;
          if (projectPath) {
            const tmuxSessions = await tmux.listSessions();
            const match = tmuxSessions.find(ts => ts.workingDir === projectPath);
            if (match) {
              targetTmuxSession = match.name;
            }
          }

          if (targetTmuxSession) {
            console.log(`Auto-approving tools [${autoApprovable.join(', ')}] in tmux session "${targetTmuxSession}" (conversation: ${sessionId})`);
            await new Promise(resolve => setTimeout(resolve, 200));
            await injector.sendInput('yes', targetTmuxSession);
          } else {
            console.log(`Auto-approving tools [${autoApprovable.join(', ')}] in active session (no tmux match for ${projectPath})`);
            await new Promise(resolve => setTimeout(resolve, 200));
            await injector.sendInput('yes');
          }
        } finally {
          // Clear the in-flight flag after a delay to let Claude process
          setTimeout(() => pendingAutoApprovals.delete(sessionId), 3000);
        }
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
