import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useHeraldVoiceInput, type VoiceInputHost } from '../useHeraldVoiceInput';
import type { HeraldVoiceStatus } from '../../types/herald';
import { SpokenLog } from '../../services/voice/echoGuard';
import { heraldSetupStore } from '../../services/heraldSetup/setupStore';

const status: HeraldVoiceStatus = {
  available: true,
  tts: { ready: true, voices: [], defaultVoice: null, sampleRate: 24000 },
  stt: { ready: true, model: 'base.en' },
  wake: { ready: false, models: [] },
  handsFreeOwner: false,
};

function setup(over: Partial<VoiceInputHost> = {}) {
  const sendVoice = vi.fn();
  const host: VoiceInputHost = {
    getTransport: () => null,
    connected: true,
    serverStatus: status,
    stopSpeech: vi.fn(),
    openPanel: vi.fn(),
    speaking: false,
    sendVoice,
    ...over,
  };
  const hook = renderHook(() => useHeraldVoiceInput(host));
  return { hook, sendVoice };
}

describe('useHeraldVoiceInput: follow-up window', () => {
  beforeEach(() => {
    localStorage.clear();
    heraldSetupStore.reset();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= class {};
  });

  it('a follow-up transcript goes straight out as a voice turn (the panel may be closed)', () => {
    const { hook, sendVoice } = setup();
    act(() => hook.result.current.controller.deliverExternal('and the web tests?', 'followup'));
    expect(sendVoice).toHaveBeenCalledWith('and the web tests?');
    expect(hook.result.current.transcript).toBeNull();
  });

  it("Herald's own voice heard in the window is dropped (self-echo filter applies)", () => {
    const log = new SpokenLog();
    log.record('Out4 finished its deploy ten minutes ago.');
    log.setSpeaking(true);
    log.setSpeaking(false);
    const { hook, sendVoice } = setup({ spokenLog: log });
    act(() => hook.result.current.controller.deliverExternal('finished its deploy ten minutes ago', 'followup'));
    expect(sendVoice).not.toHaveBeenCalled();
    expect(hook.result.current.transcript).toBeNull();
  });

  it('the loop breaker holds follow-ups for review after a burst with nobody touching anything', () => {
    const { hook, sendVoice } = setup();
    for (let i = 0; i < 4; i++) act(() => hook.result.current.controller.deliverExternal(`question number ${i}`, 'followup'));
    expect(sendVoice).toHaveBeenCalledTimes(3);
    expect(hook.result.current.transcript).toMatchObject({ text: 'question number 3', autoSend: false });
    expect(hook.result.current.echoPaused).toBe(true);
  });

  it('review-before-send puts a follow-up in the composer instead', () => {
    localStorage.setItem('herald_voice_input_prefs', JSON.stringify({ reviewBeforeSend: true }));
    const { hook, sendVoice } = setup();
    act(() => hook.result.current.controller.deliverExternal('and then?', 'followup'));
    expect(sendVoice).not.toHaveBeenCalled();
    expect(hook.result.current.transcript).toMatchObject({ text: 'and then?', autoSend: false });
  });

  it('never opens without mic permission (it must not prompt) or when turned off', () => {
    localStorage.setItem('herald_voice_input_prefs', JSON.stringify({ followUp: true }));
    const { hook } = setup();
    expect(hook.result.current.followUpOn).toBe(true);
    let opened = true;
    act(() => { opened = hook.result.current.openFollowUp(); });
    expect(opened).toBe(false); // mic not granted yet in this test environment
    localStorage.setItem('herald_voice_input_prefs', JSON.stringify({ followUp: false }));
    const off = setup();
    expect(off.hook.result.current.followUpOn).toBe(false);
  });

  it('automatic follow-up stays off in the Gaming profile even with a headset', () => {
    heraldSetupStore.set('profile', 'gaming');
    const { hook } = setup();
    expect(hook.result.current.prefs.followUp).toBeNull();
    expect(hook.result.current.followUpOn).toBe(false);
  });
});
