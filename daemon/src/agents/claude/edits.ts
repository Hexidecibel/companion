/**
 * Claude Code edit extraction for the review ledger: which tool_use is a file
 * edit (role 'edit'), and what its toolUseResult says it did
 * (`structuredPatch` hunks, or a `create` with the full content).
 */
import type { AgentEditExtractor, EditOutcome, EditStart, RawHunk } from '../types';
import { toolRole } from '../roles';

export function sanitizeHunks(raw: unknown): RawHunk[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RawHunk[] = [];
  for (const h of raw) {
    if (!h || typeof h !== 'object') return null;
    const r = h as Record<string, unknown>;
    if (!Array.isArray(r.lines)) return null;
    out.push({
      oldStart: Number(r.oldStart) || 0,
      oldLines: Number(r.oldLines) || 0,
      newStart: Number(r.newStart) || 0,
      newLines: Number(r.newLines) || 0,
      lines: (r.lines as unknown[]).filter((l): l is string => typeof l === 'string'),
    });
  }
  return out;
}

export function createHunk(content: string): RawHunk[] {
  if (!content) return [];
  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = body.split('\n').map((l) => `+${l}`);
  if (!content.endsWith('\n')) lines.push('\\ No newline at end of file');
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: body.split('\n').length, lines }];
}

export const claudeEdits: AgentEditExtractor = {
  editStart(toolName: string, input: Record<string, unknown>): EditStart | null {
    if (toolRole(toolName) !== 'edit') return null;
    const file =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : null;
    if (!file) return null;
    return { file, kind: toolName === 'Write' ? 'create' : 'update' };
  },

  editOutcome(toolName: string, current: 'create' | 'update', result: unknown): EditOutcome {
    let kind = current;
    const tur = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
    let hunks: RawHunk[] | null = null;
    if (tur) {
      if (tur.type === 'create') {
        kind = 'create';
        hunks = createHunk(typeof tur.content === 'string' ? tur.content : '');
      } else {
        if (tur.type === 'update') kind = 'update';
        else if (toolName === 'Write') kind = 'update';
        hunks = sanitizeHunks(tur.structuredPatch);
      }
    } else if (toolName === 'Write') {
      kind = 'update';
    }
    if (toolName !== 'Write' && kind === 'create') kind = 'update';
    return { kind, hunks };
  },
};
