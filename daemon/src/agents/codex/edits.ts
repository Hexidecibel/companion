/**
 * Codex edits for the review ledger.
 *
 * Codex edits files with `apply_patch` (a freeform envelope:
 * `*** Begin Patch / *** Update File: p / *** Move to: q / @@ / -old / +new /
 * *** Add File: p / +line / *** Delete File: p / *** End Patch`), called
 * directly or from a code-mode `exec` snippet. The envelope has no line
 * numbers, but Codex 0.165 writes what it actually did right after the call
 * (checked live, fixture `parity-edits.jsonl`):
 *
 *   event_msg item_completed item {type:'FileChange', id, status,
 *     changes: { <abs path>: {type:'add', content}
 *                          | {type:'update', unified_diff, move_path}
 *                          | {type:'delete', content} } }
 *
 * `unified_diff` is real unified hunks (`@@ -2,3 +2,3 @@`), so the ledger
 * gets exact hunks from it. The envelope only gives the pending view (which
 * files are being edited) while the call runs.
 *
 * Shell edits (sed -i, heredocs, generators) are not claimed: like Claude's
 * Bash, the turn is marked `usedBash` and the end-of-turn git scan finds them.
 */
import type { AgentEditExtractor, EditOutcome, EditStart, RawHunk } from '../types';
import { createHunk } from '../claude/edits';

export interface PatchFileOp {
  /** Path as written in the envelope (absolute in 0.165, may be relative). */
  file: string;
  op: 'add' | 'update' | 'delete';
  /** `*** Move to:` destination. */
  moveTo?: string;
}

/** File operations of an apply_patch envelope, in order. */
export function parsePatchEnvelope(patch: string): PatchFileOp[] {
  const out: PatchFileOp[] = [];
  const lines = patch.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    let m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      const file = m[2].trim();
      if (!file) continue;
      out.push({ file, op: m[1] === 'Add' ? 'add' : m[1] === 'Delete' ? 'delete' : 'update' });
      continue;
    }
    m = /^\*\*\* Move to: (.+)$/.exec(line);
    if (m && out.length > 0 && out[out.length - 1].op === 'update') {
      const dest = m[1].trim();
      if (dest) out[out.length - 1].moveTo = dest;
    }
  }
  return out;
}

/** Hunks of a unified diff body (`@@ -a,b +c,d @@` + lines). null = nothing parseable. */
export function parseUnifiedHunks(diff: string): RawHunk[] | null {
  if (typeof diff !== 'string') return null;
  const hunks: RawHunk[] = [];
  let cur: RawHunk | null = null;
  const lines = diff.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // --- / +++ headers or junk before the first hunk
    if (/^[ +\-\\]/.test(line)) cur.lines.push(line);
    else if (line === '') cur.lines.push(' ');
  }
  return hunks.length ? hunks : null;
}

/** A whole-file deletion as one hunk (old content all `-`). */
export function deleteHunk(content: string): RawHunk[] {
  if (!content) return [];
  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = body.split('\n').map((l) => `-${l}`);
  if (!content.endsWith('\n')) lines.push('\\ No newline at end of file');
  return [{ oldStart: 1, oldLines: body.split('\n').length, newStart: 0, newLines: 0, lines }];
}

export interface CodexFileChange {
  /** Path the change landed on (the move destination for a rename). */
  file: string;
  /** Source path of a rename. */
  movedFrom?: string;
  op: 'add' | 'update' | 'delete';
  kind: 'create' | 'update';
  /** null = no usable patch in the record. */
  hunks: RawHunk[] | null;
}

/** The changes of a `FileChange` item (item_completed), in record order. */
export function fileChangeEdits(item: Record<string, unknown>): CodexFileChange[] {
  const changes = item.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return [];
  const out: CodexFileChange[] = [];
  for (const [file, raw] of Object.entries(changes as Record<string, unknown>)) {
    if (!file || !raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const type = c.type;
    if (type === 'add') {
      out.push({
        file,
        op: 'add',
        kind: 'create',
        hunks: typeof c.content === 'string' ? createHunk(c.content) : null,
      });
    } else if (type === 'delete') {
      out.push({
        file,
        op: 'delete',
        kind: 'update',
        hunks: typeof c.content === 'string' ? deleteHunk(c.content) : null,
      });
    } else if (type === 'update') {
      const move = typeof c.move_path === 'string' && c.move_path ? c.move_path : null;
      out.push({
        file: move || file,
        ...(move ? { movedFrom: file } : {}),
        op: 'update',
        kind: 'update',
        hunks: typeof c.unified_diff === 'string' ? parseUnifiedHunks(c.unified_diff) : null,
      });
    }
  }
  return out;
}

/** True when a FileChange item applied (anything else: failed / declined). */
export function fileChangeApplied(item: Record<string, unknown>): boolean {
  return item.status === undefined || item.status === 'completed';
}

/**
 * The generic single-file extractor (interface parity): the first file of an
 * apply_patch call. The ledger itself reads FileChange records (all files,
 * exact hunks); see `review/ledger.ts`.
 */
export const codexEdits: AgentEditExtractor = {
  editStart(toolName: string, input: Record<string, unknown>): EditStart | null {
    if (toolName !== 'apply_patch') return null;
    const patch = typeof input.patch === 'string' ? input.patch : '';
    const ops = parsePatchEnvelope(patch);
    const first = ops[0];
    if (!first) return null;
    return { file: first.moveTo || first.file, kind: first.op === 'add' ? 'create' : 'update' };
  },
  editOutcome(_toolName: string, current: 'create' | 'update', result: unknown): EditOutcome {
    if (result && typeof result === 'object') {
      const edits = fileChangeEdits(result as Record<string, unknown>);
      if (edits[0]) return { kind: edits[0].kind, hunks: edits[0].hunks };
    }
    return { kind: current, hunks: null };
  },
};
