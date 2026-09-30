/**
 * The device check (about a minute, first run per device, re-runnable from the
 * menu) as a pure state machine. Every step can be skipped; the UI in
 * `components/herald/setup/HeraldSetup.tsx` renders the current step.
 *
 *   profile  pick a profile (preselected from the audio environment)
 *   mic      live level meter, say a phrase, see the transcript
 *   echo     Herald speaks a line, the echo left over is measured
 *   wake     optional: say "Hey Jarvis" (only when the wake word is loaded)
 *   trigger  desktop app: press the system-wide shortcut; browser: remote
 *            triggers (MX Master, Raycast); phone: the earbud button
 *   control  make this the main device (only on hubs that arbitrate devices)
 *   done     summary
 */
import type { EchoGrade, ProfileId } from './profiles';
import type { NativePlatform } from '../../utils/platform';

export type SetupStep = 'profile' | 'mic' | 'echo' | 'wake' | 'trigger' | 'control' | 'done';

export interface SetupEnv {
  platform: NativePlatform;
  /** The hub has the wake word loaded. */
  wakeAvailable: boolean;
  /** The hub reports devices (Take control exists). */
  devicesSupported: boolean;
}

export function setupSteps(env: SetupEnv): SetupStep[] {
  const steps: SetupStep[] = ['profile', 'mic', 'echo'];
  if (env.wakeAvailable) steps.push('wake');
  steps.push('trigger');
  if (env.devicesSupported) steps.push('control');
  steps.push('done');
  return steps;
}

export type StepOutcome = 'done' | 'skipped';

export interface SetupFlowState {
  steps: SetupStep[];
  index: number;
  outcomes: Partial<Record<SetupStep, StepOutcome>>;
  profile: ProfileId | null;
  /** What the mic test heard. */
  heard: string | null;
  echo: EchoGrade | null;
  wakeHeard: boolean;
  /** Which input fired in the trigger test ("Ctrl+Alt+Space", "Remote trigger", "Earbud button"). */
  triggerFired: string | null;
  tookControl: boolean;
}

export type SetupAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'skip' }
  | { type: 'goto'; step: SetupStep }
  | { type: 'profile'; profile: ProfileId }
  | { type: 'heard'; text: string }
  | { type: 'echo'; grade: EchoGrade }
  | { type: 'wake' }
  | { type: 'trigger'; label: string }
  | { type: 'control' }
  | { type: 'env'; env: SetupEnv };

export function initialSetupState(env: SetupEnv, profile: ProfileId | null): SetupFlowState {
  return {
    steps: setupSteps(env),
    index: 0,
    outcomes: {},
    profile,
    heard: null,
    echo: null,
    wakeHeard: false,
    triggerFired: null,
    tookControl: false,
  };
}

export function currentStep(s: SetupFlowState): SetupStep {
  return s.steps[Math.min(s.index, s.steps.length - 1)];
}

/** Progress for the dots: the summary is not counted. */
export function progress(s: SetupFlowState): { at: number; of: number } {
  const of = s.steps.filter((x) => x !== 'done').length;
  return { at: Math.min(s.index, of), of };
}

function advance(s: SetupFlowState, outcome: StepOutcome): SetupFlowState {
  const step = currentStep(s);
  if (step === 'done') return s;
  // A step completed earlier (then revisited with Back) keeps its result.
  const prev = s.outcomes[step];
  const out = prev === 'done' && outcome === 'skipped' ? 'done' : outcome;
  return { ...s, outcomes: { ...s.outcomes, [step]: out }, index: Math.min(s.index + 1, s.steps.length - 1) };
}

export function setupReducer(s: SetupFlowState, a: SetupAction): SetupFlowState {
  switch (a.type) {
    case 'next': {
      // Continue counts as done only when the step produced something.
      const step = currentStep(s);
      const produced =
        (step === 'profile' && !!s.profile) ||
        (step === 'mic' && !!s.heard) ||
        (step === 'echo' && !!s.echo) ||
        (step === 'wake' && s.wakeHeard) ||
        (step === 'trigger' && !!s.triggerFired) ||
        (step === 'control' && s.tookControl);
      return advance(s, produced ? 'done' : 'skipped');
    }
    case 'skip':
      return advance(s, 'skipped');
    case 'back':
      return { ...s, index: Math.max(0, s.index - 1) };
    case 'goto': {
      const i = s.steps.indexOf(a.step);
      return i < 0 ? s : { ...s, index: i };
    }
    case 'profile':
      return { ...s, profile: a.profile };
    case 'heard':
      return { ...s, heard: a.text.trim() || null };
    case 'echo':
      return { ...s, echo: a.grade };
    case 'wake':
      return { ...s, wakeHeard: true };
    case 'trigger':
      return { ...s, triggerFired: a.label };
    case 'control':
      return { ...s, tookControl: true };
    case 'env': {
      // The hub finished loading (wake word, devices): keep the current step.
      const steps = setupSteps(a.env);
      if (steps.join() === s.steps.join()) return s;
      const cur = currentStep(s);
      const i = steps.indexOf(cur);
      return { ...s, steps, index: i >= 0 ? i : Math.min(s.index, steps.length - 1) };
    }
  }
}

export interface SummaryLine {
  step: Exclude<SetupStep, 'done'>;
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'muted';
}

/** The done card: one line per step. */
export function summarize(s: SetupFlowState, names: { profile: (id: ProfileId) => string }): SummaryLine[] {
  const lines: SummaryLine[] = [];
  for (const step of s.steps) {
    const skipped = s.outcomes[step] !== 'done';
    switch (step) {
      case 'profile':
        lines.push({ step, label: 'Profile', value: s.profile ? names.profile(s.profile) : 'Not chosen', tone: s.profile ? 'ok' : 'muted' });
        break;
      case 'mic':
        lines.push({ step, label: 'Microphone', value: s.heard ? `Heard "${s.heard.length > 48 ? `${s.heard.slice(0, 47)}…` : s.heard}"` : 'Skipped', tone: s.heard ? 'ok' : 'muted' });
        break;
      case 'echo': {
        const map = {
          good: ['No echo: interrupt is on the table', 'ok'],
          marginal: ['Some echo: interrupt stays off', 'warn'],
          poor: ['Herald hears itself: interrupt off', 'warn'],
          unmeasured: ['Could not measure: interrupt off', 'muted'],
        } as const;
        const v = s.echo ? map[s.echo] : (['Skipped', 'muted'] as const);
        lines.push({ step, label: 'Echo', value: v[0], tone: v[1] });
        break;
      }
      case 'wake':
        lines.push({ step, label: 'Wake word', value: s.wakeHeard ? 'Heard "Hey Jarvis"' : 'Skipped', tone: s.wakeHeard ? 'ok' : 'muted' });
        break;
      case 'trigger':
        lines.push({ step, label: 'Trigger', value: s.triggerFired ?? (skipped ? 'Skipped' : 'Set up later'), tone: s.triggerFired ? 'ok' : 'muted' });
        break;
      case 'control':
        lines.push({ step, label: 'Main device', value: s.tookControl ? 'This device' : 'Unchanged', tone: s.tookControl ? 'ok' : 'muted' });
        break;
      case 'done':
        break;
    }
  }
  return lines;
}
