/**
 * Answer a question / approval / start-up prompt in a session with the
 * daemon's send_choice request. Shared by SessionView, ConciergeView and the
 * Mission Control tiles so they all send the same payload.
 */
import { connectionManager } from './ConnectionManager';

export interface ChoiceData {
  selectedIndices: number[];
  optionCount: number;
  multiSelect: boolean;
  otherText?: string;
  promptKind?: 'trust';
  /**
   * Labels of the tapped options: the daemon answers the on-screen row with
   * that label (never positional) or refuses with stale_prompt.
   */
  selectedLabels?: string[];
}

export interface SendChoiceTarget {
  serverId: string;
  sessionId: string;
  tmuxSessionName?: string;
  /** The prompt signature the user saw; the daemon refuses if the prompt changed. */
  expectSignature?: string;
}

export type SendChoiceResult =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'offline' | 'error'; error?: string };

/** The daemon's error string when expectSignature no longer matches. */
export const STALE_PROMPT_ERROR = 'stale_prompt';

export function buildSendChoicePayload(choice: ChoiceData, target: SendChoiceTarget): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...choice,
    sessionId: target.sessionId,
    tmuxSessionName: target.tmuxSessionName || target.sessionId,
  };
  if (target.expectSignature) payload.expectSignature = target.expectSignature;
  return payload;
}

function isStale(error: unknown): boolean {
  return typeof error === 'string' && /stale/i.test(error);
}

export async function sendChoice(choice: ChoiceData, target: SendChoiceTarget): Promise<SendChoiceResult> {
  const conn = connectionManager.getConnection(target.serverId);
  if (!conn?.isConnected()) return { ok: false, reason: 'offline' };
  try {
    const response = await conn.sendRequest('send_choice', buildSendChoicePayload(choice, target));
    if (response.success) return { ok: true };
    return { ok: false, reason: isStale(response.error) ? 'stale' : 'error', error: response.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: isStale(message) ? 'stale' : 'error', error: message };
  }
}
