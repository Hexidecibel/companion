/**
 * Floating orb (desktop app): what it shows and when. Pure, so the timing is
 * unit tested; `useHeraldOverlay` feeds it and forwards views to the native
 * overlay window, and bring-to-front gating lives here too.
 *
 * It appears only while Herald is doing something AND the Companion window is
 * not in front (the panel already shows it there), lingers a moment after the
 * activity ends, fades, then the window is hidden.
 */
import type { NativePlatform } from '../../utils/platform';
import type { ProfileId } from './profiles';

export type OverlayOrb = 'listening' | 'thinking' | 'speaking' | 'tone';
export type OverlayPhase = 'hidden' | 'active' | 'fading';

export interface OverlayView {
  phase: OverlayPhase;
  orb: OverlayOrb;
  caption: string;
}

export interface OverlayInput {
  /** The floating orb is turned on for this device and profile. */
  enabled: boolean;
  /** The Companion window is focused (the overlay stays out of the way). */
  mainFocused: boolean;
  listening: boolean;
  transcribing: boolean;
  thinking: boolean;
  speaking: boolean;
  /** A tone just played for news (epoch ms of it), with what it was about. */
  tone: { at: number; text: string } | null;
  /** What the user just said (shown while Herald thinks). */
  lastUserText: string | null;
  /** Herald's reply being spoken or streamed. */
  replyText: string | null;
}

export const OVERLAY_LINGER_MS = 2600;
export const OVERLAY_FADE_MS = 500;
export const TONE_SHOW_MS = 3200;
const CAPTION_MAX = 72;

/** First words of a text, one line: whole words up to about 72 characters. */
export function firstWords(text: string, max = CAPTION_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** What Herald is doing right now, or null when idle. */
export function activeView(i: OverlayInput, now: number): Omit<OverlayView, 'phase'> | null {
  if (i.listening) return { orb: 'listening', caption: 'Listening…' };
  if (i.transcribing) return { orb: 'thinking', caption: 'Transcribing…' };
  if (i.speaking) return { orb: 'speaking', caption: i.replyText ? firstWords(i.replyText) : 'Speaking…' };
  if (i.thinking) return { orb: 'thinking', caption: i.lastUserText ? `“${firstWords(i.lastUserText, 60)}”` : 'Thinking…' };
  if (i.tone && now - i.tone.at < TONE_SHOW_MS) return { orb: 'tone', caption: firstWords(i.tone.text) };
  return null;
}

type Timer = ReturnType<typeof setTimeout>;

export interface PresenterDeps {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

/**
 * Turns a stream of inputs into overlay views: active while something is
 * happening, the last view lingers, then fades, then hidden. Emits only on change.
 */
export class OverlayPresenter {
  private view: OverlayView = { phase: 'hidden', orb: 'thinking', caption: '' };
  private timer: Timer | null = null;
  private last: OverlayInput | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;

  constructor(private onView: (v: OverlayView) => void, deps: PresenterDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  }

  get current(): OverlayView {
    return this.view;
  }

  update(i: OverlayInput): void {
    this.last = i;
    if (!i.enabled || i.mainFocused) {
      this.cancelTimer();
      this.emit({ ...this.view, phase: 'hidden' });
      return;
    }
    const a = activeView(i, this.now());
    if (a) {
      this.cancelTimer();
      this.emit({ phase: 'active', ...a });
      // A tone is its own activity: schedule its end.
      if (a.orb === 'tone' && i.tone) {
        const left = Math.max(0, TONE_SHOW_MS - (this.now() - i.tone.at));
        this.timer = this.setTimer(() => { this.timer = null; if (this.last) this.update(this.last); }, left + 1);
      }
      return;
    }
    if (this.view.phase === 'active' && !this.timer) {
      this.timer = this.setTimer(() => {
        this.emit({ ...this.view, phase: 'fading' });
        this.timer = this.setTimer(() => {
          this.timer = null;
          this.emit({ ...this.view, phase: 'hidden' });
        }, OVERLAY_FADE_MS);
      }, OVERLAY_LINGER_MS);
    }
  }

  dispose(): void {
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  private emit(v: OverlayView): void {
    const cur = this.view;
    if (cur.phase === v.phase && cur.orb === v.orb && cur.caption === v.caption) return;
    this.view = v;
    this.onView(v);
  }
}

// ---------------------------------------------------------------------------
// Bring to front

export type FrontSource = 'wake' | 'trigger';

/**
 * "Hey Jarvis" or a trigger shows and focuses the Companion window, when the
 * user turned that on. Never in the Gaming profile (it would pull a game out
 * of full screen), and only in the desktop app.
 */
export function shouldBringToFront(o: { enabled: boolean; profile: ProfileId | null; platform: NativePlatform; source: FrontSource }): boolean {
  if (!o.enabled || o.platform !== 'desktop') return false;
  if (o.profile === 'gaming') return false;
  return o.source === 'wake' || o.source === 'trigger';
}
