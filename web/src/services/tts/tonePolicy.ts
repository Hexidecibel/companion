/**
 * Herald tone policy: when an inbox item may make a sound.
 *
 * Tones are for news that arrived while you were away, played once. The rules
 * (every one unit-tested, see __tests__/tonePolicy.test.ts):
 *
 *  1. Kinds. Only "needs you" chimes by default (a question or approval
 *     waiting, a device that wants to pair). Finished, risky changes, stuck and
 *     errors still show in the inbox, silently, unless turned on per kind.
 *  2. You are already there. No tone for a session you are viewing on this
 *     device, and none at all within INTERACTION_QUIET_MS of using the app
 *     (keyboard, pointer, voice, a trigger).
 *  3. Coalesce. At most one tone per `minGapMs` (2 minutes by default). Items
 *     arriving inside the window fold into ONE tone when it ends (re-checked
 *     then); they never queue as separate chimes. Coming back (the tab shown
 *     again, a reconnect) drops the fold: no backlog is ever played.
 *  4. Reminders for an unheard "needs you" item are off by default; on, one
 *     reminder after 10 minutes (heraldSpeech.ts), through the same gate.
 *  5. Quiet. "Quiet for 1 hour" (header, voice, tray) and a per-session mute.
 *  6. One device, one tab. The hub's announcer is the only device that tones,
 *     and on that device a single tab (ToneTabLock).
 */
import type { HeraldInboxItem } from '../../types/herald';
import type { ChimeKind } from './heraldSpeech';

export type ToneKind = 'needs_you' | 'finished' | 'risk' | 'stuck' | 'error';
export const TONE_KINDS: readonly ToneKind[] = ['needs_you', 'finished', 'risk', 'stuck', 'error'];

export const TONE_KIND_LABEL: Record<ToneKind, string> = {
  needs_you: 'Needs you',
  finished: 'Finished',
  risk: 'Risky changes',
  stuck: 'Stuck',
  error: 'Errors',
};

/** No tone within this long of using the app: you are already looking. */
export const INTERACTION_QUIET_MS = 60_000;
export const DEFAULT_MIN_GAP_MS = 2 * 60_000;
/** Choices offered for the minimum gap between tones. */
export const MIN_GAP_CHOICES_MS: readonly number[] = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
export const QUIET_HOUR_MS = 60 * 60_000;

export interface TonePrefs {
  /** Which kinds chime. */
  kinds: Record<ToneKind, boolean>;
  /** At most one tone per this many ms. */
  minGapMs: number;
  /** Tones are off until this time (epoch ms; 0 = not quiet). */
  quietUntil: number;
  /** Sessions whose tones are muted on this device: `${serverId}:${sessionId}` (the app's server id). */
  mutedSessions: string[];
  /** The user changed the per-kind choices themselves (profiles then leave them alone). */
  customized: boolean;
}

export const DEFAULT_TONE_KINDS: Readonly<Record<ToneKind, boolean>> = {
  needs_you: true,
  finished: false,
  risk: false,
  stuck: false,
  error: false,
};

export const DEFAULT_TONE_PREFS: TonePrefs = {
  kinds: { ...DEFAULT_TONE_KINDS },
  minGapMs: DEFAULT_MIN_GAP_MS,
  quietUntil: 0,
  mutedSessions: [],
  customized: false,
};

/** The tone category of an inbox item (null: never toned). */
export function toneKindOf(item: HeraldInboxItem): ToneKind | null {
  // The babysitter's running tally is always silent, whatever its priority.
  if (item.babysit) return null;
  if (item.pairing || item.priority === 'blocked') return 'needs_you';
  if (item.review) return 'risk';
  if (item.stuck) return 'stuck';
  if (item.error) return 'error';
  if (item.priority === 'finished') return 'finished';
  return null;
}

/** The sound for a set of kinds: the most urgent one wins. */
export function chimeFor(kinds: readonly ToneKind[]): ChimeKind | null {
  if (kinds.includes('needs_you')) return 'blocked';
  if (kinds.includes('risk')) return 'risk';
  if (kinds.includes('stuck')) return 'stuck';
  if (kinds.includes('error') || kinds.includes('finished')) return 'finished';
  return null;
}

// ---------------------------------------------------------------------------
// Persistence

export const TONE_PREFS_KEY = 'herald_tone_prefs';

export function normalizeTonePrefs(raw: unknown): TonePrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<TonePrefs>;
  const kinds = { ...DEFAULT_TONE_KINDS };
  const customized = p.customized === true;
  // Only a deliberate choice survives; anything else gets today's defaults.
  if (customized && p.kinds && typeof p.kinds === 'object') {
    for (const k of TONE_KINDS) if (typeof p.kinds[k] === 'boolean') kinds[k] = p.kinds[k];
  }
  const gap = typeof p.minGapMs === 'number' && Number.isFinite(p.minGapMs) ? p.minGapMs : DEFAULT_MIN_GAP_MS;
  return {
    kinds,
    minGapMs: Math.min(60 * 60_000, Math.max(0, Math.round(gap))),
    quietUntil: typeof p.quietUntil === 'number' && Number.isFinite(p.quietUntil) ? p.quietUntil : 0,
    mutedSessions: Array.isArray(p.mutedSessions)
      ? p.mutedSessions.filter((s): s is string => typeof s === 'string').slice(0, 200)
      : [],
    customized,
  };
}

function load(): TonePrefs {
  try {
    const raw = localStorage.getItem(TONE_PREFS_KEY);
    return normalizeTonePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeTonePrefs(null);
  }
}

type Listener = () => void;

/** This device's tone settings (localStorage), shared by the hook, settings, menus and the tray. */
class ToneStore {
  private prefs: TonePrefs = load();
  private listeners = new Set<Listener>();

  get(): TonePrefs {
    return this.prefs;
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(next: TonePrefs): void {
    this.prefs = next;
    try {
      localStorage.setItem(TONE_PREFS_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
    this.listeners.forEach((l) => l());
  }

  /** A per-kind choice by the user (marks the settings as customised). */
  setKind(kind: ToneKind, on: boolean): void {
    this.set({ ...this.prefs, kinds: { ...this.prefs.kinds, [kind]: on }, customized: true });
  }

  /** A profile's choice: only applied while the user has not customised the kinds. */
  applyProfileKinds(kinds: Record<ToneKind, boolean>): void {
    if (this.prefs.customized) return;
    this.set({ ...this.prefs, kinds: { ...kinds } });
  }

  setMinGap(ms: number): void {
    this.set(normalizeTonePrefs({ ...this.prefs, minGapMs: ms }));
  }

  /** Quiet for `ms` from now (0: resume tones). */
  quietFor(ms: number, now = Date.now()): void {
    this.set({ ...this.prefs, quietUntil: ms > 0 ? now + ms : 0 });
  }

  isQuiet(now = Date.now()): boolean {
    return this.prefs.quietUntil > now;
  }

  setSessionMuted(key: string, muted: boolean): void {
    const rest = this.prefs.mutedSessions.filter((k) => k !== key);
    this.set({ ...this.prefs, mutedSessions: muted ? [...rest, key] : rest });
  }

  isSessionMuted(key: string): boolean {
    return this.prefs.mutedSessions.includes(key);
  }

  /** Tests. */
  reset(): void {
    this.set(normalizeTonePrefs(null));
  }

  /** Re-read storage (another tab changed it). */
  reload(): void {
    this.prefs = load();
    this.listeners.forEach((l) => l());
  }
}

export const toneStore = new ToneStore();

// ---------------------------------------------------------------------------
// Interaction ("you are already looking")

let lastInteractionAt = 0;

/** The user just used the app (key, pointer, voice, trigger). */
export function noteInteraction(now = Date.now()): void {
  lastInteractionAt = Math.max(lastInteractionAt, now);
}

export function lastInteraction(): number {
  return lastInteractionAt;
}

/** Tests. */
export function resetInteraction(): void {
  lastInteractionAt = 0;
}

// ---------------------------------------------------------------------------
// The gate

export interface ToneContext {
  now: number;
  prefs: TonePrefs;
  /** Master switch ("Tone when something is new"). */
  chimeOn: boolean;
  /** This device is the hub's active device. */
  announcer: boolean;
  /** This tab holds the device's tone lock. */
  tabLeader: boolean;
  /** The page is visible, or the Gaming profile is on (the game is in front by design). */
  audible: boolean;
  lastInteractionAt: number;
  /** The item is about a session open on this device's screen right now. */
  viewing: (item: HeraldInboxItem) => boolean;
  /** The item's session has tones muted on this device. */
  muted: (item: HeraldInboxItem) => boolean;
}

/** Why a tone did not play (diagnostics / tests). */
export type ToneVerdict =
  | { play: ChimeKind }
  | { play: null; why: 'nothing' | 'off' | 'quiet' | 'interacting' | 'folded' | 'rate_limited' };

export class ToneGate {
  private lastToneAt = Number.NEGATIVE_INFINITY;
  /** Items held for the next tone (rate window), by id. */
  private folded = new Map<string, ToneKind>();

  /** The items (of those given) that may chime at all, with their kind. */
  private eligible(items: readonly HeraldInboxItem[], ctx: ToneContext): Array<[HeraldInboxItem, ToneKind]> {
    const out: Array<[HeraldInboxItem, ToneKind]> = [];
    for (const i of items) {
      if (i.heard) continue;
      const kind = toneKindOf(i);
      if (!kind || !ctx.prefs.kinds[kind]) continue;
      if (ctx.muted(i) || ctx.viewing(i)) continue;
      out.push([i, kind]);
    }
    return out;
  }

  private blocked(ctx: ToneContext): ToneVerdict | null {
    if (!ctx.chimeOn || !ctx.announcer || !ctx.tabLeader || !ctx.audible) return { play: null, why: 'off' };
    if (ctx.prefs.quietUntil > ctx.now) return { play: null, why: 'quiet' };
    if (ctx.now - ctx.lastInteractionAt < INTERACTION_QUIET_MS) return { play: null, why: 'interacting' };
    return null;
  }

  private play(kinds: ToneKind[], now: number): ToneVerdict {
    const kind = chimeFor(kinds);
    if (!kind) return { play: null, why: 'nothing' };
    this.lastToneAt = now;
    this.folded.clear();
    return { play: kind };
  }

  /** New, unheard items just arrived (live push). */
  offer(items: readonly HeraldInboxItem[], ctx: ToneContext): ToneVerdict {
    const ok = this.eligible(items, ctx);
    if (ok.length === 0) return { play: null, why: 'nothing' };
    const blocked = this.blocked(ctx);
    if (blocked) return blocked; // dropped: never replayed later
    if (ctx.now - this.lastToneAt < ctx.prefs.minGapMs) {
      for (const [i, k] of ok) this.folded.set(i.id, k);
      return { play: null, why: 'folded' };
    }
    return this.play(ok.map(([, k]) => k), ctx.now);
  }

  /**
   * Called on a timer: the rate window ended and items were folded into it.
   * They play as ONE tone if they are still in the inbox, unheard and still
   * allowed; otherwise they are dropped.
   */
  tick(inbox: readonly HeraldInboxItem[], ctx: ToneContext): ToneVerdict {
    if (this.folded.size === 0) return { play: null, why: 'nothing' };
    if (ctx.now - this.lastToneAt < ctx.prefs.minGapMs) return { play: null, why: 'rate_limited' };
    const ids = new Set(this.folded.keys());
    this.folded.clear();
    const ok = this.eligible(inbox.filter((i) => ids.has(i.id)), ctx);
    if (ok.length === 0) return { play: null, why: 'nothing' };
    const blocked = this.blocked(ctx);
    if (blocked) return blocked;
    return this.play(ok.map(([, k]) => k), ctx.now);
  }

  /** A reminder is due for an unheard "needs you" item (never folded: skipped when not allowed now). */
  remind(ctx: ToneContext): ToneVerdict {
    if (!ctx.prefs.kinds.needs_you) return { play: null, why: 'off' };
    const blocked = this.blocked(ctx);
    if (blocked) return blocked;
    if (ctx.now - this.lastToneAt < ctx.prefs.minGapMs) return { play: null, why: 'rate_limited' };
    return this.play(['needs_you'], ctx.now);
  }

  /** You came back (tab shown, reconnect, new hub): nothing held is ever played as a backlog. */
  clearBacklog(): void {
    this.folded.clear();
  }

  get foldedCount(): number {
    return this.folded.size;
  }

  reset(): void {
    this.folded.clear();
    this.lastToneAt = Number.NEGATIVE_INFINITY;
  }
}

// ---------------------------------------------------------------------------
// One tab per device

export const TONE_TAB_KEY = 'herald_tone_tab';
/** A lock not refreshed for this long is free. */
export const TAB_LOCK_STALE_MS = 15_000;

interface LockRecord {
  id: string;
  at: number;
}

/**
 * A localStorage lease so only one tab of this app on this device plays tones
 * (the hub already picks one device). The visible tab takes the lease; a
 * stale lease (closed tab) is free. Without storage every tab may tone.
 */
export class ToneTabLock {
  readonly id: string;
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeStorage(),
    id?: string,
  ) {
    this.id = id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private read(): LockRecord | null {
    try {
      const raw = this.storage?.getItem(TONE_TAB_KEY);
      if (!raw) return null;
      const r = JSON.parse(raw) as LockRecord;
      return typeof r?.id === 'string' && typeof r?.at === 'number' ? r : null;
    } catch {
      return null;
    }
  }

  private write(now: number): void {
    try {
      this.storage?.setItem(TONE_TAB_KEY, JSON.stringify({ id: this.id, at: now }));
    } catch {
      // ignore
    }
  }

  /** Take the lease (this tab became visible / is in use). */
  claim(now = Date.now()): void {
    this.write(now);
  }

  /** Keep the lease if this tab holds it, or take it when it is free. True: this tab tones. */
  isLeader(now = Date.now()): boolean {
    if (!this.storage) return true;
    const cur = this.read();
    if (!cur || cur.id === this.id || now - cur.at > TAB_LOCK_STALE_MS) {
      this.write(now);
      return true;
    }
    return false;
  }

  release(): void {
    try {
      if (this.read()?.id === this.id) this.storage?.removeItem(TONE_TAB_KEY);
    } catch {
      // ignore
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The sessions on screen

let viewed: ReadonlyArray<{ serverId: string; sessionId: string }> = [];

/** The sessions open on this device's screen (the Dashboard keeps this current). */
export function setViewedSessions(list: ReadonlyArray<{ serverId: string; sessionId: string }>): void {
  viewed = list.slice();
}

export function viewedSessions(): ReadonlyArray<{ serverId: string; sessionId: string }> {
  return viewed;
}

/**
 * Does an inbox item refer to this app session? The hub reports its own
 * sessions as server 'local'; the app knows that server by its connection id
 * (`hostId`).
 */
export function sameSession(
  item: { serverId: string; sessionId: string },
  s: { serverId: string; sessionId: string },
  hostId: string | null,
): boolean {
  if (item.sessionId !== s.sessionId) return false;
  return item.serverId === s.serverId || (item.serverId === 'local' && !!hostId && s.serverId === hostId);
}

/** The per-session mute key an item maps to on this device. */
export function sessionToneKey(serverId: string, sessionId: string): string {
  return `${serverId}:${sessionId}`;
}

export function itemMuted(item: HeraldInboxItem, prefs: TonePrefs, hostId: string | null): boolean {
  if (item.pairing) return false;
  const keys = [sessionToneKey(item.serverId, item.sessionId)];
  if (item.serverId === 'local' && hostId) keys.push(sessionToneKey(hostId, item.sessionId));
  return keys.some((k) => prefs.mutedSessions.includes(k));
}
