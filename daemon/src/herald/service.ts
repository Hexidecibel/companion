/**
 * HeraldService: orchestrates the inbox poll loop, conversation turns, actions,
 * persistence and event fan-out. Owned by the WebSocket layer; zero brain cost
 * when the brain is not configured (inbox + state still work).
 */

import { randomUUID } from 'crypto';
import type { AuditEntry, AuditOrigin } from '../audit-log';
import type {
  HeraldBrainStatus,
  HeraldDevicesSnapshot,
  HeraldAction,
  HeraldEvent,
  HeraldInboxItem,
  HeraldInputMode,
  HeraldIntent,
  HeraldMessage,
  HeraldState,
  HeraldUsageSummary,
  HeraldVerbosity,
  HeraldPronunciation,
} from './protocol';
import { ResolvedHeraldConfig } from './config';
import { ActionManager } from './actions';
import { InboxTracker } from './inbox';
import {
  HeraldStore,
  isVerbosity,
  MAX_PERSISTED_ACTIONS,
  MAX_PERSISTED_MESSAGES,
  PersistedHeraldState,
} from './store';
import type { SessionSnapshot, SessionSource } from './session-source';
import { LlmError, LlmProvider } from './llm/provider';
import { raceAbort, runTurn, TURN_TIMEOUT_MS } from './brain';
import { buildSystemPrompt, intentInstruction, replyStyleLine } from './prompt';
import type { HeraldSelfInfo } from './self-info';
import { executeTool, TurnToolState, ToolEnv } from './tools';
import { HeraldToolbox } from './knowledge/toolbox';
import { resolveKnowledgePaths } from './knowledge/sources';
import type { CushCommand } from './knowledge/cush';
import { sessionsMentioned } from './resolve';
import { hasPendingPrompt, pickShowTarget, resolveShowDevice } from './show';
import type { DeviceAliasResult } from './device-alias';
import { clip, firstSentence, formatAgo, oneLine, plainToolAction } from './text';
import { isLikelyTextEcho } from './voice/echo-match';
import { sanitizePronunciations } from './pronunciations';
import { recentVersions } from './voice/versions';
import { AskReporter, blockKeyOf, VOICE_EXCHANGE_WINDOW_MS } from './asks';
import { resolveSpawnDir, SpawnRunner, spawnRoots, type SessionSpawner } from './spawn';
import type { ActionMeta, SpawnOutcome, SpawnRequest } from './actions';
import {
  checkVoiceConfirm,
  rejectionMessage,
  type SpokenEvidence,
  type VoiceTranscriptEvidence,
} from './voice-confirm';
import { BudgetNotice, formatUsd, nextMonthStart, spokenUsd, usageAnswer, UsageMeter } from './usage';
import {
  classifyFallback,
  fallbackReply,
  isUsageQuestion,
  outageReason,
  REASON_TEXT,
  recoveryDelayMs,
} from './fallback';
import type {
  HeraldBrainDownReason,
  HeraldSessionRef,
  HeraldShowResult,
  HeraldShowVia,
} from './protocol';
import type { LlmUsage } from './llm/provider';

export const MAX_USER_TEXT = 4000;
/** A voice message is checked against Herald's replies started this recently. */
export const ECHO_GUARD_WINDOW_MS = 90_000;
/** ...the last this many of them. */
const ECHO_GUARD_REPLIES = 2;
export const DEFAULT_POLL_INTERVAL_MS = 4000;
/** Words that start a request to Herald: one Herald did not say is never self-echo. */
const ACTIVITY_DEBOUNCE_MS = 800;
const DELTA_FLUSH_MS = 60;
const SNAPSHOT_MAX_SESSIONS = 20;
/** Named sessions whose summaries are pre-fetched into the turn (more = a broad question). */
const MAX_PREFETCH_SESSIONS = 2;
const SNAPSHOT_MAX_UNHEARD = 6;
const INBOX_RANK = { blocked: 0, finished: 1, progress: 2 } as const;
/** Words the user says that Whisper tends to get wrong (tmux -> "T-MUX", daemon -> "demon"). */
const STT_HINT_TERMS = [
  'tmux',
  'deploy',
  'Haiku',
  'Kokoro',
  'Tailscale',
  'cush',
  'HAProxy',
  'APK',
  'PR',
  'commit',
  'prod',
  'daemon',
  'AUQ',
];
const STT_HINT_MAX_NAMES = 16;
const VERBOSITY_CONFIRM: Record<HeraldVerbosity, string> = {
  brief: "Okay, I'll keep it short.",
  normal: 'Okay, back to normal.',
  detailed: "Okay, I'll give you fuller answers.",
  auto: 'Okay: short when you talk, normal when you type.',
};
const STT_HINT_MAX_CHARS = 600;

export class HeraldRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeraldRequestError';
  }
}

/** Code Review relay failure; `code` is a ReviewErrorCode. */
export class HeraldRelayError extends Error {
  constructor(
    readonly code: 'herald_unavailable' | 'session_waiting' | 'unavailable',
    message: string
  ) {
    super(message);
    this.name = 'HeraldRelayError';
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
  /** Where this daemon's web UI is reachable (for Herald's self-knowledge). */
  selfInfo?: HeraldSelfInfo;
  /** The daemon's code_home (~/.claude of the real user): locates knowledge sources. */
  codeHome?: string;
  /** Knowledge + cush-tools toolbox. Omitted = built from codeHome; null = disabled. */
  toolbox?: HeraldToolbox | null;
  /** Active device + connected devices (voice layer), folded into getState(). */
  devices?: () => HeraldDevicesSnapshot | null;
  /** Starts Claude Code sessions (the app's own path). Absent = no propose_spawn_session. */
  spawner?: SessionSpawner;
  /** Voice-confirm evidence: the daemon's own transcript + Herald's speech for a client. */
  voiceEvidence?: (
    clientId: string,
    streamId?: string | null
  ) => {
    transcript: VoiceTranscriptEvidence | null;
    spoken: SpokenEvidence[];
    speechEndAt: number;
  } | null;
  /** Mark a transcript used (it confirms one thing only). */
  consumeTranscript?: (clientId: string, streamId: string) => void;
  /** The active device's client id (voice confirm only from it). */
  activeClientId?: () => string | null;
  /** Push an event to ONE client ("show me" navigation); false if it is gone. */
  deliverToClient?: (clientId: string, event: HeraldEvent) => boolean;
  /**
   * `clientId` is inside ANOTHER device's speaking window (Herald playing there,
   * or just stopped): its hands-off voice sends are dropped (voice-send backstop).
   */
  speakingSuppresses?: (clientId: string) => boolean;
}

/** Where a turn came from: a connection, and whether it was a Herald device (reported presence) then. */
export interface SpeechOrigin {
  clientId: string;
  device: boolean;
}

/** herald_send extras from the handler. */
export interface HeraldSendOptions {
  mode?: unknown;
  intent?: unknown;
  /** The sending connection (its replies are spoken there). */
  clientId?: string;
  /** Voice from a deliberate gesture (push-to-talk, hotkey, trigger): passes the speaking backstop. */
  gesture?: unknown;
}

/** Who a navigation is for and how it is acknowledged. */
export interface HeraldShowOptions {
  via: HeraldShowVia;
  /** The connection that asked (fallback target when no device is active). */
  requesterId?: string | null;
  /** The receiving device acknowledges it (triggers: nobody else is talking). */
  ack?: boolean;
}

/** herald_confirm extras (voice confirmation). */
export interface HeraldConfirmOptions {
  method?: unknown;
  phrase?: unknown;
  streamId?: unknown;
  /** The requesting connection. */
  clientId?: string;
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
  private devicesFn: (() => HeraldDevicesSnapshot | null) | undefined;
  private deliverFn: ((clientId: string, event: HeraldEvent) => boolean) | undefined;
  private navSeq = 0;
  private auditFn: (entry: AuditEntry) => void;
  private now: () => number;
  private pollIntervalMs: number;
  /** Built once: stable across turns so it caches well. */
  private systemPrompt: string;

  private messages: HeraldMessage[] = [];
  private inbox = new InboxTracker();
  private actions: ActionManager;
  private toolbox: HeraldToolbox | null;
  private busy = false;
  private verbosity: HeraldVerbosity = 'auto';
  /** The user's pronunciations for the voice (the web applies them). */
  private pronunciations: HeraldPronunciation[] = [];
  private turnAbort: AbortController | null = null;
  private started = false;
  private disposed = false;

  private pollTimer: NodeJS.Timeout | null = null;
  private activityTimer: NodeJS.Timeout | null = null;
  private pollInFlight: Promise<void> | null = null;
  private lastSnapshots: SessionSnapshot[] = [];

  /** API spend meter (persisted with the rest of Herald's state). */
  private usage: UsageMeter;
  /** Budget notice to post once the current turn's reply is out. */
  private pendingNotice: BudgetNotice | null = null;
  /** Current LLM outage (null = brain healthy). Budget exhaustion is derived, not stored. */
  private outage: {
    reason: HeraldBrainDownReason;
    since: number;
    failures: number;
    retryAt: number;
    announced: boolean;
  } | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryAbort: AbortController | null = null;
  /** Last brain status sent to clients (to emit only on change). */
  private lastBrainKey = 'ok';
  /** The budget's "spent" announcement was made for this outage of the budget. */
  private budgetAnnounced = false;
  private statusSinceMap = new Map<string, { status: string; since: number | null }>();
  /** Ask-and-report: questions sent to sessions, answered back when they reply. */
  private asks: AskReporter;
  private spawnRunner: SpawnRunner | null = null;
  private spawnEnv: { roots: string[]; userHome: string } | undefined;
  private voiceDeps: Pick<
    HeraldServiceDeps,
    'voiceEvidence' | 'consumeTranscript' | 'activeClientId'
  >;
  /** Last time the user spoke to Herald (answers are spoken during a voice exchange). */
  private lastVoiceAt = 0;
  private speakingSuppressesFn: ((clientId: string) => boolean) | undefined;

  constructor(deps: HeraldServiceDeps) {
    this.cfg = deps.config;
    this.provider = deps.provider;
    this.sources = deps.sources;
    this.store = deps.store;
    this.broadcastFn = deps.broadcast;
    this.devicesFn = deps.devices;
    this.deliverFn = deps.deliverToClient;
    this.speakingSuppressesFn = deps.speakingSuppresses;
    this.auditFn = deps.audit;
    this.now = deps.now || Date.now;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.systemPrompt = buildSystemPrompt(this.cfg.displayName, deps.selfInfo);
    this.usage = this.newUsageMeter(undefined);
    this.toolbox =
      deps.toolbox === null
        ? null
        : deps.toolbox || new HeraldToolbox({ paths: resolveKnowledgePaths(deps.codeHome) });
    this.toolbox?.setOnOpenedChange(() => this.persist());
    this.actions = new ActionManager({
      getSource: (serverId) => this.getSource(serverId),
      echoDelayMs: this.cfg.echoDelayMs,
      now: this.now,
      onChange: (a) => {
        this.emit({ kind: 'action', action: a });
        this.persist();
      },
      onSent: (a, note, meta, spawned) => this.onActionSent(a, note, meta, spawned),
      audit: (event, action, trigger, origin) => this.auditAction(event, action, trigger, origin),
      runCush: this.toolbox ? (cmd, action) => this.runCush(cmd, action) : undefined,
      runSpawn: deps.spawner ? (req, action) => this.runSpawn(req, action) : undefined,
    });
    this.voiceDeps = {
      voiceEvidence: deps.voiceEvidence,
      consumeTranscript: deps.consumeTranscript,
      activeClientId: deps.activeClientId,
    };
    this.asks = new AskReporter({
      getSource: (id) => this.getSource(id),
      provider: () => this.provider,
      now: this.now,
      voiceActive: () => this.now() - this.lastVoiceAt < VOICE_EXCHANGE_WINDOW_MS,
      busy: () => this.busy,
      post: (p) =>
        this.postMessage('herald', p.text, {
          sessionRefs: [p.ref],
          ...(p.quiet ? { quiet: true } : {}),
        }),
      addAnswer: (a) => {
        const item = this.inbox.addAnswer(a);
        // Spoken in a live voice exchange: already heard (no tone, not re-briefed).
        if (a.heard) this.inbox.markHeard([item.id]);
        this.emit({ kind: 'inbox', inbox: this.inbox.list() });
      },
      persist: () => this.persist(),
      log: (l) => console.log(l),
    });
    if (deps.spawner) {
      const paths = resolveKnowledgePaths(deps.codeHome);
      this.spawnEnv = { roots: spawnRoots(paths.projectsRoot), userHome: paths.userHome };
      this.spawnRunner = new SpawnRunner({
        spawner: deps.spawner,
        sendPrompt: async (id, text) => {
          const src = this.getSource('local');
          return src ? src.sendText(id, text, `herald-spawn-${id}`) : false;
        },
        // Later news (ready / closed): spoken only during a voice exchange.
        post: (text, ref) =>
          this.postMessage('herald', text, {
            sessionRefs: [ref],
            ...(this.now() - this.lastVoiceAt < VOICE_EXCHANGE_WINDOW_MS ? {} : { quiet: true }),
          }),
        onPromptSent: (info) =>
          this.openAsk({
            ...info,
            serverId: 'local',
            actionId: `spawn-${info.sessionId}-${info.sentAt}`,
            userText: info.prompt,
          }),
        now: this.now,
        log: (l) => console.log(l),
      });
    }
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
    this.asks.load(persisted.asks ?? []);
    this.inbox.restoreAnswers(persisted.answers ?? [], this.now());
    this.toolbox?.loadOpened(persisted.cushOpened);
    this.verbosity = persisted.verbosity ?? 'auto';
    this.pronunciations = persisted.pronunciations ?? [];
    this.usage = this.newUsageMeter(persisted.usage);
    this.lastBrainKey = this.brainKey(this.brainStatus());
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
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recoveryAbort?.abort();
    this.pollTimer = null;
    this.activityTimer = null;
    this.turnAbort?.abort();
    this.actions.dispose();
    this.spawnRunner?.dispose();
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
      verbosity: this.verbosity,
      pronunciations: this.pronunciations.map((p) => ({ ...p })),
      usage: this.usage.summary(),
      brain: this.brainStatus(),
      ...this.deviceFields(),
    };
  }

  private deviceFields(): Pick<HeraldState, 'activeDevice' | 'devices'> {
    let snap: HeraldDevicesSnapshot | null = null;
    try {
      snap = this.devicesFn?.() ?? null;
    } catch {
      snap = null;
    }
    return snap ? { activeDevice: snap.activeDevice, devices: snap.devices } : {};
  }

  getVerbosity(): HeraldVerbosity {
    return this.verbosity;
  }

  /** Reply-length setting (menu, or the brain's set_verbosity tool). Persisted. */
  setVerbosity(raw: unknown): { verbosity: HeraldVerbosity } {
    if (!isVerbosity(raw))
      throw new HeraldRequestError('verbosity must be one of auto, brief, normal, detailed');
    if (raw !== this.verbosity) {
      this.verbosity = raw;
      this.emit({ kind: 'settings', verbosity: raw });
      this.persist();
      console.log(`Herald: reply length set to ${raw}`);
    }
    return { verbosity: this.verbosity };
  }

  /** The voice's pronunciation list (Advanced > Pronunciations). Replaced whole; persisted. */
  setPronunciations(raw: unknown): { pronunciations: HeraldPronunciation[] } {
    if (!Array.isArray(raw)) throw new HeraldRequestError('pronunciations must be an array');
    const next = sanitizePronunciations(raw);
    if (JSON.stringify(next) !== JSON.stringify(this.pronunciations)) {
      this.pronunciations = next;
      this.emit({ kind: 'pronunciations', pronunciations: next.map((p) => ({ ...p })) });
      this.persist();
      console.log(`Herald: ${next.length} pronunciation(s) saved`);
    }
    return { pronunciations: this.pronunciations.map((p) => ({ ...p })) };
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
      cushOpened: this.toolbox?.openedNames() ?? [],
      ...(this.verbosity !== 'auto' ? { verbosity: this.verbosity } : {}),
      ...(this.pronunciations.length ? { pronunciations: this.pronunciations } : {}),
      asks: this.asks.list(),
      answers: this.inbox.answers(),
      usage: this.usage.toPersisted(),
    };
  }

  // ---------------------------------------------------------------- usage + budget

  private newUsageMeter(persisted: PersistedHeraldState['usage']): UsageMeter {
    return new UsageMeter(persisted, {
      model: this.cfg.model,
      now: this.now,
      pricing: this.cfg.pricing,
      cacheTtl: this.cfg.promptCache?.ttl,
      configBudgetUsd: this.cfg.monthlyBudgetUsd,
    });
  }

  getUsage(): HeraldUsageSummary {
    return this.usage.summary();
  }

  /**
   * Monthly cap from the app: a number (USD), null for no cap, undefined to go
   * back to herald.monthly_budget_usd. Raising it past the spend lifts the
   * fallback at once.
   */
  setBudget(raw: unknown): HeraldUsageSummary {
    let v: number | null | undefined;
    if (raw === undefined) v = undefined;
    else if (raw === null) v = null;
    else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 10_000)
      v = Math.round(raw * 100) / 100;
    else throw new HeraldRequestError('monthlyUsd must be a positive number of dollars, or null');
    this.usage.setBudget(v);
    if (!this.usage.overBudget()) this.budgetAnnounced = false;
    console.log(
      `Herald: monthly budget ${v === undefined ? 'reset to config' : v === null ? 'removed' : `set to ${formatUsd(v)}`}`
    );
    this.persist();
    this.emit({ kind: 'usage', usage: this.usage.summary() });
    this.emitBrainIfChanged();
    return this.usage.summary();
  }

  /** Account one brain request; queue a budget notice for after the reply. */
  private onUsage(u: LlmUsage): void {
    this.usage.recordRequest(u);
    const notice = this.usage.takeNotice();
    if (notice) this.pendingNotice = notice;
    this.persist();
  }

  /** Post a due budget notice (after the reply that crossed the line). */
  private flushBudgetNotice(): void {
    const notice = this.pendingNotice;
    this.pendingNotice = null;
    const usage = this.usage.summary();
    if (!notice) {
      this.emit({ kind: 'usage', usage });
      return;
    }
    const cap = usage.budgetUsd ?? 0;
    const spent = usage.month.costUsd;
    let text: string;
    if (notice === 'budget_warning') {
      text = `Heads up: I've used ${Math.round((spent / cap) * 100)}% of this month's ${spokenUsd(cap)} budget. At 100% I switch to offline answers.`;
    } else {
      this.budgetAnnounced = true;
      const resets = new Date(nextMonthStart(this.now())).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
      });
      text = `That's this month's ${spokenUsd(cap)} budget used up. Until ${resets}, or until you raise the cap in my menu, I'll answer from what I can see without the AI.`;
    }
    console.log(`Herald: ${notice} (${formatUsd(spent)} of ${formatUsd(cap)} this month)`);
    this.emit({ kind: 'usage', usage, notice });
    this.postMessage('herald', text);
    this.emitBrainIfChanged();
  }

  // ---------------------------------------------------------------- brain health

  brainStatus(): HeraldBrainStatus {
    if (this.usage.overBudget()) {
      return {
        state: 'degraded',
        reason: 'budget',
        detail: REASON_TEXT.budget,
        since: this.outage?.since,
      };
    }
    if (!this.outage) return { state: 'ok' };
    return {
      state: 'degraded',
      reason: this.outage.reason,
      detail: REASON_TEXT[this.outage.reason],
      since: this.outage.since,
      retryAt: this.outage.retryAt,
    };
  }

  private brainKey(b: HeraldBrainStatus): string {
    return b.state === 'ok' ? 'ok' : `${b.reason}:${b.retryAt ?? ''}`;
  }

  private emitBrainIfChanged(): void {
    const brain = this.brainStatus();
    const key = this.brainKey(brain);
    if (key === this.lastBrainKey) return;
    this.lastBrainKey = key;
    this.emit({ kind: 'brain', brain });
  }

  /** Why the brain should not be called right now, or null to call it. */
  private skipBrainReason(): HeraldBrainDownReason | null {
    if (this.usage.overBudget()) return 'budget';
    if (this.outage && this.now() < this.outage.retryAt) return this.outage.reason;
    return null;
  }

  /** The LLM failed in a way that means "brain down": enter / extend the outage. */
  private noteOutage(reason: HeraldBrainDownReason): void {
    const now = this.now();
    if (!this.outage || this.outage.reason !== reason) {
      const announced = this.outage?.announced ?? false;
      this.outage = { reason, since: this.outage?.since ?? now, failures: 0, retryAt: now, announced };
      console.log(`Herald: brain offline (${REASON_TEXT[reason]}); answering from the fallback`);
    }
    this.outage.failures += 1;
    this.outage.retryAt = now + recoveryDelayMs(reason, this.outage.failures);
    this.scheduleRecovery();
    this.emitBrainIfChanged();
  }

  private noteBrainOk(): void {
    if (!this.outage) return;
    console.log(
      `Herald: brain back online after ${Math.round((this.now() - this.outage.since) / 1000)}s`
    );
    this.outage = null;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.emitBrainIfChanged();
  }

  /** Background health check at retryAt, so the brain recovers without a user turn. */
  private scheduleRecovery(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    const provider = this.provider;
    if (!this.outage || this.disposed || !provider?.healthCheck) return;
    const delay = Math.max(1000, this.outage.retryAt - this.now());
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (!this.outage || this.disposed || this.busy) {
        if (this.outage && !this.disposed) this.scheduleRecovery();
        return;
      }
      const abort = new AbortController();
      this.recoveryAbort = abort;
      const timer = setTimeout(() => abort.abort(), 15_000);
      timer.unref?.();
      provider.healthCheck!(abort.signal).then(
        () => {
          clearTimeout(timer);
          this.noteBrainOk();
        },
        (err) => {
          clearTimeout(timer);
          if (this.disposed || !this.outage) return;
          const reason = outageReason(err) ?? this.outage.reason;
          this.noteOutage(reason);
        }
      );
    }, delay);
    this.recoveryTimer.unref?.();
  }

  /**
   * Answer without the LLM (brain down or budget spent): one deterministic
   * reply. Says what is wrong once per outage.
   */
  private answerFromFallback(
    text: string,
    intent: HeraldIntent | undefined,
    reason: HeraldBrainDownReason,
    briefing: HeraldInboxItem[] = []
  ): string {
    const kind = classifyFallback(text, intent);
    let announce: boolean;
    if (reason === 'budget') {
      announce = !this.budgetAnnounced;
      this.budgetAnnounced = true;
    } else {
      announce = !this.outage?.announced;
      if (this.outage) this.outage.announced = true;
    }
    const items = kind === 'brief' && intent !== 'brief' ? this.unheardForBriefing() : briefing;
    if (kind === 'brief' && items.length && intent !== 'brief') this.markHeard(items.map((i) => i.id));
    return fallbackReply({
      kind,
      reason,
      announce,
      snapshots: this.lastSnapshots,
      briefing: items,
      usage: kind === 'usage' ? usageAnswer(this.usage.summary()) : undefined,
    });
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

  private applyInbox(snaps: SessionSnapshot[]): void {
    if (this.disposed) return;
    // A session the user asked something: its answer replaces the generic note.
    if (this.inbox.update(snaps, this.now(), (key) => this.asks.hasOpen(key))) {
      this.emit({ kind: 'inbox', inbox: this.inbox.list() });
    }
    this.asks.onSnapshots(snaps);
  }

  poll(): Promise<void> {
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = (async () => {
      try {
        const snaps = await this.listAll();
        this.applyInbox(snaps);
        // Month rollover / cap changes lift a budget fallback without a turn.
        this.emitBrainIfChanged();
      } catch (err) {
        console.error('Herald: inbox poll failed:', err);
      } finally {
        this.pollInFlight = null;
      }
    })();
    return this.pollInFlight;
  }

  // ---------------------------------------------------------------- show me

  /**
   * herald_show: open a session's view on the active device (or `device`).
   * Never changes the active device. See HeraldShowRequest.
   */
  async show(raw: unknown, opts: HeraldShowOptions): Promise<HeraldShowResult> {
    const p = (raw && typeof raw === 'object' ? raw : {}) as { session?: unknown; device?: unknown };
    const session = typeof p.session === 'string' ? oneLine(p.session).slice(0, 200) : '';
    const device = typeof p.device === 'string' ? p.device.trim().slice(0, 200) : '';
    const sessions = await this.listAll().catch(() => this.lastSnapshots);
    return this.showWith(session, device, sessions, opts);
  }

  /** Synchronous form over the last poll's listing (remote `show` trigger). */
  showCached(session: string | undefined, device: string, opts: HeraldShowOptions): HeraldShowResult {
    return this.showWith(session || '', device, this.lastSnapshots, opts);
  }

  /** The brain's show_session tool: the session (and any device) already resolved. */
  showResolved(s: SessionSnapshot, deviceId = ''): HeraldShowResult {
    return this.navigateTo(
      { serverId: s.serverId, sessionId: s.sessionId, sessionName: s.sessionName },
      hasPendingPrompt(s),
      deviceId,
      { via: 'brain' }
    );
  }

  private showWith(
    session: string,
    device: string,
    sessions: SessionSnapshot[],
    opts: HeraldShowOptions
  ): HeraldShowResult {
    const target = pickShowTarget(session, {
      actions: this.actions.list(),
      messages: this.messages,
      inbox: this.inbox.list(),
      sessions,
    });
    if (!target.ok) {
      return {
        status: target.status,
        ...(target.candidates.length ? { candidates: target.candidates.slice(0, 5) } : {}),
      };
    }
    return this.navigateTo(target.session, target.pending, device, opts);
  }

  /**
   * The device a navigation goes to: `device` (id, label or the user's words
   * like "my PC"; see resolveShowDevice), else the active one, else the requester.
   */
  private showDevice(device: string, requesterId?: string | null): { id: string; label: string } | null {
    const snap = this.devicesFn?.() ?? null;
    const labelOf = (id: string) => snap?.devices.find((d) => d.id === id)?.label || 'this device';
    if (device) {
      if (!snap) return null;
      const r = resolveShowDevice(device, snap.devices, requesterId ?? null);
      return r.kind === 'device' && r.id ? { id: r.id, label: r.label } : null;
    }
    const id = snap?.activeDevice?.id ?? this.voiceDeps.activeClientId?.() ?? requesterId ?? null;
    return id ? { id, label: labelOf(id) } : null;
  }

  /** The brain's show_session `device`: the user's words, from the device that asked. */
  resolveDeviceWords(phrase: string, requesterId: string | null): DeviceAliasResult {
    const devices = this.devicesFn?.()?.devices ?? [];
    return resolveShowDevice(phrase, devices, requesterId);
  }

  private navigateTo(
    session: HeraldSessionRef,
    pending: boolean,
    device: string,
    opts: HeraldShowOptions
  ): HeraldShowResult {
    const dev = this.showDevice(device, opts.requesterId);
    const missing: HeraldShowResult = { status: device ? 'offline' : 'no_device', session };
    if (!dev || !this.deliverFn) return missing;
    const id = `nav-${this.now().toString(36)}-${++this.navSeq}`;
    const delivered = this.deliverFn(dev.id, {
      kind: 'navigate',
      id,
      session,
      via: opts.via,
      ...(pending ? { pending: true } : {}),
      ...(opts.ack ? { ack: true } : {}),
    });
    if (!delivered) return missing;
    console.log(`Herald: show ${session.sessionName} on ${dev.label} (${opts.via})`);
    return { status: 'shown', session, device: dev };
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

  /**
   * The ONE device that speaks a Herald line (HeraldMessage.speakOn).
   * `origin` = the turn it answers (null: Herald speaking unasked).
   *   - reply: the device the turn came from; gone since -> the active device, else nobody
   *   - a turn from a connection that was not a Herald device (older client): no routing
   *   - unasked: the active device, else nobody
   * undefined = no routing (no voice layer): each client decides, as before.
   */
  speakOnFor(origin: SpeechOrigin | null): string | null | undefined {
    const snap = this.devicesFn?.();
    if (!snap) return undefined;
    const active = snap.activeDevice?.id ?? null;
    if (!origin) return active;
    if (!origin.device) return undefined;
    return snap.devices.some((d) => d.id === origin.clientId) ? origin.clientId : active;
  }

  /** `{ speakOn }` for a Herald line, or nothing when there is no routing. */
  private speakExtra(origin: SpeechOrigin | null): Pick<HeraldMessage, 'speakOn'> {
    const speakOn = this.speakOnFor(origin);
    return speakOn === undefined ? {} : { speakOn };
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
      // Herald lines said unasked go to the active device (a reply passes its own).
      ...(role === 'herald' && !('speakOn' in extra) ? this.speakExtra(null) : {}),
      ...extra,
      streaming: false,
    };
    if (msg.speakOn === undefined) delete msg.speakOn;
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
    // Spoken ask answers held back so they would not cut this reply off.
    if (!busy) this.asks.flush();
  }

  /**
   * Accept a user message and start a turn in the background. `opts` comes
   * straight from the client: unknown mode / intent values are ignored.
   */
  /**
   * Backstop for the client's self-echo filter: is this voice message just
   * Herald's own last reply (or the one before), heard through the speakers
   * and transcribed? Strict (echo cancellation and one speaking device do the
   * heavy lifting): a long, close, in-order replay only, never a question or a
   * command word Herald did not say (`isLikelyTextEcho`).
   */
  isVoiceEcho(text: string): boolean {
    const since = this.now() - ECHO_GUARD_WINDOW_MS;
    const replies = this.messages
      // Quiet announcements were never spoken, so they cannot come back as echo.
      .filter((m) => m.role === 'herald' && !m.quiet && m.createdAt >= since && m.text.trim())
      .slice(-ECHO_GUARD_REPLIES)
      .map((m) => m.text);
    if (replies.length === 0) return false;
    return isLikelyTextEcho(text, replies);
  }

  send(
    textRaw: unknown,
    opts: HeraldSendOptions = {}
  ): { messageId: string; ignored?: 'echo' | 'speaking' } {
    if (!this.cfg.featureEnabled)
      throw new HeraldRequestError(this.cfg.disabledReason || 'Herald is disabled.');
    if (!this.provider)
      throw new HeraldRequestError(this.cfg.disabledReason || 'Herald brain is not configured.');
    if (typeof textRaw !== 'string') throw new HeraldRequestError('text must be a string');
    const text = textRaw.replace(/\r\n/g, '\n').trim();
    if (!text) throw new HeraldRequestError('Message is empty.');
    if (text.length > MAX_USER_TEXT)
      throw new HeraldRequestError(`Message is too long (max ${MAX_USER_TEXT} characters).`);
    // Another device is playing Herald: this device's mic hears it with nothing
    // to cancel it against. Only a deliberate gesture gets through (backstop
    // for the client's own suppression).
    const clientId = typeof opts.clientId === 'string' && opts.clientId ? opts.clientId : null;
    if (
      opts.mode === 'voice' &&
      opts.gesture !== true &&
      clientId &&
      this.speakingSuppressesFn?.(clientId)
    ) {
      console.debug(
        `Herald: ignored a hands-off voice message from ${clientId} while another device is speaking (${text.length} chars)`
      );
      return { messageId: '', ignored: 'speaking' };
    }
    // Herald's own voice coming back as a "user" message: benign ack, no turn.
    // A deliberate gesture (push-to-talk, hotkey, trigger) is never an echo.
    if (opts.mode === 'voice' && !opts.intent && opts.gesture !== true && this.isVoiceEcho(text)) {
      console.log(
        `Herald: ignored a voice message that matches its own last reply (${text.length} chars, likely self-echo)`
      );
      return { messageId: '', ignored: 'echo' };
    }
    if (this.busy)
      throw new HeraldRequestError(
        `${this.cfg.displayName} is still answering the previous message.`
      );

    const mode: HeraldInputMode = opts.mode === 'voice' ? 'voice' : 'text';
    if (mode === 'voice') this.lastVoiceAt = this.now();
    // The reply is spoken on the device that asked (see speakOnFor).
    const origin: SpeechOrigin | null = clientId
      ? { clientId, device: !!this.devicesFn?.()?.devices.some((d) => d.id === clientId) }
      : null;
    // A turn from no known connection, or from one that is not a Herald device:
    // no routing (`speakOn` stays absent), never the unasked default.
    const reply: Partial<HeraldMessage> = { speakOn: origin ? this.speakOnFor(origin) : undefined };
    const intent: HeraldIntent | undefined =
      opts.intent === 'shorter' || opts.intent === 'more' || opts.intent === 'brief'
        ? opts.intent
        : undefined;

    // "How much have you cost me?": answered from the meter, free and exact.
    if (!intent && isUsageQuestion(text)) {
      const userMsg = this.postMessage('user', text);
      this.postMessage('herald', usageAnswer(this.usage.summary()), reply);
      return { messageId: userMsg.id };
    }

    // "Brief me": only what the user has not been told yet. Nothing new is
    // answered deterministically, without a brain turn.
    let briefing: HeraldInboxItem[] | undefined;
    if (intent === 'brief') {
      briefing = this.unheardForBriefing();
      if (briefing.length === 0) {
        const userMsg = this.postMessage('user', text, { intent });
        this.postMessage('herald', 'Nothing new.', reply);
        return { messageId: userMsg.id };
      }
      // They are about to be told: heard from now on (the chips dim at once).
      this.markHeard(briefing.map((i) => i.id));
    }

    // Brain down (inside its retry backoff) or budget spent: answer from data.
    const skip = this.skipBrainReason();
    if (skip) {
      const userMsg = this.postMessage('user', text, intent ? { intent } : {});
      this.emitBrainIfChanged();
      this.postMessage('herald', this.answerFromFallback(text, intent, skip, briefing), reply);
      return { messageId: userMsg.id };
    }

    this.setBusy(true);
    const history = this.messages.slice();
    const userMsg = this.postMessage('user', text, intent ? { intent } : {});
    void this.runConversationTurn(text, history, { mode, intent, briefing, origin }).catch(
      (err) => {
        console.error('Herald: turn crashed:', err);
        // Never leave the turn lock held: the user could not send again until restart.
        this.setBusy(false);
      }
    );
    return { messageId: userMsg.id };
  }

  private async runConversationTurn(
    userText: string,
    history: HeraldMessage[],
    turn: {
      mode: HeraldInputMode;
      intent?: HeraldIntent;
      briefing?: HeraldInboxItem[];
      origin?: SpeechOrigin | null;
    } = {
      mode: 'text',
    }
  ): Promise<void> {
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
      ...(turn.origin ? this.speakExtra(turn.origin) : {}),
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
      toolbox: this.toolbox ?? undefined,
      spawn: this.spawnEnv,
      setVerbosity: (level) => {
        this.setVerbosity(level);
        verbositySet = level;
      },
      showSession: (s, deviceId) => this.showResolved(s, deviceId),
      resolveDevice: (phrase) => this.resolveDeviceWords(phrase, turn.origin?.clientId ?? null),
    };
    let verbositySet: HeraldVerbosity | null = null;
    const started = Date.now();
    let errorText: string | null = null;
    let outage: HeraldBrainDownReason | null = null;
    let aborted = false;

    try {
      const snaps = await raceAbort(
        this.listAll().catch(() => this.lastSnapshots),
        abort.signal
      );
      // Reconcile the inbox with this exact listing before it goes into the
      // snapshot: a "finished" note for a session that is working again must not
      // survive until the next poll tick and be read out as news.
      this.applyInbox(snaps);
      const prefetched = turn.intent
        ? ''
        : await raceAbort(this.prefetchMentioned(userText, snaps, env, toolState), abort.signal);
      const result = await runTurn(provider, {
        history,
        userText: turn.intent
          ? intentInstruction(turn.intent, userText, this.briefingLines(turn.briefing ?? []))
          : userText,
        // A briefing sets its own shape (one sentence per item).
        turnNote: turn.intent === 'brief' ? undefined : replyStyleLine(turn.mode, this.verbosity),
        snapshot: this.buildSnapshot(snaps) + prefetched,
        systemPrompt: this.systemPrompt,
        maxTokens: this.cfg.maxTokens,
        signal: abort.signal,
        ...(this.cfg.promptCache ? { cache: this.cfg.promptCache } : {}),
        onUsage: (u) => this.onUsage(u),
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
      this.usage.recordTurn();
      this.noteBrainOk();
      console.log(
        `Herald: turn done provider=${provider.name} model=${provider.model} outcome=${result.outcome} ` +
          `mode=${turn.mode}${turn.intent ? ` intent=${turn.intent}` : ''} verbosity=${this.verbosity} ` +
          `ttft=${result.firstTokenMs !== undefined ? `${result.firstTokenMs}ms` : 'n/a'} total=${Date.now() - started}ms ` +
          `iterations=${result.iterations} tools=[${result.toolCalls.join(',')}] ` +
          `tokens in=${result.usage.inputTokens} out=${result.usage.outputTokens} ` +
          `cache_read=${result.usage.cacheReadInputTokens} cache_write=${result.usage.cacheCreationInputTokens}` +
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
          outage = 'timeout';
        } else {
          aborted = true;
        }
      } else {
        outage = outageReason(err);
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

    if (errorText && outage) {
      // Brain down: a deterministic answer instead of an error (fallback brain).
      this.noteOutage(outage);
      const fb = this.answerFromFallback(userText, turn.intent, outage, turn.briefing ?? []);
      reply.text = reply.text.trim() ? `${reply.text.trim()} ${fb}` : fb;
    } else if (errorText) {
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
          a.kind === 'cush_command'
            ? a.tier === 'echo'
              ? `${a.readback} in a few seconds unless you cancel.`
              : `Needs your confirmation: ${a.readback}.`
            : a.tier === 'echo'
              ? `Sending to ${a.readback} unless you cancel.`
              : `Needs your confirmation: ${a.readback}.`
        )
        .join(' ');
    }
    // The model often says "Okay, I'll keep it short." BEFORE calling
    // set_verbosity (dropped as narration) and then nothing after it.
    if (!reply.text.trim() && verbositySet) reply.text = VERBOSITY_CONFIRM[verbositySet];
    if (!reply.text.trim()) reply.text = "I don't have an answer for that.";

    reply.streaming = false;
    if (toolState.sessionRefs.size > 0)
      reply.sessionRefs = Array.from(toolState.sessionRefs.values()).slice(0, 20);
    if (actionIds.length > 0) reply.actionIds = actionIds;
    // The asking device may have gone mid-reply: the final word on who speaks it.
    if (turn.origin) Object.assign(reply, this.speakExtra(turn.origin));
    // The reply may have been dropped by a reset while we were finishing.
    if (this.messages.includes(reply)) {
      this.emit({ kind: 'message_end', message: { ...reply } });
      this.persist();
    }
    this.setBusy(false);
    this.flushBudgetNotice();
  }

  /** Unheard inbox items for "brief me", most urgent first, newest first within a rank. */
  private unheardForBriefing(): HeraldInboxItem[] {
    const live = new Map(
      this.lastSnapshots.map((s) => [`${s.serverId}:${s.sessionId}`, s.status] as const)
    );
    return this.inbox
      .list()
      .filter((i) => !i.heard)
      .filter(
        (i) =>
          i.answer ||
          !(i.priority === 'finished' && live.get(`${i.serverId}:${i.sessionId}`) === 'working')
      )
      // Answers to the user's own questions first, then blocked, finished.
      .sort(
        (a, b) =>
          Number(!!b.answer) - Number(!!a.answer) ||
          INBOX_RANK[a.priority] - INBOX_RANK[b.priority] ||
          b.createdAt - a.createdAt
      );
  }

  private briefingLines(items: HeraldInboxItem[]): string[] {
    const now = this.now();
    return items.map(
      (i) =>
        `[${i.answer ? 'answer' : i.priority}] ${clip(oneLine(i.headline), i.answer ? 320 : 200)} (${i.sessionName}, ${formatAgo(now - i.createdAt)} ago)`
    );
  }

  /**
   * Vocabulary hints for speech recognition: the names Whisper would otherwise
   * mangle ("Out4" -> "out for", "Doc Upload Site" -> "dock upload site").
   * Built from the latest session listing, so it follows sessions as they come
   * and go. Short on purpose (Whisper's prompt window is ~220 tokens).
   */
  sttHints(): { prompt: string; hotwords: string; versions: string[] } {
    const names: string[] = [];
    const seen = new Set<string>();
    const add = (n: string | undefined) => {
      const v = oneLine(n || '').slice(0, 40);
      const k = v.toLowerCase();
      if (!v || seen.has(k)) return;
      seen.add(k);
      names.push(v);
    };
    const live = this.lastSnapshots
      .filter((s) => !s.inactive)
      .sort((a, b) => b.lastActivity - a.lastActivity);
    for (const s of live) {
      add(s.sessionName);
      if (s.projectName) add(s.projectName);
      if (names.length >= STT_HINT_MAX_NAMES) break;
    }
    const self = [this.cfg.displayName, 'Jarvis'];
    // Versions people are talking about right now ("2.0.7" was heard as "two or seven").
    const versions = recentVersions(this.recentHintTexts(live));
    // The user's own pronunciation words are their vocabulary too ("k8s").
    const own = this.pronunciations.slice(0, 10).map((p) => p.from);
    const prompt = clip(
      `${self.join(', ')}.${names.length ? ` Sessions: ${names.join(', ')}.` : ''}${versions.length ? ` Versions: ${versions.join(', ')}.` : ''} ${[...STT_HINT_TERMS, ...own].join(', ')}.`,
      STT_HINT_MAX_CHARS
    );
    const hotwords = clip([...self, ...names, ...versions, ...STT_HINT_TERMS, ...own].join(' '), STT_HINT_MAX_CHARS);
    return { prompt, hotwords, versions };
  }

  /** Recent text that may mention versions, newest first: the conversation, then sessions and inbox. */
  private recentHintTexts(live: SessionSnapshot[]): string[] {
    const texts: string[] = [];
    for (let i = this.messages.length - 1, n = 0; i >= 0 && n < 30; i--, n++) texts.push(this.messages[i].text);
    for (const s of live) texts.push(s.lastTurnGist ?? '', s.currentActivity ?? '', s.pendingQuestion ?? '');
    for (const item of this.inbox.list()) texts.push(item.headline);
    return texts;
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
    // Inbox items are events ("finished 5m ago"), not states. Each is shown with
    // the session's CURRENT status from this same listing, and a finished note for
    // a session that is running again is dropped (it is history, not news).
    const current = new Map(live.map((s) => [`${s.serverId}:${s.sessionId}`, s]));
    const statusOf = (i: { serverId: string; sessionId: string }) =>
      current.get(`${i.serverId}:${i.sessionId}`)?.status ?? 'closed';
    const inbox = this.inbox
      .list()
      .filter((i) => !(i.priority === 'finished' && statusOf(i) === 'working'));
    const blocked = inbox.filter((i) => i.priority === 'blocked').length;
    const finished = inbox.filter((i) => i.priority === 'finished').length;
    const pending = this.actions.list().filter((a) => a.status === 'pending');
    const parts = [
      `[Fleet snapshot at ${new Date(now).toISOString()} — authoritative current state]`,
      lines.length ? lines.join('\n') : '- No live sessions.',
    ];
    if (live.length > SNAPSHOT_MAX_SESSIONS)
      parts.push(`(${live.length - SNAPSHOT_MAX_SESSIONS} more sessions not shown)`);
    parts.push(
      `Inbox: ${blocked} blocked, ${finished} finished earlier. Each session's status line above is its state NOW; describe a session by that, never as finished if it is working.`
    );
    // What the user has not been told yet, most urgent first: this is what
    // "anything for me?" should cover. Headlines are deterministic, not model-written.
    const unheardItems = inbox
      .filter((i) => !i.heard && i.priority !== 'progress')
      .sort((a, b) => INBOX_RANK[a.priority] - INBOX_RANK[b.priority] || b.createdAt - a.createdAt);
    if (unheardItems.length) {
      parts.push('Not yet told to the user:');
      for (const i of unheardItems.slice(0, SNAPSHOT_MAX_UNHEARD)) {
        parts.push(
          `- [${i.priority}] ${clip(oneLine(i.headline), 200)} (${formatAgo(now - i.createdAt)} ago; ${i.sessionName} is ${statusOf(i)} now)`
        );
      }
      if (unheardItems.length > SNAPSHOT_MAX_UNHEARD)
        parts.push(`(${unheardItems.length - SNAPSHOT_MAX_UNHEARD} more)`);
    }
    if (pending.length)
      parts.push(
        `Pending actions awaiting send/confirm: ${pending
          .map((a) =>
            a.tier === 'hard_confirm' && a.confirmPhrase
              ? `${a.readback} (needs confirmation: the card, or the user saying "${a.confirmPhrase}"; a plain "yes" does not confirm it)`
              : a.readback
          )
          .join('; ')}`
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

  async confirm(
    actionId: unknown,
    decision: unknown,
    origin: AuditOrigin,
    opts: HeraldConfirmOptions = {}
  ): Promise<HeraldAction> {
    if (typeof actionId !== 'string' || !actionId)
      throw new HeraldRequestError('actionId is required');
    if (decision !== 'confirm' && decision !== 'cancel')
      throw new HeraldRequestError('decision must be "confirm" or "cancel"');
    if (!this.actions.get(actionId)) throw new HeraldRequestError('Unknown action');
    if (decision === 'confirm' && opts.method === 'voice') return this.confirmByVoice(actionId, origin, opts);
    return decision === 'confirm'
      ? this.actions.confirm(actionId, origin)
      : this.actions.cancel(actionId, origin);
  }

  /**
   * "confirm deploy", spoken. Verified against the daemon's OWN transcript of
   * the requesting device's mic, never the client's word alone; rejected
   * attempts throw a HeraldRequestError whose message Herald can say.
   */
  private async confirmByVoice(
    actionId: string,
    origin: AuditOrigin,
    opts: HeraldConfirmOptions
  ): Promise<HeraldAction> {
    const clientId = opts.clientId || origin.clientId;
    const streamId = typeof opts.streamId === 'string' && opts.streamId ? opts.streamId : null;
    const claimed = typeof opts.phrase === 'string' ? opts.phrase.slice(0, 200) : '';
    let usedStream: string | null = null;
    const res = await this.actions.confirmByVoice(
      actionId,
      (a) => {
        const active = this.voiceDeps.activeClientId?.() ?? null;
        const ev = this.voiceDeps.voiceEvidence?.(clientId, streamId) ?? null;
        usedStream = ev?.transcript?.streamId ?? null;
        return checkVoiceConfirm({
          now: this.now(),
          phrase: a.confirmPhrase || '',
          claimed,
          isActiveDevice: !!active && active === clientId,
          transcript: ev?.transcript ?? null,
          spoken: ev?.spoken ?? [],
          speechEndAt: ev?.speechEndAt ?? 0,
        });
      },
      origin
    );
    if (usedStream) this.voiceDeps.consumeTranscript?.(clientId, usedStream);
    if (res.ok) return res.action;
    console.log(
      `Herald: voice confirm rejected for ${res.action.sessionName} (${res.rejection}); ${res.action.voiceAttemptsLeft ?? 0} tries left`
    );
    throw new HeraldRequestError(
      rejectionMessage(res.rejection, res.action.confirmPhrase || '', res.action.voiceAttemptsLeft ?? 0)
    );
  }

  private async runSpawn(req: SpawnRequest, a: HeraldAction): Promise<SpawnOutcome> {
    const runner = this.spawnRunner;
    if (!runner) return { ok: false, message: '', error: 'Starting sessions is not available here.' };
    // Re-validate against the allowed roots right before acting.
    const where = this.spawnEnv
      ? resolveSpawnDir(req.dir, this.spawnEnv.roots, this.spawnEnv.userHome)
      : null;
    if (!where || !where.ok || where.dir !== req.dir)
      return { ok: false, message: '', error: `${req.name} is no longer an allowed folder; nothing was started.` };
    const started = this.now();
    const out = await runner.run(req);
    try {
      this.auditFn({
        ts: this.now(),
        origin: SERVER_ORIGIN,
        action: 'herald_spawn_result',
        payload: { actionId: a.id, dir: req.dir, promptLength: req.firstPrompt.length },
        result: {
          ok: out.ok,
          ...(out.sessionId ? { sessionId: out.sessionId } : {}),
          ...(out.error ? { error: out.error } : {}),
        },
        durationMs: Math.max(0, this.now() - started),
      });
    } catch (err) {
      console.error('Herald: audit append failed:', err);
    }
    return out;
  }

  /**
   * Code Review "Ask why": type a question into a session and report its answer
   * back like any other ask (inbox `answer` item, finished tone). Re-validates
   * the pane first: a choice prompt on screen would swallow the text.
   */
  async relayAsk(r: {
    sessionId: string;
    sessionName: string;
    prompt: string;
    userText: string;
    clientId?: string;
  }): Promise<{ askId: string }> {
    if (!this.cfg.featureEnabled || this.disposed)
      throw new HeraldRelayError('herald_unavailable', 'Herald is not running');
    const src = this.getSource('local');
    if (!src) throw new HeraldRelayError('herald_unavailable', 'No local sessions');
    let choice;
    try {
      choice = await src.getLiveChoice(r.sessionId);
    } catch {
      throw new HeraldRelayError('unavailable', "Could not read the session's screen");
    }
    if (choice)
      throw new HeraldRelayError(
        'session_waiting',
        `${r.sessionName} is waiting on a choice; answer it first`
      );
    const askId = `review-${randomUUID()}`;
    const sentAt = this.now();
    const ok = await src.sendText(r.sessionId, r.prompt, askId);
    if (!ok) throw new HeraldRelayError('unavailable', `Could not send to ${r.sessionName}`);
    this.openAsk({
      actionId: askId,
      serverId: 'local',
      sessionId: r.sessionId,
      sessionName: r.sessionName,
      userText: r.userText,
      prompt: r.prompt,
      sentAt,
    });
    try {
      this.auditFn({
        ts: this.now(),
        origin: { ...SERVER_ORIGIN, clientId: r.clientId || 'review' },
        action: 'herald_review_ask',
        payload: { session: r.sessionId, askId, text: clip(r.prompt, 500) },
        result: { ok: true },
        durationMs: Math.max(0, this.now() - sentAt),
      });
    } catch (err) {
      console.error('Herald: audit append failed:', err);
    }
    return { askId };
  }

  /** Remember a send that expects a reply (ask-and-report). */
  private openAsk(info: {
    actionId: string;
    serverId: string;
    sessionId: string;
    sessionName: string;
    userText: string;
    prompt: string;
    sentAt: number;
  }): void {
    const snap = this.lastSnapshots.find(
      (s) => s.serverId === info.serverId && s.sessionId === info.sessionId
    );
    const block = snap ? blockKeyOf(snap) : null;
    this.asks.open({
      actionId: info.actionId,
      serverId: info.serverId,
      sessionId: info.sessionId,
      sessionName: info.sessionName,
      userQuestion: info.userText,
      sentText: info.prompt,
      sentAt: info.sentAt,
      baselineTurnKey: snap?.lastTurnKey ?? null,
      baselineBlockKey: block,
    });
  }

  private async runCush(cmd: CushCommand, a: HeraldAction) {
    const started = this.now();
    const out = await this.toolbox!.runCush(cmd);
    try {
      this.auditFn({
        ts: this.now(),
        origin: SERVER_ORIGIN,
        action: 'herald_cush_result',
        payload: { actionId: a.id, op: cmd.op, name: cmd.name, command: clip(a.payload, 500) },
        result: {
          ok: out.ok,
          ...(out.result?.url ? { url: out.result.url } : {}),
          ...(out.result?.verified !== undefined ? { verified: out.result.verified } : {}),
          ...(out.result?.localPort ? { localPort: out.result.localPort } : {}),
          ...(out.result?.checks ? { checks: out.result.checks } : {}),
          ...(out.error ? { error: out.error } : {}),
        },
        durationMs: Math.max(0, this.now() - started),
      });
    } catch (err) {
      console.error('Herald: audit append failed:', err);
    }
    return out;
  }

  private onActionSent(
    a: HeraldAction,
    note?: string,
    meta?: ActionMeta,
    spawned?: SpawnOutcome
  ): void {
    if (a.kind === 'cush_command') {
      this.postMessage('herald', note || `Done: ${a.readback}.`, { actionIds: [a.id] });
      return;
    }
    if (a.kind === 'spawn_session') {
      this.postMessage('herald', note || `Started a session in ${a.sessionName}.`, {
        actionIds: [a.id],
        ...(spawned?.sessionId
          ? {
              sessionRefs: [
                {
                  serverId: 'local',
                  sessionId: spawned.sessionId,
                  sessionName: spawned.sessionName || a.sessionName,
                },
              ],
            }
          : {}),
      });
      void this.poll();
      return;
    }
    const ref = { serverId: a.serverId, sessionId: a.sessionId, sessionName: a.sessionName };
    if (a.kind === 'interrupt') {
      this.postMessage('herald', `Interrupted ${a.sessionName}.`, {
        sessionRefs: [ref],
        actionIds: [a.id],
      });
      void this.poll();
      return;
    }
    // Free text is a question or a request: report back what the session says.
    if (a.kind === 'send_input') {
      this.openAsk({
        actionId: a.id,
        serverId: a.serverId,
        sessionId: a.sessionId,
        sessionName: a.sessionName,
        userText: meta?.userText || a.payload,
        prompt: a.payload,
        sentAt: a.resolvedAt ?? this.now(),
      });
    }
    this.postMessage('herald', `Sent to ${a.sessionName}.`, {
      sessionRefs: [ref],
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
          ...(event === 'confirmed' || event === 'voice_rejected'
            ? { method: trigger === 'voice' ? 'voice' : trigger === 'confirm' ? 'tap' : trigger }
            : {}),
          ...(a.confirmPhrase && trigger === 'voice'
            ? { confirmPhrase: a.confirmPhrase, voiceAttemptsLeft: a.voiceAttemptsLeft ?? 0 }
            : {}),
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
