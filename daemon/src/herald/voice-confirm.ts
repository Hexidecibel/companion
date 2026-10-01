/**
 * Voice confirmation for hard_confirm actions ("confirm deploy").
 *
 * PURE: phrase derivation, normalisation, matching and the acceptance gate take
 * all inputs as arguments (the caller supplies the daemon's own transcript of
 * what the mic heard, and what Herald itself said and when), so every rule is
 * unit-tested without audio.
 *
 * Why so strict: the phrase is spoken BY Herald in its own prompt ("say
 * 'confirm deploy' to go ahead"), so the greatest risk is Herald confirming
 * itself through the speakers. Defences, all required:
 *   1. The phrase is never a bare "yes" / "do it": always "confirm <keyword>".
 *   2. The words must be the daemon's own fresh transcript for that client (the
 *      client's claimed text only has to agree with it), used once.
 *   3. The captured audio must start after Herald's speech to that client ended
 *      (estimated from the synthesized audio queue).
 *   4. The transcript must not look like an echo of anything Herald said around
 *      the capture window.
 *   5. Only the ACTIVE device, only while the action is pending and unexpired,
 *      at most MAX_VOICE_ATTEMPTS tries per action (then on-screen only).
 */

import { echoWords, isLikelyEcho, keysMatch, soundKey } from './voice/echo-match';

export const MAX_VOICE_ATTEMPTS = 3;
/** A transcript older than this cannot confirm anything. */
export const VOICE_TRANSCRIPT_MAX_AGE_MS = 20_000;
/**
 * Speech that ended this shortly before the capture still counts for the echo
 * check (playback-estimate slack). Kept short: Herald never ends a sentence on
 * the phrase ("say 'confirm deploy' to go ahead"), so a capture that overlaps its
 * speech holds extra words and fails the exact match anyway, while a real user
 * answering quickly must not be called an echo.
 */
export const ECHO_TAIL_MS = 400;

/** Danger rule -> the spoken keyword (most salient first). */
const KEYWORDS: Array<[string, string]> = [
  ['spawn', 'launch'],
  ['interrupt', 'interrupt'],
  ['deploy', 'deploy'],
  ['release', 'release'],
  ['publish', 'publish'],
  ['production', 'production'],
  ['push', 'push'],
  ['force', 'force'],
  ['destructive', 'delete'],
  ['migrate', 'migrate'],
  ['history-rewrite', 'rewrite'],
  ['lifecycle', 'restart'],
  ['secrets', 'secrets'],
  ['privilege', 'admin'],
  ['remote-host', 'remote'],
  ['no-verify', 'hooks'],
  ['irreversible', 'permanent'],
];

const CUSH_KEYWORDS: Record<string, string> = {
  serve: 'share',
  tunnel: 'tunnel',
  drop: 'drop',
  close: 'close',
  extend: 'extend',
};

/** Spoken words for a session name: letters/digits only, numbers spelled ("Out4" -> "out four"). */
export function sessionWords(name: string, max = 3): string[] {
  return echoWords(name).slice(0, max);
}

/**
 * The phrase that confirms an action by voice. `taken` = phrases of other
 * pending actions: a clash gets the session's name appended so each phrase
 * names exactly one card.
 */
export function deriveConfirmPhrase(input: {
  kind: string;
  ruleIds?: string[];
  cushOp?: string;
  sessionName: string;
  taken?: Iterable<string>;
}): string {
  let keyword: string | null = null;
  if (input.kind === 'cush_command' && input.cushOp) keyword = CUSH_KEYWORDS[input.cushOp] || null;
  else if (input.kind === 'spawn_session') keyword = 'launch';
  else if (input.kind === 'interrupt') keyword = 'interrupt';
  if (!keyword) {
    const ids = new Set(input.ruleIds || []);
    keyword = KEYWORDS.find(([id]) => ids.has(id))?.[1] ?? 'send';
  }
  const base = `confirm ${keyword}`;
  const taken = new Set(Array.from(input.taken || [], (p) => normalizePhrase(p).join(' ')));
  if (!taken.has(base)) return base;
  const named = [base, ...sessionWords(input.sessionName)].join(' ');
  if (!taken.has(named)) return named;
  for (let n = 2; n < 10; n++) {
    const numbered = `${named} ${echoWords(String(n)).join(' ')}`;
    if (!taken.has(numbered)) return numbered;
  }
  return named;
}

/** Leading words people (and Whisper) put before the phrase. */
const LEAD_FILLERS = new Set([
  'hey',
  'jarvis',
  'herald',
  'ok',
  'okay',
  'alright',
  'right',
  'so',
  'um',
  'uh',
  'er',
  'please',
  'yes',
  'yeah',
  'yep',
  'sure',
]);
/** Trailing courtesy words. */
const TAIL_FILLERS = new Set(['please', 'now', 'thanks', 'thank', 'you', 'go', 'ahead']);

/** Words of a phrase or transcript: lower-case, punctuation gone, numbers spelled, fillers trimmed. */
export function normalizePhrase(text: string): string[] {
  const w = echoWords(text || '');
  let a = 0;
  let b = w.length;
  while (a < b && LEAD_FILLERS.has(w[a])) a++;
  while (b > a && TAIL_FILLERS.has(w[b - 1])) b--;
  return w.slice(a, b);
}

/**
 * Does `said` say exactly `phrase`? Same number of words, each the same by
 * sound (Whisper writes "conform", "deployed", "out for"). Nothing extra:
 * "say confirm deploy to go ahead" (Herald's own sentence) never matches.
 */
export function matchesConfirmPhrase(said: string, phrase: string): boolean {
  const p = echoWords(phrase);
  if (p.length < 2 || p[0] !== 'confirm') return false;
  const same = (s: string[]) =>
    s.length === p.length &&
    s.every((w, i) => w === p[i] || keysMatch(soundKey(w), soundKey(p[i])));
  // Fillers trimmed ("okay, confirm deploy please"), or verbatim (a session named "Go").
  return same(normalizePhrase(said)) || same(echoWords(said || ''));
}

// ---------------------------------------------------------------------------

export interface VoiceTranscriptEvidence {
  streamId: string;
  text: string;
  /** Earliest audio the transcript can contain (epoch ms). */
  captureStartAt: number;
  /** When the stream ended (epoch ms). */
  endedAt: number;
  consumed: boolean;
}

export interface SpokenEvidence {
  text: string;
  startAt: number;
  /** Estimated end of playback (epoch ms). */
  endAt: number;
}

export type VoiceConfirmRejection =
  | 'not_active_device'
  | 'not_pending'
  | 'not_hard_confirm'
  | 'expired'
  | 'too_many_attempts'
  | 'no_transcript'
  | 'stale_transcript'
  | 'mismatch'
  | 'during_speech'
  | 'echo';

export interface VoiceConfirmCheck {
  now: number;
  phrase: string;
  /** What the client says it heard (must agree with the daemon's transcript). */
  claimed: string;
  isActiveDevice: boolean;
  /** The daemon's own transcript for this client (by stream id, else the latest). */
  transcript: VoiceTranscriptEvidence | null;
  /** What Herald said to this client recently, with estimated playback times. */
  spoken: SpokenEvidence[];
  /** Estimated end of Herald's speech to this client (0 = none). */
  speechEndAt: number;
}

/** Spoken user-facing reason for a rejection (Herald says / shows it). */
export function rejectionMessage(r: VoiceConfirmRejection, phrase: string, left: number): string {
  const retry = left > 0 ? ` Say "${phrase}" to go ahead.` : ' Use the card on screen to confirm.';
  switch (r) {
    case 'not_active_device':
      return 'Voice confirmation only works on the active device. Use the card on screen, or take control here first.';
    case 'not_pending':
      return 'That action is no longer waiting for confirmation.';
    case 'not_hard_confirm':
      return 'That action does not need a voice confirmation.';
    case 'expired':
      return 'That confirmation window has closed; nothing was sent.';
    case 'too_many_attempts':
      return 'Too many voice tries for this one. Use the card on screen to confirm.';
    case 'no_transcript':
    case 'stale_transcript':
      return `I didn't catch that as a fresh voice command.${retry}`;
    case 'mismatch':
      return `That didn't match.${retry}`;
    case 'during_speech':
      return `I was still talking when you said it.${left > 0 ? ` Wait for me to finish, then say "${phrase}".` : ' Use the card on screen to confirm.'}`;
    case 'echo':
      return `That sounded like my own voice, so I ignored it.${retry}`;
  }
}

/**
 * Accept or reject one voice confirmation attempt (action state checks are the
 * caller's: pending, tier, expiry, attempts). Returns null when accepted.
 */
export function checkVoiceConfirm(c: VoiceConfirmCheck): VoiceConfirmRejection | null {
  if (!c.isActiveDevice) return 'not_active_device';
  const t = c.transcript;
  if (!t || t.consumed || !t.text.trim()) return 'no_transcript';
  if (c.now - t.endedAt > VOICE_TRANSCRIPT_MAX_AGE_MS || t.endedAt > c.now + 1000)
    return 'stale_transcript';
  // The daemon's own transcript decides; the client's text must agree with it.
  if (!matchesConfirmPhrase(t.text, c.phrase)) return 'mismatch';
  if (c.claimed && !matchesConfirmPhrase(c.claimed, c.phrase)) return 'mismatch';
  // Captured while Herald was (estimated to be) still talking to this device.
  if (c.speechEndAt > 0 && t.captureStartAt < c.speechEndAt) return 'during_speech';
  const around = c.spoken
    .filter((s) => s.endAt >= t.captureStartAt - ECHO_TAIL_MS && s.startAt <= t.endedAt)
    .map((s) => s.text);
  if (around.length > 0 && isLikelyEcho(t.text, around)) return 'echo';
  return null;
}
