/**
 * What a remote trigger does on the device the daemon picked (the active one).
 * A trigger comes from a hotkey on ANOTHER machine or app (AutoHotkey mid-game,
 * Raycast, a Stream Deck), so this tab is often hidden: everything here works
 * without focus, and a failure is told by a tone now and a notice the next
 * time the user looks. Pure over injected actions so every branch is tested.
 *
 *   brief  - spoken rundown of what is new
 *   listen - open the mic, capture one utterance (ends on VAD), send it as a voice turn
 *   stop   - stop speaking and cancel any capture
 *   repeat - say the last reply again
 *   toggle - speaking: stop; listening: cancel; otherwise listen
 *   claim  - this device was just made the active one (the daemon did it): acknowledge
 */
import type { HeraldTriggerAction } from '../../types/herald';

export type TriggerTone = 'wake' | 'ok' | 'error';

export interface TriggerActions {
  /** Herald is speaking right now. */
  speaking: () => boolean;
  /** A capture is running (push-to-talk, trigger listen, VAD utterance). */
  capturing: () => boolean;
  /** STOP: silence now; a reply still being thought about stays silent. */
  stopSpeech: () => void;
  /** Abandon any capture without sending it. */
  cancelCapture: () => void;
  /** Start a VAD-ended capture; null once listening, else the reason it could not. */
  listen: () => Promise<string | null>;
  /** One-press "brief me" (a voice-mode brief intent). */
  brief: () => void;
  /** REPEAT; false when there is nothing to repeat. */
  repeat: () => boolean;
  /** Let replies play while the tab is hidden (for a while). */
  allowBackground: () => void;
  tone: (kind: TriggerTone) => void;
  /** Visible notice (deferred to the next time the page is shown when hidden). */
  notice: (message: string) => void;
}

export type TriggerOutcome =
  | 'briefing'
  | 'listening'
  | 'stopped'
  | 'cancelled'
  | 'repeating'
  | 'nothing_to_repeat'
  | 'already_listening'
  | 'claimed'
  | 'failed';

export async function runHeraldTrigger(action: HeraldTriggerAction, a: TriggerActions): Promise<TriggerOutcome> {
  switch (action) {
    case 'stop': {
      const spoke = a.speaking();
      a.stopSpeech();
      a.cancelCapture();
      a.tone('ok');
      return spoke ? 'stopped' : 'cancelled';
    }
    case 'repeat':
      a.allowBackground();
      if (a.repeat()) return 'repeating';
      a.tone('error');
      a.notice('Nothing to repeat yet');
      return 'nothing_to_repeat';
    case 'brief':
      a.allowBackground();
      a.brief();
      return 'briefing';
    case 'toggle':
      if (a.speaking()) {
        a.stopSpeech();
        a.tone('ok');
        return 'stopped';
      }
      if (a.capturing()) {
        a.cancelCapture();
        a.tone('ok');
        return 'cancelled';
      }
      return listen(a);
    case 'claim':
      a.tone('ok');
      return 'claimed';
    case 'listen':
      if (a.capturing()) return 'already_listening';
      if (a.speaking()) a.stopSpeech(); // barge-in: the user wants to talk
      return listen(a);
    default:
      return 'failed';
  }
}

async function listen(a: TriggerActions): Promise<TriggerOutcome> {
  a.allowBackground();
  let error: string | null;
  try {
    error = await a.listen();
  } catch (err) {
    error = (err as Error)?.message || 'Could not open the microphone';
  }
  if (error) {
    a.tone('error');
    a.notice(error);
    return 'failed';
  }
  // The earcon: the mic is open, go ahead.
  a.tone('wake');
  return 'listening';
}

/**
 * Holds a trigger failure that happened while the page was hidden until the
 * user comes back, so it is actually seen.
 */
export class DeferredNotice {
  private pending: string | null = null;

  constructor(
    private readonly show: (message: string) => void,
    private readonly visible: () => boolean = () => typeof document === 'undefined' || document.visibilityState === 'visible',
  ) {}

  post(message: string): void {
    if (this.visible()) this.show(message);
    else this.pending = message;
  }

  /** Call when the page becomes visible / focused. */
  flush(): void {
    const m = this.pending;
    if (!m || !this.visible()) return;
    this.pending = null;
    this.show(m);
  }

  get waiting(): string | null {
    return this.pending;
  }
}
