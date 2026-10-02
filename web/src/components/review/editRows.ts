import type { ConversationHighlight } from '../../types';
import { EDIT_CHIP_TOOLS } from './editChipTools';

export const EMPTY_EDIT_ROWS: ReadonlyMap<string, string[]> = new Map();

/**
 * Tools hidden: the Edit / Write / MultiEdit / NotebookEdit tool_use ids that
 * would have carried an inline chip, grouped under the assistant message that
 * made them. A tool-only message right after an assistant text message hands
 * its edits to that message (the parser merges consecutive tool-only ones).
 */
export function hiddenEditRows(highlights: ReadonlyArray<ConversationHighlight>): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  let prev: ConversationHighlight | null = null;
  for (const msg of highlights) {
    const ids = msg.type === 'assistant'
      ? (msg.toolCalls ?? [])
          .filter((t) => EDIT_CHIP_TOOLS.has(t.name) && t.status !== 'pending' && t.id)
          .map((t) => t.id)
      : [];
    if (ids.length) {
      const toolOnly = !msg.content?.trim();
      const owner = toolOnly && prev && prev.type === 'assistant' && prev.content?.trim() ? prev.id : msg.id;
      rows.set(owner, [...(rows.get(owner) ?? []), ...ids]);
    }
    prev = msg;
  }
  return rows;
}
