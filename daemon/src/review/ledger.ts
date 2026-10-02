/**
 * Transcript ledger: turns and per-edit patches extracted from Claude Code's
 * JSONL (tool_use + toolUseResult.structuredPatch). Exact, no subprocess, works
 * outside git. Incremental: each conversation file is tailed from a byte offset.
 *
 * Turn openers: `type:'user'` entries that are not meta / sidechain / compact
 * summaries, carry text (string or text blocks) and no tool_result. A
 * `<command-name>` entry opens a turn labelled with the command; a
 * `<task-notification>` opens a "Background task" turn; `<local-command-*>`
 * output attaches to the current turn.
 */

import * as path from 'path';
import { JsonlTail } from './jsonl-tail';
import { REVIEW_LIMITS } from './protocol';

export type EditTool = 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit';
const EDIT_TOOLS = new Set<string>(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export interface RawHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface LedgerEdit {
  id: string;
  turnId: string;
  tool: EditTool;
  absPath: string;
  kind: 'create' | 'update';
  /** tool_result time (pending: tool_use time). */
  at: number;
  startedAt: number;
  additions: number;
  deletions: number;
  hunks: RawHunk[];
  patchUnavailable?: boolean;
  /** Lines beyond the per-edit cap were dropped. */
  truncated?: boolean;
  pending?: boolean;
  failed?: boolean;
  /** Edit made by a subagent (agent id). */
  agentId?: string;
  /** Scratch space (temp dir / scratchpad outside the project): never reviewed. */
  excluded?: boolean;
}

export interface LedgerTurn {
  id: string;
  index: number;
  startedAt: number;
  /** Timestamp of the last entry seen in this turn. */
  lastEntryAt: number;
  /** Set once the next turn opened. */
  closedAt: number | null;
  prompt: string;
  editIds: string[];
  /** Last assistant text block in the turn (for free summaries). */
  lastAssistantText: string;
  usedBash: boolean;
  /** tool_use ids of Agent/Task calls in this turn (subagent attribution). */
  agentToolIds: string[];
}

export interface LedgerChange {
  phase: 'started' | 'completed' | 'failed';
  editId: string;
}

const PROMPT_MAX = 200;
const MAX_EDIT_LINES = REVIEW_LIMITS.maxFileHunkLines;

function ts(entry: Record<string, unknown>): number {
  const t = entry.timestamp;
  if (typeof t === 'string') {
    const n = Date.parse(t);
    if (Number.isFinite(n)) return n;
  }
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  return 0;
}

function oneLine(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function clipPrompt(s: string): string {
  const t = oneLine(s);
  return t.length <= PROMPT_MAX ? t : t.slice(0, PROMPT_MAX - 1).trimEnd() + '…';
}

/** Text of a user entry, or null when it is not a prompt-shaped entry. */
function userText(content: unknown): { text: string; hasToolResult: boolean; hasImage: boolean } {
  if (typeof content === 'string') return { text: content, hasToolResult: false, hasImage: false };
  if (!Array.isArray(content)) return { text: '', hasToolResult: false, hasImage: false };
  let text = '';
  let hasToolResult = false;
  let hasImage = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const blk = b as { type?: string; text?: string };
    if (blk.type === 'tool_result') hasToolResult = true;
    else if (blk.type === 'text' && typeof blk.text === 'string') text += (text ? '\n' : '') + blk.text;
    else if (blk.type === 'image') hasImage = true;
  }
  return { text, hasToolResult, hasImage };
}

/** Classify a user prompt text: opener label, 'attach' (local command output), or null (ignore). */
export function classifyPrompt(text: string, hasImage: boolean): { label: string } | 'attach' | null {
  const t = text.trim();
  if (!t) return hasImage ? { label: '(image)' } : null;
  if (/^<local-command-/.test(t)) return 'attach';
  if (/^\[Request interrupted/.test(t)) return 'attach';
  if (/^<task-notification>/.test(t)) return { label: 'Background task' };
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([^<]*)<\/command-args>/);
    const name = cmd[1].trim();
    return { label: clipPrompt(`${name.startsWith('/') ? name : `/${name}`} ${args ? args[1] : ''}`) };
  }
  return { label: clipPrompt(t) };
}

function countLines(hunks: RawHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) additions++;
      else if (l.startsWith('-')) deletions++;
    }
  }
  return { additions, deletions };
}

function sanitizeHunks(raw: unknown): RawHunk[] | null {
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

/** Cap the total lines kept for one edit. */
function capHunks(hunks: RawHunk[]): { hunks: RawHunk[]; truncated: boolean } {
  let total = 0;
  const out: RawHunk[] = [];
  for (const h of hunks) {
    if (total + h.lines.length > MAX_EDIT_LINES) {
      const room = MAX_EDIT_LINES - total;
      if (room > 0) out.push({ ...h, lines: h.lines.slice(0, room) });
      return { hunks: out, truncated: true };
    }
    total += h.lines.length;
    out.push(h);
  }
  return { hunks: out, truncated: false };
}

function createHunk(content: string): RawHunk[] {
  if (!content) return [];
  const body = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = body.split('\n').map((l) => `+${l}`);
  if (!content.endsWith('\n')) lines.push('\\ No newline at end of file');
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: body.split('\n').length, lines }];
}

interface FileState {
  tail: JsonlTail;
  /** Subagent file: its agent id + the parent tool_use id that spawned it. */
  agentId?: string;
  parentToolUseId?: string;
}

/**
 * One session's ledger. `files` must be fed oldest first (conversation chain),
 * then subagent files.
 */
export class SessionLedger {
  turns: LedgerTurn[] = [];
  edits = new Map<string, LedgerEdit>();
  /** Bumped on every change. */
  version = 0;
  skippedLines = 0;
  /** Bytes scanned over the ledger's lifetime (stats only; budgets are per update). */
  scannedBytes = 0;
  private files = new Map<string, FileState>();
  private fileOrder: string[] = [];
  private turnById = new Map<string, LedgerTurn>();
  /** Agent/Task tool_use id -> turn id. */
  private agentToolTurn = new Map<string, string>();
  private pendingChanges: LedgerChange[] = [];
  private needsRebuild = false;
  /** Set by the owner: paths that are never reviewed (marks edits `excluded`). */
  excludePath?: (absPath: string) => boolean;

  constructor(
    readonly sessionId: string,
    public projectPath: string
  ) {}

  /** Paths currently tracked (main chain first, then subagents). */
  trackedFiles(): string[] {
    return this.fileOrder.slice();
  }

  /** Main chain changed shape (file removed / reordered): the caller rebuilds. */
  get stale(): boolean {
    return this.needsRebuild;
  }

  setChain(mainFiles: string[], subagentFiles: Array<{ path: string; agentId: string; parentToolUseId?: string }>): void {
    const mains = this.fileOrder.filter((f) => !this.files.get(f)?.agentId);
    // Existing main files must be a prefix of the new chain (append-only), else rebuild.
    for (let i = 0; i < mains.length; i++) {
      if (mains[i] !== mainFiles[i]) {
        this.needsRebuild = true;
        return;
      }
    }
    for (const f of mainFiles) {
      if (!this.files.has(f)) {
        this.files.set(f, { tail: new JsonlTail(f) });
        // Keep main files before subagent files.
        const firstSub = this.fileOrder.findIndex((x) => !!this.files.get(x)?.agentId);
        if (firstSub === -1) this.fileOrder.push(f);
        else this.fileOrder.splice(firstSub, 0, f);
      }
    }
    for (const s of subagentFiles) {
      if (this.files.has(s.path)) continue;
      this.files.set(s.path, {
        tail: new JsonlTail(s.path),
        agentId: s.agentId,
        parentToolUseId: s.parentToolUseId,
      });
      this.fileOrder.push(s.path);
    }
  }

  /**
   * Read new lines from every tracked file, at most `budget` bytes in this
   * call (main chain first). Whatever is left over is read by the next call:
   * the budget bounds one pass, it is NOT a lifetime cap (a lifetime cap froze
   * big sessions: once ~64 MB of transcripts had been read, every later
   * update read 1 byte, so new edits were never attributed).
   * Returns true when anything changed.
   */
  async update(budget = 64 * 1024 * 1024): Promise<boolean> {
    const before = this.version;
    let left = budget;
    for (const f of this.fileOrder) {
      if (left <= 0) break;
      const st = this.files.get(f)!;
      const startOffset = st.tail.offset;
      const r = await st.tail.read(left);
      if (r.reset && startOffset > 0) {
        this.needsRebuild = true;
        return true;
      }
      const read = st.tail.offset - startOffset;
      left -= read;
      this.scannedBytes += read;
      this.skippedLines += r.skipped;
      for (const line of r.lines) {
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry && typeof entry === 'object') this.ingest(entry as Record<string, unknown>, st);
      }
      // Yield between files so a big initial build does not hog the loop.
      await new Promise<void>((r2) => setImmediate(r2));
    }
    return this.version !== before;
  }

  /** Edits started / completed since the last call (live view). */
  drainChanges(): LedgerChange[] {
    if (this.pendingChanges.length > 1000) this.pendingChanges = this.pendingChanges.slice(-1000);
    const c = this.pendingChanges;
    this.pendingChanges = [];
    return c;
  }

  private bump(): void {
    this.version++;
  }

  private currentTurn(): LedgerTurn | null {
    return this.turns.length ? this.turns[this.turns.length - 1] : null;
  }

  private openTurn(id: string, at: number, prompt: string): LedgerTurn {
    const prev = this.currentTurn();
    if (prev && prev.closedAt === null) prev.closedAt = prev.lastEntryAt || at;
    const turn: LedgerTurn = {
      id,
      index: this.turns.length + 1,
      startedAt: at,
      lastEntryAt: at,
      closedAt: null,
      prompt,
      editIds: [],
      lastAssistantText: '',
      usedBash: false,
      agentToolIds: [],
    };
    this.turns.push(turn);
    this.turnById.set(id, turn);
    this.bump();
    return turn;
  }

  /** Turn for an edit/tool use in the main chain (synthesizes one when none is open). */
  private turnFor(at: number, fileKey: string): LedgerTurn {
    const cur = this.currentTurn();
    if (cur) return cur;
    return this.openTurn(`pre:${path.basename(fileKey)}`, at, '(earlier conversation)');
  }

  /** Turn a subagent edit belongs to: its spawning Agent call's turn, else by time. */
  private turnForSubagent(st: FileState, at: number): LedgerTurn | null {
    if (st.parentToolUseId) {
      const tid = this.agentToolTurn.get(st.parentToolUseId);
      if (tid) return this.turnById.get(tid) || null;
    }
    let best: LedgerTurn | null = null;
    for (const t of this.turns) {
      if (t.startedAt <= at) best = t;
      else break;
    }
    return best;
  }

  getTurn(id: string): LedgerTurn | undefined {
    return this.turnById.get(id);
  }

  private isOpener(entry: Record<string, unknown>): boolean {
    if (entry.type !== 'user' || entry.isCompactSummary === true) return false;
    const { text, hasToolResult, hasImage } = userText(
      (entry.message as { content?: unknown } | undefined)?.content
    );
    if (hasToolResult) return false;
    const c = classifyPrompt(text, hasImage);
    return !!c && c !== 'attach';
  }

  private ingest(entry: Record<string, unknown>, st: FileState): void {
    const at = ts(entry);
    const isSub = !!st.agentId;
    const type = entry.type;
    const message = entry.message as { content?: unknown } | undefined;

    if (
      !isSub &&
      entry.isSidechain !== true &&
      entry.isMeta !== true &&
      (type === 'assistant' || type === 'user')
    ) {
      // Openers return early below, so only in-turn entries move the turn's end.
      const cur = this.currentTurn();
      if (cur && at > cur.lastEntryAt && !this.isOpener(entry)) cur.lastEntryAt = at;
    }

    if (type === 'user') {
      const { text, hasToolResult, hasImage } = userText(message?.content);
      if (
        !isSub &&
        !hasToolResult &&
        entry.isMeta !== true &&
        entry.isSidechain !== true &&
        entry.isCompactSummary !== true &&
        typeof entry.uuid === 'string'
      ) {
        const c = classifyPrompt(text, hasImage);
        if (c && c !== 'attach' && !this.turnById.has(entry.uuid)) {
          this.openTurn(entry.uuid, at, c.label);
          return;
        }
      }
      if (hasToolResult && Array.isArray(message?.content)) {
        const results = (message!.content as Array<Record<string, unknown>>).filter(
          (b) => b && b.type === 'tool_result'
        );
        for (const b of results) {
          const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : null;
          if (!id) continue;
          const edit = this.edits.get(id);
          if (!edit || !edit.pending) continue;
          this.completeEdit(edit, b, results.length === 1 ? entry.toolUseResult : undefined, at);
        }
      }
      return;
    }

    if (type === 'assistant' && Array.isArray(message?.content)) {
      if (!isSub && entry.isSidechain === true) return;
      for (const raw of message!.content as unknown[]) {
        if (!raw || typeof raw !== 'object') continue;
        const b = raw as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && !isSub) {
          const turn = this.currentTurn();
          if (turn && b.text.trim()) turn.lastAssistantText = b.text;
          continue;
        }
        if (b.type !== 'tool_use' || typeof b.name !== 'string' || typeof b.id !== 'string') continue;
        if (b.name === 'Bash' && !isSub) {
          const turn = this.currentTurn();
          if (turn) turn.usedBash = true;
          continue;
        }
        if ((b.name === 'Agent' || b.name === 'Task') && !isSub) {
          const turn = this.turnFor(at, st.tail.filePath);
          turn.agentToolIds.push(b.id);
          this.agentToolTurn.set(b.id, turn.id);
          continue;
        }
        if (!EDIT_TOOLS.has(b.name) || this.edits.has(b.id)) continue;
        const input = (b.input || {}) as Record<string, unknown>;
        const file =
          typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.notebook_path === 'string'
              ? input.notebook_path
              : null;
        if (!file) continue;
        const turn = isSub ? this.turnForSubagent(st, at) : this.turnFor(at, st.tail.filePath);
        if (!turn) continue;
        const absPath = path.resolve(this.projectPath || '/', file);
        const edit: LedgerEdit = {
          id: b.id,
          turnId: turn.id,
          tool: b.name as EditTool,
          absPath,
          kind: b.name === 'Write' ? 'create' : 'update',
          at,
          startedAt: at,
          additions: 0,
          deletions: 0,
          hunks: [],
          pending: true,
          ...(isSub ? { agentId: st.agentId } : {}),
          ...(this.excludePath?.(absPath) ? { excluded: true } : {}),
        };
        this.edits.set(edit.id, edit);
        turn.editIds.push(edit.id);
        this.pendingChanges.push({ phase: 'started', editId: edit.id });
        this.bump();
      }
    }
  }

  private completeEdit(
    edit: LedgerEdit,
    block: Record<string, unknown>,
    toolUseResult: unknown,
    at: number
  ): void {
    edit.pending = false;
    edit.at = at || edit.startedAt;
    if (block.is_error === true) {
      edit.failed = true;
      this.pendingChanges.push({ phase: 'failed', editId: edit.id });
      this.bump();
      return;
    }
    const tur =
      toolUseResult && typeof toolUseResult === 'object'
        ? (toolUseResult as Record<string, unknown>)
        : null;
    let hunks: RawHunk[] | null = null;
    if (tur) {
      if (tur.type === 'create') {
        edit.kind = 'create';
        hunks = createHunk(typeof tur.content === 'string' ? tur.content : '');
      } else {
        if (tur.type === 'update') edit.kind = 'update';
        else if (edit.tool === 'Write') edit.kind = 'update';
        hunks = sanitizeHunks(tur.structuredPatch);
      }
    } else if (edit.tool === 'Write') {
      edit.kind = 'update';
    }
    if (edit.tool !== 'Write' && edit.kind === 'create') edit.kind = 'update';
    if (hunks === null) {
      edit.patchUnavailable = true;
      edit.hunks = [];
    } else {
      const capped = capHunks(hunks);
      edit.hunks = capped.hunks;
      if (capped.truncated) edit.truncated = true;
      const c = countLines(hunks);
      edit.additions = c.additions;
      edit.deletions = c.deletions;
    }
    this.pendingChanges.push({ phase: 'completed', editId: edit.id });
    this.bump();
  }
}
