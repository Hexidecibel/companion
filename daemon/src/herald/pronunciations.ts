/**
 * The user's pronunciation list for Herald's voice (Advanced > Pronunciations
 * in the web app). Stored in Herald state so it follows the user to every
 * device; the web applies it in its speech normaliser
 * (web/src/services/tts/pronounce.ts, which has the same cleaning rules).
 */
import type { HeraldPronunciation } from './protocol';

export const MAX_PRONUNCIATIONS = 50;
export const MAX_PRONUNCIATION_FROM = 40;
export const MAX_PRONUNCIATION_TO = 80;

/** Trimmed, bounded, no blanks, one entry per `from` (case-insensitive; the last wins). */
export function sanitizePronunciations(raw: unknown): HeraldPronunciation[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, HeraldPronunciation>();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.from !== 'string' || typeof r.to !== 'string') continue;
    const from = r.from.replace(/\s+/g, ' ').trim().slice(0, MAX_PRONUNCIATION_FROM);
    const to = r.to.replace(/\s+/g, ' ').trim().slice(0, MAX_PRONUNCIATION_TO);
    if (!from || !to || !/[\p{L}\p{N}]/u.test(from)) continue;
    const key = from.toLowerCase();
    byKey.delete(key);
    byKey.set(key, { from, to });
  }
  return [...byKey.values()].slice(-MAX_PRONUNCIATIONS);
}
