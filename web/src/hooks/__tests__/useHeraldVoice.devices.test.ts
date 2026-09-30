import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useHeraldVoice } from '../useHeraldVoice';
import type { HeraldEventListener } from '../useHerald';
import type { TtsEngine, TtsEvent, TtsVoice } from '../../services/tts/types';
import type { HeraldTransport } from '../../services/heraldTransport';
import { heraldReducer, initialHeraldClientState } from '../../services/heraldReducer';

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

function transport() {
  const calls: Array<{ type: string; payload: any }> = [];
  const t: HeraldTransport = {
    isConnected: () => true,
    request: async (type, payload) => {
      calls.push({ type, payload });
      if (type === 'herald_presence') return { type, success: true, payload: { announcer: false, clientId: 'conn-7' } };
      if (type === 'herald_claim_device') return { type, success: true, payload: { activeDevice: null, devices: [] } };
      return { type, success: false, error: 'nope' };
    },
    onEvent: () => () => {},
    onConnectivity: () => () => {},
    onVoiceEvent: () => () => {},
  };
  return { t, calls };
}

describe('useHeraldVoice: device identity and claiming', () => {
  beforeEach(() => localStorage.clear());

  it('reports presence with a label and device key, learns its own id, claims and renames', async () => {
    localStorage.setItem('herald_device_label', 'Windows PC');
    const { t, calls } = transport();
    const subscribe = (_l: HeraldEventListener) => () => {};
    const hook = renderHook(() => useHeraldVoice(subscribe, 'hub', new MockEngine(), { getTransport: () => t, connected: true }));
    await waitFor(() => expect(hook.result.current.selfId).toBe('conn-7'));
    const presence = calls.find((c) => c.type === 'herald_presence')!;
    expect(presence.payload).toMatchObject({ interacted: false, label: 'Windows PC' });
    expect(presence.payload.deviceKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(hook.result.current.deviceLabel).toBe('Windows PC');

    let err: string | null = 'x';
    await act(async () => { err = await hook.result.current.claimDevice(true); });
    expect(err).toBeNull();
    expect(calls.find((c) => c.type === 'herald_claim_device')!.payload).toEqual({ pin: true });
    await act(async () => { await hook.result.current.claimDevice(false, 'other'); });
    expect(calls.filter((c) => c.type === 'herald_claim_device')[1].payload).toEqual({ pin: false, deviceId: 'other' });

    act(() => hook.result.current.renameDevice('Gaming PC'));
    expect(hook.result.current.deviceLabel).toBe('Gaming PC');
    await waitFor(() => expect(calls.filter((c) => c.type === 'herald_presence').pop()!.payload.label).toBe('Gaming PC'));
  });
});

describe('heraldReducer: devices event', () => {
  it('folds the active device and device list into state', () => {
    const s = heraldReducer(initialHeraldClientState, {
      type: 'event',
      receivedAt: 1,
      event: {
        kind: 'devices',
        activeDevice: { id: 'pc', label: 'Windows PC', pinned: true, reason: 'claimed' },
        devices: [{ id: 'pc', label: 'Windows PC', handsFree: false }],
      },
    });
    expect(s.server?.activeDevice).toMatchObject({ id: 'pc', pinned: true });
    expect(s.server?.devices).toHaveLength(1);
  });
});
