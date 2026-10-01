/**
 * What a voice transcript does: a local command (no brain round trip), a
 * structured brain request, or an ordinary message. Pure routing over injected
 * actions so every branch is unit-tested.
 */
import type { HeraldIntent } from '../../types/herald';
import { matchVoiceCommand, stripWakeWord, type VoiceCommand } from './voiceCommands';

export interface VoiceCommandActions {
  /** STOP: silence now (client and server queues); a reply being thought about stays silent. */
  stop: () => void;
  /** REPEAT: replay the last reply. False when there is nothing to repeat. */
  repeat: () => boolean;
  /** MORE: speak what the spoken cap held back. False when nothing was held back. */
  goOn: () => boolean;
  /** SLOWER / FASTER. */
  stepRate: (dir: 1 | -1) => void;
  /** A briefing is coming: allow it a longer spoken turn. */
  expectBriefing: () => void;
  /** Send a structured request to the brain (as a voice message). */
  sendIntent: (text: string, intent: HeraldIntent) => void;
  /** UNDO: cancel the newest send still counting down (see voiceUndo.ts). */
  undo: () => void;
  /** Short transient notice ("Nothing to repeat yet"). */
  notice: (text: string) => void;
}

export interface RouteResult {
  /** The command that matched, if any. */
  command: VoiceCommand | null;
  /** Text to send on as an ordinary message (null: handled, or nothing left). */
  send: string | null;
}

export function routeVoiceTranscript(text: string, a: VoiceCommandActions): RouteResult {
  const command = matchVoiceCommand(text);
  if (!command) {
    const rest = stripWakeWord(text);
    return { command: null, send: rest || null };
  }
  // What the chat shows for a brain request: the user's words, minus "Hey Jarvis".
  const said = stripWakeWord(text) || text.trim();
  switch (command) {
    case 'stop':
      a.stop();
      break;
    case 'repeat':
      if (!a.repeat()) a.notice('Nothing to repeat yet');
      break;
    case 'more':
      if (!a.goOn()) a.sendIntent(said, 'more');
      break;
    case 'shorter':
      a.sendIntent(said, 'shorter');
      break;
    case 'brief':
      a.expectBriefing();
      a.sendIntent(said, 'brief');
      break;
    case 'slower':
      a.stepRate(-1);
      break;
    case 'faster':
      a.stepRate(1);
      break;
    case 'undo':
      a.undo();
      break;
  }
  return { command, send: null };
}
