import { useState, useEffect, useCallback, useReducer, useRef, useMemo } from 'react';
import type { HeraldAction, HeraldEvent, HeraldInputMode, HeraldIntent, HeraldMessage, HeraldPronunciation, HeraldState, HeraldUsageSummary, HeraldVerbosity } from '../types/herald';
import {
  heraldReducer,
  initialHeraldClientState,
  selectMessages,
} from '../services/heraldReducer';
import {
  createConnectionTransport,
  HERALD_DEMO_SERVER_ID,
  type HeraldTransport,
} from '../services/heraldTransport';

const STATE_TIMEOUT = 10000;
const SEND_TIMEOUT = 20000;

/** Daemon answers unknown request types with this; means the hub predates Herald. */
function isUnsupportedError(err: string | undefined): boolean {
  return !!err && /unknown message type/i.test(err);
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return fallback;
}

/**
 * Raw event tap for side channels (voice, chimes). `push` = live socket event,
 * `fetch` = state snapshot from herald_get_state / reset (history: never voiced).
 */
export type HeraldEventListener = (event: HeraldEvent, source: 'push' | 'fetch') => void;

export interface UseHeraldReturn {
  state: HeraldState | null;
  messages: HeraldMessage[];
  loaded: boolean;
  connected: boolean;
  /** null = not yet known, false = hub daemon has no Herald support. */
  supported: boolean | null;
  sending: boolean;
  error: string | null;
  skewMs: number | null;
  /** `mode`: how the words arrived (voice replies are shorter); `intent`: a spoken command. */
  send: (text: string, opts?: SendOptions) => Promise<boolean>;
  /** Reply length setting on the hub (no-op on daemons without it). */
  setVerbosity: (v: HeraldVerbosity) => Promise<boolean>;
  /** Monthly API budget: USD, null = none, undefined = back to the server config. Error text or null. */
  setBudget: (monthlyUsd: number | null | undefined) => Promise<string | null>;
  /** Replace the voice's pronunciation list on the hub. Resolves an error, or null. */
  setPronunciations: (list: HeraldPronunciation[]) => Promise<string | null>;
  confirm: (actionId: string, decision: 'confirm' | 'cancel') => Promise<HeraldAction | null>;
  /** Confirm a red card by its spoken phrase; the hub verifies it. `error` is sayable. */
  confirmByVoice: (actionId: string, phrase: string, streamId?: string) => Promise<{ action: HeraldAction | null; error: string | null }>;
  markHeard: (itemIds: string[]) => void;
  reset: () => Promise<boolean>;
  refresh: () => void;
  clearError: () => void;
  /** Subscribe to every Herald event with its source. Stable identity. */
  subscribeEvents: (listener: HeraldEventListener) => () => void;
  /** Current host transport (voice side channel). Stable identity. */
  getTransport: () => HeraldTransport | null;
}

export interface SendOptions {
  mode?: HeraldInputMode;
  intent?: HeraldIntent;
}

export function useHerald(serverId: string | null): UseHeraldReturn {
  const [client, dispatch] = useReducer(heraldReducer, initialHeraldClientState);
  const [connected, setConnected] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const transportRef = useRef<HeraldTransport | null>(null);
  const fetchSeq = useRef(0);
  const localSeq = useRef(0);
  const eventListeners = useRef(new Set<HeraldEventListener>());

  const notify = useCallback((event: HeraldEvent, source: 'push' | 'fetch') => {
    for (const l of [...eventListeners.current]) {
      try {
        l(event, source);
      } catch {
        // side channels must never break the chat
      }
    }
  }, []);

  const subscribeEvents = useCallback((listener: HeraldEventListener) => {
    eventListeners.current.add(listener);
    return () => { eventListeners.current.delete(listener); };
  }, []);

  const fetchState = useCallback(async () => {
    const t = transportRef.current;
    if (!t || !t.isConnected()) return;
    const seq = ++fetchSeq.current;
    try {
      const res = await t.request('herald_get_state', {}, STATE_TIMEOUT);
      if (seq !== fetchSeq.current || transportRef.current !== t) return;
      if (res.success && res.payload) {
        setSupported(true);
        const event: HeraldEvent = { kind: 'state', state: res.payload as HeraldState };
        dispatch({ type: 'event', event, receivedAt: Date.now() });
        notify(event, 'fetch');
      } else if (isUnsupportedError(res.error)) {
        setSupported(false);
      } else {
        dispatch({ type: 'error', error: res.error || 'Could not load Herald' });
      }
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      dispatch({ type: 'error', error: errorText(err, 'Could not load Herald') });
    }
  }, [notify]);

  useEffect(() => {
    dispatch({ type: 'clear' });
    setSupported(null);
    setConnected(false);
    setSending(false);
    transportRef.current = null;
    if (!serverId) return;

    let cancelled = false;
    const unsubs: Array<() => void> = [];

    const attach = (t: HeraldTransport) => {
      if (cancelled) return;
      transportRef.current = t;
      unsubs.push(t.onEvent((event) => {
        dispatch({ type: 'event', event, receivedAt: Date.now() });
        notify(event, 'push');
      }));
      unsubs.push(t.onConnectivity((isUp) => {
        setConnected(isUp);
        // Initial connect and every reconnect: state may have drifted while down.
        if (isUp) void fetchState();
      }));
    };

    if (import.meta.env.MODE !== 'production' && serverId === HERALD_DEMO_SERVER_ID) {
      import('../services/heraldDemo')
        .then((m) => attach(m.getDemoTransport()))
        .catch(() => dispatch({ type: 'error', error: 'Demo fixture failed to load' }));
    } else {
      const t = createConnectionTransport(serverId);
      if (t) attach(t);
    }

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      transportRef.current = null;
    };
  }, [serverId, fetchState, notify]);

  const send = useCallback(async (raw: string, opts: SendOptions = {}): Promise<boolean> => {
    const text = raw.trim();
    const t = transportRef.current;
    if (!text) return false;
    if (!t || !t.isConnected()) {
      dispatch({ type: 'error', error: 'Not connected to the Herald host' });
      return false;
    }
    const optimistic: HeraldMessage = {
      id: `local-${Date.now()}-${++localSeq.current}`,
      role: 'user',
      text,
      createdAt: Date.now(),
      ...(opts.intent ? { intent: opts.intent } : {}),
    };
    dispatch({ type: 'optimistic_add', message: optimistic });
    setSending(true);
    try {
      // Older daemons ignore mode / intent (the words still go through).
      const payload = { text, ...(opts.mode ? { mode: opts.mode } : {}), ...(opts.intent ? { intent: opts.intent } : {}) };
      const res = await t.request('herald_send', payload, SEND_TIMEOUT);
      if (!res.success) {
        dispatch({ type: 'optimistic_remove', id: optimistic.id });
        dispatch({ type: 'error', error: res.error || 'Herald could not take that' });
        return false;
      }
      // The hub recognised Herald's own voice (self-echo) and dropped it.
      if ((res.payload as { ignored?: string } | undefined)?.ignored) {
        dispatch({ type: 'optimistic_remove', id: optimistic.id });
      }
      return true;
    } catch (err) {
      dispatch({ type: 'optimistic_remove', id: optimistic.id });
      dispatch({ type: 'error', error: errorText(err, 'Send failed') });
      return false;
    } finally {
      setSending(false);
    }
  }, []);

  const confirm = useCallback(async (actionId: string, decision: 'confirm' | 'cancel'): Promise<HeraldAction | null> => {
    const t = transportRef.current;
    if (!t || !t.isConnected()) {
      dispatch({ type: 'error', error: 'Not connected to the Herald host' });
      return null;
    }
    try {
      const res = await t.request('herald_confirm', { actionId, decision });
      if (res.success && res.payload) {
        const action = res.payload as HeraldAction;
        dispatch({ type: 'action_result', action });
        return action;
      }
      dispatch({ type: 'error', error: res.error || `Could not ${decision} that action` });
      // Our view is probably stale (e.g. it auto-sent already); resync.
      void fetchState();
      return null;
    } catch (err) {
      dispatch({ type: 'error', error: errorText(err, `Could not ${decision} that action`) });
      return null;
    }
  }, [fetchState]);

  const confirmByVoice = useCallback(async (actionId: string, phrase: string, streamId?: string): Promise<{ action: HeraldAction | null; error: string | null }> => {
    const t = transportRef.current;
    if (!t || !t.isConnected()) return { action: null, error: 'Not connected to the Herald host' };
    try {
      const res = await t.request('herald_confirm', { actionId, decision: 'confirm', method: 'voice', phrase, ...(streamId ? { streamId } : {}) });
      if (res.success && res.payload) {
        const action = res.payload as HeraldAction;
        dispatch({ type: 'action_result', action });
        return { action, error: null };
      }
      // Attempts left changed on the hub: resync the card.
      void fetchState();
      return { action: null, error: res.error || 'Could not confirm that by voice' };
    } catch (err) {
      return { action: null, error: errorText(err, 'Could not confirm that by voice') };
    }
  }, [fetchState]);

  const markHeard = useCallback((itemIds: string[]) => {
    if (itemIds.length === 0) return;
    dispatch({ type: 'mark_heard_local', ids: itemIds });
    const t = transportRef.current;
    if (!t || !t.isConnected()) return;
    t.request('herald_mark_heard', { itemIds }).catch(() => {});
  }, []);

  const reset = useCallback(async (): Promise<boolean> => {
    const t = transportRef.current;
    if (!t || !t.isConnected()) {
      dispatch({ type: 'error', error: 'Not connected to the Herald host' });
      return false;
    }
    try {
      const res = await t.request('herald_reset', {});
      if (res.success && res.payload) {
        dispatch({ type: 'reset_local' });
        const event: HeraldEvent = { kind: 'state', state: res.payload as HeraldState };
        dispatch({ type: 'event', event, receivedAt: Date.now() });
        notify(event, 'fetch');
        return true;
      }
      dispatch({ type: 'error', error: res.error || 'Reset failed' });
      return false;
    } catch (err) {
      dispatch({ type: 'error', error: errorText(err, 'Reset failed') });
      return false;
    }
  }, [notify]);

  const setVerbosity = useCallback(async (v: HeraldVerbosity): Promise<boolean> => {
    const t = transportRef.current;
    if (!t || !t.isConnected()) return false;
    dispatch({ type: 'event', event: { kind: 'settings', verbosity: v }, receivedAt: Date.now() });
    try {
      const res = await t.request('herald_set_verbosity', { verbosity: v });
      if (!res.success) {
        dispatch({ type: 'error', error: res.error || 'Could not change reply length' });
        void fetchState();
      }
      return res.success;
    } catch (err) {
      dispatch({ type: 'error', error: errorText(err, 'Could not change reply length') });
      return false;
    }
  }, [fetchState]);

  const setPronunciations = useCallback(async (list: HeraldPronunciation[]): Promise<string | null> => {
    const t = transportRef.current;
    if (!t || !t.isConnected()) return 'Not connected to the Herald host';
    try {
      const res = await t.request('herald_set_pronunciations', { pronunciations: list });
      if (!res.success) {
        return isUnsupportedError(res.error) ? 'This hub is too old to save pronunciations' : res.error || 'Could not save';
      }
      const saved = (res.payload as { pronunciations?: HeraldPronunciation[] } | undefined)?.pronunciations ?? list;
      dispatch({ type: 'event', event: { kind: 'pronunciations', pronunciations: saved }, receivedAt: Date.now() });
      return null;
    } catch (err) {
      return errorText(err, 'Could not save');
    }
  }, []);

  const setBudget = useCallback(async (monthlyUsd: number | null | undefined): Promise<string | null> => {
    const t = transportRef.current;
    if (!t || !t.isConnected()) return 'Not connected to the Herald host';
    try {
      const res = await t.request('herald_set_budget', monthlyUsd === undefined ? {} : { monthlyUsd });
      if (!res.success) {
        return isUnsupportedError(res.error) ? 'This hub is too old to set a budget' : res.error || 'Could not set the budget';
      }
      const usage = res.payload as HeraldUsageSummary | undefined;
      if (usage) dispatch({ type: 'event', event: { kind: 'usage', usage }, receivedAt: Date.now() });
      return null;
    } catch (err) {
      return errorText(err, 'Could not set the budget');
    }
  }, []);

  const getTransport = useCallback(() => transportRef.current, []);
  const clearError = useCallback(() => dispatch({ type: 'clear_error' }), []);
  const refresh = useCallback(() => { void fetchState(); }, [fetchState]);
  const messages = useMemo(() => selectMessages(client), [client]);

  return {
    state: client.server,
    messages,
    loaded: client.loaded,
    connected,
    supported,
    sending,
    error: client.error,
    skewMs: client.skewMs,
    send,
    setVerbosity,
    setBudget,
    setPronunciations,
    confirm,
    confirmByVoice,
    markHeard,
    reset,
    refresh,
    clearError,
    subscribeEvents,
    getTransport,
  };
}
