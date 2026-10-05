import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Desktop + Android update feed: GET /updates/<channel>/<file>, served
 * read-only from ~/.companion/updates (COMPANION_UPDATES_DIR overrides), which
 * `bin/companion publish-update` fills. The desktop app's updater fetches
 * <channel>/latest.json, then the signed bundle it names (verified by the app,
 * minisign). The Android app fetches <channel>/android.json, then the APK it
 * names (sha256 + signing certificate checked on the device). First installs
 * use <channel>/installers.json (dmg, NSIS setup.exe, AppImage, deb). No auth needed.
 *
 * Hardening: GET/HEAD only, every path segment must be a plain file name
 * (no dot-files, no "..", no separators), the real path must stay inside the
 * feed dir (symlinks cannot escape), only regular files are served, no listings.
 */

export const UPDATES_PREFIX = '/updates';
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const MAX_DEPTH = 3;

export function updatesDir(): string {
  return process.env.COMPANION_UPDATES_DIR || path.join(os.homedir(), '.companion', 'updates');
}

function contentType(file: string): string {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.sig') || file.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (file.endsWith('.apk')) return 'application/vnd.android.package-archive';
  if (file.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (file.endsWith('.deb')) return 'application/vnd.debian.binary-package';
  return 'application/octet-stream';
}

/** Manifests change on every publish; bundles are versioned file names. */
function cacheControl(file: string): string {
  return file.endsWith('.json') ? 'no-cache' : 'public, max-age=86400';
}

function send(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(message);
}

/** Returns the safe relative segments, or null when the path is not acceptable. */
export function parseUpdatePath(urlPath: string): string[] | null {
  if (!urlPath.startsWith(UPDATES_PREFIX + '/')) return null;
  const raw = urlPath.slice(UPDATES_PREFIX.length + 1).split('/');
  if (raw.length === 0 || raw.length > MAX_DEPTH) return null;
  const segments: string[] = [];
  for (const part of raw) {
    let seg: string;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!SEGMENT.test(seg) || seg.includes('..')) return null;
    segments.push(seg);
  }
  return segments;
}

/**
 * Handle /updates requests. Returns false when the path is not under /updates
 * (the caller continues routing); otherwise it has answered.
 */
export async function handleUpdatesRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  dir: string = updatesDir()
): Promise<boolean> {
  if (urlPath !== UPDATES_PREFIX && !urlPath.startsWith(UPDATES_PREFIX + '/')) return false;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    send(res, 405, 'Method Not Allowed');
    return true;
  }
  const segments = parseUpdatePath(urlPath);
  if (!segments) {
    send(res, 404, 'Not Found');
    return true;
  }

  try {
    const root = await fs.promises.realpath(dir);
    const real = await fs.promises.realpath(path.join(root, ...segments));
    if (!real.startsWith(root + path.sep)) {
      send(res, 404, 'Not Found');
      return true;
    }
    const st = await fs.promises.stat(real);
    if (!st.isFile()) {
      send(res, 404, 'Not Found');
      return true;
    }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': contentType(real),
      'Cache-Control': cacheControl(real),
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    await new Promise<void>((resolve) => {
      const stream = fs.createReadStream(real);
      stream.on('error', (err) => {
        console.error('Update feed: read error:', err.message);
        res.destroy();
        resolve();
      });
      stream.on('end', () => resolve());
      stream.pipe(res);
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
      send(res, 404, 'Not Found');
    } else {
      console.error('Update feed error:', err);
      if (!res.headersSent) send(res, 500, 'Internal Server Error');
      else res.destroy();
    }
  }
  return true;
}
