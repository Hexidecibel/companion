import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';

export interface TlsConfig {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
}

export function createServer(
  tlsConfig: TlsConfig,
  requestHandler?: http.RequestListener
): http.Server | https.Server {
  if (tlsConfig.enabled && tlsConfig.certPath && tlsConfig.keyPath) {
    if (!fs.existsSync(tlsConfig.certPath)) {
      throw new Error(`TLS certificate not found: ${tlsConfig.certPath}`);
    }
    if (!fs.existsSync(tlsConfig.keyPath)) {
      throw new Error(`TLS key not found: ${tlsConfig.keyPath}`);
    }

    const options: https.ServerOptions = {
      cert: fs.readFileSync(tlsConfig.certPath),
      key: fs.readFileSync(tlsConfig.keyPath),
    };

    console.log('TLS: Creating HTTPS server');
    return https.createServer(options, requestHandler);
  }

  console.log('TLS: Creating HTTP server (no TLS)');
  return http.createServer(requestHandler);
}

export function validateTlsConfig(config: TlsConfig): string[] {
  const errors: string[] = [];

  if (config.enabled) {
    if (!config.certPath) {
      errors.push('TLS enabled but no certificate path specified');
    } else if (!fs.existsSync(config.certPath)) {
      errors.push(`TLS certificate not found: ${config.certPath}`);
    }

    if (!config.keyPath) {
      errors.push('TLS enabled but no key path specified');
    } else if (!fs.existsSync(config.keyPath)) {
      errors.push(`TLS key not found: ${config.keyPath}`);
    }
  }

  return errors;
}
