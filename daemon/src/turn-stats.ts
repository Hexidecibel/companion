/**
 * Totals for the turn in progress (since the user's last message), for the chat
 * window's status line. The client only loads a page of messages, which on a
 * phone can start after the turn did. Pure and allocation-light: runs over the
 * highlights get_highlights has already built. Same counting as the web's
 * turnFromHighlights (web/src/utils/sessionStatusLine.ts).
 */
import type { ConversationHighlight, TurnStats } from './types';

export function computeTurnStats(highlights: ConversationHighlight[]): TurnStats | undefined {
  let start = -1;
  for (let i = highlights.length - 1; i >= 0; i--) {
    const h = highlights[i];
    if (h.type === 'user' && !h.content.startsWith('[Request interrupted')) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  let tools = 0;
  const files = new Set<string>();
  for (let i = start + 1; i < highlights.length; i++) {
    for (const tc of highlights[i].toolCalls ?? []) {
      tools++;
      if (tc.status !== 'completed' || tc.isError) continue;
      const input = (tc.input ?? {}) as Record<string, unknown>;
      const one =
        tc.name === 'Edit' || tc.name === 'MultiEdit' || tc.name === 'Write'
          ? input.file_path
          : tc.name === 'NotebookEdit'
            ? input.notebook_path
            : undefined;
      if (typeof one === 'string' && one) files.add(one);
      if (tc.name === 'apply_patch' && Array.isArray(input.files)) {
        for (const f of input.files) if (typeof f === 'string') files.add(f);
      }
    }
  }
  return {
    startedAt: highlights[start].timestamp,
    endedAt: highlights[highlights.length - 1].timestamp,
    tools,
    files: files.size,
  };
}
