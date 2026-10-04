/**
 * The setup wizard's state machine (pure) and a thin client for the daemon's
 * setup API (daemon/src/handlers/setup.ts).
 *
 *   server mode: every step; used on a daemon in setup mode, and when the
 *                wizard is re-run from Settings > Setup.
 *   device mode: a new device joining an already set-up server: pair, then
 *                this device's notifications and Herald device check.
 *
 * Steps already done or skipped (marks, from the daemon) are passed over when
 * moving forward, but any step can be revisited from the progress rail.
 */
import type { SetupStepId, SetupStepState } from '../types/setup';
import { SETUP_STEPS } from '../types/setup';
import { connectionManager } from './ConnectionManager';

export type WizardMode = 'server' | 'device';
export type Marks = Partial<Record<SetupStepId, SetupStepState>>;

export const SERVER_FLOW: SetupStepId[] = SETUP_STEPS;
export const DEVICE_FLOW: SetupStepId[] = ['welcome', 'pair', 'notifications', 'herald', 'done'];

/** Mirrors the daemon's SKIPPABLE_STEPS. */
export const SKIPPABLE: ReadonlySet<SetupStepId> = new Set<SetupStepId>([
  'machine',
  'claude',
  'projects',
  'session',
  'devices',
  'notifications',
  'herald',
  'remote',
]);

export const STEP_TITLES: Record<SetupStepId, string> = {
  welcome: 'Welcome',
  pair: 'Pair this device',
  name: 'Name your server',
  machine: 'Check your machine',
  claude: 'Claude Code',
  projects: 'Projects',
  session: 'First session',
  devices: 'Your devices',
  notifications: 'Notifications',
  herald: 'Herald',
  remote: 'Remote access',
  done: 'Done',
};

export interface WizardState {
  mode: WizardMode;
  flow: SetupStepId[];
  current: SetupStepId;
  marks: Marks;
  paired: boolean;
}

export type WizardAction =
  | { type: 'paired'; setupMode: boolean; marks?: Marks }
  /** resume: jump to the first unfinished step (the marks arrived after the wizard opened). */
  | { type: 'marks'; marks: Marks; resume?: boolean }
  | { type: 'next' }
  | { type: 'skip' }
  | { type: 'back' }
  | { type: 'goto'; step: SetupStepId };

export function flowFor(mode: WizardMode): SetupStepId[] {
  return mode === 'server' ? SERVER_FLOW : DEVICE_FLOW;
}

/** The first step after `from` (exclusive) without a mark; 'done' when all are marked. */
export function nextIncomplete(flow: SetupStepId[], marks: Marks, from: SetupStepId): SetupStepId {
  const i = flow.indexOf(from);
  for (let j = i + 1; j < flow.length; j++) {
    const s = flow[j];
    if (s === 'done') return 'done';
    if (!marks[s]) return s;
  }
  return 'done';
}

export function initWizard(opts: { mode: WizardMode; paired: boolean; marks?: Marks }): WizardState {
  const flow = flowFor(opts.mode);
  const marks = { ...(opts.marks || {}) };
  if (opts.paired) marks.pair = 'done';
  return {
    mode: opts.mode,
    flow,
    marks,
    paired: opts.paired,
    // Not paired yet: start at the beginning. Paired (re-run): first unfinished step.
    current: opts.paired ? nextIncomplete(flow, marks, 'pair') : 'welcome',
  };
}

export function canSkip(s: WizardState): boolean {
  return SKIPPABLE.has(s.current);
}

/** Continue is blocked only on the pair step until this device is paired. */
export function canContinue(s: WizardState): boolean {
  return s.current !== 'pair' || s.paired;
}

/** A step can be opened from the rail once paired (before that, only welcome / pair). */
export function canVisit(s: WizardState, step: SetupStepId): boolean {
  if (!s.flow.includes(step)) return false;
  return s.paired || step === 'welcome' || step === 'pair';
}

export function stepIndex(s: WizardState): { at: number; of: number } {
  return { at: s.flow.indexOf(s.current) + 1, of: s.flow.length };
}

export function wizardReducer(s: WizardState, a: WizardAction): WizardState {
  switch (a.type) {
    case 'paired': {
      const mode: WizardMode = a.setupMode || s.mode === 'server' ? 'server' : 'device';
      const flow = flowFor(mode);
      const marks: Marks = { ...s.marks, ...(a.marks || {}), pair: 'done' };
      if (s.marks.welcome) marks.welcome = s.marks.welcome;
      return { ...s, mode, flow, marks, paired: true, current: nextIncomplete(flow, marks, 'pair') };
    }
    case 'marks': {
      const marks: Marks = { ...s.marks, ...a.marks, ...(s.paired ? { pair: 'done' as const } : {}) };
      const current = a.resume && s.paired ? nextIncomplete(s.flow, marks, 'pair') : s.current;
      return { ...s, marks, current };
    }
    case 'next': {
      if (!canContinue(s) || s.current === 'done') return s;
      const marks: Marks = { ...s.marks, [s.current]: 'done' };
      // Welcome always leads to pairing when not paired yet.
      const current =
        s.current === 'welcome' && !s.paired ? 'pair' : nextIncomplete(s.flow, marks, s.current);
      return { ...s, marks, current };
    }
    case 'skip': {
      if (!canSkip(s)) return s;
      const marks: Marks = { ...s.marks, [s.current]: 'skipped' };
      return { ...s, marks, current: nextIncomplete(s.flow, marks, s.current) };
    }
    case 'back': {
      const i = s.flow.indexOf(s.current);
      if (i <= 0) return s;
      return { ...s, current: s.flow[i - 1] };
    }
    case 'goto':
      return canVisit(s, a.step) ? { ...s, current: a.step } : s;
  }
}

// ------------------------------------------------------------------ API

export class SetupApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** One setup request on a connected server. */
export async function setupCall<T>(serverId: string, type: string, payload?: unknown, timeoutMs = 15_000): Promise<T> {
  const conn = connectionManager.getConnection(serverId);
  if (!conn) throw new SetupApiError('Not connected to the server');
  const r = await conn.sendRequest(type, payload, timeoutMs);
  if (!r.success) {
    const code = (r.payload as { code?: string } | undefined)?.code;
    throw new SetupApiError(r.error || 'Request failed', code);
  }
  return r.payload as T;
}

/** http(s)://host:port for a server entry (links to its update feed). */
export function serverHttpBase(s: { host: string; port: number; useTls: boolean }): string {
  const host = s.host.includes(':') && !s.host.startsWith('[') ? `[${s.host}]` : s.host;
  return `${s.useTls ? 'https' : 'http'}://${host}:${s.port}`;
}
