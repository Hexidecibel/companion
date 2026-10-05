/**
 * The app version: one source for /health, the mDNS TXT record, pair_hello,
 * get_capabilities and `companion --version`.
 *
 * `npm run build` writes dist/version.json (scripts/write-version.js):
 * `1.0.<git commit count>`, the scheme the desktop and Android builds use; the
 * Docker build passes the same number in as COMPANION_VERSION. Without the
 * generated file (ts-node, tests) the package.json version is used.
 */
import * as fs from 'fs';
import * as path from 'path';

const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;

function readVersion(file: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return typeof v === 'string' && VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** First valid version among the candidate files (generated file first). */
export function resolveAppVersion(dir: string = __dirname): string {
  return (
    readVersion(path.join(dir, 'version.json')) ||
    readVersion(path.join(dir, '..', 'package.json')) ||
    '0.0.0'
  );
}

let cached: string | null = null;

export function appVersion(): string {
  if (cached === null) cached = resolveAppVersion();
  return cached;
}
