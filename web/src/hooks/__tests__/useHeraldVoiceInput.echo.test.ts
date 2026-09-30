import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useHeraldVoiceInput, type VoiceInputHost } from '../useHeraldVoiceInput';
import { SpokenLog } from '../../services/voice/echoGuard';
import type { HeraldVoiceStatus } from '../../types/herald';

const status: HeraldVoiceStatus = {
  available: true,
  tts: { ready: true, voices: [], defaultVoice: null, sampleRate: 24000 },
  stt: { ready: true, model: 'base.en' },
  wake: { ready: false, models: [] },
  handsFreeOwner: false,
};

function mediaDevices(devices: Array<{ kind: string; label: string; deviceId: string }> = []) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => devices), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    configurable: true,
  });
}

function setup(over: Partial<VoiceInputHost> = {}) {
  const spokenLog = new SpokenLog();
  const host: VoiceInputHost = {
    getTransport: () => null,
    connected: true,
    serverStatus: status,
    stopSpeech: vi.fn(),
    openPanel: vi.fn(),
    speaking: false,
    sendVoice: vi.fn(),
    spokenLog,
    ...over,
  };
  const hook = renderHook(() => useHeraldVoiceInput(host));
  return { hook, host, spokenLog };
}

describe('useHeraldVoiceInput: self-echo', () => {
  beforeEach(() => {
    localStorage.clear();
    mediaDevices();
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= class {};
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("drops transcripts of Herald's own voice (interrupt, hands-free, trigger), keeps real ones", () => {
    const { hook, host, spokenLog } = setup();
    spokenLog.setSpeaking(true);
    spokenLog.record('Doc Upload Site shipped v2.28.0 to supdox.com.');
    act(() => hook.result.current.controller.deliverExternal('Doc Upload Site, shift V2.', 'interrupt'));
    expect(hook.result.current.transcript).toBeNull();
    act(() => hook.result.current.controller.deliverExternal('Doc Upload', 'wake'));
    expect(hook.result.current.transcript).toBeNull();
    act(() => hook.result.current.controller.deliverExternal('Doc upload site shipped', 'trigger'));
    expect(host.sendVoice).not.toHaveBeenCalled();
    act(() => hook.result.current.controller.deliverExternal('wait tell Out4 to hold', 'interrupt'));
    expect(hook.result.current.transcript).toMatchObject({ text: 'wait tell Out4 to hold', autoSend: true });
  });

  it('push-to-talk: a short answer is never dropped, a long echo is', () => {
    const { hook, spokenLog } = setup();
    spokenLog.setSpeaking(true);
    spokenLog.record('Should I restart it, yes or no?');
    act(() => hook.result.current.controller.deliverExternal('yes', 'button'));
    expect(hook.result.current.transcript).toMatchObject({ text: 'yes' });
    act(() => hook.result.current.consumeTranscript(hook.result.current.transcript!.id));
    act(() => hook.result.current.controller.deliverExternal('should I restart it yes or no', 'space'));
    expect(hook.result.current.transcript).toBeNull();
  });

  it('loop breaker: the 4th hands-off send within 20 s waits for review, with a notice; a key press resumes', () => {
    const { hook } = setup();
    const said = ['one thing', 'second thing', 'third thing', 'fourth thing'];
    for (const [i, t] of said.entries()) {
      act(() => hook.result.current.controller.deliverExternal(t, 'interrupt'));
      expect(hook.result.current.transcript).toMatchObject({ text: t, autoSend: i < 3 });
    }
    expect(hook.result.current.echoPaused).toBe(true);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
    expect(hook.result.current.echoPaused).toBe(false);
    act(() => hook.result.current.controller.deliverExternal('fifth thing', 'interrupt'));
    expect(hook.result.current.transcript).toMatchObject({ text: 'fifth thing', autoSend: true });
  });

  it('push-to-talk and hotkeys count as a person being there (never trip the breaker)', () => {
    const { hook } = setup();
    for (let i = 0; i < 6; i++) {
      act(() => hook.result.current.controller.deliverExternal(`message ${i}`, i % 2 ? 'interrupt' : 'button'));
    }
    expect(hook.result.current.echoPaused).toBe(false);
  });
});

describe('useHeraldVoiceInput: interrupt default', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= class {};
  });

  it('off with no preference and no headphones', async () => {
    mediaDevices([{ kind: 'audiooutput', label: 'MacBook Pro Speakers', deviceId: 'default' }]);
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.headphones).toBe(false));
    expect(hook.result.current.prefs.interrupt).toBe(false);
    expect(hook.result.current.prefs.interruptOrigin).toBe('auto');
  });

  it('on by itself with headphones', async () => {
    mediaDevices([{ kind: 'audiooutput', label: 'Default - AirPods Pro', deviceId: 'default' }]);
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.prefs.interrupt).toBe(true));
  });

  it('keeps a value saved by an older build (browser), and an explicit choice sticks', async () => {
    localStorage.setItem('herald_voice_input_prefs', JSON.stringify({ interrupt: true }));
    mediaDevices([{ kind: 'audiooutput', label: 'Speakers', deviceId: 'default' }]);
    const { hook } = setup();
    expect(hook.result.current.prefs.interrupt).toBe(true);
    expect(hook.result.current.prefs.interruptOrigin).toBe('saved');
    act(() => hook.result.current.setPref('interrupt', false));
    expect(hook.result.current.prefs.interrupt).toBe(false);
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('herald_voice_input_prefs')!);
      expect(saved).toMatchObject({ interrupt: false, interruptExplicit: true });
    });
  });

  it('auto is not persisted (headphones can still turn it on later)', async () => {
    mediaDevices([]);
    setup();
    await waitFor(() => expect(localStorage.getItem('herald_voice_input_prefs')).not.toBeNull());
    expect(JSON.parse(localStorage.getItem('herald_voice_input_prefs')!).interrupt).toBeUndefined();
  });
});
