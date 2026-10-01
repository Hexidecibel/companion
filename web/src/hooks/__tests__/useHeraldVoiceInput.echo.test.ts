import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useHeraldVoiceInput, type VoiceInputHost } from '../useHeraldVoiceInput';
import { SpokenLog } from '../../services/voice/echoGuard';
import { isPendingConfirmPhrase } from '../../services/voice/confirmPhrase';
import type { HeraldAction, HeraldVoiceStatus } from '../../types/herald';

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
    // A trigger is a gesture: only a long, close echo is dropped (strict rule)...
    act(() => hook.result.current.controller.deliverExternal('Doc upload site shipped v2', 'trigger'));
    expect(host.sendVoice).not.toHaveBeenCalled();
    // ...a short one goes through (echo cancellation handles those now).
    act(() => hook.result.current.controller.deliverExternal('Doc upload site shipped', 'trigger'));
    expect(host.sendVoice).toHaveBeenCalledWith('Doc upload site shipped');
    host.sendVoice.mockClear();
    act(() => hook.result.current.controller.deliverExternal('wait tell Out4 to hold', 'interrupt'));
    expect(hook.result.current.transcript).toMatchObject({ text: 'wait tell Out4 to hold', autoSend: true });
  });

  it('push-to-talk: a short answer or a question is never dropped, a long close echo is', () => {
    const { hook, spokenLog } = setup();
    spokenLog.setSpeaking(true);
    spokenLog.record('Should I restart it, yes or no?');
    spokenLog.record('Out4 finished the refund migration and the deploy checks passed.');
    act(() => hook.result.current.controller.deliverExternal('yes', 'button'));
    expect(hook.result.current.transcript).toMatchObject({ text: 'yes' });
    act(() => hook.result.current.consumeTranscript(hook.result.current.transcript!.id));
    // A question is never an echo (the real false positive was a question).
    act(() => hook.result.current.controller.deliverExternal('should I restart it yes or no', 'space'));
    expect(hook.result.current.transcript).toMatchObject({ text: 'should I restart it yes or no' });
    act(() => hook.result.current.consumeTranscript(hook.result.current.transcript!.id));
    act(() => hook.result.current.controller.deliverExternal('out four finished the refund migration and the deploy checks', 'space'));
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

describe('useHeraldVoiceInput: voice confirm vs the echo guard', () => {
  const PROMPT = 'That one needs your confirmation: say "confirm deploy" to go ahead, or hold the card.';
  const red: HeraldAction = {
    id: 'a1',
    tier: 'hard_confirm',
    kind: 'send_input',
    serverId: 'local',
    sessionId: 'out4',
    sessionName: 'Out4',
    payload: 'deploy',
    readback: 'Out4: "deploy"',
    reasons: ['your request involves: deploy'],
    status: 'pending',
    createdAt: Date.now() - 1000,
    confirmPhrase: 'confirm deploy',
    voiceAttemptsLeft: 3,
  };

  beforeEach(() => {
    localStorage.clear();
    mediaDevices();
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode ??= class {};
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function withPrompt(actions: HeraldAction[]) {
    const onVoiceTranscript = vi.fn((_t: string) => null);
    const r = setup({ onVoiceTranscript, isPendingConfirm: (t) => isPendingConfirmPhrase(t, actions) });
    // Herald just said the prompt (it names the phrase) and stopped.
    r.spokenLog.setSpeaking(true);
    r.spokenLog.record(PROMPT);
    r.spokenLog.setSpeaking(false);
    return { ...r, onVoiceTranscript };
  }

  it('the pending phrase gets through right after Herald speaks it', () => {
    const { hook, onVoiceTranscript, spokenLog } = withPrompt([red]);
    // Without the bypass this would be called echo.
    expect(spokenLog.isEcho('confirm deploy')).toBe(true);
    act(() => hook.result.current.controller.deliverExternal('confirm deploy', 'followup'));
    expect(onVoiceTranscript).toHaveBeenCalledWith('confirm deploy', 'followup');
  });

  it('the phrase with no pending action is still filtered', () => {
    const { hook, onVoiceTranscript, host } = withPrompt([]);
    act(() => hook.result.current.controller.deliverExternal('confirm deploy', 'followup'));
    expect(onVoiceTranscript).not.toHaveBeenCalled();
    expect(host.sendVoice).not.toHaveBeenCalled();
    const done = withPrompt([{ ...red, status: 'sent' }]);
    act(() => done.hook.result.current.controller.deliverExternal('confirm deploy', 'followup'));
    expect(done.onVoiceTranscript).not.toHaveBeenCalled();
  });

  it('other short echoes are still filtered while a card is pending', () => {
    const { hook, onVoiceTranscript, spokenLog } = withPrompt([red]);
    for (const t of ['go ahead', 'hold the card', 'confirm deploy go ahead']) {
      expect(spokenLog.isEcho(t)).toBe(true);
      act(() => hook.result.current.controller.deliverExternal(t, 'followup'));
    }
    expect(onVoiceTranscript).not.toHaveBeenCalled();
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
