/**
 * Offline cache (stale-while-revalidate) for what the app shows before a
 * server answers: the last good server summary per server and the last
 * MAX_MESSAGES messages of up to MAX_CONVERSATIONS sessions (LRU, about
 * MAX_BYTES in all).
 *
 * Backed by IndexedDB (works in Chromium, WebKitGTK, WKWebView and Android
 * WebView); when IndexedDB is missing, blocked or throws (private mode, a
 * WebView without it) everything silently falls back to memory, so callers
 * never see an error. Nothing here ever throws or rejects.
 *
 * The cache is never cleared on disconnect; failed refreshes leave the last
 * good data in place. A schema version is stored with it: on mismatch the
 * whole cache is dropped.
 */
import type { ConversationHighlight, ServerSummary } from '../types';

export const CACHE_SCHEMA_VERSION = 1;
export const OFFLINE_DB_NAME = 'companion-offline-cache';
const IDB_VERSION = 1;
export const MAX_MESSAGES = 50;
export const MAX_CONVERSATIONS = 30;
export const MAX_BYTES = 5 * 1024 * 1024;
/** An unchanged summary is re-persisted (fresh updatedAt) at most this often. */
const SUMMARY_PERSIST_MS = 60_000;
const CONVERSATION_DEBOUNCE_MS = 1000;
const OPEN_TIMEOUT_MS = 3000;

type StoreName = 'meta' | 'summaries' | 'conversations' | 'convMeta';
const STORES: StoreName[] = ['meta', 'summaries', 'conversations', 'convMeta'];

export interface CachedSummary {
  key: string; // serverId
  summary: ServerSummary;
  updatedAt: number;
}

export interface CachedConversation {
  key: string; // serverId:sessionId
  serverId: string;
  sessionId: string;
  highlights: ConversationHighlight[];
  updatedAt: number;
}

interface ConvMeta {
  key: string;
  serverId: string;
  bytes: number;
  lastAccess: number;
}

interface Backend {
  kind: 'indexeddb' | 'memory';
  getAll<T>(store: StoreName): Promise<T[]>;
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, value: { key: string }): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
  close(): void;
}

function memoryBackend(): Backend {
  const data = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));
  return {
    kind: 'memory',
    async getAll<T>(store: StoreName) { return [...data.get(store)!.values()] as T[]; },
    async get<T>(store: StoreName, key: string) { return data.get(store)!.get(key) as T | undefined; },
    async put(store, value) { data.get(store)!.set(value.key, value); },
    async delete(store, key) { data.get(store)!.delete(key); },
    async clear(store) { data.get(store)!.clear(); },
    close() { /* nothing */ },
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function openIndexedDb(): Promise<Backend | null> {
  let factory: IDBFactory | undefined;
  try {
    factory = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  } catch {
    return null; // some sandboxes throw on mere access
  }
  if (!factory) return null;
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const done = (v: IDBDatabase | null) => { if (!settled) { settled = true; resolve(v); } };
    // A WebView that never answers open() must not hold the app up.
    const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
    try {
      const open = factory!.open(OFFLINE_DB_NAME, IDB_VERSION);
      open.onupgradeneeded = () => {
        const d = open.result;
        for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'key' });
      };
      open.onsuccess = () => {
        clearTimeout(timer);
        if (settled) { try { open.result.close(); } catch { /* ignore */ } return; }
        done(open.result);
      };
      open.onerror = () => { clearTimeout(timer); done(null); };
      open.onblocked = () => { clearTimeout(timer); done(null); };
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
  if (!db) return null;
  const tx = (store: StoreName, mode: IDBTransactionMode) => db.transaction(store, mode).objectStore(store);
  const write = (store: StoreName, fn: (os: IDBObjectStore) => IDBRequest) =>
    new Promise<void>((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      fn(t.objectStore(store));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  return {
    kind: 'indexeddb',
    getAll: <T,>(store: StoreName) => req(tx(store, 'readonly').getAll()) as Promise<T[]>,
    get: <T,>(store: StoreName, key: string) => req(tx(store, 'readonly').get(key)) as Promise<T | undefined>,
    put: (store, value) => write(store, (os) => os.put(value)),
    delete: (store, key) => write(store, (os) => os.delete(key)),
    clear: (store) => write(store, (os) => os.clear()),
    close: () => { try { db.close(); } catch { /* ignore */ } },
  };
}

// ---------------------------------------------------------------- state

let backend: Backend = memoryBackend();
let ready: Promise<void> | null = null;
const summaries = new Map<string, CachedSummary>();
const lastPersistedSummary = new Map<string, { json: string; at: number }>();
const index = new Map<string, ConvMeta>();
const pending = new Map<string, { serverId: string; sessionId: string; highlights: ConversationHighlight[] }>();
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let writeChain: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

/** Run a backend call; on failure fall back to memory for the rest of the session. */
async function safe<T>(fn: (b: Backend) => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn(backend);
  } catch (err) {
    if (backend.kind === 'indexeddb') {
      console.warn('offlineCache: IndexedDB failed, using memory:', err);
      backend = memoryBackend();
    }
    return fallback;
  }
}

async function doInit(forceMemory: boolean): Promise<void> {
  const idb = forceMemory ? null : await openIndexedDb().catch(() => null);
  backend = idb ?? memoryBackend();
  const meta = await safe((b) => b.get<{ key: string; version: number }>('meta', 'schema'), undefined);
  if (!meta || meta.version !== CACHE_SCHEMA_VERSION) {
    for (const s of STORES) await safe((b) => b.clear(s), undefined);
    await safe((b) => b.put('meta', { key: 'schema', version: CACHE_SCHEMA_VERSION } as { key: string }), undefined);
  }
  const rows = await safe((b) => b.getAll<CachedSummary>('summaries'), []);
  for (const row of rows) {
    if (row && row.summary && Array.isArray(row.summary.sessions) && !summaries.has(row.key)) summaries.set(row.key, row);
  }
  const metas = await safe((b) => b.getAll<ConvMeta>('convMeta'), []);
  for (const m of metas) if (m && typeof m.bytes === 'number') index.set(m.key, m);
  if (rows.length) notify();
}

/** Open the cache (idempotent). Safe to call early; everything else awaits it. */
export function initOfflineCache(): Promise<void> {
  if (!ready) ready = doInit(false).catch(() => {});
  return ready;
}

/** Which storage is in use ('memory' when IndexedDB is unavailable). */
export function offlineCacheBackend(): 'indexeddb' | 'memory' {
  return backend.kind;
}

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

/** Called when cached summaries finish loading from disk. */
export function onOfflineCacheLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------- summaries

/** The cached summaries known right now (empty until the cache has loaded). */
export function getCachedSummaries(): Map<string, CachedSummary> {
  return summaries;
}

export function getSummaryUpdatedAt(serverId: string): number | null {
  return summaries.get(serverId)?.updatedAt ?? null;
}

/** Record a successful refresh. Persists when it changed (or once a minute). */
export function saveSummary(serverId: string, summary: ServerSummary, updatedAt = Date.now()): void {
  const row: CachedSummary = { key: serverId, summary, updatedAt };
  summaries.set(serverId, row);
  let json: string;
  try {
    json = JSON.stringify(summary);
  } catch {
    return;
  }
  const last = lastPersistedSummary.get(serverId);
  if (last && last.json === json && updatedAt - last.at < SUMMARY_PERSIST_MS) return;
  lastPersistedSummary.set(serverId, { json, at: updatedAt });
  void initOfflineCache().then(() => safe((b) => b.put('summaries', row), undefined));
}

/** Drop everything cached for a server (it was removed from the app). */
export async function forgetServer(serverId: string): Promise<void> {
  summaries.delete(serverId);
  lastPersistedSummary.delete(serverId);
  for (const [k, p] of pending) if (p.serverId === serverId) pending.delete(k);
  await initOfflineCache();
  await safe((b) => b.delete('summaries', serverId), undefined);
  for (const m of [...index.values()]) {
    if (m.serverId === serverId) await evict(m.key);
  }
}

// ---------------------------------------------------------------- conversations

const convKey = (serverId: string, sessionId: string) => `${serverId}:${sessionId}`;

export async function loadConversation(serverId: string, sessionId: string): Promise<CachedConversation | null> {
  const key = convKey(serverId, sessionId);
  const queued = pending.get(key);
  if (queued) return { key, serverId, sessionId, highlights: queued.highlights.slice(-MAX_MESSAGES), updatedAt: Date.now() };
  await initOfflineCache();
  const row = await safe((b) => b.get<CachedConversation>('conversations', key), undefined);
  if (!row || !Array.isArray(row.highlights)) return null;
  const meta = index.get(key);
  if (meta) meta.lastAccess = Date.now(); // in memory; persisted with the next write
  return row;
}

/** Remember the tail of a conversation (debounced, trimmed to MAX_MESSAGES). */
export function saveConversation(serverId: string, sessionId: string, highlights: ConversationHighlight[]): void {
  if (!serverId || !sessionId) return;
  pending.set(convKey(serverId, sessionId), { serverId, sessionId, highlights });
  if (!pendingTimer) pendingTimer = setTimeout(() => { pendingTimer = null; void flushPending(); }, CONVERSATION_DEBOUNCE_MS);
}

async function evict(key: string): Promise<void> {
  index.delete(key);
  await safe((b) => b.delete('conversations', key), undefined);
  await safe((b) => b.delete('convMeta', key), undefined);
}

function flushPending(): Promise<void> {
  const batch = [...pending.entries()];
  pending.clear();
  writeChain = writeChain.then(async () => {
    await initOfflineCache();
    for (const [key, p] of batch) {
      const highlights = p.highlights.slice(-MAX_MESSAGES);
      const now = Date.now();
      const row: CachedConversation = { key, serverId: p.serverId, sessionId: p.sessionId, highlights, updatedAt: now };
      let bytes: number;
      try {
        bytes = JSON.stringify(row).length * 2; // UTF-16 estimate
      } catch {
        continue;
      }
      if (bytes > MAX_BYTES) continue;
      await safe((b) => b.put('conversations', row), undefined);
      const meta: ConvMeta = { key, serverId: p.serverId, bytes, lastAccess: now };
      index.set(key, meta);
      await safe((b) => b.put('convMeta', meta), undefined);
      // LRU: oldest access first, never the one just written.
      let total = 0;
      for (const m of index.values()) total += m.bytes;
      const byAge = [...index.values()].filter((m) => m.key !== key).sort((a, b) => a.lastAccess - b.lastAccess);
      while ((index.size > MAX_CONVERSATIONS || total > MAX_BYTES) && byAge.length) {
        const victim = byAge.shift()!;
        total -= victim.bytes;
        await evict(victim.key);
      }
    }
  }).catch(() => {});
  return writeChain;
}

/** Write anything still debounced, and wait for queued writes. */
export async function flushOfflineCache(): Promise<void> {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  await flushPending();
}

/** Keys of the cached conversations, oldest access first (diagnostics / tests). */
export function cachedConversationKeys(): string[] {
  return [...index.values()].sort((a, b) => a.lastAccess - b.lastAccess).map((m) => m.key);
}

/** Test helper: forget all in-memory state; the next call re-opens the cache. */
export async function __resetOfflineCacheForTests(opts: { forceMemory?: boolean } = {}): Promise<void> {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  pending.clear();
  await writeChain;
  summaries.clear();
  lastPersistedSummary.clear();
  index.clear();
  listeners.clear();
  if (ready) await ready;
  backend.close();
  backend = memoryBackend();
  ready = opts.forceMemory ? doInit(true).catch(() => {}) : null;
}
