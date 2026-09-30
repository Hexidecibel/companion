/**
 * Push-to-talk key handling. The rules exist so voice never gets in the way of
 * typing:
 *   - Space only talks when the Herald composer is focused AND empty, with no
 *     modifiers, not auto-repeating and not mid-IME composition. Any text in
 *     the box means Space is just a space.
 *   - The global chord (default Ctrl+Shift+Space) must match EXACTLY: extra or
 *     missing modifiers never trigger it, so ordinary shortcuts pass through.
 */

export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** KeyboardEvent.code, e.g. "Space", "KeyV". */
  code: string;
}

export const DEFAULT_CHORD = 'Ctrl+Shift+Space';

const MOD_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

export function parseChord(text: string): Chord | null {
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const chord: Chord = { ctrl: false, shift: false, alt: false, meta: false, code: '' };
  for (const p of parts) {
    const k = p.toLowerCase();
    if (k === 'ctrl' || k === 'control') chord.ctrl = true;
    else if (k === 'shift') chord.shift = true;
    else if (k === 'alt' || k === 'option') chord.alt = true;
    else if (k === 'meta' || k === 'cmd' || k === 'super') chord.meta = true;
    else if (chord.code) return null;
    else chord.code = normalizeCode(p);
  }
  if (!chord.code) return null;
  // A bare key (or Shift+key) would hijack typing: require Ctrl, Alt or Meta.
  if (!chord.ctrl && !chord.alt && !chord.meta) return null;
  return chord;
}

function normalizeCode(k: string): string {
  if (/^space$/i.test(k)) return 'Space';
  if (/^[a-z]$/i.test(k)) return `Key${k.toUpperCase()}`;
  if (/^[0-9]$/.test(k)) return `Digit${k}`;
  if (/^f([1-9]|1[0-2])$/i.test(k)) return k.toUpperCase();
  return k;
}

export function formatChord(c: Chord): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  if (c.meta) parts.push('Meta');
  let key = c.code;
  if (key.startsWith('Key')) key = key.slice(3);
  else if (key.startsWith('Digit')) key = key.slice(5);
  parts.push(key);
  return parts.join('+');
}

/** Build a chord from a keydown (for "press your shortcut" capture). */
export function chordFromEvent(e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'>): Chord | null {
  if (MOD_CODES.has(e.code)) return null;
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;
  return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, code: e.code };
}

type KeyLike = Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code' | 'repeat'>;

export function matchesChordDown(e: KeyLike, c: Chord): boolean {
  return (
    e.code === c.code &&
    e.ctrlKey === c.ctrl &&
    e.shiftKey === c.shift &&
    e.altKey === c.alt &&
    e.metaKey === c.meta
  );
}

/** Releasing the key or any of the chord's modifiers ends the hold. */
export function isChordRelease(e: Pick<KeyboardEvent, 'code'>, c: Chord): boolean {
  if (e.code === c.code) return true;
  if (c.ctrl && (e.code === 'ControlLeft' || e.code === 'ControlRight')) return true;
  if (c.shift && (e.code === 'ShiftLeft' || e.code === 'ShiftRight')) return true;
  if (c.alt && (e.code === 'AltLeft' || e.code === 'AltRight')) return true;
  if (c.meta && (e.code === 'MetaLeft' || e.code === 'MetaRight')) return true;
  return false;
}

export interface SpaceContext {
  enabled: boolean;
  /** The composer's live value is empty (whitespace counts as empty). */
  composerEmpty: boolean;
  isComposing?: boolean;
}

export function shouldStartSpacePtt(e: KeyLike & { key?: string }, ctx: SpaceContext): boolean {
  if (!ctx.enabled || !ctx.composerEmpty || ctx.isComposing) return false;
  if (e.code !== 'Space' || e.repeat) return false;
  return !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
}
