import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHIMMER_AFTER_MS, SHIMMER_MAX_MS, TURN_SENT_GRACE_MS, TurnCues } from '../turnCues';
import { TICK_VOLUME, TONES, toneDuration } from '../../tts/chime';

function setup(opts: { tick?: boolean; shimmer?: boolean } = {}) {
  const stop = vi.fn();
  const deps = {
    tick: vi.fn(),
    startShimmer: vi.fn(() => stop),
    tickOn: () => opts.tick ?? true,
    shimmerOn: () => opts.shimmer ?? true,
  };
  return { cues: new TurnCues(deps), deps, stop };
}

describe('the tick tone', () => {
  it('is under 80 ms and quieter than the news tones', () => {
    expect(toneDuration('tick')).toBeLessThan(0.08);
    expect(TICK_VOLUME).toBeLessThan(0.05);
    expect(TONES.tick.length).toBeGreaterThan(0);
  });
});

describe('TurnCues', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks at once on end-of-speech', () => {
    const { cues, deps } = setup({ shimmer: false });
    cues.endOfSpeech();
    expect(deps.tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SHIMMER_MAX_MS);
    expect(deps.startShimmer).not.toHaveBeenCalled();
  });

  it('no tick when the tick is turned off', () => {
    const { cues, deps } = setup({ tick: false, shimmer: false });
    cues.endOfSpeech();
    expect(deps.tick).not.toHaveBeenCalled();
  });

  it('shimmer starts 1.5 s after end-of-speech when a turn went out and no audio came', () => {
    const { cues, deps, stop } = setup();
    cues.endOfSpeech();
    cues.turnSent();
    vi.advanceTimersByTime(SHIMMER_AFTER_MS - 1);
    expect(deps.startShimmer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(deps.startShimmer).toHaveBeenCalledTimes(1);
    expect(cues.shimmering).toBe(true);
    cues.audioStarted();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cues.shimmering).toBe(false);
  });

  it('first audio before 1.5 s: no shimmer at all', () => {
    const { cues, deps } = setup();
    cues.endOfSpeech();
    cues.turnSent();
    vi.advanceTimersByTime(900);
    cues.audioStarted();
    vi.advanceTimersByTime(SHIMMER_MAX_MS);
    expect(deps.startShimmer).not.toHaveBeenCalled();
  });

  it('a slow transcription: the shimmer starts when the turn goes out, if 1.5 s already passed', () => {
    const { cues, deps } = setup();
    cues.endOfSpeech();
    vi.advanceTimersByTime(2000);
    expect(deps.startShimmer).not.toHaveBeenCalled();
    cues.turnSent();
    expect(deps.startShimmer).toHaveBeenCalledTimes(1);
  });

  it('nothing sent (a local command, an echo): never shimmers', () => {
    const { cues, deps } = setup();
    cues.endOfSpeech();
    vi.advanceTimersByTime(TURN_SENT_GRACE_MS + 10);
    cues.turnSent(); // too late: not this turn
    vi.advanceTimersByTime(SHIMMER_MAX_MS);
    expect(deps.startShimmer).not.toHaveBeenCalled();
  });

  it('stops when the turn ends, and after the hard cap', () => {
    const a = setup();
    a.cues.endOfSpeech();
    a.cues.turnSent();
    vi.advanceTimersByTime(SHIMMER_AFTER_MS);
    a.cues.turnDone();
    expect(a.stop).toHaveBeenCalledTimes(1);

    const b = setup();
    b.cues.endOfSpeech();
    b.cues.turnSent();
    vi.advanceTimersByTime(SHIMMER_MAX_MS + 1);
    expect(b.stop).toHaveBeenCalledTimes(1);
    expect(b.cues.shimmering).toBe(false);
  });

  it('a new end-of-speech restarts cleanly (stops a running shimmer)', () => {
    const { cues, deps, stop } = setup();
    cues.endOfSpeech();
    cues.turnSent();
    vi.advanceTimersByTime(SHIMMER_AFTER_MS);
    cues.endOfSpeech();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(deps.tick).toHaveBeenCalledTimes(2);
  });
});
