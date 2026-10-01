/**
 * ActionManager: owns the lifecycle of Herald actions (proposed input to a session).
 *
 *   echo         -> auto-sends at autoSendAt (server-owned timer, so it works across
 *                   devices) unless cancelled; confirm sends immediately.
 *   hard_confirm -> never auto-sends; requires an explicit confirm; expires after TTL.
 *
 * Every send re-validates against the LIVE session right before injecting: an
 * answer_choice is only delivered if the exact same prompt is still on screen, and
 * free text is never typed into a choice box. Nothing is sent into a changed prompt.
 * An interrupt only fires while the session is still running a turn (Ctrl+C at an
 * idle prompt is a step toward exiting Claude Code).
 *
 * hard_confirm actions carry a `confirmPhrase` ("confirm deploy"): a voice
 * confirmation must say it (verified by the caller's check, see voice-confirm.ts),
 * at most MAX_VOICE_ATTEMPTS times per action, then on-screen only.
 */

import { randomUUID } from 'crypto';
import type { HeraldAction, HeraldActionTier } from './protocol';
import type { SessionSource } from './session-source';
import type { AuditOrigin } from '../audit-log';
import type { CushCommand } from './knowledge/cush';
import {
  deriveConfirmPhrase,
  MAX_VOICE_ATTEMPTS,
  type VoiceConfirmRejection,
} from './voice-confirm';

export const HARD_CONFIRM_TTL_MS = 10 * 60 * 1000;
const REVALIDATE_TIMEOUT_MS = 8000;
const SEND_TIMEOUT_MS = 20_000;
/** Command (20s) + launch verification (12s) + local checks, with headroom. */
const CUSH_TIMEOUT_MS = 45_000;
/** tmux + Claude start-up (readiness polling) + first prompt, with headroom. */
const SPAWN_TIMEOUT_MS = 60_000;
const MAX_RESOLVED_KEPT = 30;

export interface ChoiceMeta {
  index: number;
  optionCount: number;
  multiSelect: boolean;
  signature: string;
}

/** spawn_session: a validated directory (real path, inside an allowed root). */
export interface SpawnRequest {
  dir: string;
  firstPrompt: string;
  /** Friendly name for the new session (from the folder). */
  name: string;
}

export interface ActionMeta {
  choice?: ChoiceMeta;
  /** cush_command: the validated command (never a shell string). */
  cush?: CushCommand;
  spawn?: SpawnRequest;
  /** What the user said when this was proposed (ask-and-report links the reply to it). */
  userText?: string;
  /** Danger rule ids that fired (pick the voice-confirm keyword). */
  ruleIds?: string[];
}

/** Outcome of starting a session; `message` is posted to the user verbatim. */
export interface SpawnOutcome {
  ok: boolean;
  message: string;
  error?: string;
  /** The new session (tmux name) when it started. */
  sessionId?: string;
  sessionName?: string;
}

/** Outcome of running a cush_command; `message` is posted to the user verbatim. */
export interface CushExecOutcome {
  ok: boolean;
  message: string;
  error?: string;
}

export type ActionTrigger =
  | 'auto'
  | 'confirm'
  | 'voice'
  | 'cancel'
  | 'expire'
  | 'propose'
  | 'escalate';

export interface ActionAuditHook {
  (
    event:
      | 'proposed'
      | 'escalated'
      | 'confirmed'
      | 'cancelled'
      | 'sent'
      | 'failed'
      | 'expired'
      | 'voice_rejected',
    action: HeraldAction,
    trigger: ActionTrigger,
    origin?: AuditOrigin
  ): void;
}

export interface ActionManagerDeps {
  getSource(serverId: string): SessionSource | null;
  echoDelayMs: number;
  hardConfirmTtlMs?: number;
  now?: () => number;
  onChange(action: HeraldAction): void;
  /** `note`: the result line for a cush_command / spawn. `meta`: what the action carried. */
  onSent(action: HeraldAction, note?: string, meta?: ActionMeta, spawned?: SpawnOutcome): void;
  audit: ActionAuditHook;
  /** Runs a cush_command (re-validates, executes, verifies). Absent = unsupported. */
  runCush?: (cmd: CushCommand, action: HeraldAction) => Promise<CushExecOutcome>;
  /** Starts a Claude Code session (re-validates the dir). Absent = unsupported. */
  runSpawn?: (req: SpawnRequest, action: HeraldAction) => Promise<SpawnOutcome>;
}

export type VoiceConfirmResult =
  | { ok: true; action: HeraldAction }
  | { ok: false; action: HeraldAction; rejection: VoiceConfirmRejection };

interface ActionRecord {
  action: HeraldAction;
  meta: ActionMeta;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  /** hard_confirm: when the confirmation window closes. */
  expiresAt?: number;
}

class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      t.unref?.();
    }),
  ]);
}

export class ActionManager {
  private records = new Map<string, ActionRecord>();
  private deps: ActionManagerDeps;
  private now: () => number;
  private ttl: number;

  constructor(deps: ActionManagerDeps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.ttl = deps.hardConfirmTtlMs ?? HARD_CONFIRM_TTL_MS;
  }

  /** Restore resolved history from disk (pending ones were already expired by the store). */
  loadPersisted(actions: HeraldAction[]): void {
    for (const a of actions) {
      if (a.status === 'pending') continue;
      this.records.set(a.id, { action: { ...a }, meta: {}, timer: null, inFlight: false });
    }
    this.trim();
  }

  create(params: {
    tier: HeraldActionTier;
    reasons: string[];
    kind: HeraldAction['kind'];
    serverId: string;
    sessionId: string;
    sessionName: string;
    payload: string;
    readback: string;
    meta: ActionMeta;
  }): HeraldAction {
    const now = this.now();
    const action: HeraldAction = {
      id: randomUUID(),
      tier: params.tier,
      kind: params.kind,
      serverId: params.serverId,
      sessionId: params.sessionId,
      sessionName: params.sessionName,
      payload: params.payload,
      readback: params.readback,
      reasons: [...params.reasons],
      status: 'pending',
      createdAt: now,
    };
    const rec: ActionRecord = { action, meta: params.meta, timer: null, inFlight: false };
    if (action.tier === 'hard_confirm') this.assignPhrase(rec);
    this.records.set(action.id, rec);
    this.arm(rec);
    this.deps.audit('proposed', action, 'propose');
    this.deps.onChange({ ...action });
    this.trim();
    return { ...action };
  }

  /** Voice-confirm words for a hard_confirm card, distinct from every other pending card. */
  private assignPhrase(rec: ActionRecord): void {
    if (rec.action.confirmPhrase) return;
    const taken = Array.from(this.records.values())
      .filter((r) => r !== rec && r.action.status === 'pending' && r.action.confirmPhrase)
      .map((r) => r.action.confirmPhrase as string);
    rec.action.confirmPhrase = deriveConfirmPhrase({
      kind: rec.action.kind,
      ruleIds: rec.meta.ruleIds,
      cushOp: rec.meta.cush?.op,
      sessionName: rec.action.sessionName,
      taken,
    });
    rec.action.voiceAttemptsLeft = MAX_VOICE_ATTEMPTS;
  }

  private arm(rec: ActionRecord): void {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
    const now = this.now();
    if (rec.action.tier === 'echo') {
      rec.action.autoSendAt = now + this.deps.echoDelayMs;
      rec.timer = setTimeout(() => {
        rec.timer = null;
        void this.execute(rec.action.id, 'auto');
      }, this.deps.echoDelayMs);
    } else {
      delete rec.action.autoSendAt;
      rec.expiresAt = now + this.ttl;
      rec.timer = setTimeout(() => {
        rec.timer = null;
        this.expire(rec.action.id, 'Confirmation window elapsed; nothing was sent.');
      }, this.ttl);
    }
    rec.timer.unref?.();
  }

  /** Raise a pending echo action to hard_confirm (never the other way). */
  escalate(id: string, reason: string): HeraldAction | null {
    const rec = this.records.get(id);
    if (!rec || rec.action.status !== 'pending' || rec.inFlight) return null;
    if (!rec.action.reasons.includes(reason)) rec.action.reasons.push(reason);
    if (rec.action.tier === 'hard_confirm') return { ...rec.action };
    rec.action.tier = 'hard_confirm';
    this.assignPhrase(rec);
    this.arm(rec);
    this.deps.audit('escalated', rec.action, 'escalate');
    this.deps.onChange({ ...rec.action });
    return { ...rec.action };
  }

  get(id: string): HeraldAction | null {
    const rec = this.records.get(id);
    return rec ? { ...rec.action } : null;
  }

  async confirm(id: string, origin?: AuditOrigin): Promise<HeraldAction> {
    const rec = this.records.get(id);
    if (!rec) throw new Error('Unknown action');
    if (rec.action.status !== 'pending' || rec.inFlight) return { ...rec.action };
    this.deps.audit('confirmed', rec.action, 'confirm', origin);
    return this.execute(id, 'confirm', origin);
  }

  /**
   * Confirm a hard_confirm action by voice. `verify` runs the evidence checks
   * (transcript, timing, echo, device) and returns a rejection or null. Every
   * attempt that reaches `verify` uses up one try; with none left the card is
   * on-screen only. Accepted attempts send exactly like a tap.
   */
  async confirmByVoice(
    id: string,
    verify: (action: HeraldAction) => VoiceConfirmRejection | null,
    origin?: AuditOrigin
  ): Promise<VoiceConfirmResult> {
    const rec = this.records.get(id);
    if (!rec) throw new Error('Unknown action');
    const a = rec.action;
    const reject = (rejection: VoiceConfirmRejection, counted: boolean): VoiceConfirmResult => {
      this.deps.audit('voice_rejected', { ...a, error: rejection }, 'voice', origin);
      if (counted) this.deps.onChange({ ...a });
      return { ok: false, action: { ...a }, rejection };
    };
    if (a.status !== 'pending' || rec.inFlight) return reject('not_pending', false);
    if (a.tier !== 'hard_confirm' || !a.confirmPhrase) return reject('not_hard_confirm', false);
    if (rec.expiresAt !== undefined && this.now() >= rec.expiresAt) return reject('expired', false);
    if ((a.voiceAttemptsLeft ?? 0) <= 0) return reject('too_many_attempts', false);
    const rejection = verify({ ...a });
    // Another (passive) device hearing the user is not a try at THIS card's phrase.
    if (rejection === 'not_active_device') return reject(rejection, false);
    a.voiceAttemptsLeft = Math.max(0, (a.voiceAttemptsLeft ?? MAX_VOICE_ATTEMPTS) - 1);
    if (rejection) return reject(rejection, true);
    this.deps.audit('confirmed', a, 'voice', origin);
    return { ok: true, action: await this.execute(id, 'voice', origin) };
  }

  cancel(id: string, origin?: AuditOrigin): HeraldAction {
    const rec = this.records.get(id);
    if (!rec) throw new Error('Unknown action');
    if (rec.action.status !== 'pending' || rec.inFlight) return { ...rec.action };
    this.resolve(rec, 'cancelled');
    this.deps.audit('cancelled', rec.action, 'cancel', origin);
    this.deps.onChange({ ...rec.action });
    return { ...rec.action };
  }

  private expire(id: string, error: string): void {
    const rec = this.records.get(id);
    if (!rec || rec.action.status !== 'pending' || rec.inFlight) return;
    this.resolve(rec, 'expired', error);
    this.deps.audit('expired', rec.action, 'expire');
    this.deps.onChange({ ...rec.action });
  }

  private resolve(rec: ActionRecord, status: HeraldAction['status'], error?: string): void {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
    rec.action.status = status;
    rec.action.resolvedAt = this.now();
    delete rec.action.autoSendAt;
    if (error) rec.action.error = error;
  }

  private async execute(
    id: string,
    trigger: ActionTrigger,
    origin?: AuditOrigin
  ): Promise<HeraldAction> {
    const rec = this.records.get(id);
    if (!rec) throw new Error('Unknown action');
    if (rec.action.status !== 'pending' || rec.inFlight) return { ...rec.action };
    rec.inFlight = true;
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;

    const a = rec.action;
    let sendStarted = false;
    const fail = (status: 'failed' | 'expired', error: string) => {
      this.resolve(rec, status, error);
      this.deps.audit(status, rec.action, trigger, origin);
      this.deps.onChange({ ...rec.action });
    };

    try {
      if (a.kind === 'cush_command') {
        const cmd = rec.meta.cush;
        if (!cmd || !this.deps.runCush) {
          fail('failed', 'cush-tools commands are not available here; nothing was run.');
          return { ...rec.action };
        }
        sendStarted = true;
        const out = await withTimeout(this.deps.runCush(cmd, { ...a }), CUSH_TIMEOUT_MS, 'command');
        if (!out.ok) {
          fail('failed', out.error || out.message);
          return { ...rec.action };
        }
        this.resolve(rec, 'sent');
        this.deps.audit('sent', rec.action, trigger, origin);
        this.deps.onChange({ ...rec.action });
        this.deps.onSent({ ...rec.action }, out.message);
        return { ...rec.action };
      }
      if (a.kind === 'spawn_session') {
        const req = rec.meta.spawn;
        if (!req || !this.deps.runSpawn) {
          fail('failed', 'Starting sessions is not available here; nothing was started.');
          return { ...rec.action };
        }
        sendStarted = true;
        const out = await withTimeout(this.deps.runSpawn(req, { ...a }), SPAWN_TIMEOUT_MS, 'start');
        if (!out.ok) {
          fail('failed', out.error || out.message);
          return { ...rec.action };
        }
        this.resolve(rec, 'sent');
        this.deps.audit('sent', rec.action, trigger, origin);
        this.deps.onChange({ ...rec.action });
        this.deps.onSent({ ...rec.action }, out.message, { ...rec.meta }, out);
        return { ...rec.action };
      }
      const source = this.deps.getSource(a.serverId);
      if (!source) {
        fail('failed', `Server "${a.serverId}" is not reachable.`);
        return { ...rec.action };
      }
      const exists = await withTimeout(
        source.sessionExists(a.sessionId),
        REVALIDATE_TIMEOUT_MS,
        'session check'
      );
      if (!exists) {
        fail('failed', `${a.sessionName} is no longer running; nothing was sent.`);
        return { ...rec.action };
      }
      if (a.kind === 'interrupt') {
        if (!source.interrupt) {
          fail('failed', 'Interrupting is not available for this session; nothing was sent.');
          return { ...rec.action };
        }
        const sessions = await withTimeout(
          source.listSessions(),
          REVALIDATE_TIMEOUT_MS,
          'status check'
        );
        const live = sessions.find((x) => x.sessionId === a.sessionId);
        if (!live || live.inactive) {
          fail('failed', `${a.sessionName} is no longer running; nothing was sent.`);
          return { ...rec.action };
        }
        // Ctrl+C at an idle prompt does nothing useful, and a second one exits Claude.
        if (live.status === 'idle') {
          fail('expired', `${a.sessionName} already stopped; nothing to interrupt.`);
          return { ...rec.action };
        }
        sendStarted = true;
        const done = await withTimeout(source.interrupt(a.sessionId), SEND_TIMEOUT_MS, 'interrupt');
        if (!done) {
          fail('failed', `Could not interrupt ${a.sessionName}.`);
          return { ...rec.action };
        }
        this.resolve(rec, 'sent');
        this.deps.audit('sent', rec.action, trigger, origin);
        this.deps.onChange({ ...rec.action });
        this.deps.onSent({ ...rec.action }, undefined, { ...rec.meta });
        return { ...rec.action };
      }
      const live = await withTimeout(
        source.getLiveChoice(a.sessionId),
        REVALIDATE_TIMEOUT_MS,
        'prompt check'
      );

      let ok: boolean;
      if (a.kind === 'answer_choice') {
        const c = rec.meta.choice;
        if (!c) {
          fail('failed', 'Internal error: choice details missing; nothing was sent.');
          return { ...rec.action };
        }
        if (!live || live.signature !== c.signature) {
          fail(
            'expired',
            `${a.sessionName}'s question changed or was already answered; nothing was sent.`
          );
          return { ...rec.action };
        }
        if (c.index < 0 || c.index >= live.options.length) {
          fail(
            'expired',
            `That option is no longer offered by ${a.sessionName}; nothing was sent.`
          );
          return { ...rec.action };
        }
        sendStarted = true;
        ok = await withTimeout(
          source.sendChoice(a.sessionId, c.index, live.options.length, live.multiSelect),
          SEND_TIMEOUT_MS,
          'send'
        );
      } else {
        if (live) {
          fail(
            'expired',
            `${a.sessionName} is now showing a multiple-choice prompt; typed text was not sent.`
          );
          return { ...rec.action };
        }
        sendStarted = true;
        ok = await withTimeout(
          source.sendText(a.sessionId, a.payload, `herald-${a.id}`),
          SEND_TIMEOUT_MS,
          'send'
        );
      }

      if (!ok) {
        fail('failed', `Could not deliver input to ${a.sessionName}'s terminal.`);
        return { ...rec.action };
      }
      this.resolve(rec, 'sent');
      this.deps.audit('sent', rec.action, trigger, origin);
      this.deps.onChange({ ...rec.action });
      this.deps.onSent({ ...rec.action }, undefined, { ...rec.meta });
      return { ...rec.action };
    } catch (err) {
      if (sendStarted && err instanceof TimeoutError) {
        // The keystrokes may still land after we stop waiting: never let the user
        // believe nothing was sent (a blind retry could double-send).
        fail(
          'failed',
          a.kind === 'cush_command'
            ? 'The command timed out; it may still have started. Check the cush-tools status before retrying.'
            : a.kind === 'spawn_session'
              ? 'Starting the session timed out; it may still be starting. Check the session list before retrying.'
              : `Delivery to ${a.sessionName} timed out; it may still have been typed. Check the session before retrying.`
        );
      } else {
        fail('failed', `Send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ...rec.action };
    } finally {
      rec.inFlight = false;
      this.trim();
    }
  }

  /** Pending first (oldest first), then the most recent resolved. */
  list(): HeraldAction[] {
    const all = Array.from(this.records.values()).map((r) => ({ ...r.action }));
    const pending = all
      .filter((a) => a.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    const resolved = all
      .filter((a) => a.status !== 'pending')
      .sort((a, b) => (b.resolvedAt || b.createdAt) - (a.resolvedAt || a.createdAt))
      .slice(0, MAX_RESOLVED_KEPT);
    return [...pending, ...resolved];
  }

  pendingIds(): string[] {
    return Array.from(this.records.values())
      .filter((r) => r.action.status === 'pending')
      .map((r) => r.action.id);
  }

  private trim(): void {
    const resolved = Array.from(this.records.values())
      .filter((r) => r.action.status !== 'pending' && !r.inFlight)
      .sort(
        (a, b) =>
          (b.action.resolvedAt || b.action.createdAt) - (a.action.resolvedAt || a.action.createdAt)
      );
    for (const r of resolved.slice(MAX_RESOLVED_KEPT)) this.records.delete(r.action.id);
  }

  dispose(): void {
    for (const r of this.records.values()) {
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
    }
  }
}
