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
import { resetInteraction, setViewedSessions, toneStore } from '../../services/tts/tonePolicy';

class MockEngine implements TtsEngine {
  readonly id = 'mock';
  readonly available = true;
  get speaking() { return false; }
  speak() {}
  cancel() {}
  getVoices(): TtsVoice[] { return []; }
  unlock() {}
  on(_l: (e: TtsEvent) => void) { return () => {}; }
  dispose() {}
}

function setup() {
  const listeners = new Set<HeraldEventListener>();
  const subscribe = (l: HeraldEventListener) => { listeners.add(l); return () => { listeners.delete(l); }; };
  const hook = renderHook(() => useHeraldVoice(subscribe, 'hub', new MockEngine()));
  const emit = (e: HeraldEvent) => act(() => { listeners.forEach((l) => l(e, 'push')); });
  return { hook, emit };
}

const blocked = (id: string, sessionId = id): HeraldInboxItem => ({
  id, serverId: 'local', sessionId, sessionName: sessionId, priority: 'blocked', headline: 'needs you', createdAt: 1, heard: false,
});

describe('useHeraldVoice tone policy', () => {
  beforeEach(() => {
    localStorage.clear();
    toneStore.reset();
    resetInteraction();
    setViewedSessions([]);
    vi.mocked(playChime).mockClear();
  });
  afterEach(() => setViewedSessions([]));

  it('a blocked item tones once', () => {
    const { emit } = setup();
    emit({ kind: 'inbox', inbox: [] });
    emit({ kind: 'inbox', inbox: [blocked('a')] });
    expect(playChime).toHaveBeenCalledWith('blocked');
  });

  it('no tone for the session on screen (hub "local" mapped to this connection)', () => {
    setViewedSessions([{ serverId: 'hub', sessionId: 'out4' }]);
    const { emit } = setup();
    emit({ kind: 'inbox', inbox: [] });
    emit({ kind: 'inbox', inbox: [blocked('a', 'out4')] });
    expect(playChime).not.toHaveBeenCalled();
  });

  it('no tone right after a key press in the app', () => {
    const { emit } = setup();
    emit({ kind: 'inbox', inbox: [] });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
    emit({ kind: 'inbox', inbox: [blocked('a')] });
    expect(playChime).not.toHaveBeenCalled();
  });

  it('quiet for an hour from the hook', () => {
    const { emit, hook } = setup();
    act(() => hook.result.current.quietTones());
    expect(hook.result.current.tones.quietUntil).toBeGreaterThan(Date.now());
    emit({ kind: 'inbox', inbox: [] });
    emit({ kind: 'inbox', inbox: [blocked('a')] });
    expect(playChime).not.toHaveBeenCalled();
  });

  it('existing users: old saved prefs (reminders on by the old default) get reminders off', () => {
    localStorage.setItem('herald_voice_prefs', JSON.stringify({ voiceOn: true, chimeOn: true, remind: true, riskTones: true }));
    const { hook } = setup();
    expect(hook.result.current.remind).toBe(false);
    expect(hook.result.current.riskTones).toBe(false);
    act(() => hook.result.current.setRemind(true));
    const { hook: again } = setup();
    expect(again.result.current.remind).toBe(true);
  });
});
