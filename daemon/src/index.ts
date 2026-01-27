import { loadConfig } from './config';
import { ClaudeWatcher } from './watcher';
import { InputInjector } from './input-injector';
import { MdnsAdvertiser } from './mdns';
import { PushNotificationService } from './push';
import { WebSocketHandler } from './websocket';
import { createServer, validateTlsConfig } from './tls';
import { certsExist, generateAndSaveCerts, getDefaultCertPaths } from './cert-generator';

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
  const injector = new InputInjector(config.tmuxSession);
  const push = new PushNotificationService(config.fcmCredentialsPath, config.pushDelayMs);

  // Create HTTP/HTTPS server
  const server = createServer({
    enabled: config.tls,
    certPath: config.certPath,
    keyPath: config.keyPath,
  });

  // Initialize WebSocket handler
  const wsHandler = new WebSocketHandler(server, config, watcher, injector, push);

  // Start mDNS advertisement
  let mdns: MdnsAdvertiser | null = null;
  if (config.mdnsEnabled) {
    mdns = new MdnsAdvertiser(config.port, config.tls);
    mdns.start();
  }

  // Start file watcher
  watcher.start();

  // Start HTTP server
  server.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log(`WebSocket endpoint: ws${config.tls ? 's' : ''}://localhost:${config.port}`);
  });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down...');

    watcher.stop();
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
