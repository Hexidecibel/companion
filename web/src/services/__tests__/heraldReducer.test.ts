import { describe, it, expect } from 'vitest';
import {
  heraldReducer,
  initialHeraldClientState,
  selectMessages,
  reconcileOptimistic,
  echoCountdown,
  derivePresence,
  sortInbox,
  sortPendingByUrgency,
  type HeraldClientState,
} from '../heraldReducer';
import type { HeraldAction, HeraldEvent, HeraldInboxItem, HeraldMessage, HeraldState } from '../../types/herald';

const T0 = 1_700_000_000_000;

function baseState(overrides: Partial<HeraldState> = {}): HeraldState {
  return {
    displayName: 'Herald',
    enabled: true,
    model: 'claude-haiku-4-5',
    busy: false,
    messages: [],
    inbox: [],
    actions: [],
    ...overrides,
  };
}

function apply(state: HeraldClientState, event: HeraldEvent, receivedAt = T0): HeraldClientState {
  return heraldReducer(state, { type: 'event', event, receivedAt });
}

function msg(id: string, role: 'user' | 'herald', text: string, createdAt = T0): HeraldMessage {
  return { id, role, text, createdAt };
}

function inboxItem(id: string, priority: HeraldInboxItem['priority'], heard: boolean, createdAt = T0): HeraldInboxItem {
  return { id, serverId: 's', sessionId: id, sessionName: id, priority, headline: 'h', createdAt, heard };
}

describe('heraldReducer: delta assembly', () => {
  it('assembles start + deltas + end into one message', () => {
    let s = apply(initialHeraldClientState, { kind: 'state', state: baseState() });
    s = apply(s, { kind: 'message_start', message: msg('h1', 'herald', '') });
    s = apply(s, { kind: 'message_delta', messageId: 'h1', delta: 'Two sessions ' });
    s = apply(s, { kind: 'message_delta', messageId: 'h1', delta: 'are waiting.' });
    expect(s.server!.messages).toHaveLength(1);
    expect(s.server!.messages[0].text).toBe('Two sessions are waiting.');
    expect(s.server!.messages[0].streaming).toBe(true);

    s = apply(s, { kind: 'message_end', message: { ...msg('h1', 'herald', 'Two sessions are waiting.'), sessionRefs: [{ serverId: 's', sessionId: 'a', sessionName: 'a' }] } });
    expect(s.server!.messages).toHaveLength(1);
    expect(s.server!.messages[0].streaming).toBe(false);
    expect(s.server!.messages[0].sessionRefs).toHaveLength(1);
  });

  it('creates a stub when a delta arrives before message_start', () => {
    let s = apply(initialHeraldClientState, { kind: 'message_delta', messageId: 'x', delta: 'Hi' });
    expect(s.server!.messages).toEqual([expect.objectContaining({ id: 'x', role: 'herald', text: 'Hi', streaming: true })]);
    s = apply(s, { kind: 'message_delta', messageId: 'x', delta: ' there' });
    expect(s.server!.messages[0].text).toBe('Hi there');
    expect(s.loaded).toBe(false);
  });

  it('message_end text is authoritative over accumulated deltas', () => {
    let s = apply(initialHeraldClientState, { kind: 'message_start', message: msg('h', 'herald', '') });
    s = apply(s, { kind: 'message_delta', messageId: 'h', delta: 'Garb' });
    s = apply(s, { kind: 'message_end', message: msg('h', 'herald', 'Final.') });
    expect(s.server!.messages[0].text).toBe('Final.');
  });

  it('ignores a late or duplicated delta for a message that already ended', () => {
    let s = apply(initialHeraldClientState, { kind: 'message_start', message: msg('h', 'herald', '') });
    s = apply(s, { kind: 'message_delta', messageId: 'h', delta: 'Done.' });
    s = apply(s, { kind: 'message_end', message: msg('h', 'herald', 'Done.') });
    const after = apply(s, { kind: 'message_delta', messageId: 'h', delta: 'Done.' });
    expect(after).toBe(s);
    expect(after.server!.messages[0].text).toBe('Done.');
  });

  it('ignores empty deltas without changing identity', () => {
    const s = apply(initialHeraldClientState, { kind: 'message_start', message: msg('h', 'herald', '') });
    expect(apply(s, { kind: 'message_delta', messageId: 'h', delta: '' })).toBe(s);
  });

  it('busy=false clears any dangling streaming flag', () => {
    let s = apply(initialHeraldClientState, { kind: 'message_start', message: msg('h', 'herald', '') });
    s = apply(s, { kind: 'busy', busy: true });
    s = apply(s, { kind: 'busy', busy: false });
    expect(s.server!.busy).toBe(false);
    expect(s.server!.messages[0].streaming).toBe(false);
  });

  it('a state snapshot replaces folded state and marks loaded', () => {
    let s = apply(initialHeraldClientState, { kind: 'message_delta', messageId: 'x', delta: 'partial' });
    s = apply(s, { kind: 'state', state: baseState({ messages: [msg('x', 'herald', 'complete')] }) });
    expect(s.loaded).toBe(true);
    expect(s.server!.messages[0].text).toBe('complete');
  });
});

describe('heraldReducer: optimistic user lines', () => {
  it('shows optimistic line until the server echoes it', () => {
    let s = apply(initialHeraldClientState, { kind: 'state', state: baseState() });
    s = heraldReducer(s, { type: 'optimistic_add', message: msg('local-1', 'user', 'Anything for me?') });
    expect(selectMessages(s).map((m) => m.id)).toEqual(['local-1']);

    s = apply(s, { kind: 'message_end', message: msg('u1', 'user', 'Anything for me?') });
    expect(s.optimistic).toHaveLength(0);
    expect(selectMessages(s).map((m) => m.id)).toEqual(['u1']);
  });

  it('reconciles against a state snapshot too', () => {
    let s = heraldReducer(initialHeraldClientState, { type: 'optimistic_add', message: msg('local-1', 'user', 'hi') });
    s = apply(s, { kind: 'state', state: baseState({ messages: [msg('u1', 'user', 'hi')] }) });
    expect(s.optimistic).toHaveLength(0);
  });

  it('each server line consumes at most one optimistic duplicate', () => {
    const optimistic = [msg('l1', 'user', 'go'), msg('l2', 'user', 'go')];
    const left = reconcileOptimistic(optimistic, [msg('u', 'user', 'go')]);
    expect(left.map((m) => m.id)).toEqual(['l2']);
  });

  it('does not reconcile against herald lines with the same text', () => {
    const optimistic = [msg('l1', 'user', 'ok')];
    expect(reconcileOptimistic(optimistic, [msg('h', 'herald', 'ok')])).toBe(optimistic);
  });

  it('optimistic_remove drops a failed send', () => {
    let s = heraldReducer(initialHeraldClientState, { type: 'optimistic_add', message: msg('l1', 'user', 'x') });
    s = heraldReducer(s, { type: 'optimistic_remove', id: 'l1' });
    expect(s.optimistic).toEqual([]);
  });
});

describe('heraldReducer: actions, inbox, errors', () => {
  const action: HeraldAction = {
    id: 'a1', tier: 'echo', kind: 'answer_choice', serverId: 's', sessionId: 'x', sessionName: 'x',
    payload: '1', readback: 'Telling x option 1', reasons: [], status: 'pending',
    createdAt: T0, autoSendAt: T0 + 20_000,
  };

  it('upserts actions by id', () => {
    let s = apply(initialHeraldClientState, { kind: 'action', action });
    s = apply(s, { kind: 'action', action: { ...action, status: 'sent', resolvedAt: T0 + 20_000 } });
    expect(s.server!.actions).toHaveLength(1);
    expect(s.server!.actions[0].status).toBe('sent');
  });

  it('action_result (confirm response) upserts too', () => {
    let s = apply(initialHeraldClientState, { kind: 'action', action });
    s = heraldReducer(s, { type: 'action_result', action: { ...action, status: 'cancelled' } });
    expect(s.server!.actions[0].status).toBe('cancelled');
  });

  it('marks inbox items heard locally', () => {
    let s = apply(initialHeraldClientState, { kind: 'state', state: baseState({ inbox: [inboxItem('a', 'blocked', false), inboxItem('b', 'finished', false)] }) });
    s = heraldReducer(s, { type: 'mark_heard_local', ids: ['a'] });
    expect(s.server!.inbox.map((i) => i.heard)).toEqual([true, false]);
  });

  it('surfaces and clears errors', () => {
    let s = apply(initialHeraldClientState, { kind: 'error', error: 'Brain timed out' });
    expect(s.error).toBe('Brain timed out');
    s = heraldReducer(s, { type: 'clear_error' });
    expect(s.error).toBeNull();
  });

  it('estimates clock skew as the minimum sample from fresh objects', () => {
    // Server clock is 5s behind local; latencies 300ms then 80ms.
    let s = apply(initialHeraldClientState, { kind: 'message_start', message: msg('h', 'herald', '', T0) }, T0 + 5_300);
    expect(s.skewMs).toBe(5_300);
    s = apply(s, { kind: 'action', action: { ...action, createdAt: T0 + 1_000 } }, T0 + 6_080);
    expect(s.skewMs).toBe(5_080);
    // Resolved-action rebroadcasts never feed the estimate.
    s = apply(s, { kind: 'action', action: { ...action, status: 'sent', createdAt: T0 } }, T0 + 1_000);
    expect(s.skewMs).toBe(5_080);
  });

  it('ignores implausible skew samples (stale objects)', () => {
    const s = apply(initialHeraldClientState, { kind: 'action', action: { ...action, createdAt: T0 - 60 * 60_000 } }, T0);
    expect(s.skewMs).toBeNull();
  });
});

describe('echoCountdown', () => {
  const a = { createdAt: T0, autoSendAt: T0 + 20_000 };

  it('counts down in local time with no skew', () => {
    expect(echoCountdown(a, T0, 0)).toEqual({ remainingMs: 20_000, totalMs: 20_000, fraction: 1 });
    expect(echoCountdown(a, T0 + 5_000, 0)).toEqual({ remainingMs: 15_000, totalMs: 20_000, fraction: 0.75 });
  });

  it('shifts the deadline by the estimated skew', () => {
    // Local clock runs 3s ahead of the server.
    const cd = echoCountdown(a, T0 + 3_000 + 10_000, 3_000)!;
    expect(cd.remainingMs).toBe(10_000);
    expect(cd.fraction).toBe(0.5);
  });

  it('clamps to [0, total]', () => {
    expect(echoCountdown(a, T0 + 60_000, 0)!.remainingMs).toBe(0);
    expect(echoCountdown(a, T0 + 60_000, 0)!.fraction).toBe(0);
    // Local clock far behind the server: never exceed the window.
    expect(echoCountdown(a, T0 - 30_000, 0)!.remainingMs).toBe(20_000);
  });

  it('treats unknown skew as zero', () => {
    expect(echoCountdown(a, T0 + 1_000, null)!.remainingMs).toBe(19_000);
  });

  it('returns null without autoSendAt', () => {
    expect(echoCountdown({ createdAt: T0 }, T0, 0)).toBeNull();
  });
});

describe('presence + inbox ordering', () => {
  it('derives presence with the right precedence', () => {
    const blockedUnheard = [inboxItem('a', 'blocked', false)];
    expect(derivePresence({ available: false, enabled: true, busy: true, inbox: blockedUnheard })).toBe('disabled');
    expect(derivePresence({ available: true, enabled: false, busy: false, inbox: [] })).toBe('disabled');
    expect(derivePresence({ available: true, enabled: true, busy: true, inbox: blockedUnheard })).toBe('busy');
    expect(derivePresence({ available: true, enabled: true, busy: false, inbox: blockedUnheard })).toBe('attention');
    expect(derivePresence({ available: true, enabled: true, busy: false, inbox: [inboxItem('a', 'blocked', true)] })).toBe('idle');
  });

  it('sorts unheard first, then blocked > finished > progress, newest first', () => {
    const items = [
      inboxItem('p', 'progress', false, T0 + 5),
      inboxItem('bh', 'blocked', true, T0 + 9),
      inboxItem('f', 'finished', false, T0 + 1),
      inboxItem('b1', 'blocked', false, T0 + 2),
      inboxItem('b2', 'blocked', false, T0 + 3),
    ];
    expect(sortInbox(items).map((i) => i.id)).toEqual(['b2', 'b1', 'f', 'p', 'bh']);
  });
});

describe('sortPendingByUrgency', () => {
  const mk = (id: string, tier: HeraldAction['tier'], createdAt: number, extra: Partial<HeraldAction> = {}): HeraldAction => ({
    id, tier, kind: 'send_input', serverId: 's', sessionId: id, sessionName: id,
    payload: 'go', readback: `${id}: go`, reasons: [], status: 'pending', createdAt, ...extra,
  });

  it('puts hard-confirms first (oldest first), then echoes by soonest auto-send, and drops resolved', () => {
    const items = [
      mk('echo-late', 'echo', T0, { autoSendAt: T0 + 20_000 }),
      mk('hard-new', 'hard_confirm', T0 + 5),
      mk('echo-soon', 'echo', T0 + 9, { autoSendAt: T0 + 6_000 }),
      mk('hard-old', 'hard_confirm', T0 + 1),
      mk('done', 'hard_confirm', T0, { status: 'sent' }),
    ];
    expect(sortPendingByUrgency(items).map((a) => a.id)).toEqual(['hard-old', 'hard-new', 'echo-soon', 'echo-late']);
  });

  it('falls back to creation order for echoes without a deadline', () => {
    const items = [mk('b', 'echo', T0 + 2), mk('a', 'echo', T0 + 1)];
    expect(sortPendingByUrgency(items).map((a) => a.id)).toEqual(['a', 'b']);
  });
});
