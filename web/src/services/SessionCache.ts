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
 * Compare highlights arrays to skip no-op re-renders.
 * Checks all IDs for structural equality, plus content and tool status
 * of the last item to catch streaming/status updates.
 */
export function highlightsEqual(
  a: ConversationHighlight[],
  b: ConversationHighlight[],
): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  // Check all IDs — catches inserted, removed, or reordered messages
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  // Deep check last item for content/status changes
  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  if (lastA.content !== lastB.content) return false;
  if (lastA.isWaitingForChoice !== lastB.isWaitingForChoice) return false;
  const tcA = lastA.toolCalls || [];
  const tcB = lastB.toolCalls || [];
  if (tcA.length !== tcB.length) return false;
  for (let i = 0; i < tcA.length; i++) {
    if (tcA[i].status !== tcB[i].status) return false;
  }
  return true;
}
