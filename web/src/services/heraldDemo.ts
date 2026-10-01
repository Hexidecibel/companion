/**
 * DEV-ONLY fixture transport for eyeballing the Herald UI without a daemon.
 * Activated by `?heraldDemo=1` in a Vite dev build (see isHeraldDemo()).
 * Never reachable in production builds: isHeraldDemo() short-circuits on
 * import.meta.env.MODE, and the module is loaded via dynamic import.
 */
import type { WebSocketResponse } from '../types';
import type { HeraldAction, HeraldEvent, HeraldInboxItem, HeraldMessage, HeraldState } from '../types/herald';
import type { HeraldTransport } from './heraldTransport';

const S = 'demo-server';

function ok(type: string, payload?: unknown): WebSocketResponse {
  return { type, success: true, payload };
}

let singleton: HeraldTransport | null = null;

/** One shared fixture per page so StrictMode double-mounts don't fork timelines. */
export function getDemoTransport(): HeraldTransport {
  if (!singleton) singleton = createDemoTransport();
  return singleton;
}

function createDemoTransport(): HeraldTransport {
  const now = Date.now();
  const eventHandlers = new Set<(e: HeraldEvent) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let counter = 0;

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const emit = (e: HeraldEvent) => eventHandlers.forEach((h) => h(e));

  const inbox: HeraldInboxItem[] = [
    { id: 'i1', serverId: S, sessionId: 'deploy', sessionName: 'deploy-infra', priority: 'blocked', headline: 'Asking whether to run the prod migration now', createdAt: now - 4 * 60_000, heard: false },
    { id: 'i2', serverId: S, sessionId: 'daemon', sessionName: 'herald-daemon', priority: 'blocked', headline: 'Wants to know: keep the 20s echo window or shorten it?', createdAt: now - 9 * 60_000, heard: false },
    { id: 'i3', serverId: S, sessionId: 'companion', sessionName: 'companion', priority: 'finished', headline: 'Finished the reconnect overhaul, all 214 tests green', createdAt: now - 16 * 60_000, heard: false },
    { id: 'i4', serverId: S, sessionId: 'blog', sessionName: 'blog', priority: 'progress', headline: 'Drafting the fleet post, second section', createdAt: now - 22 * 60_000, heard: true },
    { id: 'i5', serverId: S, sessionId: 'aj', sessionName: 'aj-mac', priority: 'progress', headline: 'Rebuilding the web bundle', createdAt: now - 31 * 60_000, heard: true },
  ];

  const echo: HeraldAction = {
    id: 'a-echo', tier: 'echo', kind: 'answer_choice',
    serverId: S, sessionId: 'daemon', sessionName: 'herald-daemon',
    payload: '1', readback: 'Telling herald-daemon: keep the 20 second window.',
    reasons: [], status: 'pending', createdAt: now - 2_000, autoSendAt: now + 18_000,
  };
  const hard: HeraldAction = {
    id: 'a-hard', tier: 'hard_confirm', kind: 'answer_choice',
    serverId: S, sessionId: 'deploy', sessionName: 'deploy-infra',
    payload: '1', readback: 'Telling deploy-infra: yes, run the migration against production.',
    reasons: ['The pending question mentions production', 'Database migrations are irreversible'],
    status: 'pending', createdAt: now - 1_000,
  };
  const sent: HeraldAction = {
    id: 'a-sent', tier: 'echo', kind: 'send_input',
    serverId: S, sessionId: 'companion', sessionName: 'companion',
    payload: 'go ahead, skip the e2e suite', readback: 'Told companion: go ahead, skip the end to end suite.',
    reasons: [], status: 'sent', createdAt: now - 20 * 60_000, resolvedAt: now - 20 * 60_000 + 20_000,
  };
  const failed: HeraldAction = {
    id: 'a-failed', tier: 'echo', kind: 'send_input',
    serverId: S, sessionId: 'aj', sessionName: 'aj-mac',
    payload: 'continue', readback: 'Telling aj-mac: continue.',
    reasons: [], status: 'failed', error: 'tmux pane not found', createdAt: now - 18 * 60_000, resolvedAt: now - 18 * 60_000 + 3_000,
  };

  const messages: HeraldMessage[] = [
    { id: 'm1', role: 'user', text: 'Tell companion to go ahead but skip the e2e suite.', createdAt: now - 21 * 60_000 },
    { id: 'm2', role: 'herald', text: 'Done. Companion picked it back up and is running the unit tests only.', createdAt: now - 21 * 60_000 + 3_000, actionIds: ['a-sent'], sessionRefs: [{ serverId: S, sessionId: 'companion', sessionName: 'companion' }] },
    { id: 'm3', role: 'user', text: 'And nudge the one on AJ\'s box.', createdAt: now - 18 * 60_000 },
    { id: 'm4', role: 'herald', text: 'I tried, but the send did not land. Its terminal pane seems to be gone.', createdAt: now - 18 * 60_000 + 3_000, actionIds: ['a-failed'], sessionRefs: [{ serverId: S, sessionId: 'aj', sessionName: 'aj-mac' }] },
    { id: 'm5', role: 'user', text: 'Anything for me?', createdAt: now - 60_000 },
    {
      // Grounded: every claim below is something a session reported (see the inbox
      // headlines). Herald never invents user preferences or history.
      id: 'm6', role: 'herald', createdAt: now - 55_000,
      text: 'Two sessions are waiting on you.\n\nDeploy infra is asking whether to run the production migration now.\n\nHerald daemon wants to know whether to keep the twenty second echo window or shorten it.\n\nAlso, companion says it finished the reconnect work and all 214 tests passed.',
      sessionRefs: [
        { serverId: S, sessionId: 'deploy', sessionName: 'deploy-infra' },
        { serverId: S, sessionId: 'daemon', sessionName: 'herald-daemon' },
        { serverId: S, sessionId: 'companion', sessionName: 'companion' },
      ],
    },
    { id: 'm7', role: 'user', text: 'Tell herald-daemon to keep it. And yes to the migration.', createdAt: now - 8_000 },
    {
      id: 'm8', role: 'herald', createdAt: now - 3_000,
      text: 'Herald daemon is going ahead: keep the twenty second window, sending in a few seconds unless you stop it. The migration touches production, so it waits for your confirmation.',
      sessionRefs: [
        { serverId: S, sessionId: 'daemon', sessionName: 'herald-daemon' },
        { serverId: S, sessionId: 'deploy', sessionName: 'deploy-infra' },
      ],
      actionIds: ['a-echo', 'a-hard'],
    },
  ];

  let state: HeraldState = {
    displayName: 'Herald', enabled: true, model: 'claude-haiku-4-5', busy: false,
    messages, inbox, actions: [sent, failed, echo, hard],
  };

  const updateAction = (id: string, patch: Partial<HeraldAction>): HeraldAction | null => {
    const a = state.actions.find((x) => x.id === id);
    if (!a) return null;
    const next = { ...a, ...patch };
    state = { ...state, actions: state.actions.map((x) => (x.id === id ? next : x)) };
    emit({ kind: 'action', action: next });
    return next;
  };

  const armEcho = (a: HeraldAction) => {
    if (typeof a.autoSendAt !== 'number') return;
    later(Math.max(0, a.autoSendAt - Date.now()), () => {
      const cur = state.actions.find((x) => x.id === a.id);
      if (cur?.status === 'pending') updateAction(a.id, { status: 'sent', resolvedAt: Date.now() });
    });
  };
  armEcho(echo);

  const streamReply = (text: string, extra: Partial<HeraldMessage> = {}) => {
    const id = `demo-h-${++counter}`;
    emit({ kind: 'busy', busy: true });
    state = { ...state, busy: true };
    later(700, () => {
      const start: HeraldMessage = { id, role: 'herald', text: '', createdAt: Date.now(), streaming: true };
      emit({ kind: 'message_start', message: start });
      const tokens = text.match(/\S+\s*/g) ?? [text];
      let i = 0;
      const tick = () => {
        if (i < tokens.length) {
          emit({ kind: 'message_delta', messageId: id, delta: tokens[i++] });
          later(35 + Math.random() * 45, tick);
          return;
        }
        const final: HeraldMessage = { ...start, text, streaming: false, ...extra };
        state = { ...state, busy: false, messages: [...state.messages, final] };
        emit({ kind: 'message_end', message: final });
        emit({ kind: 'busy', busy: false });
      };
      tick();
    });
  };

  const reply = (text: string) => {
    const lower = text.toLowerCase();
    const match = state.inbox.find((i) => lower.includes(i.sessionName.toLowerCase()));
    if (match) {
      return streamReply(
        `${match.sessionName} ${match.priority === 'blocked' ? 'is waiting on you.' : match.priority === 'finished' ? 'is done.' : 'is still working.'} ${match.headline}. Want me to open it, or pass something along?`,
        { sessionRefs: [{ serverId: S, sessionId: match.sessionId, sessionName: match.sessionName }] },
      );
    }
    if (lower.includes('blocked')) {
      return streamReply('Two things are blocked: deploy infra wants a yes or no on the production migration, and herald daemon is asking about the echo window.');
    }
    if (lower.includes('continue') || lower.includes('go ahead')) {
      const a: HeraldAction = {
        id: `demo-a-${++counter}`, tier: 'echo', kind: 'send_input', serverId: S, sessionId: 'blog', sessionName: 'blog',
        payload: 'continue', readback: 'Telling blog: continue.', reasons: [], status: 'pending',
        createdAt: Date.now() + 700, autoSendAt: Date.now() + 700 + 20_000,
      };
      later(700, () => { state = { ...state, actions: [...state.actions, a] }; emit({ kind: 'action', action: a }); armEcho(a); });
      return streamReply('Telling blog to continue. I will send it in twenty seconds unless you stop me.', { actionIds: [a.id], sessionRefs: [{ serverId: S, sessionId: 'blog', sessionName: 'blog' }] });
    }
    return streamReply('Five sessions are up. Two are blocked on you, companion just finished, and blog and the one on AJ\'s box are still going. Nothing is on fire.');
  };

  return {
    isConnected: () => true,
    async request(type, payload) {
      await new Promise((r) => setTimeout(r, 120));
      const p = (payload ?? {}) as Record<string, unknown>;
      switch (type) {
        case 'herald_get_state':
          return ok(type, state);
        case 'herald_send': {
          if (state.busy) return { type, success: false, error: 'Herald is still answering' };
          const text = String(p.text ?? '');
          const msg: HeraldMessage = { id: `demo-u-${++counter}`, role: 'user', text, createdAt: Date.now() };
          state = { ...state, messages: [...state.messages, msg] };
          later(60, () => emit({ kind: 'message_end', message: msg }));
          reply(text);
          return ok(type, { messageId: msg.id });
        }
        case 'herald_confirm': {
          const decision = p.decision === 'confirm' ? 'sent' : 'cancelled';
          const a = updateAction(String(p.actionId), { status: decision, resolvedAt: Date.now() });
          return a ? ok(type, a) : { type, success: false, error: 'Unknown action' };
        }
        case 'herald_mark_heard': {
          const ids = new Set((p.itemIds as string[]) ?? []);
          state = { ...state, inbox: state.inbox.map((i) => (ids.has(i.id) ? { ...i, heard: true } : i)) };
          emit({ kind: 'inbox', inbox: state.inbox });
          return ok(type, {});
        }
        case 'herald_set_pronunciations': {
          const list = Array.isArray(p.pronunciations) ? (p.pronunciations as HeraldState['pronunciations']) ?? [] : [];
          state = { ...state, pronunciations: list };
          emit({ kind: 'pronunciations', pronunciations: list });
          return ok(type, { pronunciations: list });
        }
        case 'herald_reset':
          state = { ...state, messages: [], actions: [], busy: false };
          return ok(type, state);
        default:
          return { type, success: false, error: `Unknown message type: ${type}` };
      }
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => { eventHandlers.delete(handler); };
    },
    onConnectivity(handler) {
      handler(true);
      return () => {};
    },
  };
}
