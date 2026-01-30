import { ConversationHighlight } from '../types';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  highlights: ConversationHighlight[];
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function makeKey(serverId: string, sessionId: string): string {
  return `${serverId}:${sessionId}`;
}

export function getCachedHighlights(
  serverId: string,
  sessionId: string,
): ConversationHighlight[] | null {
  const entry = cache.get(makeKey(serverId, sessionId));
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(makeKey(serverId, sessionId));
    return null;
  }
  return entry.highlights;
}

export function setCachedHighlights(
  serverId: string,
  sessionId: string,
  highlights: ConversationHighlight[],
): void {
  cache.set(makeKey(serverId, sessionId), {
    highlights,
    timestamp: Date.now(),
  });
}

export function clearCache(serverId: string, sessionId: string): void {
  cache.delete(makeKey(serverId, sessionId));
}

export function clearAllCache(): void {
  cache.clear();
}

/**
 * Shallow comparison of highlights arrays to skip no-op re-renders.
 * Compares length and the id+content of the last item.
 */
export function highlightsEqual(
  a: ConversationHighlight[],
  b: ConversationHighlight[],
): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  return lastA.id === lastB.id && lastA.content === lastB.content;
}
