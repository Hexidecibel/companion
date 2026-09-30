import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEnvironment } from '../../services/voice/audioEnvironment';

const envMock = vi.hoisted(() => ({
  listeners: new Set<(e: AudioEnvironment) => void>(),
  initial: { output: 'speakers', input: 'builtin', aec: 'browser' } as AudioEnvironment,
}));
vi.mock('../../services/voice/audioEnvironment', () => ({
  getAudioEnvironment: () => Promise.resolve(envMock.initial),
  onAudioEnvironmentChange: (cb: (e: AudioEnvironment) => void) => {
    envMock.listeners.add(cb);
    return () => envMock.listeners.delete(cb);
  },
  measureEchoSuppression: () => Promise.resolve({ erleDb: 0, residualSpeechDetected: false }),
}));

import { useHeraldSetup, type SetupHost } from '../useHeraldSetup';
import { heraldSetupStore } from '../../services/heraldSetup/setupStore';
import { tipsStore } from '../../services/heraldSetup/tips';
import type { HeraldVoice } from '../useHeraldVoice';
import type { HeraldVoiceInput } from '../useHeraldVoiceInput';

function makeHost(over: Partial<SetupHost> = {}): SetupHost {
  const voice = {
    voiceOn: true, chimeOn: true, remind: true, spokenLength: 'short', announcer: true,
    setVoiceOn: vi.fn(), setChimeOn: vi.fn(), setRemind: vi.fn(), setSpokenLength: vi.fn(),
  } as unknown as HeraldVoice;
  const input = {
    prefs: { interrupt: false, interruptOrigin: 'auto', sensitivity: 'normal', reviewBeforeSend: false, spaceToTalk: true, handsFree: false },
    setPref: vi.fn(), setHandsFree: vi.fn(), headphones: null, handsFreeActive: false,
  } as unknown as HeraldVoiceInput;
  return { voice, input, available: false, actions: [], inbox: [], ...over };
}

const fire = (e: AudioEnvironment) => act(() => { envMock.listeners.forEach((l) => l(e)); });
const headphones: AudioEnvironment = { output: 'headphones', input: 'headset', aec: 'browser', outputLabel: 'Sony WH-1000XM5' };

beforeEach(() => {
  localStorage.clear();
  heraldSetupStore.reset();
  tipsStore.reset();
  envMock.listeners.clear();
});

describe('useHeraldSetup', () => {
  it('suggests a profile when headphones are plugged in; Switch applies it', async () => {
    heraldSetupStore.set('profile', 'desk');
    const host = makeHost();
    const { result } = renderHook(() => useHeraldSetup(host));
    await act(async () => {});
    expect(result.current.suggestion).toBeNull(); // first reading: no change yet
    fire(headphones);
    expect(result.current.suggestion?.message).toBe('Sony WH-1000XM5 connected. Switch to the Headphones profile?');
    act(() => result.current.acceptSuggestion());
    expect(heraldSetupStore.get().profile).toBe('headphones');
    expect(host.input.setPref).toHaveBeenCalledWith('interrupt', true);
    expect(result.current.suggestion).toBeNull();
  });

  it('Not now remembers the change and never suggests it again', async () => {
    heraldSetupStore.set('profile', 'desk');
    const { result } = renderHook(() => useHeraldSetup(makeHost()));
    await act(async () => {});
    fire(headphones);
    act(() => result.current.dismissSuggestion());
    fire(envMock.initial);
    fire(headphones);
    expect(result.current.suggestion).toBeNull();
    expect(heraldSetupStore.get().profile).toBe('desk');
  });

  it('switches by itself only with "switch automatically" on', async () => {
    heraldSetupStore.patch({ profile: 'desk', autoSwitch: true });
    const { result } = renderHook(() => useHeraldSetup(makeHost()));
    await act(async () => {});
    fire(headphones);
    expect(heraldSetupStore.get().profile).toBe('headphones');
    expect(result.current.suggestion).toBeNull();
    expect(result.current.autoNote).toBe('Switched to Headphones');
  });

  it('no profile chosen yet: no banner (the device check picks), and the check opens once Herald is usable', async () => {
    const host = makeHost();
    const { result, rerender } = renderHook((h: SetupHost) => useHeraldSetup(h), { initialProps: host });
    await act(async () => {});
    fire(headphones);
    expect(result.current.suggestion).toBeNull();
    expect(result.current.recommended).toBe('headphones');
    expect(result.current.checkOpen).toBe(false);
    rerender({ ...host, available: true });
    expect(result.current.checkOpen).toBe(true);
    act(() => result.current.closeCheck());
    expect(heraldSetupStore.get().onboarded).toBe(true);
  });

  it('a failed echo check turns talk-over off on the Desk profile', async () => {
    heraldSetupStore.set('profile', 'desk');
    const host = makeHost();
    (host.input.prefs as { interrupt: boolean }).interrupt = true;
    const { result } = renderHook(() => useHeraldSetup(host));
    await act(async () => {});
    act(() => result.current.recordEcho({ erleDb: 8, residualSpeechDetected: true }));
    expect(heraldSetupStore.get().echo?.erleDb).toBe(8);
    expect(host.input.setPref).toHaveBeenCalledWith('interrupt', false);
  });

  it('tips: a red card appearing queues its tip once', async () => {
    const host = makeHost();
    const { rerender } = renderHook((h: SetupHost) => useHeraldSetup(h), { initialProps: host });
    await act(async () => {});
    const card = { id: 'a', status: 'pending', tier: 'hard_confirm' } as SetupHost['actions'][number];
    rerender({ ...host, actions: [card] });
    rerender({ ...host, actions: [] });
    rerender({ ...host, actions: [card] });
    expect(tipsStore.get().queue).toEqual(['red_card']);
  });
});
