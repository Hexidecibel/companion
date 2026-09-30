/**
 * Pure client-side state machine for Herald (the fleet front layer).
 *
 * Kept free of React / WebSocket concerns so delta assembly, optimistic
 * reconciliation and countdown math are unit-testable.
 */
import type {
  HeraldAction,
  HeraldEvent,
  HeraldInboxItem,
  HeraldMessage,
  HeraldState,
  InboxPriority,
} from '../types/herald';

export const DEFAULT_DISPLAY_NAME = 'Herald';

export interface HeraldClientState {
  /** Last known server state with events folded in. null until first fetch/event. */
  server: HeraldState | null;
  /** True once a full `state` snapshot has been received. */
  loaded: boolean;
  /** Locally-sent user lines not yet echoed back by the server. */
  optimistic: HeraldMessage[];
  /** Last surfaced error (non-blocking). */
  error: string | null;
  /**
   * Estimated (local clock - server clock) in ms, including one-way latency.
   * Minimum over samples taken from freshly-created server objects.
   */
  skewMs: number | null;
}

export type HeraldClientAction =
  | { type: 'event'; event: HeraldEvent; receivedAt: number }
  | { type: 'optimistic_add'; message: HeraldMessage }
  | { type: 'optimistic_remove'; id: string }
  | { type: 'action_result'; action: HeraldAction }
  | { type: 'mark_heard_local'; ids: string[] }
  | { type: 'error'; error: string }
  | { type: 'clear_error' }
  | { type: 'reset_local' }
  | { type: 'clear' };

export const initialHeraldClientState: HeraldClientState = {
  server: null,
  loaded: false,
  optimistic: [],
  error: null,
  skewMs: null,
};

function emptyServerState(): HeraldState {
  return {
    displayName: DEFAULT_DISPLAY_NAME,
    enabled: true,
    model: '',
    busy: false,
    messages: [],
    inbox: [],
    actions: [],
  };
}

/** Samples older than this are not "fresh" and must not feed the skew estimate. */
const MAX_SKEW_SAMPLE_MS = 5 * 60 * 1000;

function sampleSkew(prev: number | null, receivedAt: number, createdAt: number | undefined): number | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return prev;
  const sample = receivedAt - createdAt;
  if (Math.abs(sample) > MAX_SKEW_SAMPLE_MS) return prev;
  return prev === null ? sample : Math.min(prev, sample);
}

function upsertMessage(list: HeraldMessage[], msg: HeraldMessage): HeraldMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id);
  if (idx === -1) return [...list, msg];
  const next = list.slice();
  next[idx] = msg;
  return next;
}

function upsertAction(list: HeraldAction[], action: HeraldAction): HeraldAction[] {
  const idx = list.findIndex((a) => a.id === action.id);
  if (idx === -1) return [...list, action];
  const next = list.slice();
  next[idx] = action;
  return next;
}

/**
 * Drop optimistic user lines that the server has now echoed (same text, user role).
 * Each server line consumes at most one optimistic line.
 */
export function reconcileOptimistic(optimistic: HeraldMessage[], serverMessages: HeraldMessage[]): HeraldMessage[] {
  if (optimistic.length === 0) return optimistic;
  const serverUserTexts = serverMessages
    .filter((m) => m.role === 'user')
    .map((m) => m.text.trim());
  const remaining: HeraldMessage[] = [];
  const pool = [...serverUserTexts];
  for (const o of optimistic) {
    // Match from the end: the echo of a just-sent line is the most recent one.
    const idx = pool.lastIndexOf(o.text.trim());
    if (idx !== -1) {
      pool.splice(idx, 1);
    } else {
      remaining.push(o);
    }
  }
  return remaining.length === optimistic.length ? optimistic : remaining;
}

function applyEvent(state: HeraldClientState, event: HeraldEvent, receivedAt: number): HeraldClientState {
  const server = state.server ?? emptyServerState();
  switch (event.kind) {
    case 'state': {
      const incoming = event.state;
      return {
        ...state,
        server: incoming,
        loaded: true,
        optimistic: reconcileOptimistic(state.optimistic, incoming.messages),
      };
    }
    case 'message_start': {
      const messages = upsertMessage(server.messages, { ...event.message, streaming: event.message.role === 'herald' ? (event.message.streaming ?? true) : event.message.streaming });
      return {
        ...state,
        server: { ...server, messages },
        optimistic: reconcileOptimistic(state.optimistic, messages),
        skewMs: sampleSkew(state.skewMs, receivedAt, event.message.createdAt),
      };
    }
    case 'message_delta': {
      if (!event.delta) return state;
      const idx = server.messages.findIndex((m) => m.id === event.messageId);
      let messages: HeraldMessage[];
      if (idx === -1) {
        // Delta arrived before (or without) message_start: create a stub.
        messages = [
          ...server.messages,
          { id: event.messageId, role: 'herald', text: event.delta, createdAt: receivedAt - (state.skewMs ?? 0), streaming: true },
        ];
      } else {
        const prev = server.messages[idx];
        // A late / duplicated delta for a message that already ended would append
        // text twice: message_end carries the authoritative final text.
        if (prev.streaming === false) return state;
        messages = server.messages.slice();
        messages[idx] = { ...prev, text: prev.text + event.delta, streaming: true };
      }
      return { ...state, server: { ...server, messages } };
    }
    case 'message_end': {
      const messages = upsertMessage(server.messages, { ...event.message, streaming: false });
      return {
        ...state,
        server: { ...server, messages },
        optimistic: reconcileOptimistic(state.optimistic, messages),
      };
    }
    case 'inbox':
      return { ...state, server: { ...server, inbox: event.inbox } };
    case 'action': {
      const skewMs = event.action.status === 'pending'
        ? sampleSkew(state.skewMs, receivedAt, event.action.createdAt)
        : state.skewMs;
      return { ...state, server: { ...server, actions: upsertAction(server.actions, event.action) }, skewMs };
    }
    case 'busy': {
      // Turn finished: nothing can still be streaming.
      const messages = event.busy
        ? server.messages
        : server.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m));
      return { ...state, server: { ...server, busy: event.busy, messages } };
    }
    case 'settings':
      return { ...state, server: { ...server, verbosity: event.verbosity } };
    case 'devices':
      return { ...state, server: { ...server, activeDevice: event.activeDevice, devices: event.devices } };
    case 'error':
      return { ...state, error: event.error };
    default:
      return state;
  }
}

export function heraldReducer(state: HeraldClientState, action: HeraldClientAction): HeraldClientState {
  switch (action.type) {
    case 'event':
      return applyEvent(state, action.event, action.receivedAt);
    case 'optimistic_add':
      return { ...state, optimistic: [...state.optimistic, action.message] };
    case 'optimistic_remove':
      return { ...state, optimistic: state.optimistic.filter((m) => m.id !== action.id) };
    case 'action_result': {
      const server = state.server ?? emptyServerState();
      return { ...state, server: { ...server, actions: upsertAction(server.actions, action.action) } };
    }
    case 'mark_heard_local': {
      if (!state.server) return state;
      const ids = new Set(action.ids);
      return {
        ...state,
        server: {
          ...state.server,
          inbox: state.server.inbox.map((i) => (ids.has(i.id) && !i.heard ? { ...i, heard: true } : i)),
        },
      };
    }
    case 'error':
      return { ...state, error: action.error };
    case 'clear_error':
      return { ...state, error: null };
    case 'reset_local':
      return { ...state, optimistic: [] };
    case 'clear':
      return initialHeraldClientState;
    default:
      return state;
  }
}

/** Server messages followed by still-unacknowledged optimistic user lines. */
export function selectMessages(state: HeraldClientState): HeraldMessage[] {
  const base = state.server?.messages ?? [];
  if (state.optimistic.length === 0) return base;
  return [...base, ...state.optimistic];
}

const PRIORITY_RANK: Record<InboxPriority, number> = { blocked: 0, finished: 1, progress: 2 };

/** Priority order (blocked > finished > progress), unheard first, newest first. */
export function sortInbox(items: HeraldInboxItem[]): HeraldInboxItem[] {
  return [...items].sort((a, b) => {
    if (a.heard !== b.heard) return a.heard ? 1 : -1;
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (p !== 0) return p;
    return b.createdAt - a.createdAt;
  });
}

/**
 * Pending actions, most urgent first: hard-confirms (oldest first; they block on
 * the user and expire), then echoes by soonest auto-send.
 */
export function sortPendingByUrgency(actions: HeraldAction[]): HeraldAction[] {
  return actions
    .filter((a) => a.status === 'pending')
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === 'hard_confirm' ? -1 : 1;
      if (a.tier === 'echo' && a.autoSendAt !== b.autoSendAt) {
        if (a.autoSendAt === undefined) return 1;
        if (b.autoSendAt === undefined) return -1;
        return a.autoSendAt - b.autoSendAt;
      }
      return a.createdAt - b.createdAt;
    });
}

export type HeraldPresence = 'idle' | 'busy' | 'attention' | 'disabled';

export function derivePresence(opts: {
  available: boolean;
  enabled: boolean;
  busy: boolean;
  inbox: HeraldInboxItem[];
}): HeraldPresence {
  if (!opts.available || !opts.enabled) return 'disabled';
  if (opts.busy) return 'busy';
  if (opts.inbox.some((i) => i.priority === 'blocked' && !i.heard)) return 'attention';
  return 'idle';
}

export interface EchoCountdown {
  /** ms left until the server auto-sends (local clock), clamped to [0, totalMs]. */
  remainingMs: number;
  /** Full countdown window (server-side, drift-free). */
  totalMs: number;
  /** remaining / total, in [0, 1]. 1 = just started, 0 = due. */
  fraction: number;
}

/**
 * Countdown for an echo-tier action. The window length (autoSendAt - createdAt)
 * is computed purely from server timestamps so it is immune to clock drift; the
 * deadline is shifted into local time using the estimated skew.
 */
export function echoCountdown(action: Pick<HeraldAction, 'autoSendAt' | 'createdAt'>, nowLocal: number, skewMs: number | null): EchoCountdown | null {
  if (typeof action.autoSendAt !== 'number') return null;
  const totalMs = Math.max(1, action.autoSendAt - action.createdAt);
  const deadlineLocal = action.autoSendAt + (skewMs ?? 0);
  const remainingMs = Math.min(totalMs, Math.max(0, deadlineLocal - nowLocal));
  return { remainingMs, totalMs, fraction: remainingMs / totalMs };
}
