/**
 * How talking over Herald is detected (pure; see voiceAutomation.ts).
 *
 * - 'vad': the VAD runs on the echo-cancelled mic and real speech stops Herald
 *   at once (about the VAD's minimum speech time, ~0.3 s). Only safe when Herald
 *   cannot hear itself in that signal.
 * - 'gated': speech only stops Herald once a quick transcript of it is not
 *   Herald's own words (~2 s; needs STT every ~0.45 s while the VAD hears speech).
 *
 * 'vad' needs evidence, never a guess from device names:
 * - an echo measurement for this setup (measureEchoSuppression) with at least
 *   GOOD_SUPPRESSION_DB of Herald removed and no speech left for the VAD, or
 * - passive evidence from Herald's own replies: PASSIVE_GOOD_DB over at least
 *   PASSIVE_MIN_SECONDS of playback, with the VAD never having fired on Herald.
 * And the playback must be what the canceller has as its reference (not Web
 * Speech), unless the measurement showed no echo reaches the mic at all.
 * One talk-over that turns out to be Herald's own voice drops back to 'gated'
 * for this setup.
 */
import type { AecMode, OutputKind } from './audioEnvironment';

export type BargeInMode = 'vad' | 'gated';

/** Measured suppression (dB, Herald's playback -> what we listen to) that counts as good. */
export const GOOD_SUPPRESSION_DB = 25;
/** Passive (during replies, possibly with the user talking too) must clear more. */
export const PASSIVE_GOOD_DB = 30;
export const PASSIVE_MIN_SECONDS = 6;
/** The raw mic hears this little of Herald: nothing reaches it (headphones). */
export const NO_ECHO_PATH_DB = 40;

export interface EchoMeasurementLike {
  /** Total suppression: playback -> cleaned mic (acoustic loss + cancellation). */
  erleDb: number;
  residualSpeechDetected: boolean;
  /** Playback -> raw mic (acoustic loss only). */
  erlDb?: number;
}

export interface BargeInEvidence {
  measured?: EchoMeasurementLike | null;
  passive?: { totalDb: number; seconds: number } | null;
  /** The VAD fired on Herald's own voice (a gated check found echo). */
  echoHeard: number;
  /** A 'vad' talk-over turned out to be Herald's own voice. */
  falseBargeIns: number;
}

export interface BargeInInput {
  aec: AecMode;
  /** Herald's current voice plays through the graph (the canceller's reference). */
  playbackReferenced: boolean;
  output: OutputKind;
  evidence: BargeInEvidence;
}

export interface BargeInDecision {
  mode: BargeInMode;
  reason: string;
}

export function noEchoPath(m: EchoMeasurementLike | null | undefined): boolean {
  if (!m || m.residualSpeechDetected) return false;
  return (m.erlDb ?? m.erleDb) >= NO_ECHO_PATH_DB && m.erleDb >= NO_ECHO_PATH_DB;
}

export function selectBargeInMode(i: BargeInInput): BargeInDecision {
  const ev = i.evidence;
  if (ev.falseBargeIns > 0) return { mode: 'gated', reason: 'a talk-over turned out to be Herald itself' };
  if (ev.measured?.residualSpeechDetected) return { mode: 'gated', reason: 'the echo check heard Herald in the mic' };
  if (noEchoPath(ev.measured)) return { mode: 'vad', reason: 'no echo reaches the mic (measured)' };
  if (i.aec === 'none') return { mode: 'gated', reason: 'no echo cancellation' };
  if (!i.playbackReferenced) return { mode: 'gated', reason: 'browser voice: nothing to cancel it against' };
  if (ev.measured) {
    // A measurement is proof whatever cancels (the browser's own included).
    return ev.measured.erleDb >= GOOD_SUPPRESSION_DB
      ? { mode: 'vad', reason: `echo check: ${Math.round(ev.measured.erleDb)} dB suppressed` }
      : { mode: 'gated', reason: `echo check: only ${Math.round(ev.measured.erleDb)} dB suppressed` };
  }
  // Unmeasured: only a canceller that has Herald's exact playback earns trust passively.
  if (i.aec === 'browser') return { mode: 'gated', reason: "browser echo cancellation (run the echo check to trust it)" };
  if (ev.echoHeard > 0) return { mode: 'gated', reason: 'the VAD has heard Herald through the canceller' };
  const p = ev.passive;
  if (p && p.seconds >= PASSIVE_MIN_SECONDS && p.totalDb >= PASSIVE_GOOD_DB) {
    return { mode: 'vad', reason: `${Math.round(p.totalDb)} dB suppressed over ${Math.round(p.seconds)} s of replies` };
  }
  return { mode: 'gated', reason: 'echo not measured yet' };
}
