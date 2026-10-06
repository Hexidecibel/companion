import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_GAP_MS,
  INTERACTION_QUIET_MS,
  QUIET_HOUR_MS,
  TAB_LOCK_STALE_MS,
  TONE_PREFS_KEY,
  ToneGate,
  ToneTabLock,
  chimeFor,
  itemMuted,
  normalizeTonePrefs,
  sameSession,
  toneKindOf,
  toneStore,
  type ToneContext,
  type TonePrefs,
} from '../tonePolicy';
import type { HeraldInboxItem } from '../../../types/herald';
import { matchQuietTonesCommand, matchVoiceCommand } from '../../voice/voiceCommands';
import { dispatchNativeEvent, type NativeHeraldHandlers } from '../../nativeBridge';
import { profileSettings, PROFILE_IDS } from '../../heraldSetup/profiles';

const item = (id: string, over: Partial<HeraldInboxItem> = {}): HeraldInboxItem => ({
  id, serverId: 'local', sessionId: id, sessionName: id, priority: 'blocked', headline: 'h', createdAt: 1, heard: false, ...over,
});
const finished = (id: string) => item(id, { priority: 'finished' });
const errorItem = (id: string) => item(id, { priority: 'finished', error: { tool: 'Bash', line: 'FAIL' } });
const stuckItem = (id: string) =>
  item(id, { priority: 'finished', stuck: { kind: 'k', kinds: ['k'], findingId: 'f', summary: 's', count: 3 } });
const riskItem = (id: string) => item(id, { priority: 'finished', review: { level: 'high', kinds: ['ci'], paths: [] } });
const pairItem = (id: string) =>
  item(id, { sessionId: `pair:${id}`, pairing: { pairingId: id, deviceName: 'iPad', platform: 'ios', code: '123456', expiresAt: 9e15 } });

const T0 = 10_000_000;
function prefs(over: Partial<TonePrefs> = {}): TonePrefs {
  return { ...normalizeTonePrefs(null), ...over };
}
function ctx(over: Partial<ToneContext> = {}): ToneContext {
  return {
    now: T0,
    prefs: prefs(),
    chimeOn: true,
    announcer: true,
    tabLeader: true,
    audible: true,
    lastInteractionAt: 0,
    viewing: () => false,
    muted: () => false,
    ...over,
  };
}

describe('1. defaults: only "needs you" chimes', () => {
  it('kinds of items', () => {
    expect(toneKindOf(item('b'))).toBe('needs_you');
    expect(toneKindOf(pairItem('p'))).toBe('needs_you');
    expect(toneKindOf(finished('f'))).toBe('finished');
    expect(toneKindOf(riskItem('r'))).toBe('risk');
    expect(toneKindOf(stuckItem('s'))).toBe('stuck');
    expect(toneKindOf(errorItem('e'))).toBe('error');
    expect(toneKindOf(item('x', { priority: 'progress' }))).toBeNull();
  });

  it('the babysitter tally is always silent, whatever its priority', () => {
    const babysit = { babysitId: 'b1', status: 'active' as const, answers: 3, escalations: 1 };
    expect(toneKindOf(item('t', { priority: 'progress', babysit }))).toBeNull();
    expect(toneKindOf(item('t', { priority: 'blocked', babysit }))).toBeNull();
    expect(toneKindOf(item('t', { priority: 'finished', babysit: { ...babysit, status: 'ended', endReason: 'done' } }))).toBeNull();
    const all = prefs({ kinds: { needs_you: true, finished: true, risk: true, stuck: true, error: true } });
    expect(new ToneGate().offer([item('t', { priority: 'progress', babysit })], ctx({ prefs: all })).play).toBeNull();
  });

  it('blocked and pairing chime; finished, risk, stuck and errors are silent by default', () => {
    for (const quiet of [finished('f'), riskItem('r'), stuckItem('s'), errorItem('e')]) {
      expect(new ToneGate().offer([quiet], ctx())).toEqual({ play: null, why: 'nothing' });
    }
    expect(new ToneGate().offer([item('b')], ctx())).toEqual({ play: 'blocked' });
    expect(new ToneGate().offer([pairItem('p')], ctx())).toEqual({ play: 'blocked' });
  });

  it('each kind can be turned on; the strongest sound wins', () => {
    const all = prefs({ kinds: { needs_you: true, finished: true, risk: true, stuck: true, error: true } });
    expect(new ToneGate().offer([errorItem('e')], ctx({ prefs: all }))).toEqual({ play: 'finished' });
    expect(new ToneGate().offer([stuckItem('s'), finished('f')], ctx({ prefs: all }))).toEqual({ play: 'stuck' });
    expect(new ToneGate().offer([riskItem('r'), stuckItem('s')], ctx({ prefs: all }))).toEqual({ play: 'risk' });
    expect(new ToneGate().offer([riskItem('r'), item('b')], ctx({ prefs: all }))).toEqual({ play: 'blocked' });
    expect(chimeFor([])).toBeNull();
  });

  it('heard items never chime', () => {
    expect(new ToneGate().offer([item('b', { heard: true })], ctx()).play).toBeNull();
  });
});

describe('2. you are already there', () => {
  it('no tone for a session on screen', () => {
    const v = new ToneGate().offer([item('out4')], ctx({ viewing: (i) => i.sessionId === 'out4' }));
    expect(v.play).toBeNull();
    expect(new ToneGate().offer([item('docs')], ctx({ viewing: (i) => i.sessionId === 'out4' })).play).toBe('blocked');
  });

  it('no tone at all within a minute of using the app (dropped, not replayed later)', () => {
    const g = new ToneGate();
    expect(g.offer([item('a')], ctx({ lastInteractionAt: T0 - INTERACTION_QUIET_MS + 1000 }))).toEqual({ play: null, why: 'interacting' });
    expect(g.foldedCount).toBe(0);
    expect(g.offer([item('b')], ctx({ lastInteractionAt: T0 - INTERACTION_QUIET_MS - 1 })).play).toBe('blocked');
  });

  it('maps the hub\'s "local" sessions to the app\'s connection id', () => {
    expect(sameSession({ serverId: 'local', sessionId: 'out4' }, { serverId: 'srv1', sessionId: 'out4' }, 'srv1')).toBe(true);
    expect(sameSession({ serverId: 'local', sessionId: 'out4' }, { serverId: 'srv2', sessionId: 'out4' }, 'srv1')).toBe(false);
    expect(sameSession({ serverId: 'srv2', sessionId: 'x' }, { serverId: 'srv2', sessionId: 'x' }, 'srv1')).toBe(true);
  });
});

describe('3. coalesce and rate limit', () => {
  it('one tone per window; arrivals inside it fold into ONE tone when it ends', () => {
    const g = new ToneGate();
    expect(g.offer([item('a')], ctx()).play).toBe('blocked');
    expect(g.offer([item('b')], ctx({ now: T0 + 10_000 }))).toEqual({ play: null, why: 'folded' });
    expect(g.offer([item('c')], ctx({ now: T0 + 20_000 }))).toEqual({ play: null, why: 'folded' });
    const inbox = [item('b'), item('c')];
    expect(g.tick(inbox, ctx({ now: T0 + DEFAULT_MIN_GAP_MS - 1 })).play).toBeNull();
    expect(g.tick(inbox, ctx({ now: T0 + DEFAULT_MIN_GAP_MS }))).toEqual({ play: 'blocked' });
    // Folded once: nothing more to play.
    expect(g.tick(inbox, ctx({ now: T0 + 2 * DEFAULT_MIN_GAP_MS })).play).toBeNull();
  });

  it('folded items that were heard or resolved meanwhile are dropped', () => {
    const g = new ToneGate();
    g.offer([item('a')], ctx());
    g.offer([item('b')], ctx({ now: T0 + 1000 }));
    expect(g.tick([item('b', { heard: true })], ctx({ now: T0 + DEFAULT_MIN_GAP_MS })).play).toBeNull();
    g.offer([item('c')], ctx({ now: T0 + DEFAULT_MIN_GAP_MS + 1000 }));
    expect(g.tick([], ctx({ now: T0 + 3 * DEFAULT_MIN_GAP_MS })).play).toBeNull();
  });

  it('coming back (tab shown, reconnect) never plays a backlog', () => {
    const g = new ToneGate();
    g.offer([item('a')], ctx());
    g.offer([item('b')], ctx({ now: T0 + 1000 }));
    g.clearBacklog();
    expect(g.tick([item('b')], ctx({ now: T0 + DEFAULT_MIN_GAP_MS })).play).toBeNull();
  });

  it('the gap is configurable', () => {
    const g = new ToneGate();
    const fast = prefs({ minGapMs: 60_000 });
    g.offer([item('a')], ctx({ prefs: fast }));
    expect(g.offer([item('b')], ctx({ prefs: fast, now: T0 + 60_000 })).play).toBe('blocked');
  });
});

describe('4. reminders', () => {
  it('go through the gate: quiet, interaction and the rate window skip them', () => {
    const g = new ToneGate();
    expect(g.remind(ctx()).play).toBe('blocked');
    expect(g.remind(ctx({ now: T0 + 1000 }))).toEqual({ play: null, why: 'rate_limited' });
    expect(g.remind(ctx({ now: T0 + DEFAULT_MIN_GAP_MS, prefs: prefs({ quietUntil: T0 + QUIET_HOUR_MS }) })).play).toBeNull();
    expect(g.remind(ctx({ now: T0 + DEFAULT_MIN_GAP_MS, lastInteractionAt: T0 + DEFAULT_MIN_GAP_MS - 5 })).play).toBeNull();
    expect(g.remind(ctx({ now: T0 + DEFAULT_MIN_GAP_MS, prefs: prefs({ kinds: { needs_you: false, finished: false, risk: false, stuck: false, error: false } }) })).play).toBeNull();
  });
});

describe('5. quiet', () => {
  beforeEach(() => {
    localStorage.clear();
    toneStore.reset();
  });

  it('quiet for an hour silences everything until it ends', () => {
    const p = prefs({ quietUntil: T0 + QUIET_HOUR_MS });
    expect(new ToneGate().offer([item('a')], ctx({ prefs: p }))).toEqual({ play: null, why: 'quiet' });
    expect(new ToneGate().offer([item('a')], ctx({ prefs: p, now: T0 + QUIET_HOUR_MS })).play).toBe('blocked');
    toneStore.quietFor(QUIET_HOUR_MS, T0);
    expect(toneStore.isQuiet(T0 + 1)).toBe(true);
    toneStore.quietFor(0);
    expect(toneStore.isQuiet()).toBe(false);
  });

  it('a muted session is silent on this device; pairing is never "muted"', () => {
    toneStore.setSessionMuted('srv1:out4', true);
    const p = toneStore.get();
    expect(itemMuted(item('out4'), p, 'srv1')).toBe(true);
    expect(itemMuted(item('docs'), p, 'srv1')).toBe(false);
    expect(itemMuted(pairItem('out4'), p, 'srv1')).toBe(false);
    const v = new ToneGate().offer([item('out4')], ctx({ muted: (i) => itemMuted(i, p, 'srv1') }));
    expect(v.play).toBeNull();
    toneStore.setSessionMuted('srv1:out4', false);
    expect(toneStore.isSessionMuted('srv1:out4')).toBe(false);
  });

  it('voice: "quiet for an hour" / "stop the tones" / "tones back on"; "quiet" alone still stops speech', () => {
    expect(matchQuietTonesCommand('Quiet for an hour.')).toBe('quiet');
    expect(matchQuietTonesCommand('Hey Jarvis, stop the tones')).toBe('quiet');
    expect(matchQuietTonesCommand('tones back on please')).toBe('resume');
    expect(matchQuietTonesCommand('quiet')).toBeNull();
    expect(matchQuietTonesCommand('stop the tones test in the build')).toBeNull();
    expect(matchVoiceCommand('quiet')).toBe('stop');
  });

  it('desktop tray: "Quiet tones for 1 hour" arrives as quiet_hour', () => {
    let quiet = 0;
    const h = { quietHour: () => quiet++ } as unknown as NativeHeraldHandlers;
    expect(dispatchNativeEvent({ action: 'quiet_hour' }, h)).toBe(true);
    expect(quiet).toBe(1);
  });
});

describe('6. profiles and existing users', () => {
  beforeEach(() => {
    localStorage.clear();
    toneStore.reset();
  });

  it('every profile: needs-you tones only, reminders off', () => {
    for (const id of PROFILE_IDS) {
      const s = profileSettings(id, { echo: null });
      expect(s.voice.remind).toBe(false);
      expect(s.voice.toneKinds).toEqual({ needs_you: true, finished: false, risk: false, stuck: false, error: false });
    }
  });

  it('saved settings without a deliberate choice get the new defaults; a customised choice is kept', () => {
    expect(normalizeTonePrefs({ kinds: { finished: true } }).kinds.finished).toBe(false);
    expect(normalizeTonePrefs({ kinds: { finished: true }, customized: true }).kinds.finished).toBe(true);
    toneStore.setKind('error', true);
    expect(JSON.parse(localStorage.getItem(TONE_PREFS_KEY)!).customized).toBe(true);
    toneStore.applyProfileKinds({ needs_you: true, finished: false, risk: false, stuck: false, error: false });
    expect(toneStore.get().kinds.error).toBe(true);
  });
});

describe('7. one device, one tab', () => {
  it('the hub announcer and the tab lease both gate tones', () => {
    expect(new ToneGate().offer([item('a')], ctx({ announcer: false })).play).toBeNull();
    expect(new ToneGate().offer([item('a')], ctx({ tabLeader: false })).play).toBeNull();
    expect(new ToneGate().offer([item('a')], ctx({ chimeOn: false })).play).toBeNull();
    expect(new ToneGate().offer([item('a')], ctx({ audible: false })).play).toBeNull();
  });

  it('only one tab holds the lease; a visible tab takes it; a stale one is free', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    const a = new ToneTabLock(storage, 'a');
    const b = new ToneTabLock(storage, 'b');
    expect(a.isLeader(1000)).toBe(true);
    expect(b.isLeader(2000)).toBe(false);
    b.claim(3000); // tab b became visible
    expect(a.isLeader(4000)).toBe(false);
    expect(b.isLeader(5000)).toBe(true);
    expect(a.isLeader(5000 + TAB_LOCK_STALE_MS + 1)).toBe(true); // b went away
    a.release();
    expect(mem.size).toBe(0);
    expect(new ToneTabLock(null, 'c').isLeader()).toBe(true); // no storage: allowed
  });
});
