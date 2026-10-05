/**
 * Paired-device tokens at rest on the mobile apps.
 *
 * Android and iOS keep each server's token in the platform's secure storage
 * (Android Keystore-encrypted prefs / iOS Keychain, via the herald-native
 * plugin). The server list in app storage (localStorage + tauri-plugin-store)
 * then holds `token: ''` with `tokenStore: 'secure'`; the real tokens live in
 * memory for this run, read once at startup (`initSecureTokens`, before the
 * app renders). Desktop and the browser have no backend and keep today's
 * storage unchanged.
 *
 * Migration is transparent and loss-free: a plaintext token is first written
 * to secure storage and read back; only when the read-back matches is the
 * plaintext copy replaced. Any failure (an older native build without the
 * commands, a Keystore error) leaves the plaintext copy where it was, so the
 * app keeps working and tries again next launch.
 */
import type { Server } from '../types';
import { SERVERS_KEY } from './storageKeys';
import { syncToStore } from './persistentStorage';
import { nativeSecureStore, type SecureStoreBackend } from './nativeBridge';

/** What the server list stores for a server whose token moved to secure storage. */
export type PersistedServer = Server & { tokenStore?: 'secure' };

let backend: SecureStoreBackend | null = null;
/** serverId -> token, for the servers whose token is in secure storage. */
const tokens = new Map<string, string>();
/** Serialises writes to secure storage and the list (moves, deletes). */
let chain: Promise<unknown> = Promise.resolve();

const INIT_TIMEOUT_MS = 8000;

/** The secure-storage entry name for a server's token (plugin names: [A-Za-z0-9._:-]{1,128}). */
export function secureTokenKey(serverId: string): string {
  const safe = serverId.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 96);
  if (safe === serverId) return `server-token.${safe}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < serverId.length; i++) h = Math.imul(h ^ serverId.charCodeAt(i), 0x01000193) >>> 0;
  return `server-token.${safe}.${h.toString(16)}`;
}

export function secureTokensActive(): boolean {
  return backend !== null;
}

function readRaw(): PersistedServer[] {
  try {
    const json = localStorage.getItem(SERVERS_KEY);
    const list = json ? JSON.parse(json) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeRaw(list: PersistedServer[]): void {
  const json = JSON.stringify(list);
  localStorage.setItem(SERVERS_KEY, json);
  syncToStore(SERVERS_KEY, json);
}

/** Read path: put the in-memory tokens back into the stored list. */
export function revealTokens(list: PersistedServer[]): Server[] {
  return list.map((s) => {
    if (s.tokenStore !== 'secure') return s;
    const { tokenStore: _t, ...rest } = s;
    return { ...rest, token: tokens.get(s.id) ?? '' };
  });
}

/**
 * Write path: what goes into app storage. A token already safe in secure
 * storage is stored as a marker; a new or changed one stays plaintext until
 * `moveToSecure` has it (never a moment without a copy).
 */
export function persistableServers(servers: Server[]): PersistedServer[] {
  if (!backend) return servers;
  return servers.map((s) =>
    s.token && tokens.get(s.id) === s.token ? { ...s, token: '', tokenStore: 'secure' as const } : s,
  );
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const p = chain.then(job, job);
  chain = p.catch(() => {});
  return p;
}

/** Copy a token into secure storage, verify it, then drop the plaintext copy from the list. */
async function moveToSecure(b: SecureStoreBackend, serverId: string, token: string): Promise<boolean> {
  const key = secureTokenKey(serverId);
  await b.set(key, token);
  if ((await b.get(key)) !== token) throw new Error('secure storage read-back did not match');
  tokens.set(serverId, token);
  // Re-read: the list may have changed while we were writing.
  const list = readRaw();
  let changed = false;
  const next = list.map((s) => {
    if (s.id === serverId && s.tokenStore !== 'secure' && s.token === token) {
      changed = true;
      return { ...s, token: '', tokenStore: 'secure' as const };
    }
    return s;
  });
  if (changed) writeRaw(next);
  return true;
}

/**
 * After a save: move new / changed tokens into secure storage and forget the
 * tokens of servers that were removed. Fire-and-forget (logged on failure:
 * the plaintext copy simply stays).
 */
export function afterServersSaved(servers: Server[]): Promise<void> {
  const b = backend;
  if (!b) return Promise.resolve();
  const ids = new Set(servers.map((s) => s.id));
  const jobs: Array<Promise<unknown>> = [];
  for (const s of servers) {
    if (s.token && tokens.get(s.id) !== s.token) {
      jobs.push(enqueue(() => moveToSecure(b, s.id, s.token)).catch((err) => {
        console.warn('[secure-tokens] could not move a token to secure storage; keeping app storage', err);
      }));
    }
  }
  for (const id of Array.from(tokens.keys())) {
    if (ids.has(id)) continue;
    tokens.delete(id);
    jobs.push(enqueue(() => b.delete(secureTokenKey(id))).catch(() => {}));
  }
  return Promise.all(jobs).then(() => undefined);
}

async function hydrateAndMigrate(b: SecureStoreBackend): Promise<void> {
  const list = readRaw();
  // 1. Tokens already in secure storage.
  for (const s of list) {
    if (s.tokenStore !== 'secure') continue;
    const v = await b.get(secureTokenKey(s.id));
    if (v !== null) tokens.set(s.id, v);
    else console.warn(`[secure-tokens] token for "${s.name}" is missing from secure storage; pair again`);
  }
  // 2. Plaintext tokens left from before (first launch after the update).
  for (const s of list) {
    if (s.tokenStore === 'secure' || !s.token) continue;
    await enqueue(() => moveToSecure(b, s.id, s.token));
  }
}

/**
 * Startup (after initStorage, before render): read the secure tokens and
 * migrate any plaintext ones. A no-op on desktop and in a browser.
 */
export async function initSecureTokens(b: SecureStoreBackend | null = nativeSecureStore()): Promise<void> {
  backend = null;
  tokens.clear();
  if (!b) return;
  backend = b;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      hydrateAndMigrate(b),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), INIT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.warn('[secure-tokens] secure storage unavailable; tokens stay in app storage', err);
    // Nothing secure could be read: behave like before (plaintext stays, nothing is stripped).
    if (tokens.size === 0 && !readRaw().some((s) => s.tokenStore === 'secure')) backend = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Tests. */
export function resetSecureTokens(): void {
  backend = null;
  tokens.clear();
  chain = Promise.resolve();
}

/** Tests: wait for queued moves / deletes. */
export function secureTokensIdle(): Promise<unknown> {
  return chain;
}
