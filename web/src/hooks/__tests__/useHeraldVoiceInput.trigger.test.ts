import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useHeraldVoiceInput, type VoiceInputHost } from '../useHeraldVoiceInput';
import type { HeraldVoiceStatus } from '../../types/herald';

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

describe('useHeraldVoiceInput: remote-trigger speech', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= class {};
  });
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('sends trigger transcripts as their own voice turn and never fills the composer', () => {
    const { hook, sendVoice } = setup();
    act(() => hook.result.current.controller.deliverExternal('what finished while I was away', 'trigger'));
    expect(sendVoice).toHaveBeenCalledWith('what finished while I was away');
    // The composer is driven by `transcript`: untouched, so a half-typed draft survives.
    expect(hook.result.current.transcript).toBeNull();
    // Other sources still go through the composer as before.
    act(() => hook.result.current.controller.deliverExternal('hello there', 'wake'));
    expect(hook.result.current.transcript).toMatchObject({ text: 'hello there', autoSend: true, mode: 'voice' });
    expect(sendVoice).toHaveBeenCalledTimes(1);
  });

  it('local voice commands still apply to trigger speech (nothing is sent)', () => {
    const onVoiceTranscript = vi.fn((text: string) => (/^stop\.?$/i.test(text) ? null : text));
    const { hook, sendVoice } = setup({ onVoiceTranscript });
    act(() => hook.result.current.controller.deliverExternal('Stop.', 'trigger'));
    expect(onVoiceTranscript).toHaveBeenCalledWith('Stop.', 'trigger');
    expect(sendVoice).not.toHaveBeenCalled();
    expect(hook.result.current.transcript).toBeNull();
  });

  it('a hidden tab without mic permission refuses to listen (never prompts unseen)', async () => {
    const { hook } = setup();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    let reason: string | null = null;
    await act(async () => { reason = await hook.result.current.listen(); });
    expect(reason).toMatch(/Microphone not allowed yet/);
    expect(hook.result.current.isCapturing()).toBe(false);
  });

  it('reports why when voice input is unavailable', async () => {
    const { hook } = setup({ connected: false });
    let reason: string | null = null;
    await act(async () => { reason = await hook.result.current.listen(); });
    expect(reason).toBe('Not connected to the Herald host');
  });
});
