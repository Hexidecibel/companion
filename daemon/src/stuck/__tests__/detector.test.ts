import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_SESSIONS, StuckAlert, StuckDetector, StuckHeraldLink } from '../detector';
import { StuckSettingsStore, inQuietHours, sanitizeSettings } from '../store';
import { STUCK_DEFAULTS } from '../protocol';
import type { ConversationMessage, TmuxSession } from '../../types';
import { Transcript, MIN, jestFail, jestPass } from './fixtures';

const ALIVE = [
  '✻ Simmering… (24m 3s · esc to interrupt)',
  '',
  '❯ ',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

function tmpStore(): StuckSettingsStore {
  return new StuckSettingsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-test-')));
}

interface Harness {
  det: StuckDetector;
  clock: { now: number };
  msgs: Map<string, ConversationMessage[]>;
  sessions: TmuxSession[];
  events: Array<{ type: string; payload: { findings: Array<{ id: string; kind: string }> } }>;
  captures: string[];
}

function harness(
  opts: {
    capture?: (id: string) => Promise<string>;
    ids?: string[];
    quiet?: boolean;
    cap?: number;
  } = {}
): Harness {
  const clock = { now: 0 };
  const msgs = new Map<string, ConversationMessage[]>();
  const sessions: TmuxSession[] = (opts.ids || ['out4']).map((id) => ({
    id,
    name: id,
    lastActivity: 0,
    isWaitingForInput: false,
    messageCount: 0,
  }));
  const events: Harness['events'] = [];
  const captures: string[] = [];
  const det = new StuckDetector({
    watcher: {
      on: () => undefined,
      getSessions: () => sessions,
      getMessages: (id) => msgs.get(id) || [],
    },
    sessionName: (id) => (id === 'out4' ? 'Out4' : id),
    broadcast: (type, payload) =>
      events.push({ type, payload: payload as Harness['events'][0]['payload'] }),
    capturePane: async (id) => {
      captures.push(id);
      return opts.capture ? opts.capture(id) : ALIVE;
    },
    settings: tmpStore(),
    quietHours: () => (opts.quiet ? { enabled: true, start: '00:00', end: '23:59' } : null),
    now: () => clock.now,
    tickMs: 0,
    debounceMs: 0,
    maxCapturesPerTick: opts.cap,
  });
  return { det, clock, msgs, sessions, events, captures };
}

function failing(t: Transcript, n: number): Transcript {
  for (let i = 0; i < n; i++)
    t.edit('/p/src/api.ts', `d${i}`, `d${i + 1}`)
      .bash('npm test 2>&1 | tail -40', jestFail(i))
      .wait(150);
  return t;
}

function feed(h: Harness, id: string, t: Transcript): void {
  h.clock.now = t.t;
  h.msgs.set(id, t.messages());
  h.det.refresh(id);
}

function fakeHerald(): StuckHeraldLink & {
  alerts: StuckAlert[][];
  asks: string[];
  interrupts: string[];
} {
  const self = {
    featureEnabled: true,
    alerts: [] as StuckAlert[][],
    asks: [] as string[],
    interrupts: [] as string[],
    syncStuckAlerts(a: StuckAlert[]) {
      self.alerts.push(a);
    },
    async relayAsk(r: { sessionId: string; prompt: string }) {
      self.asks.push(r.prompt);
      return { askId: 'ask-1' };
    },
    proposeInterrupt(r: { sessionId: string }) {
      self.interrupts.push(r.sessionId);
      return { actionId: 'act-1', autoSendAt: 123 };
    },
  };
  return self;
}

describe('StuckDetector', () => {
  it('reports a finding once and dedupes it across updates (firstSeen kept, count grows)', () => {
    const h = harness();
    const t = failing(new Transcript().prompt('fix it'), 5);
    feed(h, 'out4', t);
    const [f1] = h.det.list();
    expect(f1.kind).toBe('repeated_failure');
    expect(f1.sessionName).toBe('Out4');
    expect(f1.summary).toMatch(/^Same test failing 5 times/);
    failing(t, 1);
    feed(h, 'out4', t);
    const all = h.det.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(f1.id);
    expect(all[0].firstSeen).toBe(f1.firstSeen);
    expect(all[0].count).toBe(6);
    expect(h.events.filter((e) => e.type === 'stuck_update')).toHaveLength(2);
    // Nothing changed: no broadcast.
    h.det.refresh('out4');
    expect(h.events).toHaveLength(2);
  });

  it('clears when the session finishes its turn, and when the user sends a new prompt', () => {
    const h = harness();
    const t = failing(new Transcript().prompt('fix it'), 5);
    feed(h, 'out4', t);
    expect(h.det.list()).toHaveLength(1);
    t.text('I am giving up on this one.');
    feed(h, 'out4', t);
    expect(h.det.list()).toEqual([]);

    const t2 = failing(new Transcript().prompt('fix it'), 5);
    feed(h, 'out4', t2);
    expect(h.det.list()).toHaveLength(1);
    t2.prompt('try mocking the clock instead');
    feed(h, 'out4', t2);
    expect(h.det.list()).toEqual([]);
  });

  it('clears when the failure stops recurring (the test passes)', () => {
    const h = harness();
    const t = failing(new Transcript().prompt('fix it'), 5);
    feed(h, 'out4', t);
    expect(h.det.list()).toHaveLength(1);
    t.bash('npm test 2>&1 | tail -40', jestPass());
    feed(h, 'out4', t);
    expect(h.det.list()).toEqual([]);
  });

  it('clears when the session goes away', () => {
    const h = harness();
    feed(h, 'out4', failing(new Transcript().prompt('fix it'), 5));
    h.sessions.length = 0;
    h.det.tick();
    expect(h.det.list()).toEqual([]);
    expect(h.det.stats().digests).toBe(0);
  });

  it('snooze hides a session (per kind or all) until it runs out; 0 lifts it', () => {
    const h = harness();
    const t = failing(new Transcript().prompt('fix it'), 5);
    feed(h, 'out4', t);
    const until = h.det.snooze('out4', 'repeated_failure', 5);
    expect(until).toBe(h.clock.now + 5 * MIN);
    expect(h.det.list()).toEqual([]);
    // Still recurring when the snooze ends.
    t.wait(6 * 60);
    failing(t, 1);
    feed(h, 'out4', t);
    expect(h.det.list()).toHaveLength(1);
    h.det.snooze('out4', undefined, 10);
    expect(h.det.list()).toEqual([]);
    h.det.snooze('out4', undefined, 0);
    expect(h.det.list()).toHaveLength(1);
  });

  it('"not stuck" hides that signature for the rest of the turn only', () => {
    const h = harness();
    const t = failing(new Transcript().prompt('fix it'), 5);
    feed(h, 'out4', t);
    const [f] = h.det.list();
    h.det.dismiss(f.id);
    expect(h.det.list()).toEqual([]);
    failing(t, 2);
    feed(h, 'out4', t);
    expect(h.det.list()).toEqual([]);
    // A loop is a different signature: still shown.
    for (let i = 0; i < 5; i++) t.read('/p/x.ts').wait(20);
    feed(h, 'out4', t);
    expect(h.det.list().map((x) => x.kind)).toEqual(['loop']);
    // New turn: the dismissal is gone.
    t.prompt('keep going');
    failing(t, 5);
    feed(h, 'out4', t);
    expect(h.det.list().map((x) => x.kind)).toContain('repeated_failure');
  });

  it('redacts secrets in evidence and summaries', () => {
    const h = harness();
    const t = new Transcript().prompt('call the api');
    for (let i = 0; i < 5; i++)
      t.bash(
        'API_TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 curl -s https://x.test/v1',
        'curl: (7) Failed to connect',
        {
          isError: true,
        }
      ).wait(90);
    feed(h, 'out4', t);
    const [f] = h.det.list();
    const text = JSON.stringify(f);
    expect(text).not.toContain('sk-ant-api03');
    expect(text).toContain('[redacted]');
  });

  it('keeps memory bounded (sessions, events)', () => {
    const ids = Array.from({ length: 150 }, (_, i) => `s${i}`);
    const h = harness({ ids });
    for (const id of ids) feed(h, id, failing(new Transcript().prompt('go'), 5));
    const st = h.det.stats();
    expect(st.digests).toBeLessThanOrEqual(MAX_SESSIONS);
    expect(st.findings).toBeLessThanOrEqual(MAX_SESSIONS);
    expect(st.events).toBeLessThanOrEqual(4000);
    for (let i = 0; i < 600; i++) h.det.snooze(`s${i % 150}`, i % 2 ? 'loop' : undefined, 5 + i);
    expect(h.det.stats().snoozes).toBeLessThanOrEqual(500);
  });

  it('disabled: nothing is reported', () => {
    const h = harness();
    feed(h, 'out4', failing(new Transcript().prompt('fix it'), 5));
    expect(h.det.list()).toHaveLength(1);
    h.det.setSettings({ enabled: false });
    expect(h.det.list()).toEqual([]);
    h.det.setSettings({ enabled: true });
    feed(h, 'out4', failing(new Transcript().prompt('fix it'), 5));
    expect(h.det.list()).toHaveLength(1);
  });

  it('new thresholds re-judge what is held', () => {
    const h = harness();
    feed(h, 'out4', failing(new Transcript().prompt('fix it'), 5));
    expect(h.det.list()).toHaveLength(1);
    h.det.setSettings({ failureRepeats: 8 });
    expect(h.det.list()).toEqual([]);
  });

  describe('Herald link', () => {
    it('syncs one alert per session, only on change; quiet hours keep it off the inbox', () => {
      const h = harness();
      const herald = fakeHerald();
      h.det.setHerald(herald);
      feed(h, 'out4', failing(new Transcript().prompt('fix it'), 5));
      const last = herald.alerts[herald.alerts.length - 1];
      expect(last).toHaveLength(1);
      expect(last[0].headline).toBe('Out4 looks stuck: same test failing 5 times');
      const n = herald.alerts.length;
      h.det.refresh('out4');
      expect(herald.alerts.length).toBe(n);

      const q = harness({ quiet: true });
      const herald2 = fakeHerald();
      q.det.setHerald(herald2);
      feed(q, 'out4', failing(new Transcript().prompt('fix it'), 5));
      expect(q.det.list()).toHaveLength(1);
      expect(herald2.alerts.every((a) => a.length === 0)).toBe(true);
    });

    it('ask goes through Herald ask-and-report; interrupt through propose_interrupt', async () => {
      const h = harness();
      const herald = fakeHerald();
      h.det.setHerald(herald);
      feed(h, 'out4', failing(new Transcript().prompt('fix it'), 5));
      const [f] = h.det.list();
      const r = await h.det.ask(f.id, 'c1');
      expect(r.via).toBe('herald');
      expect(herald.asks[0]).toMatch(
        /^Quick check-in from the user: you look stuck \(Same test failing 5 times/
      );
      expect(h.det.interrupt('out4', 'c1')).toEqual({ actionId: 'act-1', autoSendAt: 123 });
      expect(herald.interrupts).toEqual(['out4']);
    });

    it('interrupt without Herald is refused', () => {
      const h = harness();
      expect(() => h.det.interrupt('out4')).toThrow(/needs Herald/);
    });
  });

  describe('pane capture guard', () => {
    function stalled(h: Harness): Transcript {
      const t = new Transcript().prompt('check');
      t.text('Querying.').use('Bash', { command: 'curl -s http://localhost:9/slow' });
      h.msgs.set('out4', t.messages());
      h.clock.now = t.t + 25 * MIN;
      h.det.refresh('out4');
      return t;
    }

    it('captures only sessions that need it, dedupes in-flight calls, detects a stalled tool', async () => {
      let release: (v: string) => void = () => undefined;
      const h = harness({ capture: () => new Promise<string>((r) => (release = r)) });
      stalled(h);
      h.det.tick();
      h.det.tick(); // in flight: no second capture
      expect(h.captures).toEqual(['out4']);
      await Promise.resolve(); // let the race settle its listeners
      release(ALIVE);
      await new Promise((r) => setImmediate(r));
      expect(h.det.stats().capturing).toBe(0);
      // Too soon for another capture.
      h.det.tick();
      expect(h.captures).toHaveLength(1);
      h.clock.now += 5 * MIN;
      h.det.tick();
      expect(h.captures).toHaveLength(2);
      release(ALIVE);
      await new Promise((r) => setImmediate(r));
      expect(h.det.list().map((f) => f.kind)).toEqual(['stalled_tool']);
    });

    it('a hanging capture times out and frees its slot', async () => {
      jest.useFakeTimers();
      try {
        const h = harness({ capture: () => new Promise<string>(() => undefined) });
        stalled(h);
        h.det.tick();
        expect(h.det.stats().capturing).toBe(1);
        await jest.advanceTimersByTimeAsync(5000);
        expect(h.det.stats().capturing).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('never captures a session that is gone, nor more than the per-tick cap', () => {
      const ids = ['a', 'b', 'c', 'd'];
      const h = harness({ ids, capture: () => new Promise<string>(() => undefined), cap: 2 });
      for (const id of ids) {
        const t = new Transcript().prompt('x');
        t.use('Bash', { command: 'curl -s http://localhost:9/slow' });
        h.msgs.set(id, t.messages());
        h.clock.now = t.t + 25 * MIN;
        h.det.refresh(id);
      }
      h.det.tick();
      expect(h.captures).toHaveLength(2);
      void h.det.capture('zz', null);
      expect(h.captures).toHaveLength(2);
      h.det.shutdown();
    });

    it('no capture for sessions that are fine', () => {
      const h = harness();
      const t = new Transcript().prompt('x').text('Working on it.').read('/p/a.ts');
      feed(h, 'out4', t);
      h.det.tick();
      expect(h.captures).toEqual([]);
    });
  });
});

describe('settings store', () => {
  it('clamps and ignores junk; persists', async () => {
    expect(
      sanitizeSettings({ failureRepeats: 1, noProgressMin: 9999, enabled: 'yes', bogus: 1 })
    ).toEqual({
      ...STUCK_DEFAULTS,
      failureRepeats: 3,
      noProgressMin: 480,
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-store-'));
    const s = new StuckSettingsStore(dir);
    s.update({ noProgressMin: 45 });
    await new Promise((r) => setTimeout(r, 50));
    expect(new StuckSettingsStore(dir).get().noProgressMin).toBe(45);
  });

  it('quiet hours, overnight included', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 3, h, m);
    const q = { enabled: true, start: '22:00', end: '07:30' };
    expect(inQuietHours(q, at(23))).toBe(true);
    expect(inQuietHours(q, at(7, 0))).toBe(true);
    expect(inQuietHours(q, at(8))).toBe(false);
    expect(inQuietHours({ ...q, enabled: false }, at(23))).toBe(false);
    expect(inQuietHours(null, at(23))).toBe(false);
  });
});
