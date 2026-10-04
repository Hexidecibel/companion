import { describe, expect, it, vi } from 'vitest';

vi.mock('../ConnectionManager', () => ({ connectionManager: { getConnection: vi.fn() } }));

import {
  canContinue,
  canSkip,
  canVisit,
  DEVICE_FLOW,
  initWizard,
  nextIncomplete,
  SERVER_FLOW,
  serverHttpBase,
  stepIndex,
  wizardReducer,
  type WizardState,
} from '../setupWizard';

const run = (s: WizardState, ...actions: Parameters<typeof wizardReducer>[1][]) =>
  actions.reduce((acc, a) => wizardReducer(acc, a), s);

describe('setup wizard state machine', () => {
  it('a fresh device starts at welcome, then must pair before continuing', () => {
    let s = initWizard({ mode: 'device', paired: false });
    expect(s.current).toBe('welcome');
    s = wizardReducer(s, { type: 'next' });
    expect(s.current).toBe('pair');
    expect(canContinue(s)).toBe(false);
    expect(canSkip(s)).toBe(false);
    expect(wizardReducer(s, { type: 'next' })).toBe(s);
    expect(wizardReducer(s, { type: 'skip' })).toBe(s);
    // Only welcome / pair are reachable before pairing.
    expect(canVisit(s, 'herald')).toBe(false);
    expect(wizardReducer(s, { type: 'goto', step: 'herald' }).current).toBe('pair');
  });

  it('pairing with a daemon in setup mode switches to the full server flow', () => {
    let s = run(initWizard({ mode: 'device', paired: false }), { type: 'next' });
    s = wizardReducer(s, { type: 'paired', setupMode: true });
    expect(s.mode).toBe('server');
    expect(s.flow).toEqual(SERVER_FLOW);
    expect(s.current).toBe('name');
    expect(s.marks.pair).toBe('done');
  });

  it('pairing with an already set-up daemon continues the device flow', () => {
    let s = run(initWizard({ mode: 'device', paired: false }), { type: 'next' });
    s = wizardReducer(s, { type: 'paired', setupMode: false });
    expect(s.mode).toBe('device');
    expect(s.flow).toEqual(DEVICE_FLOW);
    expect(s.current).toBe('notifications');
    s = run(s, { type: 'skip' }, { type: 'next' });
    expect(s.current).toBe('done');
    expect(s.marks).toMatchObject({ notifications: 'skipped', herald: 'done' });
  });

  it('skipping only works on skippable steps; next marks done', () => {
    let s = initWizard({ mode: 'server', paired: true });
    expect(s.current).toBe('name');
    expect(canSkip(s)).toBe(false);
    s = wizardReducer(s, { type: 'next' });
    expect(s.current).toBe('machine');
    expect(s.marks.name).toBe('done');
    s = wizardReducer(s, { type: 'skip' });
    expect(s.current).toBe('claude');
    expect(s.marks.machine).toBe('skipped');
  });

  it('re-running skips completed steps but every step can be revisited', () => {
    const s = initWizard({
      mode: 'server',
      paired: true,
      marks: { welcome: 'done', name: 'done', machine: 'done', claude: 'skipped', projects: 'done' },
    });
    expect(s.current).toBe('session');
    const back = wizardReducer(s, { type: 'goto', step: 'name' });
    expect(back.current).toBe('name');
    // Moving on from a revisited step jumps over finished ones again.
    expect(wizardReducer(back, { type: 'next' }).current).toBe('session');
    const all = initWizard({ mode: 'server', paired: true, marks: Object.fromEntries(SERVER_FLOW.map((x) => [x, 'done'])) });
    expect(all.current).toBe('done');
  });

  it('back walks the flow; done is terminal for next', () => {
    let s = initWizard({ mode: 'server', paired: true });
    s = wizardReducer(s, { type: 'back' });
    expect(s.current).toBe('pair');
    s = wizardReducer(s, { type: 'goto', step: 'done' });
    expect(wizardReducer(s, { type: 'next' })).toBe(s);
    expect(stepIndex(s)).toEqual({ at: 12, of: 12 });
  });

  it('marks from the daemon merge in and keep pair done', () => {
    let s = initWizard({ mode: 'server', paired: true });
    s = wizardReducer(s, { type: 'marks', marks: { herald: 'skipped' } });
    expect(s.marks).toMatchObject({ pair: 'done', herald: 'skipped' });
    expect(nextIncomplete(SERVER_FLOW, { name: 'done' }, 'pair')).toBe('machine');
  });

  it('server http base handles IPv6 and TLS', () => {
    expect(serverHttpBase({ host: '192.168.1.5', port: 9877, useTls: false })).toBe('http://192.168.1.5:9877');
    expect(serverHttpBase({ host: 'fd00::1', port: 443, useTls: true })).toBe('https://[fd00::1]:443');
  });
});

describe('resume', () => {
  it('late marks with resume jump to the first unfinished step', () => {
    let s = initWizard({ mode: 'server', paired: true });
    expect(s.current).toBe('name');
    s = wizardReducer(s, { type: 'marks', marks: { name: 'done', machine: 'skipped' }, resume: true });
    expect(s.current).toBe('claude');
    const plain = wizardReducer(initWizard({ mode: 'server', paired: true }), { type: 'marks', marks: { name: 'done' } });
    expect(plain.current).toBe('name');
  });
});
