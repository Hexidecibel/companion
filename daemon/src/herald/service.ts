/**
 * HeraldService: orchestrates the inbox poll loop, conversation turns, actions,
 * persistence and event fan-out. Owned by the WebSocket layer; zero brain cost
 * when the brain is not configured (inbox + state still work).
 */

import { randomUUID } from 'crypto';
import type { AuditEntry, AuditOrigin } from '../audit-log';
import type { HeraldAction, HeraldEvent, HeraldMessage, HeraldState } from './protocol';
import { ResolvedHeraldConfig } from './config';
import { ActionManager } from './actions';
import { InboxTracker } from './inbox';
import {
  HeraldStore,
  MAX_PERSISTED_ACTIONS,
  MAX_PERSISTED_MESSAGES,
  PersistedHeraldState,
} from './store';
import type { SessionSnapshot, SessionSource } from './session-source';
import { LlmError, LlmProvider } from './llm/provider';
import { raceAbort, runTurn, TURN_TIMEOUT_MS } from './brain';
import { buildSystemPrompt } from './prompt';
import { executeTool, TurnToolState, ToolEnv } from './tools';
import { sessionsMentioned } from './resolve';
import { clip, firstSentence, formatAgo, oneLine, plainToolAction } from './text';

export const MAX_USER_TEXT = 4000;
export const DEFAULT_POLL_INTERVAL_MS = 4000;
const ACTIVITY_DEBOUNCE_MS = 800;
const DELTA_FLUSH_MS = 60;
const SNAPSHOT_MAX_SESSIONS = 20;
/** Named sessions whose summaries are pre-fetched into the turn (more = a broad question). */
const MAX_PREFETCH_SESSIONS = 2;
const SNAPSHOT_MAX_UNHEARD = 6;
const INBOX_RANK = { blocked: 0, finished: 1, progress: 2 } as const;

export class HeraldRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeraldRequestError';
  }
}

export interface HeraldServiceDeps {
  config: ResolvedHeraldConfig;
  provider: LlmProvider | null;
  sources: SessionSource[];
  store: HeraldStore;
  broadcast: (event: HeraldEvent) => void;
  audit: (entry: AuditEntry) => void;
  pollIntervalMs?: number;
  now?: () => number;
}

const SERVER_ORIGIN: AuditOrigin = {
  addr: 'daemon',
  clientId: 'herald',
  isLocal: true,
  tls: false,
  origin: null,
};

export class HeraldService {
  private cfg: ResolvedHeraldConfig;
  private provider: LlmProvider | null;
  private sources: SessionSource[];
  private store: HeraldStore;
  private broadcastFn: (event: HeraldEvent) => void;
  private auditFn: (entry: AuditEntry) => void;
  private now: () => number;
  private pollIntervalMs: number;

  private messages: HeraldMessage[] = [];
  private inbox = new InboxTracker();
  private actions: ActionManager;
  private busy = false;
  private turnAbort: AbortController | null = null;
  private started = false;
  private disposed = false;

  private pollTimer: NodeJS.Timeout | null = null;
  private activityTimer: NodeJS.Timeout | null = null;
  private pollInFlight: Promise<void> | null = null;
  private lastSnapshots: SessionSnapshot[] = [];
  private statusSinceMap = new Map<string, { status: string; since: number | null }>();

  constructor(deps: HeraldServiceDeps) {
    this.cfg = deps.config;
    this.provider = deps.provider;
    this.sources = deps.sources;
    this.store = deps.store;
    this.broadcastFn = deps.broadcast;
    this.auditFn = deps.audit;
    this.now = deps.now || Date.now;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.actions = new ActionManager({
      getSource: (serverId) => this.getSource(serverId),
      echoDelayMs: this.cfg.echoDelayMs,
      now: this.now,
      onChange: (a) => {
        this.emit({ kind: 'action', action: a });
        this.persist();
      },
      onSent: (a) => this.onActionSent(a),
      audit: (event, action, trigger, origin) => this.auditAction(event, action, trigger, origin),
    });
  }

  get enabled(): boolean {
    return this.cfg.featureEnabled && this.provider !== null;
  }

  get featureEnabled(): boolean {
    return this.cfg.featureEnabled;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started || !this.cfg.featureEnabled) return;
    this.started = true;
    const persisted = await this.store.load(this.now());
    if (this.disposed) return;
    this.messages = persisted.messages.slice(-MAX_PERSISTED_MESSAGES);
    this.inbox = new InboxTracker(persisted.heard);
    this.actions.loadPersisted(persisted.actions);
    if (persisted.actions.some((a) => a.status === 'expired' && a.error?.includes('restarted')))
      this.persist();
    const brain = this.enabled
      ? `${this.cfg.provider} model=${this.cfg.model}${this.cfg.baseUrl ? ` at ${this.cfg.baseUrl}` : ''}`
      : `brain disabled (${this.cfg.disabledReason})`;
    console.log(
      `Herald: started as "${this.cfg.displayName}" — ${brain}; ${this.messages.length} messages restored`
    );
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.pollTimer.unref?.();
    void this.poll();
  }

  /** Hint that session state changed (watcher events): poll soon, debounced. */
  notifyActivity(): void {
    if (!this.started || this.disposed || this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      void this.poll();
    }, ACTIVITY_DEBOUNCE_MS);
    this.activityTimer.unref?.();
  }

  shutdown(): void {
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.pollTimer = null;
    this.activityTimer = null;
    this.turnAbort?.abort();
    this.actions.dispose();
    this.store.flushSyncOnShutdown();
    this.store.dispose();
  }

  // ---------------------------------------------------------------- state

  getState(): HeraldState {
    return {
      displayName: this.cfg.displayName,
      enabled: this.enabled,
      disabledReason: this.enabled ? undefined : this.cfg.disabledReason,
      model: this.cfg.model,
      busy: this.busy,
      messages: this.messages.map((m) => ({ ...m })),
      inbox: this.inbox.list(),
      actions: this.actions.list(),
    };
  }

  private emit(event: HeraldEvent): void {
    try {
      this.broadcastFn(event);
    } catch (err) {
      console.error('Herald: broadcast failed:', err);
    }
  }

  private persist(): void {
    this.store.scheduleSave(() => this.snapshotForDisk());
  }

  private snapshotForDisk(): PersistedHeraldState {
    return {
      version: 1,
      messages: this.messages.filter((m) => !m.streaming).slice(-MAX_PERSISTED_MESSAGES),
      heard: this.inbox.heardIds(),
      actions: this.actions.list().slice(0, MAX_PERSISTED_ACTIONS),
    };
  }

  private getSource(serverId: string): SessionSource | null {
    return this.sources.find((s) => s.serverId === serverId) || null;
  }

  private async listAll(): Promise<SessionSnapshot[]> {
    const lists = await Promise.all(
      this.sources.map((s) =>
        s.listSessions().catch((err) => {
          console.error(`Herald: listing sessions from "${s.serverId}" failed:`, err);
          return [] as SessionSnapshot[];
        })
      )
    );
    const all = lists.flat();
    this.trackStatus(all);
    this.lastSnapshots = all;
    return all;
  }

  private trackStatus(snaps: SessionSnapshot[]): void {
    const now = this.now();
    const seen = new Set<string>();
    for (const s of snaps) {
      const key = `${s.serverId}:${s.sessionId}`;
      seen.add(key);
      const prev = this.statusSinceMap.get(key);
      if (!prev) {
        // First sighting: idle/waiting age is approximated by last activity;
        // working start is unknown until we observe a transition.
        this.statusSinceMap.set(key, {
          status: s.status,
          since: s.status === 'working' ? null : s.lastActivity || null,
        });
      } else if (prev.status !== s.status) {
        this.statusSinceMap.set(key, { status: s.status, since: now });
      }
    }
    for (const key of Array.from(this.statusSinceMap.keys())) {
      if (!seen.has(key)) this.statusSinceMap.delete(key);
    }
  }

  private statusSince(serverId: string, sessionId: string): number | null {
    return this.statusSinceMap.get(`${serverId}:${sessionId}`)?.since ?? null;
  }

  // ---------------------------------------------------------------- inbox

  poll(): Promise<void> {
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = (async () => {
      try {
        const snaps = await this.listAll();
        if (this.disposed) return;
        if (this.inbox.update(snaps, this.now())) {
          this.emit({ kind: 'inbox', inbox: this.inbox.list() });
        }
      } catch (err) {
        console.error('Herald: inbox poll failed:', err);
      } finally {
        this.pollInFlight = null;
      }
    })();
    return this.pollInFlight;
  }

  markHeard(itemIds: string[]): void {
    if (!Array.isArray(itemIds)) throw new HeraldRequestError('itemIds must be an array');
    const ids = itemIds
      .filter((i) => typeof i === 'string' && i.length > 0 && i.length < 500)
      .slice(0, 200);
    if (this.inbox.markHeard(ids)) {
      this.emit({ kind: 'inbox', inbox: this.inbox.list() });
      this.persist();
    }
  }

  // ---------------------------------------------------------------- conversation

  private appendMessage(msg: HeraldMessage): void {
    this.messages.push(msg);
    if (this.messages.length > MAX_PERSISTED_MESSAGES)
      this.messages.splice(0, this.messages.length - MAX_PERSISTED_MESSAGES);
  }

  /** Append a complete (non-streamed) message and announce it. */
  private postMessage(
    role: HeraldMessage['role'],
    text: string,
    extra: Partial<HeraldMessage> = {}
  ): HeraldMessage {
    const msg: HeraldMessage = {
      id: randomUUID(),
      role,
      text,
      createdAt: this.now(),
      ...extra,
      streaming: false,
    };
    this.appendMessage(msg);
    this.emit({ kind: 'message_start', message: { ...msg } });
    this.emit({ kind: 'message_end', message: { ...msg } });
    this.persist();
    return msg;
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.emit({ kind: 'busy', busy });
  }

  /** Accept a user message and start a turn in the background. */
  send(textRaw: unknown): { messageId: string } {
    if (!this.cfg.featureEnabled)
      throw new HeraldRequestError(this.cfg.disabledReason || 'Herald is disabled.');
    if (!this.provider)
      throw new HeraldRequestError(this.cfg.disabledReason || 'Herald brain is not configured.');
    if (typeof textRaw !== 'string') throw new HeraldRequestError('text must be a string');
    const text = textRaw.replace(/\r\n/g, '\n').trim();
    if (!text) throw new HeraldRequestError('Message is empty.');
    if (text.length > MAX_USER_TEXT)
      throw new HeraldRequestError(`Message is too long (max ${MAX_USER_TEXT} characters).`);
    if (this.busy)
      throw new HeraldRequestError(
        `${this.cfg.displayName} is still answering the previous message.`
      );

    this.setBusy(true);
    const history = this.messages.slice();
    const userMsg = this.postMessage('user', text);
    void this.runConversationTurn(text, history).catch((err) => {
      console.error('Herald: turn crashed:', err);
      // Never leave the turn lock held: the user could not send again until restart.
      this.setBusy(false);
    });
    return { messageId: userMsg.id };
  }

  private async runConversationTurn(userText: string, history: HeraldMessage[]): Promise<void> {
    const provider = this.provider!;
    const abort = new AbortController();
    this.turnAbort = abort;
    const turnTimer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
    turnTimer.unref?.();

    const reply: HeraldMessage = {
      id: randomUUID(),
      role: 'herald',
      text: '',
      createdAt: this.now(),
      streaming: true,
    };
    this.appendMessage(reply);
    this.emit({ kind: 'message_start', message: { ...reply } });

    // Coalesce token deltas into ~60ms batches to keep WS traffic sane.
    let pendingDelta = '';
    let flushTimer: NodeJS.Timeout | null = null;
    // reply.text only ever holds text that has been (or is being) broadcast, so a
    // herald_get_state snapshot taken mid-stream never contains text that a later
    // delta will append again (duplicated words after a reconnect).
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (!pendingDelta) return;
      const d = pendingDelta;
      pendingDelta = '';
      reply.text += d;
      if (!abort.signal.aborted)
        this.emit({ kind: 'message_delta', messageId: reply.id, delta: d });
    };
    const onText = (delta: string) => {
      pendingDelta += delta;
      if (!flushTimer) {
        flushTimer = setTimeout(flush, DELTA_FLUSH_MS);
        flushTimer.unref?.();
      }
    };

    const toolState: TurnToolState = { userText, sessionRefs: new Map(), proposals: [] };
    const env: ToolEnv = {
      listSessions: () => this.listAll(),
      getSource: (id) => this.getSource(id),
      actions: this.actions,
      now: this.now,
      statusSince: (s, id) => this.statusSince(s, id),
      echoDelayMs: this.cfg.echoDelayMs,
    };
    const started = Date.now();
    let errorText: string | null = null;
    let aborted = false;

    try {
      const snaps = await raceAbort(
        this.listAll().catch(() => this.lastSnapshots),
        abort.signal
      );
      const prefetched = await raceAbort(
        this.prefetchMentioned(userText, snaps, env, toolState),
        abort.signal
      );
      const result = await runTurn(provider, {
        history,
        userText,
        snapshot: this.buildSnapshot(snaps) + prefetched,
        systemPrompt: buildSystemPrompt(this.cfg.displayName),
        maxTokens: this.cfg.maxTokens,
        signal: abort.signal,
        onText,
        runTool: async (name, args) => {
          const out = await executeTool(name, args, env, toolState);
          // Opt-in tool tracing for prompt tuning (tool results contain session text).
          if (process.env.HERALD_DEBUG_TOOLS === '1') {
            console.log(
              `Herald[debug]: ${name}(${JSON.stringify(args)}) -> ${clip(out.content, 2500)}`
            );
          }
          return out;
        },
      });
      flush();
      reply.text = result.text;
      console.log(
        `Herald: turn done provider=${provider.name} model=${provider.model} outcome=${result.outcome} ` +
          `ttft=${result.firstTokenMs !== undefined ? `${result.firstTokenMs}ms` : 'n/a'} total=${Date.now() - started}ms ` +
          `iterations=${result.iterations} tools=[${result.toolCalls.join(',')}] ` +
          `tokens in=${result.usage.inputTokens} out=${result.usage.outputTokens}` +
          (result.droppedNarration.length
            ? ` dropped_narration=${JSON.stringify(result.droppedNarration)}`
            : '')
      );
    } catch (err) {
      flush();
      if (err instanceof LlmError && err.code === 'aborted') {
        // Our own turn timer fired (turn still current) vs. a reset/shutdown.
        if (!this.disposed && this.turnAbort === abort) {
          errorText = `Brain took longer than ${Math.round(TURN_TIMEOUT_MS / 1000)}s to answer; gave up.`;
        } else {
          aborted = true;
        }
      } else {
        errorText =
          err instanceof LlmError
            ? err.message
            : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      }
      console.log(
        `Herald: turn failed provider=${provider.name} model=${provider.model} after ${Date.now() - started}ms: ${
          errorText || 'aborted'
        }`
      );
    } finally {
      clearTimeout(turnTimer);
      if (flushTimer) clearTimeout(flushTimer);
      if (this.turnAbort === abort) this.turnAbort = null;
    }

    if (aborted) {
      // Reset / shutdown: the reply was already discarded with the conversation.
      this.setBusy(false);
      return;
    }

    if (errorText) {
      this.emit({ kind: 'error', error: errorText });
      const note = errorText.startsWith('Brain server unreachable')
        ? "I can't reach my brain server right now."
        : 'Sorry, something went wrong on my end.';
      reply.text = reply.text.trim() ? `${reply.text.trim()} ${note}` : note;
    }

    // Deterministic readback when the model produced actions but no words.
    const actionIds = toolState.proposals.map((p) => p.actionId);
    if (!reply.text.trim() && actionIds.length > 0) {
      reply.text = actionIds
        .map((id) => this.actions.get(id))
        .filter((a): a is HeraldAction => !!a)
        .map((a) =>
          a.tier === 'echo'
            ? `Sending to ${a.readback} unless you cancel.`
            : `Needs your confirmation: ${a.readback}.`
        )
        .join(' ');
    }
    if (!reply.text.trim()) reply.text = "I don't have an answer for that.";

    reply.streaming = false;
    if (toolState.sessionRefs.size > 0)
      reply.sessionRefs = Array.from(toolState.sessionRefs.values()).slice(0, 20);
    if (actionIds.length > 0) reply.actionIds = actionIds;
    // The reply may have been dropped by a reset while we were finishing.
    if (this.messages.includes(reply)) {
      this.emit({ kind: 'message_end', message: { ...reply } });
      this.persist();
    }
    this.setBusy(false);
  }

  /**
   * When the user names one or two sessions outright, fetch their summaries up
   * front so the brain answers from real detail in a single round-trip instead of
   * guessing from the snapshot's one-line gist.
   */
  private async prefetchMentioned(
    userText: string,
    snaps: SessionSnapshot[],
    env: ToolEnv,
    toolState: TurnToolState
  ): Promise<string> {
    const mentioned = sessionsMentioned(userText, snaps);
    if (mentioned.length === 0 || mentioned.length > MAX_PREFETCH_SESSIONS) return '';
    const blocks: string[] = [];
    for (const s of mentioned) {
      const out = await executeTool(
        'summarize_session',
        { session: s.sessionName },
        env,
        toolState
      );
      if (!out.isError)
        blocks.push(
          `[Detail for ${s.sessionName}, fetched just now with summarize_session]\n${out.content}`
        );
    }
    return blocks.length ? `\n${blocks.join('\n')}` : '';
  }

  /** Compact, grounded fleet snapshot injected with every user message. */
  buildSnapshot(snaps: SessionSnapshot[]): string {
    const now = this.now();
    const live = snaps.filter((s) => !s.inactive);
    const rank = { waiting: 0, working: 1, idle: 2 } as const;
    live.sort((a, b) => rank[a.status] - rank[b.status] || b.lastActivity - a.lastActivity);
    const lines: string[] = [];
    for (const s of live.slice(0, SNAPSHOT_MAX_SESSIONS)) {
      const since = this.statusSince(s.serverId, s.sessionId);
      const age = since ? ` for ${formatAgo(now - since)}` : '';
      let detail = '';
      if (s.pendingChoice) {
        const opts = s.pendingChoice.options
          .map((o, i) => `${i + 1}) ${clip(oneLine(o.label), 50)}`)
          .join(' ');
        detail = ` — asking: "${clip(oneLine(s.pendingChoice.question), 160)}" options: ${opts}`;
      } else if (s.pendingApproval) {
        detail = ` — needs approval to ${plainToolAction(s.pendingApproval.tool)}${s.pendingApproval.detail ? `: ${clip(s.pendingApproval.detail, 160)}` : ''}`;
      } else if (s.pendingQuestion) {
        detail = ` — asked: "${clip(s.pendingQuestion, 160)}"`;
      } else if (s.status === 'working' && s.currentActivity) {
        detail = ` — ${clip(oneLine(s.currentActivity), 100)}`;
      }
      // What the session last reported (its words, first sentence). Lets simple
      // "what is everyone doing" questions be answered from the snapshot alone.
      const said = !s.pendingChoice && s.lastTurnGist ? firstSentence(s.lastTurnGist, 160) : '';
      if (said) detail += ` — last said: "${said}"`;
      else if (!detail) detail = ' — (no transcript text visible)';
      const project =
        s.projectName && s.projectName !== s.sessionName ? ` (project ${s.projectName})` : '';
      lines.push(`- ${s.sessionName}${project}: ${s.status}${age}${detail}`);
    }
    const inbox = this.inbox.list();
    const blocked = inbox.filter((i) => i.priority === 'blocked').length;
    const finished = inbox.filter((i) => i.priority === 'finished').length;
    const pending = this.actions.list().filter((a) => a.status === 'pending');
    const parts = [
      `[Fleet snapshot at ${new Date(now).toISOString()} — authoritative current state]`,
      lines.length ? lines.join('\n') : '- No live sessions.',
    ];
    if (live.length > SNAPSHOT_MAX_SESSIONS)
      parts.push(`(${live.length - SNAPSHOT_MAX_SESSIONS} more sessions not shown)`);
    parts.push(`Inbox: ${blocked} blocked, ${finished} finished.`);
    // What the user has not been told yet, most urgent first: this is what
    // "anything for me?" should cover. Headlines are deterministic, not model-written.
    const unheardItems = inbox
      .filter((i) => !i.heard && i.priority !== 'progress')
      .sort((a, b) => INBOX_RANK[a.priority] - INBOX_RANK[b.priority] || b.createdAt - a.createdAt);
    if (unheardItems.length) {
      parts.push('Not yet told to the user:');
      for (const i of unheardItems.slice(0, SNAPSHOT_MAX_UNHEARD)) {
        parts.push(
          `- [${i.priority}] ${clip(oneLine(i.headline), 200)} (${formatAgo(now - i.createdAt)} ago)`
        );
      }
      if (unheardItems.length > SNAPSHOT_MAX_UNHEARD)
        parts.push(`(${unheardItems.length - SNAPSHOT_MAX_UNHEARD} more)`);
    }
    if (pending.length)
      parts.push(
        `Pending actions awaiting send/confirm: ${pending.map((a) => a.readback).join('; ')}`
      );
    parts.push('[End snapshot]');
    return parts.join('\n');
  }

  reset(): HeraldState {
    if (this.turnAbort) {
      this.turnAbort.abort();
      this.turnAbort = null;
    }
    this.messages = [];
    this.persist();
    const state = this.getState();
    this.emit({ kind: 'state', state });
    return state;
  }

  // ---------------------------------------------------------------- actions

  async confirm(actionId: unknown, decision: unknown, origin: AuditOrigin): Promise<HeraldAction> {
    if (typeof actionId !== 'string' || !actionId)
      throw new HeraldRequestError('actionId is required');
    if (decision !== 'confirm' && decision !== 'cancel')
      throw new HeraldRequestError('decision must be "confirm" or "cancel"');
    if (!this.actions.get(actionId)) throw new HeraldRequestError('Unknown action');
    return decision === 'confirm'
      ? this.actions.confirm(actionId, origin)
      : this.actions.cancel(actionId, origin);
  }

  private onActionSent(a: HeraldAction): void {
    this.postMessage('herald', `Sent to ${a.sessionName}.`, {
      sessionRefs: [{ serverId: a.serverId, sessionId: a.sessionId, sessionName: a.sessionName }],
      actionIds: [a.id],
    });
    void this.poll();
  }

  private auditAction(event: string, a: HeraldAction, trigger: string, origin?: AuditOrigin): void {
    try {
      this.auditFn({
        ts: this.now(),
        origin: origin || SERVER_ORIGIN,
        action: `herald_action_${event}`,
        payload: {
          actionId: a.id,
          tier: a.tier,
          kind: a.kind,
          serverId: a.serverId,
          sessionId: a.sessionId,
          sessionName: a.sessionName,
          payload: clip(a.payload, 500),
          reasons: a.reasons,
          trigger,
        },
        result: {
          ok: event !== 'failed',
          status: a.status,
          ...(a.error ? { error: a.error } : {}),
        },
        durationMs: Math.max(0, this.now() - a.createdAt),
      });
    } catch (err) {
      console.error('Herald: audit append failed:', err);
    }
  }
}
