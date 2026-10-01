import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeView, firstWords, OVERLAY_FADE_MS, OVERLAY_LINGER_MS, OverlayPresenter, shouldBringToFront, TONE_SHOW_MS, type OverlayInput, type OverlayView } from '../overlay';

const idle: OverlayInput = {
  enabled: true,
  mainFocused: false,
  listening: false,
  transcribing: false,
  thinking: false,
  speaking: false,
  tone: null,
  lastUserText: null,
  replyText: null,
};

describe('firstWords', () => {
  it('keeps short text, cuts long text at a word with an ellipsis', () => {
    expect(firstWords('  Two  sessions finished. ')).toBe('Two sessions finished.');
    const long = 'The docs build finished cleanly and the deploy session is waiting for you to confirm the production push';
    const out = firstWords(long);
    expect(out.length).toBeLessThanOrEqual(73);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toMatch(/^The docs build finished cleanly and the deploy session is waiting for/);
  });
});

describe('activeView', () => {
  it('priority: listening > transcribing > speaking > thinking > tone', () => {
    expect(activeView({ ...idle, listening: true, speaking: true }, 0)?.orb).toBe('listening');
    expect(activeView({ ...idle, transcribing: true }, 0)?.caption).toBe('Transcribing…');
    expect(activeView({ ...idle, speaking: true, thinking: true, replyText: 'Docs is done.' }, 0)).toEqual({ orb: 'speaking', caption: 'Docs is done.' });
    expect(activeView({ ...idle, thinking: true, lastUserText: 'anything for me' }, 0)).toEqual({ orb: 'thinking', caption: '“anything for me”' });
    expect(activeView({ ...idle, tone: { at: 1000, text: 'api: finished' } }, 1000 + TONE_SHOW_MS - 1)).toEqual({ orb: 'tone', caption: 'api: finished' });
    expect(activeView({ ...idle, tone: { at: 1000, text: 'x' } }, 1000 + TONE_SHOW_MS)).toBeNull();
    expect(activeView(idle, 0)).toBeNull();
  });
});

describe('OverlayPresenter (overlay state sync)', () => {
  let now = 0;
  let views: OverlayView[];
  let p: OverlayPresenter;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    views = [];
    p = new OverlayPresenter((v) => views.push(v), { now: () => now });
  });
  afterEach(() => {
    p.dispose();
    vi.useRealTimers();
  });

  const tick = (ms: number) => { now += ms; vi.advanceTimersByTime(ms); };

  it('shows on activity, lingers, fades, hides', () => {
    p.update({ ...idle, listening: true });
    expect(p.current).toEqual({ phase: 'active', orb: 'listening', caption: 'Listening…' });
    p.update({ ...idle, thinking: true, lastUserText: 'what is blocked' });
    p.update({ ...idle, speaking: true, replyText: 'Deploy is waiting on you.' });
    p.update(idle);
    expect(p.current.phase).toBe('active'); // lingers with the last caption
    expect(p.current.caption).toBe('Deploy is waiting on you.');
    tick(OVERLAY_LINGER_MS);
    expect(p.current.phase).toBe('fading');
    tick(OVERLAY_FADE_MS);
    expect(p.current.phase).toBe('hidden');
    expect(views.map((v) => `${v.phase}:${v.orb}`)).toEqual([
      'active:listening', 'active:thinking', 'active:speaking', 'fading:speaking', 'hidden:speaking',
    ]);
  });

  it('new activity during the linger or fade brings it straight back', () => {
    p.update({ ...idle, speaking: true });
    p.update(idle);
    tick(OVERLAY_LINGER_MS);
    expect(p.current.phase).toBe('fading');
    p.update({ ...idle, listening: true });
    expect(p.current.phase).toBe('active');
    tick(OVERLAY_LINGER_MS + OVERLAY_FADE_MS);
    expect(p.current.phase).toBe('active'); // still listening: no timer ran
  });

  it('hidden while the Companion window is focused, or when turned off', () => {
    p.update({ ...idle, speaking: true, mainFocused: true });
    expect(p.current.phase).toBe('hidden');
    expect(views).toEqual([]);
    p.update({ ...idle, speaking: true });
    expect(p.current.phase).toBe('active');
    p.update({ ...idle, speaking: true, enabled: false });
    expect(p.current.phase).toBe('hidden');
  });

  it('a tone shows by itself for a few seconds, then lingers out', () => {
    p.update({ ...idle, tone: { at: 0, text: 'docs: finished' } });
    expect(p.current).toEqual({ phase: 'active', orb: 'tone', caption: 'docs: finished' });
    tick(TONE_SHOW_MS + 1);
    expect(p.current.phase).toBe('active');
    tick(OVERLAY_LINGER_MS);
    expect(p.current.phase).toBe('fading');
    tick(OVERLAY_FADE_MS);
    expect(p.current.phase).toBe('hidden');
  });

  it('emits only on change', () => {
    p.update({ ...idle, listening: true });
    p.update({ ...idle, listening: true });
    expect(views).toHaveLength(1);
  });
});

describe('follow-up window on the floating orb', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows "follow-up" with its countdown while the window is open, below every activity', () => {
    const fu = { until: 10_000, ms: 6000 };
    expect(activeView({ ...idle, followUp: fu }, 5000)).toEqual({ orb: 'followup', caption: expect.any(String), countdown: fu });
    expect(activeView({ ...idle, followUp: fu, speaking: true }, 5000)?.orb).toBe('speaking');
    expect(activeView({ ...idle, followUp: fu, listening: true }, 5000)?.orb).toBe('listening');
    expect(activeView({ ...idle, followUp: fu }, 10_000)).toBeNull(); // expired
  });

  it('a window that closes in silence hides at once (no lingering "listening")', () => {
    const views: OverlayView[] = [];
    const p = new OverlayPresenter((v) => views.push(v), { now: () => 5000 });
    p.update({ ...idle, followUp: { until: 10_000, ms: 6000 } });
    expect(views[views.length - 1]).toMatchObject({ phase: 'active', orb: 'followup' });
    p.update({ ...idle, followUp: null });
    vi.advanceTimersByTime(1);
    expect(views[views.length - 1].phase).toBe('fading');
    vi.advanceTimersByTime(OVERLAY_FADE_MS);
    expect(views[views.length - 1].phase).toBe('hidden');
  });
});

describe('shouldBringToFront', () => {
  it('only when enabled, only in the desktop app, never in Gaming', () => {
    const base = { enabled: true, profile: 'headphones' as const, platform: 'desktop' as const };
    expect(shouldBringToFront({ ...base, source: 'wake' })).toBe(true);
    expect(shouldBringToFront({ ...base, source: 'trigger' })).toBe(true);
    expect(shouldBringToFront({ ...base, enabled: false, source: 'wake' })).toBe(false);
    expect(shouldBringToFront({ ...base, profile: 'gaming', source: 'wake' })).toBe(false);
    expect(shouldBringToFront({ ...base, profile: 'gaming', source: 'trigger' })).toBe(false);
    expect(shouldBringToFront({ ...base, platform: 'browser', source: 'wake' })).toBe(false);
    expect(shouldBringToFront({ ...base, profile: null, source: 'trigger' })).toBe(true);
  });

  it('"show me" is an explicit request: always in the desktop app, even in Gaming or with the setting off', () => {
    const base = { enabled: false, profile: 'gaming' as const, platform: 'desktop' as const };
    expect(shouldBringToFront({ ...base, source: 'show' })).toBe(true);
    expect(shouldBringToFront({ ...base, platform: 'android', source: 'show' })).toBe(false);
    expect(shouldBringToFront({ ...base, platform: 'browser', source: 'show' })).toBe(false);
  });
});
