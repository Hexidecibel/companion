import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { handleUpdatesRequest, parseUpdatePath } from '../src/update-feed';

let root: string;
let feed: string;
let server: http.Server;
let base: string;

function get(p: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = http.request(
        base + p,
        { method: init.method || 'GET', headers: init.headers },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
        }
      );
      req.on('error', reject);
      req.end();
    }
  );
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-feed-'));
  feed = path.join(root, 'updates');
  fs.mkdirSync(path.join(feed, 'stable'), { recursive: true });
  fs.writeFileSync(path.join(feed, 'stable', 'latest.json'), '{"version":"1.0.5"}');
  fs.writeFileSync(path.join(feed, 'stable', 'Companion_1.0.5_aarch64.app.tar.gz'), 'BUNDLE');
  fs.writeFileSync(path.join(feed, 'stable', 'android.json'), '{"versionCode":1000500}');
  fs.writeFileSync(path.join(feed, 'stable', 'Companion_1.0.500_android-1000500.apk'), 'APK');
  fs.writeFileSync(path.join(feed, 'stable', '.hidden'), 'x');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(feed, 'stable', 'escape.txt'));
  server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (!(await handleUpdatesRequest(req, res, urlPath, feed))) {
      res.writeHead(418);
      res.end('next');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('update feed', () => {
  it('serves the manifest uncached and bundles cacheable', async () => {
    const m = await get('/updates/stable/latest.json');
    expect(m.status).toBe(200);
    expect(m.body).toBe('{"version":"1.0.5"}');
    expect(m.headers['content-type']).toMatch(/application\/json/);
    expect(m.headers['cache-control']).toBe('no-cache');
    const b = await get('/updates/stable/Companion_1.0.5_aarch64.app.tar.gz');
    expect(b.status).toBe(200);
    expect(b.body).toBe('BUNDLE');
    expect(b.headers['content-type']).toBe('application/octet-stream');
    expect(b.headers['cache-control']).toMatch(/max-age/);
  });

  it('serves the Android entry uncached and the APK with its MIME type', async () => {
    const m = await get('/updates/stable/android.json');
    expect(m.status).toBe(200);
    expect(JSON.parse(m.body).versionCode).toBe(1000500);
    expect(m.headers['cache-control']).toBe('no-cache');
    const a = await get('/updates/stable/Companion_1.0.500_android-1000500.apk');
    expect(a.status).toBe(200);
    expect(a.body).toBe('APK');
    expect(a.headers['content-type']).toBe('application/vnd.android.package-archive');
  });

  it('revalidates with ETag and supports HEAD', async () => {
    const first = await get('/updates/stable/latest.json');
    const again = await get('/updates/stable/latest.json', {
      headers: { 'If-None-Match': String(first.headers.etag) },
    });
    expect(again.status).toBe(304);
    const head = await get('/updates/stable/latest.json', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe('19');
  });

  it('rejects traversal, dot-files, symlink escapes, directories and writes', async () => {
    for (const p of [
      '/updates/stable/..%2f..%2fsecret.txt',
      '/updates/stable/.hidden',
      '/updates/stable/escape.txt',
      '/updates/stable',
      '/updates/',
      '/updates',
      '/updates/stable/missing.json',
      '/updates/stable/a%5cb',
    ]) {
      const r = await get(p);
      expect([p, r.status]).toEqual([p, 404]);
      expect(r.body).not.toContain('SECRET');
    }
    expect((await get('/updates/stable/latest.json', { method: 'POST' })).status).toBe(405);
  });

  it('passes other paths through', async () => {
    expect((await get('/web/index.html')).status).toBe(418);
    expect((await get('/updatesX/latest.json')).status).toBe(418);
  });

  it('parseUpdatePath validates segments', () => {
    expect(parseUpdatePath('/updates/stable/latest.json')).toEqual(['stable', 'latest.json']);
    expect(parseUpdatePath('/updates/a/b/c/d')).toBeNull();
    // Raw '..' (HTTP clients normalise it away; curl --path-as-is does not).
    expect(parseUpdatePath('/updates/../secret.txt')).toBeNull();
    expect(parseUpdatePath('/updates/stable/a..b')).toBeNull();
    expect(parseUpdatePath('/updates/%2e%2e/secret.txt')).toBeNull();
    expect(parseUpdatePath('/updates/stable/%E0%A4%A')).toBeNull();
  });
});
