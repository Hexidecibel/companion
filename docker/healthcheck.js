// Docker HEALTHCHECK: GET /health on the daemon's configured port.
'use strict';
const fs = require('fs');
let port = 9877;
let tls = false;
try {
  const c = JSON.parse(fs.readFileSync('/home/companion/.companion/config.json', 'utf8'));
  const l = Array.isArray(c.listeners) && c.listeners[0] ? c.listeners[0] : c;
  if (Number.isInteger(l.port)) port = l.port;
  tls = l.tls === true;
} catch {
  const p = Number(process.env.COMPANION_PORT);
  if (Number.isInteger(p) && p > 0) port = p;
}
const mod = require(tls ? 'https' : 'http');
const req = mod.get(
  { host: '127.0.0.1', port, path: '/health', timeout: 4000, rejectUnauthorized: false },
  (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => {
      try {
        process.exit(res.statusCode === 200 && JSON.parse(body).ok === true ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  }
);
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
