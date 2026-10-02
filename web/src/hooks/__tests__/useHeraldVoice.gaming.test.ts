import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('../../services/tts/chime', async (orig) => ({
  ...(await orig<typeof import('../../services/tts/chime')>()),
  playChime: vi.fn(),
}));

import { useHeraldVoice } from '../useHeraldVoice';
import type { HeraldEventListener } from '../useHerald';
import type { TtsEngine, TtsEvent, TtsVoice } from '../../services/tts/types';
import type { HeraldEvent, HeraldInboxItem } from '../../types/herald';
import { playChime } from '../../services/tts/chime';
import { heraldSetupStore } from '../../services/heraldSetup/setupStore';

class MockEngine implements TtsEngine {
  readonly id = 'mock';
  readonly available = true;
  spoken: string[] = [];
  cancels = 0;
  get speaking() { return false; }
  speak(text: string) { this.spoken.push(text); }
  cancel() { this.cancels++; }
  getVoices(): TtsVoice[] { return []; }
  unlock() {}
  on(_l: (e: TtsEvent) => void) { return () => {}; }
  dispose() {}
}

function setup() {
  const listeners = new Set<HeraldEventListener>();
  const subscribe = (l: HeraldEventListener) => { listeners.add(l); return () => { listeners.delete(l); }; };
  const engine = new MockEngine();
  const hook = renderHook(() => useHeraldVoice(subscribe, 'hub', engine));
  const emit = (e: HeraldEvent, source: 'push' | 'fetch' = 'push') => act(() => { listeners.forEach((l) => l(e, source)); });
  return { engine, hook, emit };
}

const item = (id: string): HeraldInboxItem => ({
  id, serverId: 's', sessionId: 'out4', sessionName: 'Out4', priority: 'blocked', headline: 'Out4 needs you', createdAt: 1, heard: false,
});
const hide = (hidden: boolean) => Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });

describe('useHeraldVoice in the Gaming profile (the game is in front)', () => {
  beforeEach(() => {
    localStorage.clear();
    heraldSetupStore.reset();
    vi.mocked(playChime).mockClear();
  });
  afterEach(() => hide(false));

  it('news tones still play with the tab hidden behind a full-screen game', () => {
    heraldSetupStore.set('profile', 'gaming');
    const { emit } = setup();
    emit({ kind: 'inbox', inbox: [] });
    hide(true);
    emit({ kind: 'inbox', inbox: [item('a')] });
    expect(playChime).toHaveBeenCalledWith('blocked');
  });

  it('risky-change items play the risk tone and are never spoken', () => {
    heraldSetupStore.set('profile', 'gaming');
    const { emit, engine } = setup();
    emit({ kind: 'inbox', inbox: [] });
    hide(true);
    emit({ kind: 'inbox', inbox: [{ ...item('r'), priority: 'finished', headline: 'Out4 changed a CI workflow: deploy.yml', review: { level: 'high', kinds: ['ci'], paths: ['.github/workflows/deploy.yml'] } }] });
    expect(playChime).toHaveBeenCalledWith('risk');
    expect(engine.spoken).toEqual([]);
  });

  it('the riskTones pref silences the risk tone', () => {
    heraldSetupStore.set('profile', 'gaming');
    const { emit, hook } = setup();
    act(() => { hook.result.current.setRiskTones(false); });
    vi.mocked(playChime).mockClear();
    emit({ kind: 'inbox', inbox: [] });
    emit({ kind: 'inbox', inbox: [{ ...item('r'), priority: 'finished', review: { level: 'high', kinds: ['ci'], paths: ['x'] } }] });
    expect(playChime).not.toHaveBeenCalled();
  });

  it('outside Gaming a hidden tab stays silent (unchanged)', () => {
    heraldSetupStore.set('profile', 'headphones');
    const { emit } = setup();
    emit({ kind: 'inbox', inbox: [] });
    hide(true);
    emit({ kind: 'inbox', inbox: [item('b')] });
    expect(playChime).not.toHaveBeenCalled();
  });

  it('alt-tabbing into the game does not cut off a reply the trigger asked for', () => {
    const { engine, hook } = setup();
    act(() => hook.result.current.allowBackground());
    const before = engine.cancels;
    hide(true);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(engine.cancels).toBe(before);
    act(() => hook.result.current.allowBackground(-1));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(engine.cancels).toBeGreaterThan(before);
  });
});
