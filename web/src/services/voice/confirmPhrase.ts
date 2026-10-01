/**
 * Voice confirmation of a red (hard_confirm) card: "confirm deploy".
 *
 * Hook for the voice-command flow: call `detectVoiceConfirm(transcript,
 * actions)` BEFORE the command matcher. It only recognises two shapes, so it
 * coexists with every other command:
 *   - "confirm <words>" while a red card with a confirm phrase is pending
 *     -> { kind: 'confirm' }: send `herald_confirm {method:'voice', phrase}`.
 *     The DAEMON decides (its own transcript, timing vs Herald's speech, the
 *     active device, 3 tries); nothing here can confirm anything by itself.
 *   - a bare "yes" / "do it" / "go ahead" / "confirm" while a red card waits
 *     -> { kind: 'hint' }: never confirms; tell the user the phrase instead.
 * Anything else -> null (carry on with the normal routing).
 */
import type { HeraldAction } from '../../types/herald';

export type VoiceConfirmMatch =
  | { kind: 'confirm'; action: HeraldAction; phrase: string }
  | { kind: 'hint'; action: HeraldAction; phrase: string };

/** A bare yes only hints while the card is this fresh (the user is likely answering it). */
export const HINT_WINDOW_MS = 5 * 60_000;

const LEAD = new Set(['hey', 'jarvis', 'herald', 'ok', 'okay', 'alright', 'so', 'um', 'uh', 'please', 'yes', 'yeah', 'yep']);
const TAIL = new Set(['please', 'now', 'thanks', 'thank', 'you']);
const BARE = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'sure',
  'confirm',
  'confirmed',
  'do it',
  'yes do it',
  'go ahead',
  'yes go ahead',
  'go for it',
  'send it',
  'approve',
  'approved',
  'yes please',
  'ok do it',
  'okay do it',
]);

function words(text: string): string[] {
  return (text.toLowerCase().replace(/['’]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Lower-case words with wake words / fillers trimmed. */
export function confirmWords(text: string): string[] {
  const w = words(text);
  let a = 0;
  let b = w.length;
  while (a < b && LEAD.has(w[a]) && !(w[a] === 'yes' && b - a === 1)) a++;
  while (b > a && TAIL.has(w[b - 1])) b--;
  return w.slice(a, b);
}

/** Red cards that can still be confirmed by voice, newest first. */
export function voiceConfirmable(actions: HeraldAction[]): HeraldAction[] {
  return actions
    .filter((a) => a.status === 'pending' && a.tier === 'hard_confirm' && !!a.confirmPhrase && (a.voiceAttemptsLeft ?? 1) > 0)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function detectVoiceConfirm(
  transcript: string,
  actions: HeraldAction[] | null | undefined,
  now: number = Date.now(),
): VoiceConfirmMatch | null {
  const cards = voiceConfirmable(actions ?? []);
  if (cards.length === 0) return null;
  const raw = words(transcript).join(' ');
  const said = confirmWords(transcript);
  if (BARE.has(raw) || BARE.has(said.join(' '))) {
    const fresh = cards.find((a) => now - a.createdAt < HINT_WINDOW_MS);
    return fresh ? { kind: 'hint', action: fresh, phrase: fresh.confirmPhrase! } : null;
  }
  if (said[0] !== 'confirm' || said.length < 2) return null;
  // The card whose phrase this is (exact words), else the one sharing the most
  // words, else the newest. The daemon still checks the exact phrase.
  const key = said.join(' ');
  const exact = cards.find((a) => words(a.confirmPhrase!).join(' ') === key);
  if (exact) return { kind: 'confirm', action: exact, phrase: transcript.trim() };
  const scored = cards
    .map((a) => ({ a, n: words(a.confirmPhrase!).filter((w) => w !== 'confirm' && said.includes(w)).length }))
    .sort((x, y) => y.n - x.n);
  const best = scored[0].n > 0 ? scored[0].a : cards[0];
  return { kind: 'confirm', action: best, phrase: transcript.trim() };
}

/**
 * Is `transcript` exactly the confirm phrase of a red card pending right now?
 * Such a transcript skips the client self-echo guard: Herald's prompt says the
 * phrase ("say 'confirm deploy' to go ahead"), so the user's real answer in the
 * follow-up window would otherwise look like an echo of it. Safe because the
 * daemon checks the active device, the timing (after Herald's playback end) and
 * echo on its OWN transcript before anything is confirmed. Narrow on purpose:
 * exact phrase words only (wake words / fillers trimmed), never a partial match.
 */
export function isPendingConfirmPhrase(
  transcript: string,
  actions: HeraldAction[] | null | undefined,
  now: number = Date.now(),
): boolean {
  const m = detectVoiceConfirm(transcript, actions, now);
  if (!m || m.kind !== 'confirm') return false;
  return confirmWords(transcript).join(' ') === words(m.action.confirmPhrase!).join(' ');
}

/** What Herald says / shows for a bare "yes" at a red card. */
export function hintText(phrase: string): string {
  return `That one needs your confirmation: say "${phrase}" to go ahead, or hold the card.`;
}

export interface VoiceConfirmDeps {
  confirmByVoice: (actionId: string, phrase: string) => Promise<{ action: HeraldAction | null; error: string | null }>;
  /** Short spoken line (replaces anything playing). */
  say: (text: string) => void;
  tone: (kind: 'ok' | 'error') => void;
}

/**
 * Act on a match: a hint is said (nothing is confirmed); a confirm goes to the
 * hub, and its verdict is heard either way (mid-game, the user is not looking).
 * Success: a short tone; the hub then posts "Sent to X." as usual.
 */
export async function runVoiceConfirm(m: VoiceConfirmMatch, d: VoiceConfirmDeps): Promise<boolean> {
  if (m.kind === 'hint') {
    d.tone('error');
    d.say(hintText(m.phrase));
    return false;
  }
  const r = await d.confirmByVoice(m.action.id, m.phrase);
  if (r.action && !r.error) {
    d.tone('ok');
    return true;
  }
  d.tone('error');
  d.say(r.error || 'That did not confirm it. Use the card on screen.');
  return false;
}
