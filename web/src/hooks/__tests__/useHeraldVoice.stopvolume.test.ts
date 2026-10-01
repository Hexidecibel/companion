import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useHeraldVoice } from '../useHeraldVoice';
import type { HeraldEventListener } from '../useHerald';
import type { TtsEngine, TtsEvent, TtsVoice } from '../../services/tts/types';
import type { HeraldTransport } from '../../services/heraldTransport';
import type { HeraldEvent } from '../../types/herald';
import { heraldVolumeStore } from '../../services/tts/volume';
import { planStop } from '../../services/voice/fleetSpeaking';
import { runHeraldTrigger, type TriggerActions } from '../../services/voice/heraldTrigger';

class MockEngine implements TtsEngine {
  readonly id = 'mock';
  readonly available = true;
  playing = false;
  said: string[] = [];
  cancels = 0;
  private ls = new Set<(e: TtsEvent) => void>();
  get speaking() { return this.playing; }
  speak(text: string) { this.said.push(text); }
  cancel() { this.cancels++; this.setPlaying(false); }
  getVoices(): TtsVoice[] { return []; }
  unlock() {}
  on(l: (e: TtsEvent) => void) { this.ls.add(l); return () => { this.ls.delete(l); }; }
  dispose() {}
  setPlaying(v: boolean) {
    if (this.playing === v) return;
    this.playing = v;
    for (const l of this.ls) l({ type: 'speaking', speaking: v });
  }
}

function transport() {
  const calls: Array<{ type: string; payload: any }> = [];
  const t: HeraldTransport = {
    isConnected: () => true,
    request: async (type, payload) => {
      calls.push({ type, payload });
      if (type === 'herald_presence') return { type, success: true, payload: { announcer: true, clientId: 'me' } };
      return { type, success: true, payload: {} };
    },
    onEvent: () => () => {},
    onConnectivity: () => () => {},
    onVoiceEvent: () => () => {},
  };
  return { t, calls };
}

function setup() {
  const engine = new MockEngine();
  const { t, calls } = transport();
  let listener: HeraldEventListener | null = null;
  const subscribe = (l: HeraldEventListener) => { listener = l; return () => { listener = null; }; };
  const hook = renderHook(() => useHeraldVoice(subscribe, 'hub', engine, { getTransport: () => t, connected: true }));
  const push = (e: HeraldEvent) => act(() => listener!(e, 'push'));
  const stops = () => calls.filter((c) => c.type === 'herald_stop_speaking').map((c) => c.payload);
  return { engine, hook, calls, push, stops };
}

describe('planStop', () => {
  it('this device speaking: stop here only', () => {
    expect(planStop({ localSpeaking: true, remote: null })).toEqual({ local: true, hub: null });
  });
  it('another device known to be speaking: ask the hub to stop that one', () => {
    expect(planStop({ localSpeaking: false, remote: { deviceId: 'mac', label: 'Mac', utteranceId: 'u1' } }))
      .toEqual({ local: true, hub: { deviceId: 'mac' } });
  });
  it('nothing speaking here and no signal seen: the hub stops whoever speaks', () => {
    expect(planStop({ localSpeaking: false, remote: null })).toEqual({ local: true, hub: {} });
  });
});

describe('useHeraldVoice: stop everywhere', () => {
  beforeEach(() => {
    localStorage.clear();
    heraldVolumeStore.reset();
  });

  it('speaking here: stops here, nothing sent to the hub', async () => {
    const { engine, hook, stops } = setup();
    await waitFor(() => expect(hook.result.current.selfId).toBe('me'));
    act(() => engine.setPlaying(true));
    act(() => hook.result.current.stopCommand());
    expect(engine.cancels).toBeGreaterThan(0);
    expect(stops()).toEqual([]);
    expect(hook.result.current.flash).toBe('Stopped');
  });

  it('another device speaking (remote stop): the hub is asked to stop THAT device', async () => {
    const { hook, push, stops } = setup();
    await waitFor(() => expect(hook.result.current.selfId).toBe('me'));
    push({ kind: 'speaking', speaking: { active: true, deviceId: 'mac', label: 'Mac', utteranceId: 'u1', remainingMs: 3000 } });
    expect(hook.result.current.remoteSpeaking?.deviceId).toBe('mac');
    act(() => hook.result.current.stopCommand());
    await waitFor(() => expect(stops()).toEqual([{ deviceId: 'mac' }]));
  });

  it('quiet here and no signal: the hub still gets a stop (it knows the speaker)', async () => {
    const { hook, stops } = setup();
    await waitFor(() => expect(hook.result.current.selfId).toBe('me'));
    act(() => hook.result.current.stopCommand());
    await waitFor(() => expect(stops()).toEqual([{}]));
  });

  it('the stop shortcut / tray / orb path (stop trigger) stops a remote speaker', async () => {
    const { hook, push, stops } = setup();
    await waitFor(() => expect(hook.result.current.selfId).toBe('me'));
    push({ kind: 'speaking', speaking: { active: true, deviceId: 'phone', label: 'Phone', utteranceId: 'u2', remainingMs: 3000 } });
    const actions: TriggerActions = {
      speaking: () => !!hook.result.current.remoteSpeaking,
      capturing: () => false,
      stopSpeech: () => hook.result.current.stopCommand(),
      cancelCapture: vi.fn(),
      listen: async () => null,
      brief: vi.fn(),
      repeat: () => false,
      allowBackground: vi.fn(),
      tone: vi.fn(),
      notice: vi.fn(),
    };
    let outcome = '';
    await act(async () => { outcome = await runHeraldTrigger('stop', actions); });
    expect(outcome).toBe('stopped');
    await waitFor(() => expect(stops()).toEqual([{ deviceId: 'phone' }]));
  });
});

describe('useHeraldVoice: volume commands', () => {
  beforeEach(() => {
    localStorage.clear();
    heraldVolumeStore.reset();
  });

  it('louder: one 15 % step, persisted, confirmed out loud at the new level', () => {
    const { engine, hook } = setup();
    act(() => hook.result.current.volumeCommand({ kind: 'step', dir: 1 }));
    expect(heraldVolumeStore.get().voice).toBe(1.15);
    expect(hook.result.current.volume.voice).toBe(1.15);
    expect(JSON.parse(localStorage.getItem('herald_volume')!).voice).toBe(1.15);
    expect(engine.said[engine.said.length - 1]).toBe('Volume 115.');
    expect(hook.result.current.flash).toBe('Volume 115%');
  });

  it('volume 50 / quieter / limits', () => {
    const { engine, hook } = setup();
    act(() => hook.result.current.volumeCommand({ kind: 'set', value: 0.5 }));
    expect(heraldVolumeStore.get().voice).toBe(0.5);
    act(() => hook.result.current.volumeCommand({ kind: 'step', dir: -1 }));
    expect(heraldVolumeStore.get().voice).toBe(0.35);
    act(() => hook.result.current.volumeCommand({ kind: 'set', value: 1.5 }));
    act(() => hook.result.current.volumeCommand({ kind: 'step', dir: 1 }));
    expect(heraldVolumeStore.get().voice).toBe(1.5);
    expect(engine.said[engine.said.length - 1]).toBe("That's as loud as I go.");
  });

  it('volume 0 mutes without trying to say so', () => {
    const { engine, hook } = setup();
    act(() => hook.result.current.volumeCommand({ kind: 'set', value: 0 }));
    expect(heraldVolumeStore.get().voice).toBe(0);
    expect(engine.said).toEqual([]);
    expect(hook.result.current.flash).toBe('Muted');
  });

  it('the slider sets the store; tones can follow or not', () => {
    const { hook } = setup();
    act(() => hook.result.current.setVolume(0.8));
    act(() => hook.result.current.setTonesVolume(0.5));
    act(() => hook.result.current.setTonesFollowVoice(false));
    expect(hook.result.current.volume).toEqual({ voice: 0.8, tones: 0.5, tonesFollowVoice: false });
  });
});
