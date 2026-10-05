/**
 * The daemon's stable public identity: a random id (advertised over mDNS and
 * put in pairing QR codes so apps can tell daemons apart) and a display name.
 * Neither is a credential.
 *
 * `~/.companion/daemon-id.json` (COMPANION_DAEMON_ID_FILE overrides), 0600,
 * created on first start.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils';
import { appVersion } from '../version';

export interface DaemonIdentity {
  id: string;
  name: string;
  version: string;
}

export function defaultIdentityPath(): string {
  return (
    process.env.COMPANION_DAEMON_ID_FILE || path.join(os.homedir(), '.companion', 'daemon-id.json')
  );
}

export function daemonDisplayName(configured?: string): string {
  // eslint-disable-next-line no-control-regex
  const n = (configured || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 60);
  return n || `Companion on ${os.hostname()}`;
}

/** The app version (version.ts: 1.0.<git commit count> from the build). */
export function daemonVersion(): string {
  return appVersion();
}

/** Read the id, creating it when missing or malformed. */
export function loadOrCreateDaemonId(file: string = defaultIdentityPath()): string {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: unknown };
    if (typeof raw.id === 'string' && /^[0-9a-f]{32}$/.test(raw.id)) return raw.id;
  } catch {
    /* create below */
  }
  const id = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(file, JSON.stringify({ id, createdAt: Date.now() }, null, 2) + '\n', {
      mode: 0o600,
    });
  } catch (err) {
    console.error('Identity: could not persist daemon id:', (err as Error).message);
  }
  return id;
}

export function loadDaemonIdentity(configuredName?: string): DaemonIdentity {
  return {
    id: loadOrCreateDaemonId(),
    name: daemonDisplayName(configuredName),
    version: daemonVersion(),
  };
}

/** For tests / handlers constructed without a persisted identity. */
export function ephemeralIdentity(configuredName?: string): DaemonIdentity {
  return {
    id: crypto.randomBytes(16).toString('hex'),
    name: daemonDisplayName(configuredName),
    version: daemonVersion(),
  };
}
