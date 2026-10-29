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
import { codexAdapter, defaultAgent, type AgentEditExtractor, type RawHunk } from '../agents';
import { isCodexRollout } from '../agents/codex/discovery';
import {
  customToolStart,
  functionToolStart,
  isInjectedUserMessage,
  summarizeExecInput,
} from '../agents/codex/parse';
import { fileChangeApplied, fileChangeEdits, parsePatchEnvelope } from '../agents/codex/edits';

/** Edit tools (role 'edit'): Claude's, plus Codex's apply_patch. */
export type EditTool = 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit' | 'apply_patch';

export type { RawHunk } from '../agents/types';

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
    else if (blk.type === 'text' && typeof blk.text === 'string')
      text += (text ? '\n' : '') + blk.text;
    else if (blk.type === 'image') hasImage = true;
  }
  return { text, hasToolResult, hasImage };
}

/** Classify a user prompt text: opener label, 'attach' (local command output), or null (ignore). */
export function classifyPrompt(
  text: string,
  hasImage: boolean
): { label: string } | 'attach' | null {
  const t = text.trim();
  if (!t) return hasImage ? { label: '(image)' } : null;
  if (/^<local-command-/.test(t)) return 'attach';
  if (/^\[Request interrupted/.test(t)) return 'attach';
  if (/^<task-notification>/.test(t)) return { label: 'Background task' };
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([^<]*)<\/command-args>/);
    const name = cmd[1].trim();
    return {
      label: clipPrompt(`${name.startsWith('/') ? name : `/${name}`} ${args ? args[1] : ''}`),
    };
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

interface FileState {
  tail: JsonlTail;
  /** A Codex rollout (`{type, payload}` records), not a Claude JSONL. */
  codex?: boolean;
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
  /** The session's agent: tool roles + edit extraction (Claude: structuredPatch). */
  private readonly agent = defaultAgent();
  private readonly editExtractor: AgentEditExtractor = this.agent.transcript.edits;
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

  setChain(
    mainFiles: string[],
    subagentFiles: Array<{ path: string; agentId: string; parentToolUseId?: string }>
  ): void {
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
        this.files.set(f, {
          tail: new JsonlTail(f),
          ...(isCodexRollout(f) ? { codex: true } : {}),
        });
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
    if (st.codex) {
      this.ingestCodex(entry, st);
      return;
    }
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
        if (b.type !== 'tool_use' || typeof b.name !== 'string' || typeof b.id !== 'string')
          continue;
        const role = this.agent.toolRole(b.name);
        if (role === 'shell' && !isSub) {
          const turn = this.currentTurn();
          if (turn) turn.usedBash = true;
          continue;
        }
        if (role === 'subagent' && !isSub) {
          const turn = this.turnFor(at, st.tail.filePath);
          turn.agentToolIds.push(b.id);
          this.agentToolTurn.set(b.id, turn.id);
          continue;
        }
        if (role !== 'edit' || this.edits.has(b.id)) continue;
        const start = this.editExtractor.editStart(
          b.name,
          (b.input || {}) as Record<string, unknown>
        );
        if (!start) continue;
        const file = start.file;
        const turn = isSub ? this.turnForSubagent(st, at) : this.turnFor(at, st.tail.filePath);
        if (!turn) continue;
        const absPath = path.resolve(this.projectPath || '/', file);
        const edit: LedgerEdit = {
          id: b.id,
          turnId: turn.id,
          tool: b.name as EditTool,
          absPath,
          kind: start.kind,
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

  // ---------------------------------------------------------------- Codex

  /** call id -> pending edit ids made from its apply_patch envelope. */
  private codexCallEdits = new Map<string, string[]>();

  /**
   * One Codex rollout record. Turns open on a user message the user typed
   * (harness-injected context skipped); apply_patch calls open pending edits
   * from the envelope; the FileChange item that follows carries the exact
   * unified hunks and completes them (or adds edits the envelope missed);
   * shell calls mark the turn `usedBash` for the end-of-turn git scan.
   */
  private ingestCodex(entry: Record<string, unknown>, st: FileState): void {
    const at = ts(entry);
    const type = entry.type;
    const p =
      entry.payload && typeof entry.payload === 'object'
        ? (entry.payload as Record<string, unknown>)
        : {};
    const cur = this.currentTurn();
    if (cur && at > cur.lastEntryAt && (type === 'response_item' || type === 'event_msg'))
      cur.lastEntryAt = at;

    if (type === 'response_item') {
      const ptype = p.type;
      if (ptype === 'message') {
        const text = codexText(p.content);
        if (p.role === 'user') {
          if (!text || isInjectedUserMessage(p, text)) return;
          const c = classifyPrompt(text, false);
          if (!c || c === 'attach') return;
          const id = typeof p.id === 'string' && p.id ? p.id : `codex:${st.tail.offset}:${at}`;
          if (!this.turnById.has(id)) this.openTurn(id, at, c.label);
        } else if (p.role === 'assistant' && text.trim()) {
          const turn = this.currentTurn();
          if (turn) turn.lastAssistantText = text;
        }
        return;
      }
      if (ptype === 'custom_tool_call' || ptype === 'function_call') {
        const callId = typeof p.call_id === 'string' ? p.call_id : '';
        const name = typeof p.name === 'string' ? p.name : '';
        const start =
          ptype === 'custom_tool_call'
            ? customToolStart(name || 'exec', typeof p.input === 'string' ? p.input : '')
            : functionToolStart(name || 'function', p.arguments);
        // A code-mode snippet can patch AND run commands in one call.
        const shell =
          codexAdapter.toolRole(start.name) === 'shell' ||
          (ptype === 'custom_tool_call' &&
            name === 'exec' &&
            summarizeExecInput(typeof p.input === 'string' ? p.input : '').commands.length > 0);
        if (shell) {
          const turn = this.currentTurn();
          if (turn) turn.usedBash = true;
        }
        if (start.name === 'apply_patch' && callId) {
          const patch = typeof start.input.patch === 'string' ? start.input.patch : '';
          const ids: string[] = [];
          parsePatchEnvelope(patch).forEach((op, i) => {
            const id = `${callId}#${i}`;
            if (this.edits.has(id)) return;
            const target = op.moveTo || op.file;
            const e = this.addCodexEdit(id, target, op.op === 'add' ? 'create' : 'update', at, st);
            if (e) ids.push(e.id);
            if (op.moveTo) {
              const src = this.addCodexEdit(`${id}:from`, op.file, 'update', at, st);
              if (src) ids.push(src.id);
            }
          });
          if (ids.length) this.codexCallEdits.set(callId, ids);
        }
        return;
      }
      if (ptype === 'custom_tool_call_output' || ptype === 'function_call_output') {
        // The FileChange item normally completed these already; whatever is
        // still pending got no FileChange: the patch failed or was declined.
        const callId = typeof p.call_id === 'string' ? p.call_id : '';
        const ids = this.codexCallEdits.get(callId);
        if (!ids) return;
        this.codexCallEdits.delete(callId);
        for (const id of ids) {
          const e = this.edits.get(id);
          if (e?.pending) this.failEdit(e, at);
        }
      }
      return;
    }

    if (type === 'event_msg' && p.type === 'item_completed') {
      const item =
        p.item && typeof p.item === 'object' ? (p.item as Record<string, unknown>) : null;
      if (!item) return;
      if (item.type === 'CommandExecution') {
        const turn = this.currentTurn();
        if (turn) turn.usedBash = true;
        return;
      }
      if (item.type !== 'FileChange') return;
      const applied = fileChangeApplied(item);
      const itemId = typeof item.id === 'string' && item.id ? item.id : `fc:${at}`;
      fileChangeEdits(item).forEach((ch, i) => {
        const abs = path.resolve(this.projectPath || '/', ch.file);
        let e = this.pendingCodexEditFor(abs);
        if (!e) {
          const id = `${itemId}#${i}`;
          if (this.edits.has(id)) return;
          e = this.addCodexEdit(id, ch.file, ch.kind, at, st) || undefined;
          if (!e) return;
        }
        if (!applied) {
          this.failEdit(e, at);
        } else {
          this.finishEdit(e, { kind: ch.kind, hunks: ch.hunks }, at);
        }
        if (ch.movedFrom) {
          const srcAbs = path.resolve(this.projectPath || '/', ch.movedFrom);
          let src = this.pendingCodexEditFor(srcAbs);
          if (!src) {
            const id = `${itemId}#${i}:from`;
            if (this.edits.has(id)) return;
            src = this.addCodexEdit(id, ch.movedFrom, 'update', at, st) || undefined;
          }
          if (src) {
            if (applied) this.finishEdit(src, { kind: 'update', hunks: null }, at);
            else this.failEdit(src, at);
          }
        }
      });
    }
  }

  private pendingCodexEditFor(absPath: string): LedgerEdit | undefined {
    const turn = this.currentTurn();
    if (!turn) return undefined;
    for (const id of turn.editIds) {
      const e = this.edits.get(id);
      if (e && e.pending && e.absPath === absPath) return e;
    }
    return undefined;
  }

  private addCodexEdit(
    id: string,
    file: string,
    kind: 'create' | 'update',
    at: number,
    st: FileState
  ): LedgerEdit | null {
    const turn = this.turnFor(at, st.tail.filePath);
    const absPath = path.resolve(this.projectPath || '/', file);
    const edit: LedgerEdit = {
      id,
      turnId: turn.id,
      tool: 'apply_patch',
      absPath,
      kind,
      at,
      startedAt: at,
      additions: 0,
      deletions: 0,
      hunks: [],
      pending: true,
      ...(this.excludePath?.(absPath) ? { excluded: true } : {}),
    };
    this.edits.set(id, edit);
    turn.editIds.push(id);
    this.pendingChanges.push({ phase: 'started', editId: id });
    this.bump();
    return edit;
  }

  private failEdit(edit: LedgerEdit, at: number): void {
    edit.pending = false;
    edit.at = at || edit.startedAt;
    edit.failed = true;
    this.pendingChanges.push({ phase: 'failed', editId: edit.id });
    this.bump();
  }

  private finishEdit(
    edit: LedgerEdit,
    outcome: { kind: 'create' | 'update'; hunks: RawHunk[] | null },
    at: number
  ): void {
    edit.pending = false;
    edit.at = at || edit.startedAt;
    edit.kind = outcome.kind;
    if (outcome.hunks === null) {
      edit.patchUnavailable = true;
      edit.hunks = [];
    } else {
      const capped = capHunks(outcome.hunks);
      edit.hunks = capped.hunks;
      if (capped.truncated) edit.truncated = true;
      const c = countLines(outcome.hunks);
      edit.additions = c.additions;
      edit.deletions = c.deletions;
    }
    this.pendingChanges.push({ phase: 'completed', editId: edit.id });
    this.bump();
  }

  private completeEdit(
    edit: LedgerEdit,
    block: Record<string, unknown>,
    toolUseResult: unknown,
    at: number
  ): void {
    if (block.is_error === true) {
      this.failEdit(edit, at);
      return;
    }
    this.finishEdit(edit, this.editExtractor.editOutcome(edit.tool, edit.kind, toolUseResult), at);
  }
}

/** Text of a Codex message's content parts (input_text / output_text / text). */
function codexText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const b = c as { type?: unknown; text?: unknown };
    if (
      (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') &&
      typeof b.text === 'string'
    )
      parts.push(b.text);
  }
  return parts.join('\n').trim();
}
