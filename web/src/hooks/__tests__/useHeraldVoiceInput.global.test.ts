import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('useHeraldVoiceInput: desktop global hold-to-talk', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= class {};
  });

  it('sends a global-shortcut transcript as its own voice turn, never via the composer', () => {
    const sendVoice = vi.fn();
    const host: VoiceInputHost = {
      getTransport: () => null,
      connected: true,
      serverStatus: status,
      stopSpeech: vi.fn(),
      openPanel: vi.fn(),
      speaking: false,
      sendVoice,
    };
    const { result } = renderHook(() => useHeraldVoiceInput(host));
    act(() => result.current.controller.deliverExternal('is the deploy done', 'global'));
    expect(sendVoice).toHaveBeenCalledWith('is the deploy done');
    expect(result.current.transcript).toBeNull();
  });
});
