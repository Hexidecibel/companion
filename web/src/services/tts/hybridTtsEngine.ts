/**
 * The engine Herald's UI actually uses: neural voices from the daemon when the
 * voice service is up, the browser's Web Speech otherwise (or when the user
 * picks a browser voice). Routing is per sentence, so a service outage mid-reply
 * degrades to Web Speech without losing or reordering anything.
 */
import type { HeraldVoiceInfo } from '../../types/herald';
import { NEURAL_PREFIX, ServerTtsEngine, type AudioSink, type TtsRequester } from './serverTtsEngine';
import type { TtsEngine, TtsEvent, TtsSpeakOptions, TtsVoice } from './types';
import { getAudioGraph } from '../voice/audioGraph';

export class HybridTtsEngine implements TtsEngine {
  readonly id = 'hybrid';
  readonly server: ServerTtsEngine;
  private listeners = new Set<(e: TtsEvent) => void>();
  private unsubs: Array<() => void> = [];
  private lastSpeaking = false;
  private webSpeaking = false;

  constructor(private web: TtsEngine, requester: TtsRequester, sink: AudioSink) {
    this.server = new ServerTtsEngine(requester, sink, (text, opts) => {
      // Fallback keeps the user's rate; the browser picks its best voice.
      this.web.speak(text, { ...opts, voiceId: null });
    });
    for (const eng of [this.server, this.web]) {
      this.unsubs.push(eng.on((e) => this.relay(e)));
    }
    // Web Speech plays outside Herald's audio graph: the echo canceller has no
    // reference for it, so barge-in falls back to transcript checks meanwhile.
    this.unsubs.push(this.web.on((e) => {
      if (e.type === 'speaking') this.setWebSpeaking(e.speaking);
    }));
  }

  private setWebSpeaking(on: boolean): void {
    if (on === this.webSpeaking) return;
    this.webSpeaking = on;
    getAudioGraph().setUnreferencedPlayback(on);
  }

  get available(): boolean {
    return this.server.available || this.web.available;
  }

  get speaking(): boolean {
    return this.server.speaking || this.web.speaking;
  }

  /** Neural voices first (engine "neural"), then the browser's. */
  getVoices(): TtsVoice[] {
    const browser = this.web.getVoices().map((v) => ({ ...v, engine: 'browser' as const }));
    return [...this.server.getVoices(), ...browser];
  }

  setServerStatus(available: boolean, voices: HeraldVoiceInfo[], defaultVoice: string | null): void {
    this.server.setStatus(available, voices, defaultVoice);
  }

  /** Which backend a speak() with these options would use. */
  route(opts: TtsSpeakOptions = {}): 'neural' | 'browser' {
    const id = opts.voiceId ?? null;
    if (!this.server.available) return 'browser';
    if (id === null || id.startsWith(NEURAL_PREFIX)) return 'neural';
    return 'browser';
  }

  speak(text: string, opts: TtsSpeakOptions = {}): void {
    if (this.route(opts) === 'neural') this.server.speak(text, opts);
    else this.web.speak(text, opts.voiceId?.startsWith(NEURAL_PREFIX) ? { ...opts, voiceId: null } : opts);
  }

  cancel(): void {
    this.server.cancel();
    this.web.cancel();
  }

  unlock(): void {
    this.server.unlock();
    this.web.unlock();
  }

  on(listener: (event: TtsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.setWebSpeaking(false);
    this.server.dispose();
    this.unsubs.forEach((u) => u());
    this.listeners.clear();
  }

  private relay(e: TtsEvent): void {
    let out: TtsEvent = e;
    if (e.type === 'speaking') {
      const now = this.speaking;
      if (now === this.lastSpeaking) return;
      this.lastSpeaking = now;
      out = { type: 'speaking', speaking: now };
    } else if (e.type === 'voices') {
      out = { type: 'voices', voices: this.getVoices() };
    }
    for (const l of [...this.listeners]) {
      try {
        l(out);
      } catch {
        // ignore
      }
    }
  }
}
