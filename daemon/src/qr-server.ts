import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
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
 * Get content type for file extension
 */
function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  return types[ext] || 'text/plain';
}

/**
 * Find the web directory (handles both dev and installed paths)
 */
function findWebDir(): string | null {
  // Try relative to daemon dist (installed or dev)
  const candidates = [
    path.join(__dirname, '../../web'),           // From dist/
    path.join(__dirname, '../../../web'),        // From dist/ in installed location
    path.join(process.cwd(), '../web'),          // From daemon directory
    path.join(process.cwd(), 'web'),             // From project root
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }

  return null;
}

/**
 * Create an HTTP request handler that serves QR code at /qr and web client at /web
 */
export function createQRRequestHandler(config: DaemonConfig): http.RequestListener {
  const webDir = findWebDir();
  if (webDir) {
    console.log(`Web client: Serving from ${webDir}`);
  } else {
    console.log('Web client: Not found (web/ directory missing)');
  }

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Handle CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const fullUrl = req.url || '/';
    const [urlPath, queryString] = fullUrl.split('?');
    const params = new URLSearchParams(queryString || '');

    // HTTP image upload endpoint - more reliable than WebSocket for large payloads
    if (urlPath === '/upload' && req.method === 'POST') {
      // Verify auth token
      const authHeader = req.headers['authorization'];
      const token = authHeader?.replace('Bearer ', '');
      if (token !== config.token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return;
      }

      // Read request body (raw binary image data)
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks);
          const contentType = req.headers['content-type'] || 'image/jpeg';
          const ext = contentType.includes('png') ? 'png' : 'jpg';
          const filename = `claude-companion-${Date.now()}.${ext}`;
          const filepath = path.join(os.tmpdir(), filename);

          fs.writeFileSync(filepath, body);
          console.log(`HTTP upload: ${filepath} (${body.length} bytes)`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, filepath }));
        } catch (err) {
          console.error('HTTP upload error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Upload failed' }));
        }
      });
      return;
    }

    // Web client routes - public access, security via WebSocket token
    if (urlPath.startsWith('/web')) {
      if (!webDir) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Web client not found. Make sure web/ directory exists.');
        return;
      }

      // Determine file to serve
      let filePath = urlPath.replace('/web', '') || '/index.html';
      if (filePath === '/' || filePath === '') {
        filePath = '/index.html';
      }

      const fullPath = path.join(webDir, filePath);

      // Security: prevent directory traversal
      if (!fullPath.startsWith(webDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      try {
        if (!fs.existsSync(fullPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        const content = fs.readFileSync(fullPath);
        const contentType = getContentType(fullPath);

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': content.length,
          'Cache-Control': 'no-cache',
        });
        res.end(content);
      } catch (err) {
        console.error('Error serving web file:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      return;
    }

    if (urlPath === '/qr' || urlPath === '/qr.png') {
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

    if (urlPath === '/qr.json') {
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

    if (urlPath === '/') {
      // Simple HTML page showing QR code
      const webClientLink = webDir
        ? `<a href="/web" class="web-link">Open Web Client</a>`
        : '';

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
    .info p { margin-bottom: 8px; }
    .info code {
      color: #3b82f6;
    }
    .web-link {
      display: inline-block;
      margin-top: 24px;
      padding: 14px 28px;
      background: #3b82f6;
      color: white;
      text-decoration: none;
      border-radius: 10px;
      font-weight: 600;
      transition: background 0.2s;
    }
    .web-link:hover {
      background: #2563eb;
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
  ${webClientLink}
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
