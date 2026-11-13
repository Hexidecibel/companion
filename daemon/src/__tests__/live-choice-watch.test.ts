import {
  AFTER_ANSWER_DELAY_MS,
  LIVE_INTERVAL_MS,
  LiveChoiceWatch,
  PROBE_SCHEDULE_MS,
  liveChoiceStateSig,
} from '../live-choice-watch';
import type { TerminalChoicePrompt } from '../types';

const box = (over: Partial<TerminalChoicePrompt> = {}): TerminalChoicePrompt => ({
  question: 'Which drink?',
  header: 'Drink',
  options: [{ label: 'Water' }, { label: 'Tea' }],
  auq: { screen: 'question', cursor: 0 },
  ...over,
});

function setup() {
  let current: TerminalChoicePrompt | null = null;
  const capture = jest.fn(async () => 'pane');
  const emitUpdate = jest.fn();
  const w = new LiveChoiceWatch({
    capture,
    note: () => current,
    emitUpdate,
  });
  return {
    w,
    capture,
    emitUpdate,
    show: (b: TerminalChoicePrompt | null) => {
      current = b;
    },
  };
}

async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

describe('LiveChoiceWatch', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('probe: finds a box that appears after a transcript write and emits once', async () => {
    const t = setup();
    t.w.probe('s');
    await advance(PROBE_SCHEDULE_MS[0]);
    expect(t.capture).toHaveBeenCalledTimes(1);
    expect(t.emitUpdate).not.toHaveBeenCalled();
    t.show(box());
    await advance(PROBE_SCHEDULE_MS[1] - PROBE_SCHEDULE_MS[0]);
    expect(t.emitUpdate).toHaveBeenCalledTimes(1);
    expect(t.w.isWatching('s')).toBe(true);
    // Unchanged box: no further updates while it stays.
    await advance(LIVE_INTERVAL_MS * 3);
    expect(t.emitUpdate).toHaveBeenCalledTimes(1);
    t.w.stopAll();
  });

  it('probe gives up after the schedule when no box shows', async () => {
    const t = setup();
    t.w.probe('s');
    await advance(PROBE_SCHEDULE_MS[PROBE_SCHEDULE_MS.length - 1] + 5000);
    expect(t.capture).toHaveBeenCalledTimes(PROBE_SCHEDULE_MS.length);
    expect(t.emitUpdate).not.toHaveBeenCalled();
    expect(t.w.isWatching('s')).toBe(false);
  });

  it('live: a change in the terminal (checks, next question) emits; a cursor move does not', async () => {
    const t = setup();
    t.show(box());
    t.w.follow('s', box());
    await advance(LIVE_INTERVAL_MS);
    expect(t.emitUpdate).not.toHaveBeenCalled();
    t.show(box({ auq: { screen: 'question', cursor: 1 } }));
    await advance(LIVE_INTERVAL_MS);
    expect(t.emitUpdate).not.toHaveBeenCalled();
    t.show(box({ question: 'Which sides?', header: 'Sides' }));
    await advance(LIVE_INTERVAL_MS);
    expect(t.emitUpdate).toHaveBeenCalledTimes(1);
    // Box goes away (answered in the terminal): one update, then stop.
    t.show(null);
    await advance(LIVE_INTERVAL_MS);
    expect(t.emitUpdate).toHaveBeenCalledTimes(2);
    expect(t.w.isWatching('s')).toBe(false);
    const calls = t.capture.mock.calls.length;
    await advance(LIVE_INTERVAL_MS * 5);
    expect(t.capture.mock.calls.length).toBe(calls);
  });

  it('watch after an answer: always emits the first look', async () => {
    const t = setup();
    t.show(box());
    t.w.watch('s');
    await advance(AFTER_ANSWER_DELAY_MS);
    expect(t.emitUpdate).toHaveBeenCalledTimes(1);
    t.w.stopAll();
  });

  it('never runs two captures at once for a session', async () => {
    let release: (v: string) => void = () => {};
    const capture = jest.fn(() => new Promise<string>((r) => (release = r)));
    const w = new LiveChoiceWatch({ capture, note: () => box(), emitUpdate: jest.fn() });
    w.watch('s');
    await advance(AFTER_ANSWER_DELAY_MS);
    await advance(LIVE_INTERVAL_MS * 3);
    expect(capture).toHaveBeenCalledTimes(1);
    release('pane');
    w.stopAll();
  });

  it('state signature ignores the cursor, not the checks or the typed Other text', () => {
    const a = box({ multiSelect: true, options: [{ label: 'A', selected: false }] });
    const moved = { ...a, auq: { ...a.auq!, cursor: 'submit' as const } };
    const checked = { ...a, options: [{ label: 'A', selected: true }] };
    const typed = { ...a, auq: { ...a.auq!, other: { number: 2, text: 'x' } } };
    expect(liveChoiceStateSig(moved)).toBe(liveChoiceStateSig(a));
    expect(liveChoiceStateSig(checked)).not.toBe(liveChoiceStateSig(a));
    expect(liveChoiceStateSig(typed)).not.toBe(liveChoiceStateSig(a));
  });
});
