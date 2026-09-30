/**
 * Herald's brain tools: schemas, strict argument validation, and grounded executors.
 *
 * Every tool returns real session data (or a clear error). propose_input never
 * sends anything: it routes through the deterministic danger classifier and the
 * ActionManager, which owns confirmation and delivery.
 */

import type { LlmToolSpec } from './llm/provider';
import type { PendingChoice, SessionSnapshot, SessionSource } from './session-source';
import type { HeraldAction, HeraldSessionRef } from './protocol';
import type { ActionManager } from './actions';
import { classifyAction, findSelectedOption } from './danger';
import { resolveSession, normalizeRef } from './resolve';
import { clip, clipTail, firstSentence, formatAgo, oneLine, plainToolAction } from './text';

export const MAX_PROPOSALS_PER_TURN = 4;
const MAX_SESSIONS_LISTED = 25;
const SUMMARY_TAIL_CHARS = 1500;
const SUMMARY_PREV_CHARS = 500;
const READ_FULL_CHARS = 6000;
const MAX_INPUT_CHARS = 2000;
const NO_TRANSCRIPT_NOTE =
  "No transcript text is available for this session right now (it may not have replied yet, or the daemon is still loading it). Say you can't see what it said; don't claim it has done nothing.";

// ---------------------------------------------------------------------------
// Schemas

const SESSION_PROP = {
  type: 'string',
  description:
    'Which session: its name (or project name) exactly as listed. Never guess between similar names.',
  maxLength: 120,
};

export const TOOL_SPECS: LlmToolSpec[] = [
  {
    name: 'list_sessions',
    description:
      'List every coding session with its live status (working / waiting / idle), how long it has been in that state, what it is doing, and any question it is waiting on. Use for any status question.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'summarize_session',
    description:
      "Get a session's most recent output (trimmed) plus any pending question and its options, so you can paraphrase what it did or is asking.",
    parameters: {
      type: 'object',
      properties: { session: SESSION_PROP },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_full',
    description:
      "Get the session's full last reply verbatim (bounded). Only use when the user asks you to read it out in full.",
    parameters: {
      type: 'object',
      properties: { session: SESSION_PROP },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_input',
    description:
      'Propose sending input to a session. This does NOT send immediately: the system reads it back and either auto-sends after a short delay or requires the user to confirm on screen. ' +
      'Give exactly one of `option` (to answer a multiple-choice question: the option number like "2" or its exact label) or `text` (a free-text message to type into the session). ' +
      "Relay the user's intent faithfully; do not add instructions they did not give.",
    parameters: {
      type: 'object',
      properties: {
        session: SESSION_PROP,
        option: {
          type: 'string',
          description: 'Option number ("2") or exact option label, for multiple-choice prompts.',
          maxLength: 200,
        },
        text: {
          type: 'string',
          description: 'Free text to send to the session.',
          maxLength: MAX_INPUT_CHARS,
        },
        confirm: {
          type: 'boolean',
          description:
            'Set true if you are at all unsure this is safe; forces an explicit confirmation.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Validation (small, strict JSON-schema subset matching the specs above)

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function validateToolCall(name: string, rawArgs: string): ValidationResult {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) {
    return {
      ok: false,
      error: `Unknown tool "${name}". Available tools: ${TOOL_SPECS.map((t) => t.name).join(', ')}.`,
    };
  }
  let parsed: unknown;
  const trimmed = (rawArgs || '').trim();
  try {
    parsed = trimmed ? JSON.parse(trimmed) : {};
  } catch {
    return {
      ok: false,
      error: `Arguments for ${name} are not valid JSON. Send a single JSON object, e.g. ${example(name)}.`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `Arguments for ${name} must be a JSON object, e.g. ${example(name)}.`,
    };
  }
  const schema = spec.parameters as {
    properties: Record<string, { type: string; maxLength?: number }>;
    required?: string[];
  };
  const input = parsed as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const prop = schema.properties[key];
    if (!prop) {
      return {
        ok: false,
        error: `Unexpected argument "${key}" for ${name}. Allowed: ${Object.keys(schema.properties).join(', ') || 'none'}.`,
      };
    }
    let v = input[key];
    if (v === null || v === undefined) continue;
    if (prop.type === 'string') {
      if (typeof v === 'number' && Number.isFinite(v)) v = String(v); // lenient: option 2 -> "2"
      if (typeof v !== 'string')
        return { ok: false, error: `Argument "${key}" for ${name} must be a string.` };
      if (prop.maxLength && v.length > prop.maxLength) {
        return {
          ok: false,
          error: `Argument "${key}" for ${name} is too long (max ${prop.maxLength} characters).`,
        };
      }
    } else if (prop.type === 'boolean') {
      if (v === 'true' || v === 'false') v = v === 'true';
      if (typeof v !== 'boolean')
        return { ok: false, error: `Argument "${key}" for ${name} must be true or false.` };
    }
    value[key] = v;
  }
  for (const req of schema.required || []) {
    if (
      value[req] === undefined ||
      (typeof value[req] === 'string' && !(value[req] as string).trim())
    ) {
      return {
        ok: false,
        error: `Missing required argument "${req}" for ${name}, e.g. ${example(name)}.`,
      };
    }
  }
  if (name === 'propose_input') {
    const hasText = typeof value.text === 'string' && (value.text as string).trim() !== '';
    const hasOption = typeof value.option === 'string' && (value.option as string).trim() !== '';
    if (hasText === hasOption) {
      return { ok: false, error: 'propose_input needs exactly one of "option" or "text".' };
    }
  }
  return { ok: true, value };
}

function example(name: string): string {
  switch (name) {
    case 'list_sessions':
      return '{}';
    case 'propose_input':
      return '{"session": "companion", "option": "2"}';
    default:
      return '{"session": "companion"}';
  }
}

// ---------------------------------------------------------------------------
// Execution

export interface TurnToolState {
  userText: string;
  sessionRefs: Map<string, HeraldSessionRef>;
  /** Actions proposed this turn, with their target session and the tier each got. */
  proposals: Array<{
    actionId: string;
    sessionKey: string;
    sessionName: string;
    tier: HeraldAction['tier'];
  }>;
}

export interface ToolEnv {
  listSessions(): Promise<SessionSnapshot[]>;
  getSource(serverId: string): SessionSource | null;
  actions: ActionManager;
  now(): number;
  /** Observed start of the current status per session (from the poll loop). */
  statusSince(serverId: string, sessionId: string): number | null;
  echoDelayMs: number;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

const ok = (data: unknown): ToolOutcome => ({ content: JSON.stringify(data), isError: false });
const err = (message: string): ToolOutcome => ({
  content: JSON.stringify({ error: message }),
  isError: true,
});

function sessionKey(s: { serverId: string; sessionId: string }): string {
  return `${s.serverId}:${s.sessionId}`;
}

function describeChoice(c: PendingChoice) {
  return {
    question: clip(oneLine(c.header ? `${c.header}: ${c.question}` : c.question), 300),
    options: c.options.map((o, i) => ({
      number: i + 1,
      label: clip(oneLine(o.label), 120),
      ...(o.description ? { description: clip(oneLine(o.description), 160) } : {}),
    })),
    multi_select: c.multiSelect || undefined,
  };
}

export function sessionView(s: SessionSnapshot, env: ToolEnv) {
  const now = env.now();
  const since = env.statusSince(s.serverId, s.sessionId);
  return {
    name: s.sessionName,
    project: s.projectName || undefined,
    status: s.inactive ? 'closed' : s.status,
    status_for: since ? formatAgo(now - since) : undefined,
    last_activity_ago: s.lastActivity ? formatAgo(now - s.lastActivity) : 'unknown',
    doing:
      s.status === 'working' && s.currentActivity
        ? clip(oneLine(s.currentActivity), 120)
        : undefined,
    pending_choice: s.pendingChoice ? describeChoice(s.pendingChoice) : undefined,
    needs_approval: s.pendingApproval
      ? {
          wants_to: plainToolAction(s.pendingApproval.tool),
          tool: s.pendingApproval.tool,
          detail: clip(s.pendingApproval.detail, 200) || undefined,
        }
      : undefined,
    asked: s.pendingQuestion ? clip(s.pendingQuestion, 240) : undefined,
    last_said:
      !s.pendingChoice && s.lastTurnGist
        ? firstSentence(s.lastTurnGist, 160) || undefined
        : undefined,
  };
}

async function resolveFresh(env: ToolEnv, ref: string, state: TurnToolState) {
  const sessions = await env.listSessions();
  const r = resolveSession(ref, sessions);
  if (r.ok) {
    state.sessionRefs.set(sessionKey(r.session), {
      serverId: r.session.serverId,
      sessionId: r.session.sessionId,
      sessionName: r.session.sessionName,
    });
  }
  return r;
}

const NEGATION_TOKENS = [
  'no',
  'not',
  'don',
  'dont',
  't',
  'never',
  'deny',
  'reject',
  'cancel',
  'stop',
  'without',
];

/** Map an option reference ("2", "option 2", label, unique partial label) to an index. */
export function resolveOption(
  ref: string,
  options: PendingChoice['options']
): { ok: true; index: number } | { ok: false; error: string } {
  const raw = oneLine(ref);
  const byExact = findSelectedOption(raw, options);
  if (byExact) return { ok: true, index: options.indexOf(byExact) };
  const n = normalizeRef(raw);
  if (n) {
    // Whole-word containment only (a character substring lets "no" match inside
    // another word), and never across a negation: "go ahead" must not pick
    // "Don't go ahead" just because its words are contained in it.
    const refTokens = n.split(' ');
    const negationMismatch = (kt: string[]) =>
      NEGATION_TOKENS.some((t) => kt.includes(t) !== refTokens.includes(t));
    const hits = options
      .map((o, i) => ({ i, k: normalizeRef(o.label) }))
      .filter(({ k }) => {
        if (!k) return false;
        if (k === n) return true;
        const kt = k.split(' ');
        if (negationMismatch(kt)) return false;
        return refTokens.every((t) => kt.includes(t)) || kt.every((t) => refTokens.includes(t));
      });
    if (hits.length === 1) return { ok: true, index: hits[0].i };
  }
  const list = options.map((o, i) => `${i + 1}) ${clip(oneLine(o.label), 60)}`).join('; ');
  return {
    ok: false,
    error: `"${raw}" does not clearly match one option. Options are: ${list}. Ask the user which one.`,
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  env: ToolEnv,
  state: TurnToolState
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'list_sessions': {
        const sessions = await env.listSessions();
        const live = sessions.filter((s) => !s.inactive);
        const rank = { waiting: 0, working: 1, idle: 2 } as const;
        live.sort((a, b) => rank[a.status] - rank[b.status] || b.lastActivity - a.lastActivity);
        for (const s of live.slice(0, MAX_SESSIONS_LISTED)) {
          state.sessionRefs.set(sessionKey(s), {
            serverId: s.serverId,
            sessionId: s.sessionId,
            sessionName: s.sessionName,
          });
        }
        return ok({
          sessions: live.slice(0, MAX_SESSIONS_LISTED).map((s) => sessionView(s, env)),
          omitted:
            live.length > MAX_SESSIONS_LISTED ? live.length - MAX_SESSIONS_LISTED : undefined,
          closed_sessions: sessions.length - live.length || undefined,
        });
      }

      case 'summarize_session':
      case 'read_full': {
        const r = await resolveFresh(env, String(args.session), state);
        if (!r.ok) return err(r.error);
        const s = r.session;
        const src = env.getSource(s.serverId);
        if (!src) return err(`Server for ${s.sessionName} is not reachable.`);
        const t = await src.getRecentTranscript(s.sessionId, name === 'read_full' ? 1 : 2);
        const turns = t.assistantTurns;
        const last = turns[turns.length - 1];
        const base = sessionView(s, env);
        if (name === 'read_full') {
          if (!last) return ok({ ...base, full_reply: null, note: NO_TRANSCRIPT_NOTE });
          return ok({
            ...base,
            full_reply: clip(last.text, READ_FULL_CHARS),
            truncated: last.text.length > READ_FULL_CHARS || undefined,
            replied_ago: formatAgo(env.now() - last.at),
          });
        }
        const prev = turns.length > 1 ? turns[turns.length - 2] : null;
        return ok({
          ...base,
          last_user_request: t.lastUserPrompt
            ? clip(oneLine(t.lastUserPrompt.text), 300)
            : undefined,
          latest_reply: last ? clipTail(last.text, SUMMARY_TAIL_CHARS) : null,
          transcript_note: last ? undefined : NO_TRANSCRIPT_NOTE,
          latest_reply_ago: last ? formatAgo(env.now() - last.at) : undefined,
          earlier_reply: prev ? clipTail(prev.text, SUMMARY_PREV_CHARS) : undefined,
          note: prev
            ? 'latest_reply is the current state. earlier_reply is older context: anything it asked may already be answered or superseded.'
            : undefined,
        });
      }

      case 'propose_input':
        return await proposeInput(args, env, state);

      default:
        return err(`Unknown tool "${name}".`);
    }
  } catch (e) {
    console.error(`Herald: tool ${name} failed:`, e);
    return err(`Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function proposeInput(
  args: Record<string, unknown>,
  env: ToolEnv,
  state: TurnToolState
): Promise<ToolOutcome> {
  if (state.proposals.length >= MAX_PROPOSALS_PER_TURN) {
    return err(
      `At most ${MAX_PROPOSALS_PER_TURN} actions per request. Ask the user to handle the rest one at a time.`
    );
  }
  const r = await resolveFresh(env, String(args.session), state);
  if (!r.ok) return err(r.error);
  const s = r.session;
  if (s.inactive) return err(`${s.sessionName} is closed; nothing can be sent to it.`);
  const key = sessionKey(s);
  if (state.proposals.some((p) => p.sessionKey === key)) {
    return err(
      `You already proposed an action for ${s.sessionName} in this request. One action per session per request.`
    );
  }

  const optionRef = typeof args.option === 'string' ? args.option.trim() : '';
  const textRaw = typeof args.text === 'string' ? args.text : '';

  let kind: HeraldAction['kind'];
  let payload: string;
  let readback: string;
  let meta: Parameters<ActionManager['create']>[0]['meta'] = {};
  let pendingQuestion: string | null = null;
  let pendingOptions: PendingChoice['options'] | null = null;

  if (optionRef) {
    const c = s.pendingChoice;
    if (!c) {
      return err(
        `${s.sessionName} is not showing a multiple-choice prompt right now${s.pendingQuestion ? ' (it asked in plain text; use "text")' : ''}.`
      );
    }
    if (c.multiSelect) {
      return err(
        `${s.sessionName} is asking a multi-select question; tell the user to answer it in the app.`
      );
    }
    const o = resolveOption(optionRef, c.options);
    if (!o.ok) return err(o.error);
    const opt = c.options[o.index];
    kind = 'answer_choice';
    payload = opt.label;
    readback = `${s.sessionName}: option ${o.index + 1}, ${clip(oneLine(opt.label), 80)}`;
    meta = {
      choice: {
        index: o.index,
        optionCount: c.options.length,
        multiSelect: false,
        signature: c.signature,
      },
    };
    pendingQuestion = [c.header, c.question].filter(Boolean).join(': ');
    pendingOptions = c.options;
  } else {
    if (s.pendingChoice) {
      const list = s.pendingChoice.options
        .map((op, i) => `${i + 1}) ${clip(oneLine(op.label), 60)}`)
        .join('; ');
      return err(
        `${s.sessionName} is showing a multiple-choice prompt, so typed text cannot be sent. Use "option" with one of: ${list}. If none fits, ask the user.`
      );
    }
    // Strip control characters (keep newlines/tabs), collapse trailing whitespace.
    // eslint-disable-next-line no-control-regex
    payload = textRaw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (!payload) return err('The text to send is empty.');
    if (payload.length > MAX_INPUT_CHARS)
      return err(`The text is too long (max ${MAX_INPUT_CHARS} characters).`);
    kind = 'send_input';
    readback = `${s.sessionName}: "${clip(oneLine(payload), 100)}"`;
    if (s.pendingApproval) {
      pendingQuestion = `approve ${s.pendingApproval.tool}: ${s.pendingApproval.detail}`;
    } else {
      pendingQuestion = s.pendingQuestion;
    }
  }

  // Each member of a multi-session request is classified independently: safe ones
  // echo, dangerous ones hard-confirm. Nothing is escalated just for being batched.
  const verdict = classifyAction({
    userText: state.userText,
    payload,
    pendingQuestion,
    pendingOptions,
    sessionName: s.sessionName,
    project: s.projectPath,
    requestedConfirm: args.confirm === true,
  });

  // Supersede any older pending action aimed at the same session.
  for (const a of env.actions.list()) {
    if (a.status === 'pending' && a.serverId === s.serverId && a.sessionId === s.sessionId) {
      env.actions.cancel(a.id);
    }
  }

  const action = env.actions.create({
    tier: verdict.tier,
    reasons: verdict.reasons,
    kind,
    serverId: s.serverId,
    sessionId: s.sessionId,
    sessionName: s.sessionName,
    payload,
    readback,
    meta,
  });
  state.proposals.push({
    actionId: action.id,
    sessionKey: key,
    sessionName: s.sessionName,
    tier: action.tier,
  });

  const seconds = Math.round(env.echoDelayMs / 1000);
  const batch = state.proposals.length > 1 ? batchSplit(state) : undefined;
  return ok({
    action_id: action.id,
    tier: action.tier,
    readback: action.readback,
    reasons: action.reasons.length ? action.reasons : undefined,
    batch,
    instruction: batch
      ? `This request now covers ${state.proposals.length} sessions, each judged on its own. ` +
        `In one or two short sentences say which are going ahead automatically in about ${seconds} seconds unless cancelled` +
        `${batch.needs_confirmation.length ? ', and which are held back for on-screen confirmation and briefly why' : ''}. ` +
        'Never imply the held ones will send without the user confirming.'
      : action.tier === 'echo'
        ? `Read back in one short sentence what you are sending to ${s.sessionName}; it sends automatically in about ${seconds} seconds unless the user cancels.`
        : `This needs the user's explicit confirmation on screen; it will NOT be sent otherwise. Read it back, say briefly why it needs confirming, and ask them to confirm.`,
  });
}

/** Summarize this turn's proposals as the echo / hard-confirm split for the readback. */
function batchSplit(state: TurnToolState): {
  sending_automatically: string[];
  needs_confirmation: string[];
} {
  return {
    sending_automatically: state.proposals
      .filter((p) => p.tier === 'echo')
      .map((p) => p.sessionName),
    needs_confirmation: state.proposals
      .filter((p) => p.tier === 'hard_confirm')
      .map((p) => p.sessionName),
  };
}
