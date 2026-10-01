/**
 * "Show me": which session to open. PURE (unit-tested resolution order).
 *
 * Named ("show me Out4"): the same fuzzy-but-safe resolution every session tool
 * uses (resolve.ts): one match or nothing; several = ambiguous (ask which).
 * Unnamed ("show me", "pull it up"): the most relevant thing Herald just
 * discussed, in this order:
 *   1. the session of the newest pending card (echo or red),
 *   2. the latest Herald message's first session chip,
 *   3. the newest unheard inbox item.
 */

import type {
  HeraldAction,
  HeraldInboxItem,
  HeraldMessage,
  HeraldSessionRef,
  HeraldShowStatus,
} from './protocol';
import { resolveSession } from './resolve';
import type { SessionSnapshot } from './session-source';

export type ShowTarget =
  | { ok: true; session: HeraldSessionRef; pending: boolean; from: ShowSourceKind }
  | {
      ok: false;
      status: Extract<HeraldShowStatus, 'ambiguous' | 'not_found' | 'nothing'>;
      candidates: string[];
    };

/** Where an unnamed target came from (tests, logs). */
export type ShowSourceKind = 'named' | 'card' | 'message' | 'inbox';

export interface ShowContext {
  actions: readonly HeraldAction[];
  messages: readonly HeraldMessage[];
  inbox: readonly HeraldInboxItem[];
  sessions: readonly SessionSnapshot[];
}

/** Does the session have a question, choice or approval waiting? */
export function hasPendingPrompt(s: SessionSnapshot | undefined): boolean {
  return !!s && !s.inactive && !!(s.pendingChoice || s.pendingApproval || s.pendingQuestion);
}

function findSnap(
  sessions: readonly SessionSnapshot[],
  ref: { serverId: string; sessionId: string }
): SessionSnapshot | undefined {
  return sessions.find((s) => s.serverId === ref.serverId && s.sessionId === ref.sessionId);
}

function toTarget(
  ref: HeraldSessionRef,
  sessions: readonly SessionSnapshot[],
  from: ShowSourceKind
): ShowTarget {
  const snap = findSnap(sessions, ref);
  return {
    ok: true,
    // The live name wins (a rename since the card / message was written).
    session: {
      serverId: ref.serverId,
      sessionId: ref.sessionId,
      sessionName: snap?.sessionName || ref.sessionName,
    },
    pending: hasPendingPrompt(snap),
    from,
  };
}

/** The unnamed target, by the order above; null when there is nothing. */
export function latestShowRef(
  ctx: Omit<ShowContext, 'sessions'>
): { ref: HeraldSessionRef; from: ShowSourceKind } | null {
  // 1. Newest pending card that is about a session (not a cush-tools command).
  const cards = ctx.actions
    .filter((a) => a.status === 'pending' && a.kind !== 'cush_command' && a.sessionId)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (cards[0]) {
    const a = cards[0];
    return {
      ref: { serverId: a.serverId, sessionId: a.sessionId, sessionName: a.sessionName },
      from: 'card',
    };
  }
  // 2. The latest Herald message's first chip (only the latest: an older
  // message is no longer "what Herald is talking about").
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i];
    if (m.role !== 'herald') continue;
    const first = m.sessionRefs?.[0];
    if (first) return { ref: { ...first }, from: 'message' };
    break;
  }
  // 3. Newest unheard inbox item.
  const unheard = ctx.inbox.filter((i) => !i.heard).sort((a, b) => b.createdAt - a.createdAt);
  if (unheard[0]) {
    const i = unheard[0];
    return {
      ref: { serverId: i.serverId, sessionId: i.sessionId, sessionName: i.sessionName },
      from: 'inbox',
    };
  }
  return null;
}

export function pickShowTarget(
  sessionRef: string | undefined | null,
  ctx: ShowContext
): ShowTarget {
  const named = (sessionRef || '').trim();
  if (named) {
    const r = resolveSession(named, [...ctx.sessions]);
    if (r.ok) {
      return toTarget(
        {
          serverId: r.session.serverId,
          sessionId: r.session.sessionId,
          sessionName: r.session.sessionName,
        },
        ctx.sessions,
        'named'
      );
    }
    // resolveSession lists live sessions as candidates when nothing matched:
    // only a multi-match is "ambiguous".
    return r.ambiguous
      ? { ok: false, status: 'ambiguous', candidates: r.candidates }
      : { ok: false, status: 'not_found', candidates: [] };
  }
  const latest = latestShowRef(ctx);
  if (!latest) return { ok: false, status: 'nothing', candidates: [] };
  return toTarget(latest.ref, ctx.sessions, latest.from);
}
