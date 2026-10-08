/**
 * Herald's brain tools: schemas, strict argument validation, and grounded executors.
 *
 * Every tool returns real session data (or a clear error). propose_input never
 * sends anything: it routes through the deterministic danger classifier and the
 * ActionManager, which owns confirmation and delivery.
 */

import type { LlmToolSpec } from './llm/provider';
import type { PendingChoice, SessionSnapshot, SessionSource } from './session-source';
import {
  HERALD_BABYSIT_LIMITS,
  type HeraldAction,
  type HeraldBabysit,
  type HeraldSessionRef,
  type HeraldShowResult,
} from './protocol';
import { deviceNotFoundLine, type DeviceAliasResult } from './device-alias';
import type { ActionManager } from './actions';
import {
  classifyAction,
  classifyCushCommand,
  classifyInterrupt,
  classifySpawn,
  findSelectedOption,
} from './danger';
import { cleanFirstPrompt, resolveSpawnDir, sessionsIn } from './spawn';
import type { HeraldToolbox } from './knowledge/toolbox';
import { cushCommandLine, cushReadback, CUSH_OPS, publicUrl } from './knowledge/cush';
import { MAX_QUERY_CHARS } from './knowledge/sources';
import { redactSecrets } from './knowledge/redact';
import type { StuckFinding, StuckKind } from '../stuck/protocol';
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

const QUERY_PROP = {
  type: 'string',
  description: 'What to look up, in a few keywords (e.g. "jellyfin port", "share file phone").',
  maxLength: MAX_QUERY_CHARS,
};

/** Read-only lookups over the user's own docs and tools. */
export const KNOWLEDGE_TOOL_SPECS: LlmToolSpec[] = [
  {
    name: 'search_infra',
    description:
      "Search the home server's infrastructure doc: ports and the port registry, which service runs where, HAProxy routing and subdomains, SSL certs, docker patterns, firewall, deployed apps. Returns the best matching sections.",
    parameters: {
      type: 'object',
      properties: { query: QUERY_PROP },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'cush_tools_help',
    description:
      'Search the docs for cush-tools, the user\'s own sharing toolkit: tunnels, serving a folder, file drops, pastes, receiving secrets, .env injection, status/extend/close. Use for any "how do I share / send / expose / receive" question.',
    parameters: {
      type: 'object',
      properties: { query: QUERY_PROP },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'cush_status',
    description:
      'List the cush-tools tunnels and shares running right now: name, type, public link, uptime, time left, and whether you opened it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_project_notes',
    description:
      "Search the user's project notes (each project's CLAUDE.md, plan.md, todo.md, FEATURES.md, README.md): how a project is built, deployed or configured, what is planned or done.",
    parameters: {
      type: 'object',
      properties: {
        query: QUERY_PROP,
        project: {
          type: 'string',
          description: 'Optional project (folder) name to search first, e.g. "companion".',
          maxLength: 80,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_memory',
    description:
      "Search the persistent memory notes the user's coding sessions keep: setup facts, gotchas, deploy mechanics, how things were fixed, where machines live.",
    parameters: {
      type: 'object',
      properties: { query: QUERY_PROP },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_cush_command',
    description:
      'Propose a cush-tools command. It does NOT run immediately: extending or closing a share you opened runs after a short delay; everything that makes something public waits for on-screen confirmation. ' +
      'Operations: "extend" (name) keeps a share open another hour; "close" (name) shuts one; "serve" (name, dir) shares a folder; "tunnel" (name, port) exposes a local port; "drop" (name) opens an upload page. ' +
      'Nothing else is possible (no secrets, deploys, certificates or permanent exposure). The name becomes the link: 2 to 32 lowercase letters, digits or hyphens.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...CUSH_OPS], maxLength: 20 },
        name: { type: 'string', description: 'Share name, e.g. "phone-share".', maxLength: 40 },
        dir: {
          type: 'string',
          description:
            'serve only: full path of the folder to share. Projects live in ~/local/src/<project> (e.g. ~/local/src/companion/web/dist). Never guess: take it from the project notes or ask.',
          maxLength: 500,
        },
        port: { type: 'integer', description: 'tunnel only: local port number.' },
        confirm: {
          type: 'boolean',
          description: 'Set true if you are at all unsure; forces an explicit confirmation.',
        },
      },
      required: ['operation', 'name'],
      additionalProperties: false,
    },
  },
];

TOOL_SPECS.push(...KNOWLEDGE_TOOL_SPECS);

/** Session control: stop a running turn, start a new session. */
export const SESSION_CONTROL_TOOL_SPECS: LlmToolSpec[] = [
  {
    name: 'propose_interrupt',
    description:
      'Propose interrupting a session that is running (Ctrl+C: stops its current turn, keeps the session). Only when the user asks to stop, cancel, interrupt or kill what a session is doing. ' +
      'It does NOT happen immediately: it runs after a short countdown unless the user cancels.',
    parameters: {
      type: 'object',
      properties: {
        session: SESSION_PROP,
        confirm: {
          type: 'boolean',
          description: 'Set true if you are at all unsure; forces an explicit confirmation.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_spawn_session',
    description:
      'Propose starting a NEW Claude Code session in a project folder with a first prompt. Only when the user explicitly asks to start, open or spin up a new session. ' +
      'It never starts without the user confirming (on the card, or by saying the confirm phrase). The session runs with permissions bypassed.',
    parameters: {
      type: 'object',
      properties: {
        project_or_dir: {
          type: 'string',
          description:
            'Project folder name as the user said it (e.g. "companion"), or a path under ~/local/src. Never guess: ask if unsure.',
          maxLength: 300,
        },
        first_prompt: {
          type: 'string',
          description: "The first instruction for the new session, in the user's words.",
          maxLength: 2000,
        },
        confirm: {
          type: 'boolean',
          description: 'Unused: starting a session always needs confirmation.',
        },
      },
      required: ['project_or_dir', 'first_prompt'],
      additionalProperties: false,
    },
  },
];

TOOL_SPECS.push(...SESSION_CONTROL_TOOL_SPECS);

export const VERBOSITY_TOOL_LEVELS = ['brief', 'normal', 'detailed', 'auto'] as const;

TOOL_SPECS.push({
  name: 'set_verbosity',
  description:
    'Change how long your replies are FROM NOW ON, only when the user asks for a lasting change ("keep it short from now on", "you can be more detailed", "back to normal"). ' +
    'Not for a one-off request about a single answer. brief = one or two sentences; normal = a few sentences; detailed = fuller answers; auto = brief when spoken, normal when typed (the default).',
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: [...VERBOSITY_TOOL_LEVELS], maxLength: 10 },
    },
    required: ['level'],
    additionalProperties: false,
  },
});

TOOL_SPECS.push({
  name: 'show_session',
  description:
    "Open a session's view on the user's active device, or on the device they named (their screen jumps to it, scrolled to any question or choice waiting there). " +
    'When the user asks to see, open, pull up or be taken to a session ("pull up whatever Out4 is stuck on", "show me the deploy session on my PC"). ' +
    'Nothing is sent to the session. Then say in a few words what is on screen, e.g. "Here\'s Out4, it\'s asking which branch."',
  parameters: {
    type: 'object',
    properties: {
      session: SESSION_PROP,
      device: {
        type: 'string',
        description:
          'The device the user named, in their words ("my PC", "the phone", "Mac", "here"). Omit when they named none.',
        maxLength: 60,
      },
    },
    required: ['session'],
    additionalProperties: false,
  },
});

export const REVIEW_SCOPES = ['since_last_look', 'last_turn', 'all'] as const;

TOOL_SPECS.push({
  name: 'review_changes',
  description:
    "What a session changed in code: its recent turns as one-line summaries, files with +/- line counts, risk flags (CI, migrations, secrets, deletions, config...) and how much the user has not reviewed yet. Use for 'what did Out4 change?', 'anything risky in X?', 'did X touch the deploy script?'. Report counts and at most three file names, risky ones first. Never mention changes that are not listed.",
  parameters: {
    type: 'object',
    properties: {
      session: SESSION_PROP,
      scope: { type: 'string', enum: [...REVIEW_SCOPES] },
    },
    required: ['session'],
    additionalProperties: false,
  },
});

TOOL_SPECS.push({
  name: 'stuck_sessions',
  description:
    "Which working sessions look stuck, and on what: the same test or error failing again and again, the same command repeated with no change, an edit undone and redone, no progress for a long time, or a command hanging. Use for 'is anything stuck?', 'what's Out4 stuck on?'. Omit session for all. Say it plainly in one sentence per session; never add causes it does not list.",
  parameters: {
    type: 'object',
    properties: {
      session: { ...SESSION_PROP, description: 'Only this session (optional).' },
    },
    required: [],
    additionalProperties: false,
  },
});

TOOL_SPECS.push({
  name: 'snooze_stuck',
  description:
    "Stop flagging a session as stuck for a while, when the user says to ignore it ('ignore that for 30 minutes', 'it's fine, leave Out4 alone'). minutes 0 lifts a snooze. Nothing is sent to the session.",
  parameters: {
    type: 'object',
    properties: {
      session: SESSION_PROP,
      minutes: { type: 'integer', description: 'How long, in minutes (default 30, at most 1440).' },
    },
    required: ['session'],
    additionalProperties: false,
  },
});

/**
 * Session babysitter. Static specs (the prompt prefix stays cacheable): live
 * brief state reaches the brain through the fleet snapshot and babysit_status.
 */
export const BABYSIT_TOOL_SPECS: LlmToolSpec[] = [
  {
    name: 'propose_babysit',
    description:
      'Propose babysitting one session: a standing brief under which you answer its simple questions yourself ("want me to continue?", and choices the brief clearly settles), bring every real judgment call to the user with a suggested answer, and never answer permission prompts or anything risky. ' +
      'Only when the user asks for it ("babysit Out4 until it is production ready", "keep Docs going, prefer the simple fix"). It never starts without the user confirming on the card or saying the confirm phrase. ' +
      "Put the user's goal and leanings in their own words; add nothing they did not say.",
    parameters: {
      type: 'object',
      properties: {
        session: SESSION_PROP,
        goal: {
          type: 'string',
          description: "What the session should get done, in the user's words.",
          maxLength: HERALD_BABYSIT_LIMITS.maxGoalChars,
        },
        direction: {
          type: 'string',
          description:
            'Which way to lean when it offers a choice, if the user said ("prefer the smaller change", "keep the existing API").',
          maxLength: HERALD_BABYSIT_LIMITS.maxDirectionChars,
        },
        never: {
          type: 'string',
          description:
            'Things the user said you must never decide ("anything about pricing", "the database schema").',
          maxLength: HERALD_BABYSIT_LIMITS.maxNeverChars,
        },
        minutes: {
          type: 'integer',
          description: 'Time limit in minutes if the user gave one (default 120, at most 480).',
        },
        max_answers: {
          type: 'integer',
          description:
            'How many answers you may send if the user gave a number (default 20, at most 50).',
        },
      },
      required: ['session', 'goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_babysit',
    description:
      'Stop babysitting a session at once ("stop babysitting Out4", "I\'ll take Docs from here"). Omit session to stop every brief. Nothing is sent to the session.',
    parameters: {
      type: 'object',
      properties: { session: { ...SESSION_PROP, description: 'Only this session (optional).' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'babysit_status',
    description:
      'What you are babysitting: each brief with its goal, answers sent, questions brought to the user, time left and the last few things you answered. Use for "what are you babysitting?", "what did you tell Out4?".',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

TOOL_SPECS.push(...BABYSIT_TOOL_SPECS);

/** Tools that create an action: never executed in an iteration with malformed calls. */
export const ACTION_TOOLS = new Set([
  'propose_babysit',
  'propose_input',
  'propose_cush_command',
  'propose_interrupt',
  'propose_spawn_session',
]);

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
    } else if (prop.type === 'integer') {
      if (typeof v === 'string' && /^\s*\d{1,6}\s*$/.test(v)) v = Number(v);
      if (typeof v !== 'number' || !Number.isInteger(v))
        return { ok: false, error: `Argument "${key}" for ${name} must be a whole number.` };
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
    case 'babysit_status':
      return '{}';
    case 'propose_babysit':
      return '{"session": "Out4", "goal": "get the release build passing"}';
    case 'propose_input':
      return '{"session": "companion", "option": "2"}';
    case 'cush_status':
      return '{}';
    case 'search_project_notes':
      return '{"query": "deploy", "project": "companion"}';
    case 'search_infra':
    case 'cush_tools_help':
    case 'search_memory':
      return '{"query": "jellyfin port"}';
    case 'propose_cush_command':
      return '{"operation": "serve", "name": "phone-share", "dir": "~/local/src/<project>/dist"}';
    case 'set_verbosity':
      return '{"level": "brief"}';
    case 'propose_spawn_session':
      return '{"project_or_dir": "companion", "first_prompt": "run the tests and tell me what fails"}';
    case 'review_changes':
      return '{"session": "Out4", "scope": "since_last_look"}';
    case 'stuck_sessions':
      return '{"session": "Out4"}';
    case 'snooze_stuck':
      return '{"session": "Out4", "minutes": 30}';
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
    confirmPhrase?: string;
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
  /** Knowledge lookups + cush-tools. Absent = those tools report unavailable. */
  toolbox?: HeraldToolbox;
  /** Persist the reply-length setting. Absent = set_verbosity reports unavailable. */
  setVerbosity?: (level: (typeof VERBOSITY_TOOL_LEVELS)[number]) => void;
  /** Where new sessions may start. Absent = propose_spawn_session reports unavailable. */
  spawn?: { roots: string[]; userHome: string };
  /** Open a session on the active device. Absent = show_session reports unavailable. */
  showSession?: (s: SessionSnapshot, deviceId?: string) => HeraldShowResult;
  /** The device the user's words name ("my PC"), from the device that asked. */
  resolveDevice?: (phrase: string) => DeviceAliasResult;
  /** Stuck detection. Absent = stuck_sessions / snooze_stuck report unavailable. */
  stuck?: {
    list(sessionId?: string): StuckFinding[];
    snooze(sessionId: string, kind: StuckKind | undefined, minutes: number): number;
  };
  /** Session babysitter. Absent = the babysit tools report unavailable. */
  babysit?: {
    list(): HeraldBabysit[];
    /** Stop one session's brief (`serverId:sessionId`), or all (null). Returns what stopped. */
    stop(sessionKey: string | null): HeraldBabysit[];
  };
  /** Code Review digests. Absent = review_changes reports unavailable. */
  review?: {
    digest(sessionId: string, scope: (typeof REVIEW_SCOPES)[number]): Promise<object | null>;
  };
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

const ok = (data: unknown): ToolOutcome => ({ content: JSON.stringify(data), isError: false });
/** For results built from files or subprocess output: redacted once more on the way out. */
const safeOk = (data: unknown): ToolOutcome => ({
  content: redactSecrets(JSON.stringify(data)),
  isError: false,
});
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

      case 'search_infra':
      case 'cush_tools_help':
      case 'search_project_notes':
      case 'search_memory': {
        if (!env.toolbox) return err('Knowledge lookups are not available on this server.');
        const kb = env.toolbox.knowledge;
        const q = oneLine(String(args.query || ''));
        const r =
          name === 'search_infra'
            ? await kb.searchInfra(q)
            : name === 'cush_tools_help'
              ? await kb.cushToolsHelp(q)
              : name === 'search_memory'
                ? await kb.searchMemory(q)
                : await kb.searchProjectNotes(
                    q,
                    typeof args.project === 'string' ? args.project : undefined
                  );
        return safeOk({
          ...r,
          instruction: r.found
            ? 'Answer only from these sections, in plain spoken words. If they do not actually answer the question, say you could not find it.'
            : undefined,
        });
      }

      case 'cush_status': {
        if (!env.toolbox) return err('cush-tools status is not available on this server.');
        const st = await env.toolbox.cushStatus();
        if (!st.ok) return err(`Could not read the cush-tools status: ${st.error}`);
        const mine = env.toolbox.openedByHerald();
        return safeOk({
          tunnel_server: st.server,
          active: st.tools.map((t) => ({
            name: t.name,
            type: t.type,
            link: t.url,
            up_for: t.uptime,
            time_left: t.expires ?? (t.managed ? undefined : 'unmanaged, no timer'),
            opened_by_you: mine.has(t.name) || undefined,
          })),
          note: st.tools.length
            ? 'Say names and what they share; the links are visible to the user already, do not read them out.'
            : 'Nothing is running.',
        });
      }

      case 'propose_cush_command':
        return await proposeCush(args, env, state);

      case 'propose_interrupt':
        return await proposeInterrupt(args, env, state);

      case 'propose_babysit':
        return await proposeBabysit(args, env, state);

      case 'stop_babysit': {
        if (!env.babysit) return err('Babysitting is not available on this server.');
        let key: string | null = null;
        let name = '';
        if (typeof args.session === 'string' && args.session.trim()) {
          const r = await resolveFresh(env, args.session, state);
          if (!r.ok) return err(r.error);
          key = sessionKey(r.session);
          name = r.session.sessionName;
        }
        const stopped = env.babysit.stop(key);
        if (!stopped.length)
          return ok({
            stopped: [],
            instruction: name
              ? `You were not babysitting ${name}. Say so in a few words.`
              : 'You were not babysitting anything. Say so in a few words.',
          });
        return ok({
          stopped: stopped.map((b) => ({ session: b.sessionName, answers_sent: b.answersUsed })),
          instruction:
            'Stopped: you answer nothing more for these sessions. Confirm in a few words, e.g. "Okay, Out4 is yours again."',
        });
      }

      case 'babysit_status': {
        if (!env.babysit) return err('Babysitting is not available on this server.');
        const now = env.now();
        const list = env.babysit.list();
        for (const b of list)
          state.sessionRefs.set(sessionKey(b), {
            serverId: b.serverId,
            sessionId: b.sessionId,
            sessionName: b.sessionName,
          });
        const view = (b: HeraldBabysit) => ({
          session: b.sessionName,
          goal: clip(oneLine(b.goal), 200),
          direction: b.direction ? clip(oneLine(b.direction), 200) : undefined,
          never_decide: b.never ? clip(oneLine(b.never), 200) : undefined,
          answers_sent: `${b.answersUsed} of ${b.maxAnswers}`,
          brought_to_user: b.escalations,
          time_left: b.status === 'active' ? formatAgo(Math.max(0, b.expiresAt - now)) : undefined,
          ended: b.status === 'ended' ? b.endReason : undefined,
          suggests_only: b.autoSend === false || undefined,
          recent: b.log.slice(-4).map((e) => ({
            what:
              e.kind === 'answered'
                ? 'you answered'
                : e.kind === 'user'
                  ? 'the user answered'
                  : e.kind === 'done'
                    ? 'goal reported done'
                    : 'brought to the user',
            asked: clip(oneLine(e.question), 160),
            answer: e.answer ? clip(oneLine(e.answer), 120) : undefined,
            ago: formatAgo(now - e.at),
          })),
        });
        const active = list.filter((b) => b.status === 'active');
        return safeOk({
          babysitting: active.map(view),
          recently_ended: list.filter((b) => b.status === 'ended').map(view),
          instruction: active.length
            ? 'One short sentence per session: what it is working toward and how many answers you have sent. Mention an answer only if asked.'
            : 'You are not babysitting anything right now. Say so in a few words.',
        });
      }

      case 'propose_spawn_session':
        return await proposeSpawn(args, env, state);

      case 'set_verbosity': {
        const level = String(args.level || '').toLowerCase();
        const valid = (VERBOSITY_TOOL_LEVELS as readonly string[]).includes(level);
        if (!valid) return err(`level must be one of: ${VERBOSITY_TOOL_LEVELS.join(', ')}.`);
        if (!env.setVerbosity) return err('Changing reply length is not available here.');
        env.setVerbosity(level as (typeof VERBOSITY_TOOL_LEVELS)[number]);
        return ok({
          ok: true,
          level,
          instruction: 'Saved. Confirm in a few words, e.g. "Okay, I\'ll keep it short."',
        });
      }

      case 'review_changes': {
        const scope = (args.scope === undefined ? 'since_last_look' : String(args.scope)) as
          | (typeof REVIEW_SCOPES)[number]
          | string;
        if (!(REVIEW_SCOPES as readonly string[]).includes(scope))
          return err(`scope must be one of: ${REVIEW_SCOPES.join(', ')}.`);
        if (!env.review) return err('Code review is not available on this server.');
        const r = await resolveFresh(env, String(args.session), state);
        if (!r.ok) return err(r.error);
        const s = r.session;
        if (s.serverId !== 'local')
          return err(
            `I can only review code changes for sessions on this machine for now; ${s.sessionName} is on another server.`
          );
        const digest = await env.review.digest(
          s.sessionId,
          scope as (typeof REVIEW_SCOPES)[number]
        );
        if (!digest) return err(`No code changes are known for ${s.sessionName}.`);
        return safeOk(digest);
      }

      case 'stuck_sessions': {
        if (!env.stuck) return err('Stuck detection is not available on this server.');
        let only: SessionSnapshot | null = null;
        if (typeof args.session === 'string' && args.session.trim()) {
          const r = await resolveFresh(env, args.session, state);
          if (!r.ok) return err(r.error);
          only = r.session;
          if (only.serverId !== 'local')
            return err(
              `I can only tell for sessions on this machine for now; ${only.sessionName} is on another server.`
            );
        }
        const now = env.now();
        const findings = env.stuck.list(only?.sessionId);
        const bySession = new Map<string, StuckFinding[]>();
        for (const f of findings)
          bySession.set(f.sessionId, [...(bySession.get(f.sessionId) || []), f]);
        for (const list of bySession.values()) {
          const f = list[0];
          state.sessionRefs.set(`local:${f.sessionId}`, {
            serverId: 'local',
            sessionId: f.sessionId,
            sessionName: f.sessionName,
          });
        }
        const stuck = Array.from(bySession.values()).map((list) => ({
          session: list[0].sessionName,
          signals: list.slice(0, 3).map((f) => ({
            what: f.summary,
            since: `${formatAgo(now - f.firstSeen)} ago`,
            evidence: f.evidence.slice(0, 2),
          })),
        }));
        if (!stuck.length)
          return safeOk({
            stuck: [],
            instruction: only
              ? `${only.sessionName} does not look stuck. Say so in a few words${only.status === 'working' ? '; it is still working' : ''}.`
              : 'Nothing looks stuck. Say so in a few words.',
          });
        return safeOk({
          stuck,
          instruction:
            'One plain sentence per session from "what" (e.g. "Out4 looks stuck: the same test failed 6 times in 18 minutes."). Then offer, in a few words, to ask it what is going on, interrupt it, show it, or ignore it for a while. Never act without the user asking: asking = propose_input with a short question, interrupting = propose_interrupt, showing = show_session, ignoring = snooze_stuck.',
        });
      }

      case 'snooze_stuck': {
        if (!env.stuck) return err('Stuck detection is not available on this server.');
        const r = await resolveFresh(env, String(args.session), state);
        if (!r.ok) return err(r.error);
        const s = r.session;
        if (s.serverId !== 'local')
          return err(
            `I can only do that for sessions on this machine for now; ${s.sessionName} is on another server.`
          );
        const minutes =
          typeof args.minutes === 'number' ? Math.max(0, Math.min(1440, args.minutes)) : 30;
        const until = env.stuck.snooze(s.sessionId, undefined, minutes);
        return ok({
          ok: true,
          session: s.sessionName,
          snoozed_minutes: until ? minutes : 0,
          instruction: until
            ? `Done. Confirm in a few words, e.g. "Okay, I'll leave ${s.sessionName} alone for ${minutes} minutes."`
            : `Done: ${s.sessionName} can be flagged as stuck again. Confirm in a few words.`,
        });
      }

      case 'show_session': {
        // The named device first: never quietly show it somewhere else.
        const phrase = typeof args.device === 'string' ? oneLine(args.device).slice(0, 60) : '';
        let deviceId: string | undefined;
        if (phrase && env.resolveDevice) {
          const d = env.resolveDevice(phrase);
          if (d.kind === 'none') {
            return err(
              `${deviceNotFoundLine(d.noun)} Tell the user exactly that in one short sentence; do not show it on another device.`
            );
          }
          if (d.kind === 'ambiguous') {
            const labels = d.devices.map((x) => x.label);
            return err(
              `Several connected devices match "${phrase}": ${labels.join(', ')}. Ask which one in a few words ("Which one, ${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}?"); do not show it yet.`
            );
          }
          deviceId = d.id || undefined;
        }
        const r = await resolveFresh(env, String(args.session), state);
        if (!r.ok) return err(r.error);
        const s = r.session;
        if (!env.showSession) return err('Opening sessions on a screen is not available here.');
        const shown = env.showSession(s, deviceId);
        if (shown.status !== 'shown') {
          return err(
            shown.status === 'no_device'
              ? 'No device is open to show it on. Tell the user to open Companion first.'
              : `Could not show ${s.sessionName} (${shown.status}).`
          );
        }
        state.sessionRefs.set(sessionKey(s), {
          serverId: s.serverId,
          sessionId: s.sessionId,
          sessionName: s.sessionName,
        });
        const choice = s.pendingChoice ? describeChoice(s.pendingChoice) : undefined;
        return ok({
          shown: s.sessionName,
          on: shown.device?.label,
          waiting_on_user:
            choice ?? (s.pendingQuestion ? clip(oneLine(s.pendingQuestion), 300) : undefined),
          instruction:
            'It is on their screen now. Confirm in a few words ("Here\'s ' +
            s.sessionName +
            '.") and, if something is waiting on them, name it in one short sentence. Do not read the screen out.',
        });
      }

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
    meta: { ...meta, userText: state.userText, ruleIds: verdict.ruleIds },
  });
  state.proposals.push({
    actionId: action.id,
    sessionKey: key,
    sessionName: s.sessionName,
    tier: action.tier,
    confirmPhrase: action.confirmPhrase,
  });

  const seconds = Math.round(env.echoDelayMs / 1000);
  const batch = state.proposals.length > 1 ? batchSplit(state) : undefined;
  return ok({
    action_id: action.id,
    tier: action.tier,
    readback: action.readback,
    reasons: action.reasons.length ? action.reasons : undefined,
    confirm_phrase: action.confirmPhrase,
    batch,
    confirm_phrases: batch ? batchPhrases(state) : undefined,
    instruction: batch
      ? `This request now covers ${state.proposals.length} sessions, each judged on its own. ` +
        `In one or two short sentences say which are going ahead automatically in about ${seconds} seconds unless cancelled` +
        `${batch.needs_confirmation.length ? ', and which are held back for on-screen confirmation, briefly why, and the words that confirm each (confirm_phrases; quote each mid-sentence followed by "to go ahead")' : ''}. ` +
        'Never imply the held ones will send without the user confirming.'
      : action.tier === 'echo'
        ? `Read back in one short sentence what you are sending to ${s.sessionName}; it sends automatically in about ${seconds} seconds unless the user cancels.`
        : hardConfirmInstruction(action.confirmPhrase),
  });
}

/**
 * How Herald asks for a hard confirmation. The phrase is quoted mid-sentence and
 * never last ("say 'confirm deploy' to go ahead"), so a recording that starts
 * late in Herald's own sentence can never contain exactly the phrase.
 */
function hardConfirmInstruction(phrase: string | undefined): string {
  const how = phrase
    ? `They confirm by holding the card or by saying "${phrase}". Ask in this shape: "That's a deploy to prod — say '${phrase}' to go ahead." Quote the phrase exactly, mid-sentence, followed by "to go ahead"; never end your reply with the phrase.`
    : 'They confirm on the card.';
  return `Nothing has been sent; it waits for the user's explicit confirmation. In one or two short sentences say what it is and briefly why it needs confirming. ${how} A plain "yes" does not confirm it.`;
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

/** Held-back members' voice-confirm words, by session. */
function batchPhrases(state: TurnToolState): Record<string, string> | undefined {
  const held = state.proposals.filter((p) => p.tier === 'hard_confirm' && p.confirmPhrase);
  if (!held.length) return undefined;
  return Object.fromEntries(held.map((p) => [p.sessionName, p.confirmPhrase as string]));
}

async function proposeBabysit(
  args: Record<string, unknown>,
  env: ToolEnv,
  state: TurnToolState
): Promise<ToolOutcome> {
  if (!env.babysit) return err('Babysitting is not available on this server.');
  if (state.proposals.length >= MAX_PROPOSALS_PER_TURN) {
    return err(
      `At most ${MAX_PROPOSALS_PER_TURN} actions per request. Ask the user to handle the rest one at a time.`
    );
  }
  const r = await resolveFresh(env, String(args.session), state);
  if (!r.ok) return err(r.error);
  const s = r.session;
  if (s.inactive) return err(`${s.sessionName} is closed; there is nothing to babysit.`);
  const key = sessionKey(s);
  if (state.proposals.some((p) => p.sessionKey === key)) {
    return err(
      `You already proposed an action for ${s.sessionName} in this request. One action per session per request.`
    );
  }
  const L = HERALD_BABYSIT_LIMITS;
  const text = (v: unknown) => (typeof v === 'string' ? oneLine(v) : '');
  const goal = text(args.goal);
  if (goal.length < L.minGoalChars)
    return err('The goal is missing. Ask the user what the session should get done.');
  const direction = text(args.direction);
  const never = text(args.never);
  const int = (v: unknown, def: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
  const minutes = int(args.minutes, L.defaultMinutes, L.minMinutes, L.maxMinutes);
  const maxAnswers = int(args.max_answers, L.defaultMaxAnswers, 1, L.maxMaxAnswers);
  const editing = env.babysit.list().some((b) => b.status === 'active' && sessionKey(b) === key);
  // One pending start per session: a re-worded goal replaces the older card.
  for (const a of env.actions.list()) {
    if (
      a.status === 'pending' &&
      a.kind === 'babysit_start' &&
      a.serverId === s.serverId &&
      a.sessionId === s.sessionId
    )
      env.actions.cancel(a.id);
  }
  const span =
    minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`;
  const action = env.actions.create({
    // Always confirmed: a misheard goal must never start answering a session.
    tier: 'hard_confirm',
    reasons: [
      `I would answer ${s.sessionName}'s simple questions for you (up to ${maxAnswers}, for ${span})`,
      ...(direction ? [`Lean: ${clip(direction, 160)}`] : []),
      ...(never ? [`Never decide: ${clip(never, 160)}`] : []),
    ],
    kind: 'babysit_start',
    serverId: s.serverId,
    sessionId: s.sessionId,
    sessionName: s.sessionName,
    payload: goal,
    readback: `${editing ? 'Update babysitting' : 'Babysit'} ${s.sessionName}: "${clip(goal, 100)}"`,
    meta: {
      babysit: {
        serverId: s.serverId,
        sessionId: s.sessionId,
        sessionName: s.sessionName,
        goal,
        ...(direction ? { direction } : {}),
        ...(never ? { never } : {}),
        minutes,
        maxAnswers,
      },
      userText: state.userText,
    },
  });
  state.proposals.push({
    actionId: action.id,
    sessionKey: key,
    sessionName: s.sessionName,
    tier: action.tier,
    confirmPhrase: action.confirmPhrase,
  });
  return ok({
    action_id: action.id,
    tier: action.tier,
    readback: action.readback,
    time_limit: span,
    max_answers: maxAnswers,
    confirm_phrase: action.confirmPhrase,
    instruction:
      `Nothing has started. In one or two short sentences read the goal back and say you would answer its simple questions, for ${span} at most, and bring anything else to them. ` +
      (action.confirmPhrase
        ? `They confirm by holding the card or by saying "${action.confirmPhrase}": say "say '${action.confirmPhrase}' to go ahead" (phrase mid-sentence, never last). A plain "yes" does not confirm it.`
        : 'They confirm on the card.'),
  });
}

async function proposeInterrupt(
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
  if (s.inactive) return err(`${s.sessionName} is closed; there is nothing to interrupt.`);
  if (s.status === 'idle')
    return err(
      `${s.sessionName} is not running anything right now, so there is nothing to interrupt. Tell the user that.`
    );
  const key = sessionKey(s);
  if (state.proposals.some((p) => p.sessionKey === key)) {
    return err(
      `You already proposed an action for ${s.sessionName} in this request. One action per session per request.`
    );
  }
  const verdict = classifyInterrupt({ requestedConfirm: args.confirm === true });
  // A second pending interrupt for the same session would be a double Ctrl+C (exits Claude).
  for (const a of env.actions.list()) {
    if (
      a.status === 'pending' &&
      a.kind === 'interrupt' &&
      a.serverId === s.serverId &&
      a.sessionId === s.sessionId
    )
      env.actions.cancel(a.id);
  }
  const action = env.actions.create({
    tier: verdict.tier,
    reasons: verdict.reasons,
    kind: 'interrupt',
    serverId: s.serverId,
    sessionId: s.sessionId,
    sessionName: s.sessionName,
    payload: 'Ctrl+C',
    readback: `Interrupting ${s.sessionName}`,
    meta: { userText: state.userText, ruleIds: verdict.ruleIds },
  });
  state.proposals.push({
    actionId: action.id,
    sessionKey: key,
    sessionName: s.sessionName,
    tier: action.tier,
    confirmPhrase: action.confirmPhrase,
  });
  const seconds = Math.round(env.echoDelayMs / 1000);
  return ok({
    action_id: action.id,
    tier: action.tier,
    readback: action.readback,
    confirm_phrase: action.confirmPhrase,
    instruction:
      action.tier === 'echo'
        ? `Say just "Interrupting ${s.sessionName}." It happens in about ${seconds} seconds unless the user cancels; it stops the current turn and keeps the session.`
        : hardConfirmInstruction(action.confirmPhrase),
  });
}

async function proposeSpawn(
  args: Record<string, unknown>,
  env: ToolEnv,
  state: TurnToolState
): Promise<ToolOutcome> {
  if (!env.spawn) return err('Starting new sessions is not available on this server.');
  if (state.proposals.length >= MAX_PROPOSALS_PER_TURN) {
    return err(
      `At most ${MAX_PROPOSALS_PER_TURN} actions per request. Ask the user to handle the rest one at a time.`
    );
  }
  const where = resolveSpawnDir(
    String(args.project_or_dir || ''),
    env.spawn.roots,
    env.spawn.userHome
  );
  if (!where.ok) return err(where.error);
  const prompt = cleanFirstPrompt(args.first_prompt);
  if (!prompt.ok) return err(prompt.error);
  const key = `spawn:${where.dir}`;
  if (state.proposals.some((p) => p.sessionKey === key))
    return err(`You already proposed a new session in ${where.name} in this request.`);
  const verdict = classifySpawn({
    dir: where.dir,
    userText: state.userText,
    firstPrompt: prompt.prompt,
  });
  let already: SessionSnapshot[] = [];
  try {
    already = sessionsIn(where.dir, await env.listSessions());
  } catch {
    already = [];
  }
  if (already.length)
    verdict.reasons.push(
      `${already.map((x) => x.sessionName).join(', ')} already ${already.length === 1 ? 'runs' : 'run'} in this folder`
    );
  for (const a of env.actions.list()) {
    if (a.status === 'pending' && a.kind === 'spawn_session' && a.sessionId === key)
      env.actions.cancel(a.id);
  }
  const action = env.actions.create({
    tier: 'hard_confirm',
    reasons: verdict.reasons,
    kind: 'spawn_session',
    serverId: 'local',
    sessionId: key,
    sessionName: where.name,
    payload: prompt.prompt,
    readback: `New session in ${where.name}: "${clip(oneLine(prompt.prompt), 100)}"`,
    meta: {
      spawn: { dir: where.dir, firstPrompt: prompt.prompt, name: where.name },
      userText: state.userText,
      ruleIds: verdict.ruleIds,
    },
  });
  state.proposals.push({
    actionId: action.id,
    sessionKey: key,
    sessionName: where.name,
    tier: action.tier,
    confirmPhrase: action.confirmPhrase,
  });
  return ok({
    action_id: action.id,
    tier: action.tier,
    folder: where.name,
    readback: action.readback,
    reasons: action.reasons,
    confirm_phrase: action.confirmPhrase,
    instruction:
      `Nothing has started. ${hardConfirmInstruction(action.confirmPhrase)} ` +
      'Once it starts, its first prompt is sent and you will report back what it says.',
  });
}

async function proposeCush(
  args: Record<string, unknown>,
  env: ToolEnv,
  state: TurnToolState
): Promise<ToolOutcome> {
  if (!env.toolbox) return err('cush-tools commands are not available on this server.');
  if (state.proposals.length >= MAX_PROPOSALS_PER_TURN) {
    return err(
      `At most ${MAX_PROPOSALS_PER_TURN} actions per request. Ask the user to handle the rest one at a time.`
    );
  }
  const v = await env.toolbox.validateCush({
    operation: args.operation,
    name: args.name,
    dir: args.dir,
    port: args.port,
  });
  if (!v.ok) return err(v.error);
  const { cmd, facts } = v;
  const key = `cush:${cmd.name}`;
  if (state.proposals.some((p) => p.sessionKey === key)) {
    return err(`You already proposed a command for ${cmd.name} in this request.`);
  }
  const verdict = classifyCushCommand({
    op: cmd.op,
    name: cmd.name,
    openedByHerald: facts.openedByHerald,
    exposure: facts.exposure,
    port: cmd.port,
    warnings: facts.warnings,
    requestedConfirm: args.confirm === true,
  });
  // Supersede an older pending command for the same share name.
  for (const a of env.actions.list()) {
    if (a.status === 'pending' && a.kind === 'cush_command' && a.sessionId === key) {
      env.actions.cancel(a.id);
    }
  }
  const action = env.actions.create({
    tier: verdict.tier,
    reasons: verdict.reasons,
    kind: 'cush_command',
    serverId: 'local',
    sessionId: key,
    sessionName: 'cush-tools',
    payload: cushCommandLine(cmd),
    readback: cushReadback(cmd, facts),
    meta: { cush: cmd },
  });
  state.proposals.push({
    actionId: action.id,
    sessionKey: key,
    sessionName: cmd.name,
    tier: action.tier,
  });
  const seconds = Math.round(env.echoDelayMs / 1000);
  return ok({
    action_id: action.id,
    tier: action.tier,
    readback: action.readback,
    confirm_phrase: action.confirmPhrase,
    link: cmd.op === 'extend' || cmd.op === 'close' ? undefined : publicUrl(cmd.name),
    reasons: action.reasons.length ? action.reasons : undefined,
    instruction:
      action.tier === 'echo'
        ? `Say in one short sentence what will happen; it runs automatically in about ${seconds} seconds unless the user cancels.`
        : `Nothing has run. In one or two short sentences say what it would make public. ${
            action.confirmPhrase
              ? `They confirm on the card or by saying "${action.confirmPhrase}": say "say '${action.confirmPhrase}' to go ahead" (phrase mid-sentence, never last).`
              : 'Ask them to confirm on the card.'
          } Do not read the link out.`,
  });
}
