/**
 * StuckDetector: "Out4 looks stuck". Watches every session's parsed transcript
 * (watcher conversation-update / status-change, debounced per session) plus a
 * 60 s tick for the time-based signals, and keeps a small, bounded set of
 * findings that clear themselves when progress resumes.
 *
 * Deterministic, no LLM. The only subprocess is a tmux pane capture for the
 * time-based signals, and only through a guarded probe: per-session in-flight
 * dedupe, a hard timeout (the capture itself SIGKILLs at 2.5 s, plus our own
 * race), a liveness check against the watcher's live session list (no
 * subprocess), at most N captures per tick and a minimum interval per session
 * (fork-bomb history: 3058a0a).
 */

import type { ConversationMessage, TmuxSession } from '../types';
import type { AuditEntry } from '../audit-log';
import {
  STUCK_LIMITS,
  StuckAskResponse,
  StuckFinding,
  StuckInterruptResponse,
  StuckKind,
  StuckSettings,
} from './protocol';
import {
  analyze,
  buildDigest,
  PaneTrack,
  StuckCandidate,
  StuckDigest,
  StuckToolEvent,
  wantsPane,
} from './signals';
import { readPane } from './normalize';
import { inQuietHours, StuckSettingsStore } from './store';
import { redactSecrets } from '../herald/knowledge/redact';
import { clip, fnv1a, oneLine } from '../herald/text';

export interface StuckWatcherLike {
  on(
    ev: string,
    fn: (data: { sessionId?: string; messages?: ConversationMessage[] }) => void
  ): unknown;
  getSessions(): TmuxSession[];
  getMessages(sessionId: string): ConversationMessage[];
}

/** One inbox item per stuck session (Herald). */
export interface StuckAlert {
  sessionId: string;
  sessionName: string;
  /** Stable per session + turn: the item updates in place, tones once per turn. */
  key: string;
  /** "Out4 looks stuck: same test failing 6 times" */
  headline: string;
  summary: string;
  kind: StuckKind;
  kinds: StuckKind[];
  findingId: string;
  count: number;
}

/** What the detector needs from Herald (late-bound: Herald is built first). */
export interface StuckHeraldLink {
  readonly featureEnabled: boolean;
  syncStuckAlerts(alerts: StuckAlert[]): void;
  relayAsk(r: {
    sessionId: string;
    sessionName: string;
    prompt: string;
    userText: string;
    clientId?: string;
  }): Promise<{ askId: string }>;
  proposeInterrupt(r: { sessionId: string; sessionName: string; clientId?: string }): {
    actionId: string;
    autoSendAt: number | null;
  };
}

export interface StuckDetectorDeps {
  watcher: StuckWatcherLike;
  sessionName?: (sessionId: string) => string;
  /** GLOBAL broadcast (every subscribed client), never session-scoped. */
  broadcast?: (type: string, payload: unknown) => void;
  /** Capture a session's pane (rejects on failure). Absent = time-based signals off. */
  capturePane?: (sessionId: string) => Promise<string>;
  settings?: StuckSettingsStore;
  /** Escalation quiet hours: findings stay off the Herald inbox (no tone) while they last. */
  quietHours?: () => { enabled: boolean; start: string; end: string } | null;
  /** Type text straight into a session (ask without Herald). */
  sendDirect?: (sessionId: string, text: string) => Promise<boolean>;
  audit?: (entry: AuditEntry) => void;
  now?: () => number;
  debounceMs?: number;
  /** Time-based evaluation tick (default 60 s; 0 = no timer, tests call tick()). */
  tickMs?: number;
  maxCapturesPerTick?: number;
  /** Minimum time between two captures of one session. */
  captureIntervalMs?: number;
  /** Our own cap on one capture (the default capture also SIGKILLs at 2.5 s). */
  captureTimeoutMs?: number;
}

export class StuckError extends Error {
  constructor(
    readonly code:
      | 'unknown_session'
      | 'bad_request'
      | 'unavailable'
      | 'not_found'
      | 'herald_unavailable'
      | 'session_waiting',
    message: string
  ) {
    super(message);
    this.name = 'StuckError';
  }
}

export const MAX_SESSIONS = 64;
const MAX_FINDINGS_PER_SESSION = 5;
const MAX_SNOOZES = 500;
const MAX_DISMISSED_SESSIONS = 200;
const MAX_DISMISSED_IDS = 50;
const MAX_EVENT_CACHE = 4000;
const KIND_RANK: Record<StuckKind, number> = {
  stalled_tool: 0,
  repeated_failure: 1,
  oscillation: 2,
  loop: 3,
  no_progress: 4,
};

/** Map with insertion-order LRU eviction (touch = delete + set). */
function lruSet<K, V>(m: Map<K, V>, k: K, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest as K);
  }
}

function redactLine(s: string, max: number): string {
  return clip(redactSecrets(oneLine(s)), max);
}

export class StuckDetector {
  private deps: StuckDetectorDeps;
  private now: () => number;
  private settingsStore: StuckSettingsStore;
  private digests = new Map<string, StuckDigest>();
  private findings = new Map<string, Map<string, StuckFinding>>();
  private panes = new Map<string, PaneTrack>();
  private capturing = new Set<string>();
  private snoozes = new Map<string, number>();
  private dismissed = new Map<string, { turnId: string | null; ids: Set<string> }>();
  private eventCache = new Map<string, StuckToolEvent>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private tickTimer: NodeJS.Timeout | null = null;
  private herald: StuckHeraldLink | null = null;
  private lastBroadcastKey = '';
  private lastHeraldKey = '';
  private disposed = false;
  /** Captures started over the detector's life (tests / diagnostics). */
  capturesStarted = 0;

  constructor(deps: StuckDetectorDeps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.settingsStore = deps.settings || new StuckSettingsStore();
    const tickMs = deps.tickMs ?? 60_000;
    if (tickMs > 0) {
      this.tickTimer = setInterval(() => this.tick(), tickMs);
      this.tickTimer.unref?.();
    }
  }

  // ------------------------------------------------------------------ wiring

  attach(emitter: StuckWatcherLike): void {
    emitter.on(
      'conversation-update',
      (d) => d?.sessionId && this.onActivity(d.sessionId, d.messages)
    );
    emitter.on('status-change', (d) => d?.sessionId && this.onActivity(d.sessionId));
  }

  setHerald(h: StuckHeraldLink | null): void {
    this.herald = h;
    this.lastHeraldKey = '';
    this.publish();
  }

  /** Watcher activity: rebuild the session's digest (debounced). */
  onActivity(sessionId: string, messages?: ConversationMessage[]): void {
    if (this.disposed) return;
    const t = this.debounceTimers.get(sessionId);
    if (t) clearTimeout(t);
    if (this.debounceTimers.size >= MAX_SESSIONS * 2 && !t) return;
    const timer = setTimeout(() => {
      this.debounceTimers.delete(sessionId);
      try {
        this.refresh(sessionId, messages);
      } catch (err) {
        console.error(
          `Stuck: refresh of ${sessionId} failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }, this.deps.debounceMs ?? 1000);
    timer.unref?.();
    this.debounceTimers.set(sessionId, timer);
  }

  /** Re-read a session now (tests call this directly). */
  refresh(sessionId: string, messages?: ConversationMessage[]): void {
    if (this.disposed) return;
    const settings = this.settingsStore.get();
    const session = this.liveSession(sessionId);
    if (!settings.enabled || !session) {
      this.forget(sessionId);
      this.publish();
      return;
    }
    const msgs = messages ?? this.deps.watcher.getMessages(sessionId);
    const now = this.now();
    const horizon =
      Math.max(settings.failureWindowMin, settings.loopWindowMin, settings.oscillationWindowMin) *
      60_000;
    const digest = buildDigest(msgs, now, horizon, this.cachedEvent);
    lruSet(this.digests, sessionId, digest, MAX_SESSIONS);
    this.evaluate(sessionId);
    this.publish();
  }

  private cachedEvent = (id: string, make: () => StuckToolEvent): StuckToolEvent => {
    const hit = this.eventCache.get(id);
    if (hit) return hit;
    const ev = make();
    if (!ev.pending) lruSet(this.eventCache, id, ev, MAX_EVENT_CACHE);
    return ev;
  };

  private liveSession(sessionId: string): TmuxSession | null {
    const s = this.deps.watcher.getSessions().find((x) => x.id === sessionId);
    return s && !s.inactive ? s : null;
  }

  private forget(sessionId: string): void {
    this.digests.delete(sessionId);
    this.findings.delete(sessionId);
    this.panes.delete(sessionId);
  }

  private name(sessionId: string): string {
    return this.deps.sessionName?.(sessionId) || sessionId;
  }

  // ------------------------------------------------------------------ evaluation

  private evaluate(sessionId: string): void {
    const d = this.digests.get(sessionId);
    if (!d) return;
    const now = this.now();
    const settings = this.settingsStore.get();
    const pane = this.panes.get(sessionId) || null;
    const cands = analyze(d, now, settings, pane);
    const prev = this.findings.get(sessionId);
    const next = new Map<string, StuckFinding>();
    const name = this.name(sessionId);
    for (const c of cands.slice(0, MAX_FINDINGS_PER_SESSION)) {
      const id = `${sessionId}|${c.kind}|${c.signature}`;
      const old = prev?.get(id);
      next.set(id, this.toFinding(id, sessionId, name, c, d, old));
    }
    // The turn moved on: "not stuck" feedback for the old turn is done.
    const dis = this.dismissed.get(sessionId);
    if (dis && dis.turnId !== d.turnId) this.dismissed.delete(sessionId);
    if (next.size) lruSet(this.findings, sessionId, next, MAX_SESSIONS);
    else this.findings.delete(sessionId);
  }

  private toFinding(
    id: string,
    sessionId: string,
    name: string,
    c: StuckCandidate,
    d: StuckDigest,
    old: StuckFinding | undefined
  ): StuckFinding {
    return {
      id,
      sessionId,
      sessionName: name,
      kind: c.kind,
      severity: c.severity,
      signature: c.signature,
      summary: redactLine(c.summary, 240),
      headline: redactLine(c.headline, 120),
      evidence: c.evidence
        .filter((e) => e && e.trim())
        .slice(0, STUCK_LIMITS.maxEvidence)
        .map((e) => redactLine(e, STUCK_LIMITS.maxEvidenceChars)),
      firstSeen: old ? Math.min(old.firstSeen, c.firstSeen) : c.firstSeen,
      lastSeen: c.lastSeen,
      count: c.count,
      turnId: d.turnId,
    };
  }

  /** Time-based signals: evaluate working sessions, capture panes where it matters. */
  tick(): void {
    if (this.disposed) return;
    const settings = this.settingsStore.get();
    if (!settings.enabled) {
      if (this.digests.size || this.findings.size) {
        this.digests.clear();
        this.findings.clear();
        this.panes.clear();
      }
      this.publish();
      return;
    }
    const now = this.now();
    const live = new Set(
      this.deps.watcher
        .getSessions()
        .filter((s) => !s.inactive)
        .map((s) => s.id)
    );
    for (const id of Array.from(this.digests.keys())) if (!live.has(id)) this.forget(id);
    for (const id of Array.from(this.findings.keys())) if (!live.has(id)) this.findings.delete(id);
    for (const id of Array.from(this.panes.keys()))
      if (!this.digests.has(id)) this.panes.delete(id);

    const wanted: Array<{ id: string; pendingId: string | null; age: number }> = [];
    const interval = this.deps.captureIntervalMs ?? 120_000;
    for (const [id, d] of this.digests) {
      if (d.phase === 'working' && this.deps.capturePane && wantsPane(d, now, settings)) {
        const pendingId = d.pending.length ? d.pending[d.pending.length - 1].id : null;
        const pane = this.panes.get(id);
        if (!pane || pane.pendingId !== pendingId || now - pane.checkedAt >= interval)
          wanted.push({ id, pendingId, age: pane ? now - pane.checkedAt : Infinity });
      }
      this.evaluate(id);
    }
    // Oldest reading first; never more than the cap in flight.
    wanted.sort((a, b) => b.age - a.age);
    const cap = this.deps.maxCapturesPerTick ?? 2;
    for (const w of wanted) {
      if (this.capturing.size >= cap) break;
      void this.capture(w.id, w.pendingId);
    }
    this.publish();
  }

  /** One guarded pane capture. */
  async capture(sessionId: string, pendingId: string | null): Promise<void> {
    const fn = this.deps.capturePane;
    if (!fn || this.disposed) return;
    if (this.capturing.has(sessionId)) return; // in-flight dedupe
    if (this.capturing.size >= (this.deps.maxCapturesPerTick ?? 2)) return;
    if (!this.liveSession(sessionId)) return; // liveness: no subprocess for a gone session
    this.capturing.add(sessionId);
    this.capturesStarted++;
    let timer: NodeJS.Timeout | null = null;
    try {
      const text = await Promise.race([
        fn(sessionId),
        new Promise<string>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('capture timeout')),
            this.deps.captureTimeoutMs ?? 4000
          );
          timer.unref?.();
        }),
      ]);
      if (this.disposed) return;
      const now = this.now();
      const reading = readPane(text);
      const prev = this.panes.get(sessionId);
      if (prev && prev.reading.hash === reading.hash && prev.pendingId === pendingId) {
        prev.reading = reading;
        prev.stableChecks++;
        prev.checkedAt = now;
      } else {
        lruSet(
          this.panes,
          sessionId,
          { reading, stableSince: now, stableChecks: 1, checkedAt: now, pendingId },
          MAX_SESSIONS
        );
      }
      this.evaluate(sessionId);
      this.publish();
    } catch {
      // Unreadable pane: the time-based signals simply stay quiet.
    } finally {
      if (timer) clearTimeout(timer);
      this.capturing.delete(sessionId);
    }
  }

  // ------------------------------------------------------------------ visibility

  private isSnoozed(f: { sessionId: string; kind: StuckKind }, now: number): boolean {
    for (const k of [`${f.sessionId}|${f.kind}`, `${f.sessionId}|*`]) {
      const until = this.snoozes.get(k);
      if (until !== undefined) {
        if (until > now) return true;
        this.snoozes.delete(k);
      }
    }
    return false;
  }

  private isDismissed(f: StuckFinding): boolean {
    const d = this.dismissed.get(f.sessionId);
    return !!d && d.turnId === f.turnId && d.ids.has(f.id);
  }

  /** Visible findings (not snoozed, not dismissed), most urgent first. */
  list(sessionId?: string): StuckFinding[] {
    if (!this.settingsStore.get().enabled) return [];
    const now = this.now();
    const out: StuckFinding[] = [];
    for (const [sid, m] of this.findings) {
      if (sessionId && sid !== sessionId) continue;
      for (const f of m.values()) {
        if (this.isSnoozed(f, now) || this.isDismissed(f)) continue;
        out.push({ ...f, evidence: [...f.evidence], sessionName: this.name(sid) });
      }
    }
    out.sort(
      (a, b) =>
        Number(b.severity === 'high') - Number(a.severity === 'high') ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        b.lastSeen - a.lastSeen
    );
    return out.slice(0, STUCK_LIMITS.maxFindings);
  }

  /** Broadcast + Herald sync, each only on change. */
  publish(): void {
    if (this.disposed) return;
    const findings = this.list();
    const key = JSON.stringify(findings);
    if (key !== this.lastBroadcastKey) {
      this.lastBroadcastKey = key;
      try {
        this.deps.broadcast?.('stuck_update', { findings });
      } catch (err) {
        console.error('Stuck: broadcast failed:', err);
      }
    }
    if (!this.herald) return;
    const quiet = inQuietHours(this.deps.quietHours?.() ?? null, new Date(this.now()));
    const alerts = quiet ? [] : this.alerts(findings);
    const hk = JSON.stringify(alerts);
    if (hk === this.lastHeraldKey) return;
    this.lastHeraldKey = hk;
    try {
      this.herald.syncStuckAlerts(alerts);
    } catch (err) {
      console.error('Stuck: Herald sync failed:', err);
    }
  }

  /** One alert per session: its most telling finding. */
  alerts(findings: StuckFinding[] = this.list()): StuckAlert[] {
    const bySession = new Map<string, StuckFinding[]>();
    for (const f of findings) {
      const l = bySession.get(f.sessionId) || [];
      l.push(f);
      bySession.set(f.sessionId, l);
    }
    const out: StuckAlert[] = [];
    for (const [sid, list] of bySession) {
      const top = list[0];
      out.push({
        sessionId: sid,
        sessionName: top.sessionName,
        key: `${sid}|${top.turnId ?? ''}`,
        headline: `${top.sessionName} looks stuck: ${top.headline}`,
        summary: top.summary,
        kind: top.kind,
        kinds: Array.from(new Set(list.map((f) => f.kind))),
        findingId: top.id,
        count: top.count,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ actions

  /** Quiet a session (one kind or all) for `minutes`; 0 lifts it. Returns the end time. */
  snooze(
    sessionId: string,
    kind: StuckKind | undefined,
    minutes: number = STUCK_LIMITS.defaultSnoozeMin
  ): number {
    if (!sessionId) throw new StuckError('bad_request', 'sessionId is required');
    const key = `${sessionId}|${kind ?? '*'}`;
    let until = 0;
    if (minutes <= 0) {
      this.snoozes.delete(key);
      if (!kind)
        for (const k of Array.from(this.snoozes.keys()))
          if (k.startsWith(`${sessionId}|`)) this.snoozes.delete(k);
    } else {
      const m = Math.min(
        STUCK_LIMITS.maxSnoozeMin,
        Math.max(STUCK_LIMITS.minSnoozeMin, Math.round(minutes))
      );
      until = this.now() + m * 60_000;
      lruSet(this.snoozes, key, until, MAX_SNOOZES);
    }
    this.publish();
    return until;
  }

  /** "Not stuck": that finding's signature is quiet for the rest of the turn. */
  dismiss(findingId: string): StuckFinding {
    const f = this.findById(findingId);
    if (!f) throw new StuckError('not_found', 'That finding is gone');
    let d = this.dismissed.get(f.sessionId);
    if (!d || d.turnId !== f.turnId) d = { turnId: f.turnId, ids: new Set() };
    d.ids.add(f.id);
    while (d.ids.size > MAX_DISMISSED_IDS) d.ids.delete(d.ids.values().next().value as string);
    lruSet(this.dismissed, f.sessionId, d, MAX_DISMISSED_SESSIONS);
    this.publish();
    return f;
  }

  private findById(findingId: string): StuckFinding | null {
    const sid = String(findingId || '').split('|')[0];
    const f = this.findings.get(sid)?.get(findingId);
    return f ? { ...f, sessionName: this.name(sid) } : null;
  }

  /** The question "Ask what's wrong" types into the session. */
  askText(f: StuckFinding): string {
    return `Quick check-in from the user: you look stuck (${f.summary}). In two or three sentences: what is blocking you, and what will you try next? If you are going in circles, stop and say so.`;
  }

  async ask(findingId: string, clientId?: string): Promise<StuckAskResponse> {
    const f = this.findById(findingId);
    if (!f) throw new StuckError('not_found', 'That finding is gone');
    const text = this.askText(f);
    const h = this.herald;
    if (h && h.featureEnabled) {
      try {
        const r = await h.relayAsk({
          sessionId: f.sessionId,
          sessionName: f.sessionName,
          prompt: text,
          userText: `What's ${f.sessionName} stuck on?`,
          clientId,
        });
        this.auditAsk(f, 'herald', clientId);
        return { via: 'herald', askId: r.askId, sentText: text };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'session_waiting')
          throw new StuckError('session_waiting', (err as Error).message);
        if (code !== 'herald_unavailable')
          throw new StuckError('unavailable', (err as Error).message || 'Could not ask');
      }
    }
    if (!this.deps.sendDirect)
      throw new StuckError('herald_unavailable', 'Herald is not available to ask');
    const ok = await this.deps.sendDirect(f.sessionId, text);
    if (!ok) throw new StuckError('unavailable', `Could not send to ${f.sessionName}`);
    this.auditAsk(f, 'direct', clientId);
    return { via: 'direct', askId: null, sentText: text };
  }

  private auditAsk(f: StuckFinding, via: string, clientId?: string): void {
    try {
      this.deps.audit?.({
        ts: this.now(),
        origin: {
          addr: 'server',
          clientId: clientId || 'stuck',
          isLocal: true,
          tls: false,
          origin: null,
        },
        action: 'stuck_ask',
        payload: { session: f.sessionId, kind: f.kind, via },
        result: { ok: true },
        durationMs: 0,
      });
    } catch {
      // audit is best effort
    }
  }

  /** "Interrupt": Herald's propose_interrupt path (echo tier, cancellable countdown). */
  interrupt(sessionId: string, clientId?: string): StuckInterruptResponse {
    if (!sessionId) throw new StuckError('bad_request', 'sessionId is required');
    if (!this.liveSession(sessionId))
      throw new StuckError('unknown_session', `Unknown session ${sessionId}`);
    const h = this.herald;
    if (!h || !h.featureEnabled)
      throw new StuckError('herald_unavailable', 'Interrupting needs Herald');
    return h.proposeInterrupt({ sessionId, sessionName: this.name(sessionId), clientId });
  }

  getSettings(): StuckSettings {
    return this.settingsStore.get();
  }

  setSettings(patch: unknown): StuckSettings {
    const before = this.settingsStore.get();
    const next = this.settingsStore.update(patch);
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      // New thresholds: re-judge everything we hold.
      if (!next.enabled) {
        this.digests.clear();
        this.findings.clear();
        this.panes.clear();
      } else {
        for (const id of this.digests.keys()) this.evaluate(id);
      }
      this.publish();
    }
    return next;
  }

  // ------------------------------------------------------------------ introspection (tests)

  stats(): {
    digests: number;
    findings: number;
    panes: number;
    snoozes: number;
    dismissed: number;
    capturing: number;
    events: number;
  } {
    return {
      digests: this.digests.size,
      findings: this.findings.size,
      panes: this.panes.size,
      snoozes: this.snoozes.size,
      dismissed: this.dismissed.size,
      capturing: this.capturing.size,
      events: this.eventCache.size,
    };
  }

  /** Digest of a session (tests / diagnostics). */
  digest(sessionId: string): StuckDigest | undefined {
    return this.digests.get(sessionId);
  }

  shutdown(): void {
    this.disposed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }
}

/** Stable short id for logs. */
export function findingTag(f: StuckFinding): string {
  return `${f.kind}:${fnv1a(f.id)}`;
}
