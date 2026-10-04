/**
 * Setup-mode state: which wizard steps are done / skipped, plus the wizard
 * choices that are not daemon config (the notifications choice). Stored in
 * ~/.companion/setup-state.json (COMPANION_SETUP_STATE_FILE overrides), 0600,
 * atomic. Whether the daemon IS in setup mode lives in the config
 * (`setup_complete`), see config.ts isSetupMode().
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils';
import type { NotificationsChoice, SetupStepId, SetupStepState } from './protocol';
import { SETUP_STEPS } from './protocol';

export interface SetupStateFile {
  version: 1;
  steps: Partial<Record<SetupStepId, SetupStepState>>;
  notifications: NotificationsChoice;
}

export function defaultSetupStatePath(): string {
  return (
    process.env.COMPANION_SETUP_STATE_FILE ||
    path.join(os.homedir(), '.companion', 'setup-state.json')
  );
}

export class SetupStateStore {
  private cache: SetupStateFile | null = null;

  constructor(private readonly file: string = defaultSetupStatePath()) {}

  get(): SetupStateFile {
    if (this.cache) return this.cache;
    let out: SetupStateFile = { version: 1, steps: {}, notifications: 'browser' };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SetupStateFile>;
      const steps: SetupStateFile['steps'] = {};
      for (const id of SETUP_STEPS) {
        const v = raw.steps?.[id];
        if (v === 'done' || v === 'skipped') steps[id] = v;
      }
      out = {
        version: 1,
        steps,
        notifications: raw.notifications === 'off' ? 'off' : 'browser',
      };
    } catch {
      /* fresh */
    }
    this.cache = out;
    return out;
  }

  private save(next: SetupStateFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(this.file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    this.cache = next;
  }

  markStep(step: SetupStepId, state: SetupStepState | null): SetupStateFile {
    const cur = this.get();
    const steps = { ...cur.steps };
    if (state === null) delete steps[step];
    else steps[step] = state;
    const next = { ...cur, steps };
    this.save(next);
    return next;
  }

  setNotifications(choice: NotificationsChoice): void {
    this.save({ ...this.get(), notifications: choice });
  }
}

/** Only these steps may be skipped; the rest are required or informational. */
export const SKIPPABLE_STEPS: ReadonlySet<SetupStepId> = new Set<SetupStepId>([
  'machine',
  'claude',
  'projects',
  'session',
  'devices',
  'notifications',
  'herald',
  'remote',
]);
