/**
 * Stuck signals: pure functions over a session's parsed transcript.
 *
 *   buildDigest(messages) -> the current turn, compacted (bounded, no raw output)
 *   analyze(digest, now, settings, pane) -> candidate findings
 *
 * Deterministic and cheap: one backwards walk over the newest messages per
 * update, no subprocess, no LLM. The pane reading (only for the time-based
 * signals) comes from the detector's guarded capture.
 */

import type { ConversationMessage, ToolCall } from '../types';
import type { StuckKind, StuckSettings, StuckSeverity } from './protocol';
import {
  analyzeFailure,
  baseName,
  commandCore,
  contentHash,
  FailureKey,
  inputKey,
  isLongCommand,
  isPollingCommand,
  normalizeText,
  outputHash,
  PaneReading,
} from './normalize';
import { clip, fnv1a, oneLine } from '../herald/text';

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** Tools whose repeats are a loop when input + result are identical. */
const LOOP_TOOLS = new Set(['Bash', 'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'NotebookRead']);
/** Never stalled (long by design) / handled by the inbox (waiting on the user). */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const POLL_TOOLS = new Set(['BashOutput', 'TaskOutput', 'Monitor', 'KillShell', 'TodoWrite']);

/** Messages walked back per update (bounded however long the transcript is). */
export const MAX_SCAN_MESSAGES = 3000;
/** Tool events kept per digest. */
export const MAX_EVENTS = 600;
const MIN = 60_000;

export interface StuckToolEvent {
  id: string;
  name: string;
  at: number;
  doneAt: number | null;
  pending: boolean;
  failed: boolean;
  /** The user said no to this call. */
  rejected?: boolean;
  /** Exact identity: tool + collapsed input. */
  inputKey: string;
  outputHash: string;
  /** Command / file / pattern (display, clipped). */
  display: string;
  /** Bash: normalised command core (re-runs with another `| tail` compare equal). */
  cmdKey?: string;
  rawCommand?: string;
  failureKeys: FailureKey[];
  excerpt?: string;
  /** Successful file change. */
  isEdit: boolean;
  file?: string;
  /** Edit / MultiEdit: [oldHash, newHash] per replacement. */
  pairs?: Array<[string, string]>;
  /** Write: content hash. */
  writeHash?: string;
}

export type StuckPhase = 'idle' | 'working' | 'waiting';

export interface StuckDigest {
  phase: StuckPhase;
  turnId: string | null;
  turnStartedAt: number;
  lastTextAt: number;
  lastEditAt: number;
  lastMessageAt: number;
  events: StuckToolEvent[];
  pending: StuckToolEvent[];
}

export interface StuckCandidate {
  kind: StuckKind;
  severity: StuckSeverity;
  signature: string;
  summary: string;
  headline: string;
  evidence: string[];
  firstSeen: number;
  lastSeen: number;
  count: number;
}

function displayFor(tc: ToolCall): string {
  const i = tc.input || {};
  if (tc.name === 'Bash') return clip(oneLine(String(i.command ?? '')), 160);
  if (typeof i.file_path === 'string') return baseName(i.file_path);
  if (typeof i.notebook_path === 'string') return baseName(i.notebook_path);
  if (typeof i.pattern === 'string') return clip(oneLine(i.pattern), 120);
  if (typeof i.url === 'string') return clip(i.url, 120);
  if (typeof i.path === 'string') return baseName(i.path);
  return tc.name;
}

function toEvent(tc: ToolCall, msgAt: number): StuckToolEvent {
  const pending = tc.status === 'pending' || tc.status === 'running';
  const at = tc.startedAt || msgAt;
  const input = tc.input || {};
  const ev: StuckToolEvent = {
    id: tc.id,
    name: tc.name,
    at,
    doneAt: pending ? null : tc.completedAt || at,
    pending,
    failed: false,
    inputKey: inputKey(tc.name, input),
    outputHash: pending ? '' : outputHash(tc.output),
    display: displayFor(tc),
    failureKeys: [],
    isEdit: false,
  };
  const file = input.file_path ?? input.notebook_path;
  if (typeof file === 'string' && file) ev.file = file;
  if (tc.name === 'Bash') {
    ev.rawCommand = clip(oneLine(String(input.command ?? '')), 300);
    ev.cmdKey = normalizeText(commandCore(String(input.command ?? '')));
  }
  if (!pending) {
    const f = analyzeFailure(tc.name, input, tc.output, tc.isError === true);
    ev.failed = f.failed && !f.rejected;
    if (f.rejected) ev.rejected = true;
    ev.failureKeys = ev.failed ? f.keys : [];
    if (ev.failed && f.excerpt) ev.excerpt = f.excerpt;
    if (EDIT_TOOLS.has(tc.name) && !ev.failed && !f.rejected) {
      ev.isEdit = true;
      if (tc.name === 'Edit') {
        ev.pairs = [
          [
            contentHash(String(input.old_string ?? '')),
            contentHash(String(input.new_string ?? '')),
          ],
        ];
      } else if (tc.name === 'MultiEdit' && Array.isArray(input.edits)) {
        ev.pairs = (input.edits as Array<Record<string, unknown>>)
          .slice(0, 20)
          .map(
            (e) =>
              [
                contentHash(String(e?.old_string ?? '')),
                contentHash(String(e?.new_string ?? '')),
              ] as [string, string]
          );
      } else if (tc.name === 'Write') {
        ev.writeHash = contentHash(String(input.content ?? ''));
      }
    }
  }
  return ev;
}

/** A user entry that starts a turn (a prompt, slash command or background-task notice). */
function isTurnOpener(m: ConversationMessage): boolean {
  if (m.type !== 'user') return false;
  const t = (m.content || '').trim();
  if (!t) return false;
  if (/^<local-command-|^<command-message>|^\[Request interrupted/.test(t)) return false;
  return true;
}

function phaseOf(messages: ConversationMessage[]): StuckPhase {
  const last = messages[messages.length - 1];
  if (!last) return 'idle';
  if (last.type === 'user') {
    if (/^\[Request interrupted/.test((last.content || '').trim())) return 'idle';
    return 'working';
  }
  if (last.type === 'system') return 'working';
  const pending = (last.toolCalls || []).filter(
    (t) => t.status === 'pending' || t.status === 'running'
  );
  if (pending.some((t) => WAITING_TOOLS.has(t.name))) return 'waiting';
  if (last.isWaitingForChoice && !pending.length) return 'waiting';
  return pending.length ? 'working' : 'idle';
}

/**
 * The current turn, compacted. `horizonMs`: how far back tool events are kept
 * (the longest signal window); the turn opener is searched further back so a
 * new prompt is always seen.
 */
export function buildDigest(
  messages: ConversationMessage[],
  now: number,
  horizonMs: number,
  cache?: (id: string, make: () => StuckToolEvent) => StuckToolEvent
): StuckDigest {
  const phase = phaseOf(messages);
  const lastMessageAt = messages.length ? messages[messages.length - 1].timestamp || 0 : 0;
  const digest: StuckDigest = {
    phase,
    turnId: null,
    turnStartedAt: 0,
    lastTextAt: 0,
    lastEditAt: 0,
    lastMessageAt,
    events: [],
    pending: [],
  };
  if (phase === 'idle') return digest;
  const stop = Math.max(0, messages.length - MAX_SCAN_MESSAGES);
  const horizon = now - horizonMs;
  const events: StuckToolEvent[] = [];
  let i = messages.length - 1;
  for (; i >= stop; i--) {
    const m = messages[i];
    if (isTurnOpener(m)) {
      digest.turnId = m.id;
      digest.turnStartedAt = m.timestamp || 0;
      break;
    }
    if (m.type !== 'assistant') continue;
    if (!digest.lastTextAt && (m.content || '').trim() && !m.isWaitingForChoice)
      digest.lastTextAt = m.timestamp || 0;
    if (!m.toolCalls) continue;
    for (let j = m.toolCalls.length - 1; j >= 0; j--) {
      const tc = m.toolCalls[j];
      const at = tc.startedAt || m.timestamp || 0;
      const pending = tc.status === 'pending' || tc.status === 'running';
      if (!pending && at < horizon && digest.lastEditAt) continue;
      const make = () => toEvent(tc, m.timestamp || 0);
      const ev = cache && !pending && tc.id ? cache(tc.id, make) : make();
      if (ev.isEdit && !digest.lastEditAt) digest.lastEditAt = ev.doneAt || ev.at;
      if (pending && i === messages.length - 1) digest.pending.push(ev);
      if (at >= horizon && events.length < MAX_EVENTS) events.push(ev);
    }
  }
  if (!digest.turnId && i < stop) {
    // No opener in reach: the oldest scanned message bounds the turn.
    digest.turnStartedAt = messages[Math.max(stop, 0)]?.timestamp || 0;
  }
  digest.events = events.reverse();
  digest.pending.reverse();
  return digest;
}

function mins(ms: number): number {
  return Math.max(1, Math.round(ms / MIN));
}

// ---------------------------------------------------------------- 1. repeated failure

function repeatedFailure(d: StuckDigest, now: number, s: StuckSettings): StuckCandidate | null {
  const since = now - s.failureWindowMin * MIN;
  const byKey = new Map<string, { key: FailureKey; evs: StuckToolEvent[] }>();
  for (const ev of d.events) {
    if (!ev.failed || ev.at < since) continue;
    for (const k of ev.failureKeys) {
      const e = byKey.get(k.key) || { key: k, evs: [] };
      if (!e.evs.includes(ev)) e.evs.push(ev);
      byKey.set(k.key, e);
    }
  }
  let best: { key: FailureKey; evs: StuckToolEvent[] } | null = null;
  const typeRank: Record<string, number> = { test: 0, error: 1, tool: 2, command: 3 };
  for (const e of byKey.values()) {
    const n = e.evs.length;
    if (n < s.failureRepeats) continue;
    const first = e.evs[0];
    const last = e.evs[n - 1];
    // A burst is not a pattern: the repeats must span real time.
    if ((last.doneAt || last.at) - first.at < 2 * MIN) continue;
    // Resolved: a later run of one of the same commands no longer shows it.
    const cmds = new Set(e.evs.map((x) => x.cmdKey).filter((c): c is string => !!c));
    const tools = new Set(e.evs.map((x) => `${x.name}|${x.file ?? ''}|${x.cmdKey ?? ''}`));
    const lastAt = last.at;
    let resolved = false;
    for (const ev of d.events) {
      if (ev.at <= lastAt || ev.pending) continue;
      const same = ev.cmdKey
        ? cmds.has(ev.cmdKey)
        : tools.has(`${ev.name}|${ev.file ?? ''}|${ev.cmdKey ?? ''}`);
      if (same && !ev.failureKeys.some((k) => k.key === e.key.key)) {
        resolved = true;
        break;
      }
    }
    if (resolved) continue;
    // Stopped recurring: nothing for half the window (at most 15 min).
    if (now - (last.doneAt || last.at) > Math.min(15, s.failureWindowMin / 2) * MIN) continue;
    if (
      !best ||
      n > best.evs.length ||
      (n === best.evs.length &&
        (typeRank[e.key.type] - typeRank[best.key.type] ||
          e.key.rank - best.key.rank ||
          (e.key.key < best.key.key ? -1 : 1)) < 0)
    )
      best = e;
  }
  if (!best) return null;
  const n = best.evs.length;
  const first = best.evs[0];
  const last = best.evs[n - 1];
  const span = mins((last.doneAt || last.at) - first.at);
  const label = best.key.label;
  const what =
    best.key.type === 'test'
      ? { lead: 'Same test failing', head: 'same test failing' }
      : best.key.type === 'error'
        ? { lead: 'Same error', head: 'same error' }
        : best.key.type === 'tool'
          ? { lead: `${last.name} failing the same way`, head: `${last.name} failing the same way` }
          : { lead: 'Same command failing', head: 'same command failing' };
  const evidence: string[] = [];
  if (last.rawCommand) evidence.push(`$ ${clip(last.rawCommand, 180)}`);
  if (last.excerpt) evidence.push(...last.excerpt.split('\n'));
  return {
    kind: 'repeated_failure',
    severity: n >= s.failureRepeats * 2 ? 'high' : 'medium',
    signature: fnv1a(best.key.key),
    summary: `${what.lead} ${n} times in ${span} min: ${clip(label, 90)}`,
    headline: `${what.head} ${n} times`,
    evidence,
    firstSeen: first.at,
    lastSeen: last.doneAt || last.at,
    count: n,
  };
}

// ---------------------------------------------------------------- 2. loop

function loop(d: StuckDigest, now: number, s: StuckSettings): StuckCandidate | null {
  const since = now - s.loopWindowMin * MIN;
  // Only what happened since the last change: an edit in between is progress.
  let groups = new Map<string, StuckToolEvent[]>();
  for (const ev of d.events) {
    if (ev.pending) continue;
    if (ev.isEdit) {
      groups = new Map();
      continue;
    }
    if (
      ev.at < since ||
      ev.failed ||
      ev.rejected ||
      !LOOP_TOOLS.has(ev.name) ||
      POLL_TOOLS.has(ev.name)
    )
      continue;
    if (ev.name === 'Bash' && isPollingCommand(ev.rawCommand || '')) continue;
    const k = `${ev.inputKey}#${ev.outputHash}`;
    const g = groups.get(k) || [];
    g.push(ev);
    groups.set(k, g);
  }
  let g: StuckToolEvent[] | null = null;
  for (const x of groups.values())
    if (x.length >= s.loopRepeats && (!g || x.length > g.length)) g = x;
  if (!g) return null;
  const first = g[0];
  const last = g[g.length - 1];
  // Stale: the loop ended a while ago.
  if (now - (last.doneAt || last.at) > Math.min(10, s.loopWindowMin) * MIN) return null;
  const n = g.length;
  const span = mins((last.doneAt || last.at) - first.at);
  const read = last.name === 'Read';
  const lead = read
    ? `Read the same file ${n} times in ${span} min with no edits`
    : last.name === 'Bash'
      ? `Ran the same command ${n} times in ${span} min with the same result`
      : `${last.name} with the same input ${n} times in ${span} min, same result`;
  return {
    kind: 'loop',
    severity: 'medium',
    signature: fnv1a(`${last.inputKey}#${last.outputHash}`),
    summary: `${lead}: ${clip(last.display, 90)}`,
    headline: read
      ? `re-reading ${clip(last.display, 40)} over and over`
      : `repeating the same ${last.name === 'Bash' ? 'command' : last.name} ${n} times`,
    evidence: [
      last.name === 'Bash'
        ? `$ ${clip(last.rawCommand || last.display, 180)}`
        : `${last.name} ${clip(last.display, 180)}`,
    ],
    firstSeen: first.at,
    lastSeen: last.doneAt || last.at,
    count: n,
  };
}

// ---------------------------------------------------------------- 3. oscillation

function oscillation(d: StuckDigest, now: number, s: StuckSettings): StuckCandidate | null {
  const since = now - s.oscillationWindowMin * MIN;
  interface Pair {
    file: string;
    a: string;
    b: string;
    moves: Array<{ dir: 1 | -1; at: number }>;
  }
  const pairs = new Map<string, Pair>();
  const lastWrite = new Map<string, string>();
  const note = (file: string, from: string, to: string, at: number) => {
    if (from === to) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    const k = `${file}|${a}|${b}`;
    const p = pairs.get(k) || { file, a, b, moves: [] };
    p.moves.push({ dir: from === a ? 1 : -1, at });
    pairs.set(k, p);
  };
  const edits = d.events.filter((e) => e.isEdit && e.at >= since && e.file);
  for (const e of edits) {
    const at = e.doneAt || e.at;
    if (e.pairs) for (const [o, n] of e.pairs) note(e.file!, o, n, at);
    if (e.writeHash) {
      const prev = lastWrite.get(e.file!);
      if (prev) note(e.file!, prev, e.writeHash, at);
      lastWrite.set(e.file!, e.writeHash);
    }
  }
  let best: Pair | null = null;
  for (const p of pairs.values()) {
    if (p.moves.length < s.oscillationFlips) continue;
    if (!p.moves.some((m) => m.dir === 1) || !p.moves.some((m) => m.dir === -1)) continue;
    // Converged: a later edit of that file moved on to a third state.
    const lastAt = p.moves[p.moves.length - 1].at;
    const movedOn = edits.some((e) => {
      if ((e.doneAt || e.at) <= lastAt || e.file !== p.file) return false;
      if (e.writeHash) return e.writeHash !== p.a && e.writeHash !== p.b;
      return (e.pairs || []).some(([o, n]) => (o === p.a || o === p.b) && n !== p.a && n !== p.b);
    });
    if (movedOn) continue;
    if (!best || p.moves.length > best.moves.length) best = p;
  }
  const b = best;
  if (!b) return null;
  const n = b.moves.length;
  const first = b.moves[0].at;
  const last = b.moves[n - 1].at;
  if (now - last > Math.min(15, s.oscillationWindowMin) * MIN) return null;
  const name = baseName(b.file);
  return {
    kind: 'oscillation',
    severity: n >= s.oscillationFlips * 2 ? 'high' : 'medium',
    signature: fnv1a(`${b.file}|${b.a}|${b.b}`),
    summary: `Flip-flopping the same change in ${name}: ${n} edits back and forth in ${mins(last - first)} min`,
    headline: `undoing and redoing the same edit in ${name}`,
    evidence: [`${name}: changed and changed back ${n} times`],
    firstSeen: first,
    lastSeen: last,
    count: n,
  };
}

// ---------------------------------------------------------------- 4/5. time-based

/** The pane state the detector tracks for one session (guarded captures only). */
export interface PaneTrack {
  reading: PaneReading;
  /** When the current (normalised) screen was first seen. */
  stableSince: number;
  /** Captures with this same screen. */
  stableChecks: number;
  checkedAt: number;
  /** The tool call that was pending when it was read. */
  pendingId: string | null;
}

function stallCapMin(ev: StuckToolEvent, s: StuckSettings): number | null {
  if (SUBAGENT_TOOLS.has(ev.name) || POLL_TOOLS.has(ev.name) || WAITING_TOOLS.has(ev.name))
    return null;
  if (ev.name.startsWith('mcp__')) return s.longCommandCapMin;
  if (ev.name === 'Bash')
    return isLongCommand(ev.rawCommand || '')
      ? Math.max(s.stalledBashMin, s.longCommandCapMin)
      : s.stalledBashMin;
  return s.stalledToolMin;
}

/** Whether a fresh pane reading would change the verdict for this digest now. */
export function wantsPane(d: StuckDigest, now: number, s: StuckSettings): boolean {
  if (d.phase !== 'working') return false;
  const progressAt = Math.max(d.turnStartedAt, d.lastTextAt, d.lastEditAt);
  if (progressAt && now - progressAt >= s.noProgressMin * MIN) return true;
  for (const p of d.pending) {
    const cap = stallCapMin(p, s);
    if (cap !== null && now - p.at >= cap * MIN) return true;
  }
  return false;
}

function stalledTool(
  d: StuckDigest,
  now: number,
  s: StuckSettings,
  pane: PaneTrack | null
): StuckCandidate | null {
  if (!pane || !pane.reading.alive || pane.reading.prompt) return null;
  for (const p of d.pending) {
    const cap = stallCapMin(p, s);
    if (cap === null || now - p.at < cap * MIN) continue;
    if (pane.pendingId !== p.id) continue;
    // Unchanged across at least two captures, four minutes apart.
    if (pane.stableChecks < 2 || now - pane.stableSince < 4 * MIN) continue;
    const running = mins(now - p.at);
    const what =
      p.name === 'Bash'
        ? `: ${clip(p.rawCommand || p.display, 90)}`
        : p.display !== p.name
          ? `: ${clip(p.display, 90)}`
          : '';
    return {
      kind: 'stalled_tool',
      severity: 'high',
      signature: fnv1a(`stall|${p.id}`),
      summary: `${p.name} has been running ${running} min with no screen change${what}`,
      headline: `${p.name} stuck for ${running} min`,
      evidence: [
        p.name === 'Bash'
          ? `$ ${clip(p.rawCommand || p.display, 180)}`
          : `${p.name} ${clip(p.display, 180)}`,
        `Screen unchanged for ${mins(now - pane.stableSince)} min`,
      ],
      firstSeen: p.at,
      lastSeen: now,
      count: running,
    };
  }
  return null;
}

function noProgress(
  d: StuckDigest,
  now: number,
  s: StuckSettings,
  pane: PaneTrack | null
): StuckCandidate | null {
  const progressAt = Math.max(d.turnStartedAt, d.lastTextAt, d.lastEditAt);
  if (!progressAt) return null;
  const idle = now - progressAt;
  if (idle < s.noProgressMin * MIN) return null;
  // Claude must visibly be alive and not waiting on a prompt.
  if (!pane || !pane.reading.alive || pane.reading.prompt) return null;
  const cap = s.longCommandCapMin * MIN;
  for (const p of d.pending) {
    if (SUBAGENT_TOOLS.has(p.name) || p.name.startsWith('mcp__')) {
      if (idle < cap) return null;
    } else if (p.name === 'Bash') {
      if (isLongCommand(p.rawCommand || '') && idle < cap) return null;
      // A command still printing output is busy, not stuck.
      if (pane.pendingId === p.id && now - pane.stableSince < 5 * MIN) return null;
      if (pane.pendingId !== p.id) return null;
    }
  }
  const m = mins(idle);
  const lastTool = d.pending[d.pending.length - 1] || d.events[d.events.length - 1];
  const evidence = [`Last edit or reply ${m} min ago`];
  if (lastTool)
    evidence.push(
      `${d.pending.length ? 'Running' : 'Last tool'}: ${lastTool.name} ${clip(lastTool.display, 140)}`
    );
  return {
    kind: 'no_progress',
    severity: 'medium',
    signature: fnv1a(`np|${d.turnId ?? d.turnStartedAt}`),
    summary: `No edits or new text for ${m} min`,
    headline: `no progress for ${m} min`,
    evidence,
    firstSeen: progressAt,
    lastSeen: now,
    count: m,
  };
}

/** Every signal for one session, most useful first. Only while WORKING. */
export function analyze(
  d: StuckDigest,
  now: number,
  s: StuckSettings,
  pane: PaneTrack | null
): StuckCandidate[] {
  if (d.phase !== 'working') return [];
  if (pane?.reading.prompt && now - pane.checkedAt < 2 * MIN) return [];
  const out: StuckCandidate[] = [];
  const stalled = stalledTool(d, now, s, pane);
  if (stalled) out.push(stalled);
  const rf = repeatedFailure(d, now, s);
  if (rf) out.push(rf);
  const osc = oscillation(d, now, s);
  if (osc) out.push(osc);
  const lp = loop(d, now, s);
  if (lp) out.push(lp);
  // No progress says less than any specific signal: only on its own.
  if (!out.length) {
    const np = noProgress(d, now, s, pane);
    if (np) out.push(np);
  }
  return out;
}
