import { describe, expect, it } from 'vitest';
import { currentStep, initialSetupState, progress, setupReducer, setupSteps, summarize, type SetupAction, type SetupEnv, type SetupFlowState } from '../onboarding';
import { PROFILES } from '../profiles';

const desktop: SetupEnv = { platform: 'desktop', wakeAvailable: true, devicesSupported: true };
const run = (s: SetupFlowState, ...actions: SetupAction[]) => actions.reduce(setupReducer, s);
const names = { profile: (id: keyof typeof PROFILES) => PROFILES[id].name };

describe('setupSteps', () => {
  it('includes wake only with the wake word loaded, control only on hubs with devices', () => {
    expect(setupSteps(desktop)).toEqual(['profile', 'mic', 'echo', 'wake', 'trigger', 'control', 'done']);
    expect(setupSteps({ platform: 'ios', wakeAvailable: false, devicesSupported: false })).toEqual(['profile', 'mic', 'echo', 'trigger', 'done']);
  });
});

describe('setupReducer', () => {
  it('walks every step; Continue with a result counts as done, without one as skipped', () => {
    let s = initialSetupState(desktop, 'headphones');
    expect(currentStep(s)).toBe('profile');
    s = run(s, { type: 'next' });
    expect(s.outcomes.profile).toBe('done');
    expect(currentStep(s)).toBe('mic');
    s = run(s, { type: 'next' });
    expect(s.outcomes.mic).toBe('skipped');
    s = run(s, { type: 'echo', grade: 'poor' }, { type: 'next' });
    expect(s.outcomes.echo).toBe('done');
    s = run(s, { type: 'skip' }, { type: 'trigger', label: 'Ctrl+Alt+Space' }, { type: 'next' }, { type: 'control' }, { type: 'next' });
    expect(currentStep(s)).toBe('done');
    expect(s.outcomes).toEqual({ profile: 'done', mic: 'skipped', echo: 'done', wake: 'skipped', trigger: 'done', control: 'done' });
    // Past the end: stays on done.
    expect(currentStep(run(s, { type: 'next' }, { type: 'skip' }))).toBe('done');
  });

  it('every step can be skipped straight through', () => {
    let s = initialSetupState(desktop, null);
    for (let i = 0; i < 10; i++) s = setupReducer(s, { type: 'skip' });
    expect(currentStep(s)).toBe('done');
    expect(Object.values(s.outcomes).every((o) => o === 'skipped')).toBe(true);
  });

  it('back keeps results; skipping a finished step on the way forward keeps it done', () => {
    let s = run(initialSetupState(desktop, 'desk'), { type: 'next' }, { type: 'heard', text: ' testing one two ' }, { type: 'next' });
    expect(s.heard).toBe('testing one two');
    s = run(s, { type: 'back' });
    expect(currentStep(s)).toBe('mic');
    s = run(s, { type: 'skip' });
    expect(s.outcomes.mic).toBe('done');
    expect(run(initialSetupState(desktop, null), { type: 'back' }).index).toBe(0);
  });

  it('goto jumps to a step that exists only', () => {
    const s = initialSetupState({ ...desktop, wakeAvailable: false }, null);
    expect(currentStep(run(s, { type: 'goto', step: 'trigger' }))).toBe('trigger');
    expect(run(s, { type: 'goto', step: 'wake' })).toBe(s);
  });

  it('the hub finishing loading adds steps without moving the user', () => {
    let s = run(initialSetupState({ platform: 'browser', wakeAvailable: false, devicesSupported: false }, null), { type: 'skip' }, { type: 'skip' });
    expect(currentStep(s)).toBe('echo');
    s = run(s, { type: 'env', env: { platform: 'browser', wakeAvailable: true, devicesSupported: true } });
    expect(currentStep(s)).toBe('echo');
    expect(s.steps).toContain('wake');
    expect(s.steps).toContain('control');
  });

  it('progress counts steps before the summary', () => {
    const s = initialSetupState(desktop, null);
    expect(progress(s)).toEqual({ at: 0, of: 6 });
    expect(progress(run(s, { type: 'goto', step: 'done' }))).toEqual({ at: 6, of: 6 });
  });
});

describe('summarize', () => {
  it('one line per step with a tone', () => {
    const s = run(
      initialSetupState(desktop, 'gaming'),
      { type: 'next' },
      { type: 'heard', text: 'Hello Herald' }, { type: 'next' },
      { type: 'echo', grade: 'good' }, { type: 'next' },
      { type: 'skip' },
      { type: 'trigger', label: 'Ctrl+Alt+Space' }, { type: 'next' },
      { type: 'skip' },
    );
    const lines = summarize(s, names);
    expect(lines.map((l) => [l.label, l.value, l.tone])).toEqual([
      ['Profile', 'Gaming', 'ok'],
      ['Microphone', 'Heard "Hello Herald"', 'ok'],
      ['Echo', 'No echo: interrupt is on the table', 'ok'],
      ['Wake word', 'Skipped', 'muted'],
      ['Trigger', 'Ctrl+Alt+Space', 'ok'],
      ['Main device', 'Unchanged', 'muted'],
    ]);
  });
});
