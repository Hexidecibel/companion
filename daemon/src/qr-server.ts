import * as http from 'http';
import * as os from 'os';
import QRCode from 'qrcode';
import { DaemonConfig } from './types';

export interface QRConfig {
  host: string;
  port: number;
  token: string;
  tls: boolean;
}

/**
 * Get the server's local IP address (non-loopback)
 */
function getLocalIP(): string {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    const netInterface = interfaces[name];
    if (!netInterface) continue;

    for (const iface of netInterface) {
      // Skip loopback and non-IPv4
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }

  return 'localhost';
}

/**
 * Create an HTTP request handler that serves QR code at /qr
 */
export function createQRRequestHandler(config: DaemonConfig): http.RequestListener {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Handle CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '/';

    if (url === '/qr' || url === '/qr.png') {
      try {
        const qrConfig: QRConfig = {
          host: getLocalIP(),
          port: config.port,
          token: config.token,
          tls: config.tls,
        };

        const qrData = JSON.stringify(qrConfig);
        const qrBuffer = await QRCode.toBuffer(qrData, {
          type: 'png',
          width: 400,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#ffffff',
          },
        });

        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': qrBuffer.length,
          'Cache-Control': 'no-cache',
        });
        res.end(qrBuffer);
      } catch (err) {
        console.error('Error generating QR code:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error generating QR code');
      }
      return;
    }

    if (url === '/qr.json') {
      // Return raw config as JSON (for debugging/testing)
      const qrConfig: QRConfig = {
        host: getLocalIP(),
        port: config.port,
        token: config.token,
        tls: config.tls,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(qrConfig, null, 2));
      return;
    }

    if (url === '/') {
      // Simple HTML page showing QR code
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>Claude Companion Setup</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #111827;
      color: #f3f4f6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 20px;
    }
    h1 { margin-bottom: 8px; }
    p { color: #9ca3af; margin-bottom: 24px; }
    img {
      border-radius: 16px;
      background: white;
      padding: 16px;
    }
    .info {
      margin-top: 24px;
      background: #1f2937;
      padding: 16px 24px;
      border-radius: 12px;
      font-size: 14px;
    }
    .info code {
      color: #3b82f6;
    }
  </style>
</head>
<body>
  <h1>Claude Companion</h1>
  <p>Scan this QR code with the app to connect</p>
  <img src="/qr.png" alt="QR Code" width="300" height="300">
  <div class="info">
    <p>Server: <code>${getLocalIP()}:${config.port}</code></p>
    <p>TLS: <code>${config.tls ? 'Enabled' : 'Disabled'}</code></p>
  </div>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  };
}
