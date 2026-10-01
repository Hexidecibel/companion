/**
 * Several devices, one Herald voice (no React; unit-tested).
 *
 * Echo cancellation only removes Herald on the device that PLAYS it: a Mac
 * next to the phone that is talking hears Herald with nothing to cancel it
 * against, and its VAD, wake word and follow-up window would take Herald's
 * words for the user's. So:
 *
 * - One device speaks each line (`speakOn`, decided by the hub; see
 *   `shouldSpeakLine`). The others show it silently.
 * - The speaking device reports `herald_speaking` start / heartbeat / end
 *   (`SpeakingReporter`); the hub broadcasts it as a `speaking` event.
 * - Every OTHER device tracks that signal (`FleetSpeakingTracker`) and, while
 *   it is active plus a short tail, drops hands-off captures
 *   (`fleetDecision`): barge-in, follow-up and hands-free. A wake word
 *   followed at once by "stop" still works (it stops the speaker, via the
 *   hub); gestures (push-to-talk, hotkeys, triggers, buttons) always do, and
 *   their sends carry `gesture: true` so the hub's own backstop lets them by.
 * - The speaking device itself keeps its normal echo-cancelled behaviour.
 */
import type { HeraldMessage, HeraldSpeakingReport, HeraldSpeakingSignal } from '../../types/herald';
import type { TtsEngine } from '../tts/types';
import type { VoiceInputSource } from './voiceInput';
import { COMMAND_PHRASES, matchVoiceCommand, normalizeUtterance, stripWakeWord } from './voiceCommands';

/** After the speaker stops, the room still rings this long. */
export const FLEET_TAIL_MS = 800;
/** No heartbeat for this long: the speaker stopped (its `end` was lost). */
export const FLEET_HEARTBEAT_TIMEOUT_MS = 2500;
/** One utterance holds the other devices back at most this long. */
export const FLEET_MAX_MS = 30_000;
/** The speaking device repeats `start` this often while it plays. */
export const SPEAKING_HEARTBEAT_MS = 1000;
/** A gesture capture's send counts as a gesture this long after its transcript. */
export const GESTURE_TTL_MS = 20_000;

// ---------------------------------------------------------------- speakOn

/**
 * Should THIS device speak `message` aloud? The hub names one device per line
 * (`speakOn`). Absent (older hub, or a turn from a client that is not a Herald
 * device) or this device's id unknown (older hub): the old rule, every device
 * with voice on decides for itself.
 */
export function shouldSpeakLine(message: Pick<HeraldMessage, 'speakOn'>, selfId: string | null): boolean {
  if (message.speakOn === undefined || !selfId) return true;
  return message.speakOn === selfId;
}

// ---------------------------------------------------------------- suppression

/** Captures someone deliberately started: never suppressed, and flagged to the hub. */
export const GESTURE_SOURCES: ReadonlySet<VoiceInputSource> = new Set(['button', 'space', 'chord', 'global', 'trigger']);

/** A whole-utterance STOP (with or without "Hey Jarvis" in front). */
export function isStopUtterance(text: string): boolean {
  const t = stripWakeWord(text);
  return !!t && matchVoiceCommand(t) === 'stop';
}

const STOP_PHRASES = new Set<string>(COMMAND_PHRASES.stop);
/** The wake word anywhere in a transcript (Whisper's spellings, as in wake-phrase.ts). */
const WAKE_ANY_RE = /\b(?:jarvis|jervis|jarvas|jarvus|javis|travis)\b/g;

/**
 * "...Hey Jarvis, stop..." inside a longer transcript: the words right after
 * the LAST wake word are a stop phrase. While another device talks, this
 * device's mic hears Herald and the user as one long utterance, so the stop
 * cannot wait for it to end or match it whole. A transcript without the
 * name never counts (Herald's own "wait" or "thanks" must not stop it).
 */
export function stopAfterWake(text: string): boolean {
  const norm = normalizeUtterance(text);
  let end = -1;
  WAKE_ANY_RE.lastIndex = 0;
  for (let m = WAKE_ANY_RE.exec(norm); m; m = WAKE_ANY_RE.exec(norm)) end = m.index + m[0].length;
  if (end < 0) return false;
  const words = norm.slice(end).split(' ').filter(Boolean);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    if (STOP_PHRASES.has(words.slice(0, n).join(' '))) return true;
  }
  return false;
}

/**
 * What to do with a transcript while another device is speaking (`suppressed`):
 *   allow - a gesture, or nobody else is speaking
 *   stop  - "Hey Jarvis, stop": stop the speaking device (nothing is sent)
 *   drop  - a hands-off capture (barge-in, follow-up, hands-free): probably Herald
 */
export type FleetDecision = 'allow' | 'stop' | 'drop';

export function fleetDecision(source: VoiceInputSource, text: string, suppressed: boolean): FleetDecision {
  if (!suppressed || GESTURE_SOURCES.has(source)) return 'allow';
  if (source === 'wake' && isStopUtterance(text)) return 'stop';
  return 'drop';
}

/**
 * Was the transcript about to be sent captured by a gesture? Set for every
 * transcript (a hands-off one clears it), read once by the send that follows.
 */
export class GestureLedger {
  private at: number | null = null;
  constructor(private now: () => number = () => Date.now()) {}

  note(source: VoiceInputSource): void {
    this.at = GESTURE_SOURCES.has(source) ? this.now() : null;
  }

  /** True once per gesture transcript, within GESTURE_TTL_MS. */
  take(): boolean {
    const ok = this.at !== null && this.now() - this.at < GESTURE_TTL_MS;
    this.at = null;
    return ok;
  }
}

/** The app's ledger: voice input notes, useHerald's send takes. */
export const gestureLedger = new GestureLedger();

// ---------------------------------------------------------------- receiver

export interface RemoteSpeaker {
  deviceId: string;
  label: string;
  utteranceId: string;
}

interface Track extends RemoteSpeaker {
  startedAt: number;
  beatAt: number;
}

/**
 * Another device's "Herald is speaking" signal, as seen here. Active from a
 * start until its end, a missed heartbeat or the cap; suppressing for
 * FLEET_TAIL_MS more. This device's own signal is ignored (it has AEC).
 */
export class FleetSpeakingTracker {
  private cur: Track | null = null;
  private endedAt = 0;
  private listeners = new Set<(s: RemoteSpeaker | null) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastNotified: string | null = null;

  constructor(private now: () => number = () => Date.now()) {}

  handle(signal: HeraldSpeakingSignal, selfId: string | null): void {
    if (selfId && signal.deviceId === selfId) {
      // This device took over (it is the one playing now): nothing to hold back for.
      if (this.cur) this.end();
      return;
    }
    const now = this.now();
    if (!signal.active) {
      if (this.cur && this.cur.deviceId === signal.deviceId) this.end();
      return;
    }
    const same = this.cur && this.cur.deviceId === signal.deviceId && this.cur.utteranceId === signal.utteranceId;
    if (same) {
      this.cur!.beatAt = now;
      this.cur!.label = signal.label;
    } else {
      this.cur = { deviceId: signal.deviceId, label: signal.label, utteranceId: signal.utteranceId, startedAt: now, beatAt: now };
    }
    this.schedule();
    this.notify();
  }

  /** The speaker on another device right now (null: nobody). */
  get remote(): RemoteSpeaker | null {
    this.expire();
    const c = this.cur;
    return c ? { deviceId: c.deviceId, label: c.label, utteranceId: c.utteranceId } : null;
  }

  /** Hold back hands-off capture now (speaking elsewhere, or within the tail). */
  suppressed(): boolean {
    this.expire();
    return !!this.cur || (this.endedAt > 0 && this.now() - this.endedAt < FLEET_TAIL_MS);
  }

  subscribe(fn: (s: RemoteSpeaker | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Host switch / disconnect: forget it. */
  reset(): void {
    this.cur = null;
    this.endedAt = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.notify();
  }

  private expire(): void {
    const c = this.cur;
    if (!c) return;
    const now = this.now();
    if (now - c.beatAt > FLEET_HEARTBEAT_TIMEOUT_MS || now - c.startedAt > FLEET_MAX_MS) this.end();
  }

  private end(): void {
    this.cur = null;
    this.endedAt = this.now();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.notify();
  }

  /** Re-check when the heartbeat would time out, so the indicator goes away by itself. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.expire();
      if (this.cur) this.schedule();
      else this.notify();
    }, FLEET_HEARTBEAT_TIMEOUT_MS + 50);
  }

  private notify(): void {
    const r = this.cur ? { deviceId: this.cur.deviceId, label: this.cur.label, utteranceId: this.cur.utteranceId } : null;
    const key = r ? `${r.deviceId}|${r.label}|${r.utteranceId}` : '';
    if (key === this.lastNotified) return;
    this.lastNotified = key;
    for (const l of this.listeners) l(r);
  }
}

// ---------------------------------------------------------------- speaker

/** Rough playback length of a sentence: ~165 words a minute at rate 1. */
export function estimateSpeechMs(text: string, rate = 1): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words * 60_000) / (165 * Math.max(0.5, rate || 1))) + 150;
}

export interface SpeakingReporterDeps {
  /** Send one report to the hub (fire and forget). False / throw: not sent. */
  send: (report: HeraldSpeakingReport) => void;
  /** This device can report (connected to a hub that routes speech). */
  enabled: () => boolean;
  now?: () => number;
  newId?: () => string;
}

/**
 * This device's side of the signal: `start` when playback begins, again every
 * SPEAKING_HEARTBEAT_MS while it lasts (with a fresh end estimate), `end` when
 * it stops.
 */
export class SpeakingReporter {
  private id: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private estEnd = 0;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private deps: SpeakingReporterDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? (() => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  }

  get utteranceId(): string | null {
    return this.id;
  }

  /** A sentence was queued for playback. */
  queued(text: string, rate?: number): void {
    const now = this.now();
    this.estEnd = Math.max(this.estEnd, now) + estimateSpeechMs(text, rate);
  }

  /** Playback was cut: nothing more is queued. */
  cancelled(): void {
    this.estEnd = this.now();
  }

  setSpeaking(on: boolean): void {
    if (on) {
      if (this.id) return;
      if (!this.deps.enabled()) return;
      this.id = this.newId();
      this.beat();
      this.timer = setInterval(() => this.beat(), SPEAKING_HEARTBEAT_MS);
      return;
    }
    if (!this.id) return;
    const id = this.id;
    this.stopTimer();
    this.id = null;
    this.post({ state: 'end', utteranceId: id, sentAt: this.now() });
  }

  dispose(): void {
    this.setSpeaking(false);
  }

  private beat(): void {
    if (!this.id) return;
    const now = this.now();
    this.post({ state: 'start', utteranceId: this.id, approxEndAt: Math.max(now, this.estEnd), sentAt: now });
  }

  private post(r: HeraldSpeakingReport): void {
    try {
      this.deps.send(r);
    } catch {
      // A lost report is covered by the heartbeat timeout on the other side.
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Wrap a TTS engine so the reporter sees what is queued, cut and played. */
export function reportingEngine(engine: TtsEngine, reporter: SpeakingReporter): TtsEngine {
  engine.on((e) => {
    if (e.type === 'speaking') reporter.setSpeaking(e.speaking);
  });
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'speak') {
        return (text: string, opts?: Parameters<TtsEngine['speak']>[1]) => {
          reporter.queued(text, opts?.rate);
          return target.speak(text, opts);
        };
      }
      if (prop === 'cancel') {
        return () => {
          reporter.cancelled();
          return target.cancel();
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
