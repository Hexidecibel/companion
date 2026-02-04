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
  // Try built Vite output first (web/dist/), then fall back to source web/
  const bases = [
    path.join(__dirname, '../../web'), // From dist/
    path.join(__dirname, '../../../web'), // From dist/ in installed location
    path.join(process.cwd(), '../web'), // From daemon directory
    path.join(process.cwd(), 'web'), // From project root
  ];

  // Prefer web/dist/ (Vite build output)
  for (const base of bases) {
    const distDir = path.join(base, 'dist');
    if (fs.existsSync(path.join(distDir, 'index.html'))) {
      return distDir;
    }
  }

  // Fall back to web/ root (old vanilla client)
  for (const dir of bases) {
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
    const [urlPath] = fullUrl.split('?');

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
          const filename = `companion-${Date.now()}.${ext}`;
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
        // SPA fallback: if file not found and not a static asset, serve index.html
        let servePath = fullPath;
        if (!fs.existsSync(fullPath)) {
          const ext = path.extname(fullPath);
          if (ext && ext !== '.html') {
            // Static asset not found — genuine 404
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }
          // Route path — serve index.html for client-side routing
          servePath = path.join(webDir, 'index.html');
          if (!fs.existsSync(servePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }
        }

        const content = fs.readFileSync(servePath);
        const contentType = getContentType(servePath);

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

    // QR and JSON endpoints require token auth via query param
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const queryToken = url.searchParams.get('token');
    const isAuthed = queryToken === config.token;

    if (urlPath === '/qr' || urlPath === '/qr.png') {
      if (!isAuthed) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized - token required');
        return;
      }

      try {
        // Prefer host/port sent by the client (from document.location) since
        // reverse proxies like HAProxy may strip the Host header
        const clientHost = url.searchParams.get('host');
        const clientPort = url.searchParams.get('port');
        const qrConfig: QRConfig = {
          host: clientHost || (req.headers.host || '').split(':')[0] || getLocalIP(),
          port: clientPort ? parseInt(clientPort, 10) : config.port,
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
      if (!isAuthed) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized - token required' }));
        return;
      }

      const clientHost = url.searchParams.get('host');
      const clientPort = url.searchParams.get('port');
      const qrConfig: QRConfig = {
        host: clientHost || (req.headers.host || '').split(':')[0] || getLocalIP(),
        port: clientPort ? parseInt(clientPort, 10) : config.port,
        token: config.token,
        tls: config.tls,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(qrConfig, null, 2));
      return;
    }

    if (urlPath === '/') {
      // HTML page with token gate - must enter token before seeing QR
      const webClientPath = webDir ? '/web' : '';
      // Use request host for display; JS will read location.host at runtime
      const displayHost = (req.headers.host || '').split(':')[0] || getLocalIP();

      const html = `<!DOCTYPE html>
<html>
<head>
  <title>Companion Setup</title>
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
    .info code { color: #3b82f6; }
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
    .web-link:hover { background: #2563eb; }
    .token-form {
      background: #1f2937;
      padding: 32px;
      border-radius: 16px;
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    .token-input {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid #374151;
      border-radius: 8px;
      background: #111827;
      color: #f3f4f6;
      font-size: 16px;
      margin-bottom: 16px;
      box-sizing: border-box;
      font-family: monospace;
    }
    .token-input:focus { outline: none; border-color: #3b82f6; }
    .token-btn {
      width: 100%;
      padding: 12px;
      background: #3b82f6;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
    }
    .token-btn:hover { background: #2563eb; }
    .error { color: #ef4444; font-size: 14px; margin-bottom: 12px; }
    #auth-section { display: block; }
    #qr-section { display: none; }
  </style>
</head>
<body>
  <h1>Companion</h1>

  <div id="auth-section">
    <p>Enter your token to access setup</p>
    <div class="token-form">
      <input type="password" id="token" class="token-input" placeholder="Enter token..." autofocus>
      <div id="error" class="error" style="display:none"></div>
      <button class="token-btn" onclick="authenticate()">Authenticate</button>
    </div>
    <div class="info">
      <p>Server: <code class="server-addr">${displayHost}:${config.port}</code></p>
    </div>
  </div>

  <div id="qr-section">
    <p>Scan this QR code with the app to connect</p>
    <img id="qr-img" alt="QR Code" width="300" height="300">
    <div class="info">
      <p>Server: <code class="server-addr">${displayHost}:${config.port}</code></p>
      <p>TLS: <code>${config.tls ? 'Enabled' : 'Disabled'}</code></p>
    </div>
    ${webClientPath ? `<a id="web-link" href="${webClientPath}" class="web-link">Open Web Client</a>` : ''}
  </div>

  <script>
    function authenticate() {
      var token = document.getElementById('token').value;
      if (!token) return;
      // Pass the browser's host back to the server so the QR code uses the
      // correct address even behind reverse proxies that strip the Host header
      var qrParams = 'token=' + encodeURIComponent(token)
        + '&host=' + encodeURIComponent(location.hostname)
        + '&port=' + encodeURIComponent(location.port || (location.protocol === 'https:' ? '443' : '80'));
      fetch('/qr.png?' + qrParams)
        .then(function(res) {
          if (res.ok) {
            document.getElementById('auth-section').style.display = 'none';
            document.getElementById('qr-section').style.display = 'flex';
            document.getElementById('qr-section').style.flexDirection = 'column';
            document.getElementById('qr-section').style.alignItems = 'center';
            document.getElementById('qr-img').src = '/qr.png?' + qrParams;
            // Update server info to show actual host
            document.querySelectorAll('.server-addr').forEach(function(el) {
              el.textContent = location.host;
            });
            // Update web client link to pass token so it auto-connects
            var webLink = document.getElementById('web-link');
            if (webLink) {
              webLink.href = '/web#token=' + encodeURIComponent(token);
            }
          } else {
            document.getElementById('error').textContent = 'Invalid token';
            document.getElementById('error').style.display = 'block';
          }
        });
    }
    document.getElementById('token').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') authenticate();
    });
  </script>
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
