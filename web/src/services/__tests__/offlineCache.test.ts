import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __resetOfflineCacheForTests,
  initOfflineCache,
  offlineCacheBackend,
  saveSummary,
  getCachedSummaries,
  getSummaryUpdatedAt,
  saveConversation,
  loadConversation,
  flushOfflineCache,
  cachedConversationKeys,
  forgetServer,
  OFFLINE_DB_NAME,
  CACHE_SCHEMA_VERSION,
  MAX_MESSAGES,
  MAX_CONVERSATIONS,
} from '../offlineCache';
import type { ConversationHighlight, ServerSummary } from '../../types';

const summary = (n: number): ServerSummary => ({
  sessions: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `S${i}`, status: 'idle' } as unknown as ServerSummary['sessions'][number])),
  totalSessions: n,
  waitingCount: 0,
  workingCount: 0,
});

const msgs = (n: number, size = 10, prefix = 'm'): ConversationHighlight[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    type: 'assistant',
    content: 'x'.repeat(size),
    timestamp: i,
    isWaitingForChoice: false,
  }));

async function deleteDb(): Promise<void> {
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(OFFLINE_DB_NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
    r.onblocked = () => resolve();
  });
}

/** Simulate a reload: forget memory, re-open from IndexedDB. */
async function reload(): Promise<void> {
  await __resetOfflineCacheForTests();
  await initOfflineCache();
}

describe('offlineCache', () => {
  beforeEach(async () => {
    await __resetOfflineCacheForTests();
    await deleteDb();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses IndexedDB and survives a reload (summaries)', async () => {
    await initOfflineCache();
    expect(offlineCacheBackend()).toBe('indexeddb');
    saveSummary('srv', summary(3), 1000);
    await flushOfflineCache();
    await new Promise((r) => setTimeout(r, 20));
    await reload();
    expect(getCachedSummaries().get('srv')?.summary.sessions).toHaveLength(3);
    expect(getSummaryUpdatedAt('srv')).toBe(1000);
  });

  it('keeps the last MAX_MESSAGES messages of a conversation', async () => {
    saveConversation('srv', 'sess', msgs(80));
    await flushOfflineCache();
    await reload();
    const row = await loadConversation('srv', 'sess');
    expect(row?.highlights).toHaveLength(MAX_MESSAGES);
    expect(row?.highlights[0].id).toBe('m30');
    expect(row?.highlights[MAX_MESSAGES - 1].id).toBe('m79');
  });

  it('evicts the least recently used conversation beyond MAX_CONVERSATIONS', async () => {
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++t);
    for (let i = 0; i < MAX_CONVERSATIONS; i++) {
      saveConversation('srv', `s${i}`, msgs(2));
      await flushOfflineCache();
    }
    // Touch s0 so s1 becomes the oldest.
    expect(await loadConversation('srv', 's0')).not.toBeNull();
    saveConversation('srv', 'new', msgs(2));
    await flushOfflineCache();
    const keys = cachedConversationKeys();
    expect(keys).toHaveLength(MAX_CONVERSATIONS);
    expect(keys).not.toContain('srv:s1');
    expect(keys).toContain('srv:s0');
    expect(keys).toContain('srv:new');
    expect(await loadConversation('srv', 's1')).toBeNull();
    vi.restoreAllMocks();
  });

  it('caps total size (~5 MB) by evicting old entries, and skips a single oversized one', async () => {
    // Each ~1.2 MB (50 x 12k chars x 2 bytes): five of them exceed the cap.
    for (let i = 0; i < 5; i++) {
      saveConversation('srv', `big${i}`, msgs(50, 12_000, `b${i}-`));
      await flushOfflineCache();
    }
    const keys = cachedConversationKeys();
    expect(keys.length).toBeLessThan(5);
    expect(keys).toContain('srv:big4');
    expect(keys).not.toContain('srv:big0');
    // One conversation alone over the cap is not stored at all.
    saveConversation('srv', 'huge', msgs(50, 60_000));
    await flushOfflineCache();
    expect(cachedConversationKeys()).not.toContain('srv:huge');
  });

  it('drops the whole cache on a schema version mismatch', async () => {
    saveSummary('srv', summary(2));
    saveConversation('srv', 'sess', msgs(3));
    await flushOfflineCache();
    await new Promise((r) => setTimeout(r, 20));
    // Rewrite the stored schema version as if an older build had written it.
    await new Promise<void>((resolve) => {
      const open = indexedDB.open(OFFLINE_DB_NAME);
      open.onsuccess = () => {
        const tx = open.result.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ key: 'schema', version: CACHE_SCHEMA_VERSION + 99 });
        tx.oncomplete = () => { open.result.close(); resolve(); };
      };
    });
    await reload();
    expect(getCachedSummaries().size).toBe(0);
    expect(await loadConversation('srv', 'sess')).toBeNull();
    expect(cachedConversationKeys()).toEqual([]);
  });

  it('falls back to memory when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await __resetOfflineCacheForTests();
    await initOfflineCache();
    expect(offlineCacheBackend()).toBe('memory');
    saveSummary('srv', summary(1));
    saveConversation('srv', 'sess', msgs(2));
    await flushOfflineCache();
    expect(getCachedSummaries().get('srv')).toBeTruthy();
    expect((await loadConversation('srv', 'sess'))?.highlights).toHaveLength(2);
  });

  it('falls back to memory when IndexedDB.open throws (private mode)', async () => {
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('SecurityError'); } });
    await __resetOfflineCacheForTests();
    await initOfflineCache();
    expect(offlineCacheBackend()).toBe('memory');
    saveConversation('srv', 'sess', msgs(1));
    await flushOfflineCache();
    expect(await loadConversation('srv', 'sess')).not.toBeNull();
  });

  it('forgetServer removes its summary and conversations only', async () => {
    saveSummary('a', summary(1));
    saveSummary('b', summary(1));
    saveConversation('a', 'x', msgs(1));
    saveConversation('b', 'y', msgs(1));
    await flushOfflineCache();
    await forgetServer('a');
    expect(getCachedSummaries().has('a')).toBe(false);
    expect(getCachedSummaries().has('b')).toBe(true);
    expect(cachedConversationKeys()).toEqual(['b:y']);
  });
});
