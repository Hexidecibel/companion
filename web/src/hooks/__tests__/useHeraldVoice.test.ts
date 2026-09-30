import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useHeraldVoice } from '../useHeraldVoice';
import type { HeraldEventListener } from '../useHerald';
import type { TtsEngine, TtsEvent, TtsVoice } from '../../services/tts/types';
import type { HeraldEvent } from '../../types/herald';

class MockEngine implements TtsEngine {
  readonly id = 'mock';
  readonly available = true;
  spoken: string[] = [];
  cancels = 0;
  private ls = new Set<(e: TtsEvent) => void>();
  get speaking() { return false; }
  speak(text: string) { this.spoken.push(text); }
  cancel() { this.cancels++; }
  getVoices(): TtsVoice[] { return []; }
  unlock() {}
  on(l: (e: TtsEvent) => void) { this.ls.add(l); return () => { this.ls.delete(l); }; }
  dispose() {}
}

function setup() {
  const listeners = new Set<HeraldEventListener>();
  const subscribe = (l: HeraldEventListener) => { listeners.add(l); return () => { listeners.delete(l); }; };
  const engine = new MockEngine();
  const hook = renderHook(() => useHeraldVoice(subscribe, 'hub', engine));
  const emit = (e: HeraldEvent, source: 'push' | 'fetch' = 'push') => act(() => { listeners.forEach((l) => l(e, source)); });
  return { engine, hook, emit };
}

const start = (id: string): HeraldEvent => ({ kind: 'message_start', message: { id, role: 'herald', text: '', createdAt: 1, streaming: true } });
const delta = (id: string, d: string): HeraldEvent => ({ kind: 'message_delta', messageId: id, delta: d });

describe('useHeraldVoice', () => {
  beforeEach(() => { localStorage.clear(); });

  it('defaults voice on and speaks live replies', () => {
    const { engine, hook, emit } = setup();
    expect(hook.result.current.voiceOn).toBe(true);
    emit(start('r'));
    emit(delta('r', 'Hello there. '));
    expect(engine.spoken).toEqual(['Hello there.']);
  });

  it('does not speak history snapshots', () => {
    const { engine, emit } = setup();
    emit({ kind: 'state', state: { displayName: 'H', enabled: true, model: '', busy: false, inbox: [], actions: [], messages: [{ id: 'h', role: 'herald', text: 'Old. News.', createdAt: 1 }] } }, 'fetch');
    expect(engine.spoken).toEqual([]);
  });

  it('stop() barges in; turning voice off cancels and persists', () => {
    const { engine, hook, emit } = setup();
    emit(start('r'));
    emit(delta('r', 'One. '));
    act(() => hook.result.current.stop());
    emit(delta('r', 'Two. '));
    expect(engine.spoken).toEqual(['One.']);
    const before = engine.cancels;
    act(() => hook.result.current.setVoiceOn(false));
    expect(engine.cancels).toBeGreaterThan(before);
    expect(JSON.parse(localStorage.getItem('herald_voice_prefs') ?? '{}').voiceOn).toBe(false);
    emit(start('r2'));
    emit(delta('r2', 'Silent. '));
    expect(engine.spoken).toEqual(['One.']);
  });

  it('going hidden silences the current reply', () => {
    const { engine, emit } = setup();
    emit(start('r'));
    emit(delta('r', 'One. '));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    emit(delta('r', 'Two. '));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(engine.spoken).toEqual(['One.']);
    expect(engine.cancels).toBeGreaterThan(0);
  });
});
