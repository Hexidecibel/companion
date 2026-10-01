import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useHeraldVoiceInput, type VoiceInputHost } from '../useHeraldVoiceInput';
import type { HeraldVoiceEvent, HeraldVoiceStatus } from '../../types/herald';
import type { HeraldTransport } from '../../services/heraldTransport';

// No real VAD in jsdom (its start failure would turn hands-free off).
vi.mock('../../services/voice/vadListener', () => ({
  VAD_PRESETS: {},
  VadListener: class {
    running = false;
    async start() { this.running = true; }
    pause() { this.running = false; }
    setSensitivity() {}
    destroy() {}
  },
}));

const status: HeraldVoiceStatus = {
  available: true,
  tts: { ready: true, voices: [], defaultVoice: null, sampleRate: 24000 },
  stt: { ready: true, model: 'base.en' },
  wake: { ready: true, models: ['hey_jarvis'] },
  handsFreeOwner: false,
};

function fakeTransport() {
  const handlers = new Set<(ev: HeraldVoiceEvent) => void>();
  const request = vi.fn(async (type: string) => ({
    type,
    success: true,
    payload: type === 'herald_handsfree' ? { owner: true } : {},
  }));
  const t: HeraldTransport = {
    isConnected: () => true,
    request: request as unknown as HeraldTransport['request'],
    onEvent: () => () => {},
    onConnectivity: () => () => {},
    fire: () => true,
    onVoiceEvent: (h) => {
      handlers.add(h);
      return () => { handlers.delete(h); };
    },
  };
  return { t, request, handlers };
}

/**
 * The native apps connect to several hubs. When the preferred Herald hub
 * connects after another one, the host switches while `connected` stays true.
 * The hands-free request and the voice-event subscription must follow the
 * host, or wake events from the new hub never arrive (production: the wake
 * word was detected, the client never heard of it and discarded the stream).
 */
describe('useHeraldVoiceInput: switching Herald hubs', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('herald_voice_input_prefs', JSON.stringify({ handsFree: true }));
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= class {};
  });

  it('re-subscribes and re-requests hands-free on the new hub, and releases the old one', async () => {
    const a = fakeTransport();
    const b = fakeTransport();
    let current: HeraldTransport | null = a.t;
    const base: Omit<VoiceInputHost, 'hostId'> = {
      getTransport: () => current,
      connected: true,
      serverStatus: status,
      stopSpeech: vi.fn(),
      openPanel: vi.fn(),
      speaking: false,
    };
    const hook = renderHook((p: { hostId: string }) => useHeraldVoiceInput({ ...base, hostId: p.hostId }), {
      initialProps: { hostId: 'other-hub' },
    });
    await act(async () => {});
    expect(a.request).toHaveBeenCalledWith('herald_handsfree', { on: true }, 5000);
    expect(a.handlers.size).toBe(1);

    // The preferred hub connects: same `connected`, new transport.
    current = b.t;
    hook.rerender({ hostId: 'hexi' });
    await act(async () => {});

    expect(b.request).toHaveBeenCalledWith('herald_handsfree', { on: true }, 5000);
    expect(b.handlers.size).toBe(1);
    expect(a.handlers.size).toBe(0);
    expect(a.request).toHaveBeenLastCalledWith('herald_handsfree', { on: false }, 5000);
    expect(hook.result.current.handsFreeActive).toBe(true);
  });

  it('a hands-free revocation from the new hub reaches this device', async () => {
    const a = fakeTransport();
    const b = fakeTransport();
    let current: HeraldTransport | null = a.t;
    const base: Omit<VoiceInputHost, 'hostId'> = {
      getTransport: () => current,
      connected: true,
      serverStatus: status,
      stopSpeech: vi.fn(),
      openPanel: vi.fn(),
      speaking: false,
    };
    const hook = renderHook((p: { hostId: string }) => useHeraldVoiceInput({ ...base, hostId: p.hostId }), {
      initialProps: { hostId: 'other-hub' },
    });
    await act(async () => {});
    current = b.t;
    hook.rerender({ hostId: 'hexi' });
    await act(async () => {});
    act(() => { for (const h of b.handlers) h({ kind: 'handsfree_revoked' }); });
    expect(hook.result.current.prefs.handsFree).toBe(false);
  });
});
