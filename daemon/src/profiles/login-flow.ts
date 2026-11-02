/**
 * One-tap account login: runs the agent's login in a hidden tmux session,
 * reads the sign-in link / code from the pane, types a pasted code back, and
 * always removes the session at the end (success, failure, cancel, timeout;
 * leftovers from a previous daemon are reaped at start).
 *
 * The session is identified by a tmux environment tag, so a user's own session
 * named `login-x` is never touched. It has no COMPANION_APP tag, so the
 * watcher, trust-prompt checks and start-up captures never see it.
 *
 * Secrets: the link, the device code and pasted codes go only to the clients
 * `emit` allows. They are never logged, audited or put in an error string.
 */
import { randomBytes, createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseLoginOutput } from './login-parser';
import type { ProfileAgent, ProfileLoginFlow, ProfileLoginFlowState } from './protocol';
import { isShellSafePath } from './registry';
import type { AgentProfile } from './registry';

/** What each login session runs (headless-friendly: both print a link). */
export const LOGIN_COMMANDS: Record<ProfileAgent, string> = {
  claude: 'claude auth login',
  codex: 'codex login --device-auth',
};

export const LOGIN_FLOW_TAG = 'COMPANION_LOGIN_FLOW';
export const LOGIN_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 1000;
/** Nothing readable by now: the sheet offers the terminal. */
const UNPARSED_AFTER_MS = 20_000;
/** The empty prompt still up this long after a code = the code was not taken. */
const CODE_REJECTED_AFTER_MS = 8000;
/** An ended flow stays readable so a device coming back can see the outcome. */
const ENDED_KEEP_MS = 5 * 60_000;
const MAX_CODE_LENGTH = 4096;

export function loginSessionName(profileId: string): string {
  return `login-${profileId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const ACTIVE: ReadonlySet<ProfileLoginFlowState> = new Set([
  'starting',
  'open_link',
  'awaiting_code',
  'verifying',
]);

/** Tag prefix naming this daemon's home: a sandbox never reaps production's logins. */
export function loginOwner(home: string = os.homedir()): string {
  return createHash('sha256').update(home).digest('hex').slice(0, 12);
}

export interface LoginTestOverride {
  command?: string;
  timeoutMs?: number;
}

/**
 * Probe only: with COMPANION_SANDBOX=1 and COMPANION_PROFILE_LOGIN_TEST_DIR,
 * `<dir>/<profile>.sh` replaces the login command and `<dir>/<profile>.timeout-ms`
 * the time limit. Ignored everywhere else.
 */
export function loginTestOverride(
  profileId: string,
  env: NodeJS.ProcessEnv = process.env
): LoginTestOverride {
  const dir = env.COMPANION_PROFILE_LOGIN_TEST_DIR;
  if (env.COMPANION_SANDBOX !== '1' || !dir || !/^\/[\w./-]+$/.test(dir)) return {};
  const out: LoginTestOverride = {};
  const script = path.join(dir, `${profileId}.sh`);
  if (fs.existsSync(script)) out.command = `sh ${script}`;
  try {
    const ms = Number(fs.readFileSync(path.join(dir, `${profileId}.timeout-ms`), 'utf-8').trim());
    if (ms > 0) out.timeoutMs = ms;
  } catch {
    /* no override */
  }
  return out;
}

/**
 * The typed line: records the login's exit code in a file (reading it costs no
 * subprocess), whatever the user's shell is. Single-quoted words only, so it
 * also survives fish and the env-file wrapper. INT is trapped so a Ctrl+C in
 * the terminal view still records an outcome.
 */
export function loginLaunchLine(command: string, exitFile: string): string {
  return `sh -c 'trap : INT; ${command}; echo $? > "$0"' '${exitFile}'`;
}

export interface LoginTmux {
  sessionExists(name: string): Promise<boolean>;
  createSession(
    name: string,
    workingDir: string,
    startCli: boolean,
    opts: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }>;
  capturePaneJoined(name: string): Promise<{ text: string | null; gone: boolean }>;
  sendSecretLine(name: string, text: string): Promise<boolean>;
  sessionEnvValue(name: string, key: string): Promise<string | null>;
  listAllSessionNames(): Promise<string[]>;
  killSessionNow(name: string): Promise<boolean>;
}

export interface LoginFlowDeps {
  tmux: LoginTmux;
  launchOpts: (p: AgentProfile) => Promise<{ env?: Record<string, string>; envFile?: string }>;
  emit: (flow: ProfileLoginFlow) => void;
  /** Refresh the account list after a good login. */
  onSuccess: (profile: AgentProfile) => void;
  audit: (action: string, info: Record<string, unknown>, ok: boolean) => void;
  hide: (name: string) => void;
  unhide: (name: string) => void;
  log?: (line: string) => void;
  now?: () => number;
  stateDir?: string;
  owner?: string;
  pollMs?: number;
  homeDir?: string;
  override?: (profileId: string) => LoginTestOverride;
}

interface Entry {
  flow: ProfileLoginFlow;
  profile: AgentProfile;
  tag: string;
  exitFile: string;
  launched: boolean;
  polling: boolean;
  codeSentAt?: number;
  cancelledBeforeLaunch?: boolean;
  endedAt?: number;
}

export type LoginCodeResult = { flow: ProfileLoginFlow } | { error: string };

export class LoginFlowManager {
  private flows = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;
  private log: (line: string) => void;
  private stateDir: string;
  private owner: string;
  private override: (profileId: string) => LoginTestOverride;

  constructor(private deps: LoginFlowDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((l) => console.log(l));
    this.stateDir = deps.stateDir ?? path.join(os.homedir(), '.companion', 'profile-login');
    this.owner = deps.owner ?? loginOwner();
    this.override = deps.override ?? ((id) => loginTestOverride(id));
  }

  /** Flows a client should know about (running, or recently ended). */
  list(): ProfileLoginFlow[] {
    this.pruneEnded();
    return [...this.flows.values()].map((e) => ({ ...e.flow }));
  }

  async start(
    profile: AgentProfile
  ): Promise<{ flow: ProfileLoginFlow; alreadyRunning?: boolean } | { error: string }> {
    this.pruneEnded();
    const existing = this.flows.get(profile.id);
    if (existing && ACTIVE.has(existing.flow.state)) {
      if (!existing.flow.unparsed) return { flow: { ...existing.flow }, alreadyRunning: true };
      await this.finish(existing, 'cancelled');
    }

    const nonce = randomBytes(8).toString('hex');
    const exitFile = path.join(this.stateDir, `${nonce}.exit`);
    if (!isShellSafePath(exitFile)) return { error: 'The login status path cannot be used' };
    const base = loginSessionName(profile.id);
    const started = this.now();
    const test = this.override(profile.id);
    const entry: Entry = {
      profile,
      tag: `${this.owner}.${nonce}`,
      exitFile,
      launched: false,
      polling: false,
      flow: {
        flowId: nonce,
        profileId: profile.id,
        profileLabel: profile.label,
        agent: profile.agent,
        state: 'starting',
        sessionName: base,
        startedAt: started,
        expiresAt: started + (test.timeoutMs ?? LOGIN_TIMEOUT_MS),
      },
    };
    // In the map before any await: a second tap attaches instead of racing.
    this.flows.set(profile.id, entry);

    try {
      await fs.promises.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      // A session the user owns under this name is left alone.
      const name = (await this.deps.tmux.sessionExists(base))
        ? `${base}-${nonce.slice(0, 4)}`
        : base;
      entry.flow.sessionName = name;
      const launch = await this.deps.launchOpts(profile);
      this.deps.hide(name);
      const result = await this.deps.tmux.createSession(
        name,
        this.deps.homeDir ?? os.homedir(),
        true,
        {
          ...launch,
          env: { ...(launch.env ?? {}), [LOGIN_FLOW_TAG]: entry.tag, COMPANION_APP: '0' },
          command: loginLaunchLine(test.command ?? LOGIN_COMMANDS[profile.agent], exitFile),
          managed: false,
        }
      );
      if (!result.success) throw new Error('create failed');
    } catch {
      this.deps.unhide(entry.flow.sessionName);
      this.flows.delete(profile.id);
      this.deps.audit(
        'profile_login_end',
        { profileId: profile.id, outcome: 'start_failed' },
        false
      );
      return { error: 'Could not start the login' };
    }
    entry.launched = true;
    if (entry.cancelledBeforeLaunch) {
      await this.removeSession(entry);
      return { flow: { ...entry.flow } };
    }
    this.log(`Profiles: login started for ${profile.id} (${profile.agent})`);
    this.deps.audit('profile_login_start', { profileId: profile.id, agent: profile.agent }, true);
    this.deps.emit({ ...entry.flow });
    this.ensureTimer();
    return { flow: { ...entry.flow } };
  }

  async submitCode(profileId: string, rawCode: unknown): Promise<LoginCodeResult> {
    const entry = this.flows.get(profileId);
    if (!entry || !ACTIVE.has(entry.flow.state))
      return { error: 'This login is no longer running' };
    if (entry.flow.agent !== 'claude' || !entry.flow.url)
      return { error: 'This login is not waiting for a code' };
    const code = typeof rawCode === 'string' ? rawCode.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (!code || code.length > MAX_CODE_LENGTH || /[\x00-\x1f\x7f]/.test(code))
      return { error: 'That code cannot be sent' };
    const ok = await this.deps.tmux.sendSecretLine(entry.flow.sessionName, code);
    if (!ok) return { error: 'Could not send the code to the login' };
    entry.codeSentAt = this.now();
    this.update(entry, { state: 'verifying', message: undefined });
    return { flow: { ...entry.flow } };
  }

  async cancel(profileId: string): Promise<{ flow: ProfileLoginFlow } | { error: string }> {
    const entry = this.flows.get(profileId);
    if (!entry) return { error: 'No login is running for this account' };
    if (!ACTIVE.has(entry.flow.state)) return { flow: { ...entry.flow } };
    await this.finish(entry, 'cancelled');
    return { flow: { ...entry.flow } };
  }

  /** Remove login sessions a previous daemon of this home left behind. */
  async reapLeftovers(): Promise<number> {
    let reaped = 0;
    const names = await this.deps.tmux.listAllSessionNames();
    for (const name of names) {
      if (!name.startsWith('login-')) continue;
      if ([...this.flows.values()].some((e) => e.flow.sessionName === name)) continue;
      const tag = await this.deps.tmux.sessionEnvValue(name, LOGIN_FLOW_TAG);
      if (!tag || !tag.startsWith(`${this.owner}.`)) continue;
      this.deps.hide(name);
      if (await this.deps.tmux.killSessionNow(name)) {
        this.deps.unhide(name);
        reaped++;
      }
    }
    const live = new Set([...this.flows.values()].map((e) => path.basename(e.exitFile)));
    const files = await fs.promises.readdir(this.stateDir).catch(() => [] as string[]);
    for (const f of files) {
      if (f.endsWith('.exit') && !live.has(f)) {
        await fs.promises.rm(path.join(this.stateDir, f), { force: true }).catch(() => undefined);
      }
    }
    if (reaped) this.log(`Profiles: removed ${reaped} leftover login session(s)`);
    return reaped;
  }

  /** Timers only; sessions stay for the next start's reap. */
  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------- polling

  /** One pass; exposed for tests. A flow whose previous poll still runs is skipped. */
  async tick(): Promise<void> {
    const running = [...this.flows.values()].filter(
      (e) => e.launched && ACTIVE.has(e.flow.state) && !e.polling
    );
    await Promise.all(
      running.map(async (e) => {
        e.polling = true;
        try {
          await this.pollOne(e);
        } catch {
          // The error may quote pane text, so it is not logged. Next tick retries.
        } finally {
          e.polling = false;
        }
      })
    );
    if (![...this.flows.values()].some((e) => ACTIVE.has(e.flow.state))) this.shutdown();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  private async pollOne(e: Entry): Promise<void> {
    const now = this.now();
    if (now >= e.flow.expiresAt)
      return this.finish(e, 'expired', 'The login timed out. Try again.');
    if (await this.finishFromExitFile(e)) return;

    const cap = await this.deps.tmux.capturePaneJoined(e.flow.sessionName);
    if (cap.gone) {
      if (await this.finishFromExitFile(e)) return;
      return this.finish(e, 'failed', 'The login window closed before it finished.');
    }
    if (cap.text === null) return; // tmux timed out: says nothing, try again

    const parsed = parseLoginOutput(e.flow.agent, cap.text);
    const patch: Partial<ProfileLoginFlow> = {};
    if (parsed.url) patch.url = parsed.url;
    if (parsed.deviceCode) patch.deviceCode = parsed.deviceCode;

    let state = e.flow.state;
    if (state === 'verifying') {
      if (
        parsed.codePromptEmpty &&
        e.codeSentAt !== undefined &&
        now - e.codeSentAt >= CODE_REJECTED_AFTER_MS
      ) {
        state = 'awaiting_code';
        patch.message = "That code wasn't accepted. Check it and try again.";
      }
    } else if (e.flow.agent === 'claude' && parsed.codePrompt && (parsed.url || e.flow.url)) {
      state = 'awaiting_code';
    } else if (parsed.url || e.flow.url) {
      if (e.flow.agent === 'claude' || parsed.deviceCode || e.flow.deviceCode) state = 'open_link';
    }
    patch.state = state;

    const readable =
      !!(patch.url || e.flow.url) &&
      (e.flow.agent === 'claude' || !!(patch.deviceCode || e.flow.deviceCode));
    if (readable) patch.unparsed = undefined;
    else if (parsed.blockedLink || now - e.flow.startedAt >= UNPARSED_AFTER_MS)
      patch.unparsed = true;

    this.update(e, patch);
  }

  private async finishFromExitFile(e: Entry): Promise<boolean> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(e.exitFile, 'utf-8');
    } catch {
      return false;
    }
    if (!/^\d+\s*$/.test(raw)) return false; // being written
    const code = Number(raw.trim());
    if (code === 0) await this.finish(e, 'success');
    else if (code === 127)
      await this.finish(e, 'failed', `The ${e.flow.agent} command was not found on this server.`);
    else if (code === 130) await this.finish(e, 'failed', 'The login was interrupted.');
    else await this.finish(e, 'failed', "The login didn't finish. Try again.");
    return true;
  }

  // ------------------------------------------------------------------ state

  private update(e: Entry, patch: Partial<ProfileLoginFlow>): void {
    const before = JSON.stringify(e.flow);
    const next: ProfileLoginFlow = { ...e.flow, ...patch };
    for (const k of Object.keys(next) as Array<keyof ProfileLoginFlow>) {
      if (next[k] === undefined) delete next[k];
    }
    if (JSON.stringify(next) === before) return;
    e.flow = next;
    this.deps.emit({ ...next });
  }

  private async finish(e: Entry, state: ProfileLoginFlowState, message?: string): Promise<void> {
    if (!ACTIVE.has(e.flow.state)) return;
    const rest = { ...e.flow };
    delete rest.url;
    delete rest.deviceCode;
    delete rest.unparsed;
    delete rest.message;
    e.flow = { ...rest, state, ...(message ? { message } : {}) };
    e.endedAt = this.now();
    if (e.launched) await this.removeSession(e);
    else e.cancelledBeforeLaunch = true;
    this.log(`Profiles: login for ${e.profile.id} ended: ${state}`);
    this.deps.audit(
      'profile_login_end',
      { profileId: e.profile.id, outcome: state },
      state === 'success'
    );
    this.deps.emit({ ...e.flow });
    if (state === 'success') this.deps.onSuccess(e.profile);
  }

  private async removeSession(e: Entry): Promise<void> {
    const name = e.flow.sessionName;
    // Only ever kill the session this flow created.
    const tag = await this.deps.tmux.sessionEnvValue(name, LOGIN_FLOW_TAG);
    let gone: boolean;
    if (tag === e.tag) {
      gone =
        (await this.deps.tmux.killSessionNow(name)) || (await this.deps.tmux.killSessionNow(name));
    } else {
      // Another owner's session, or none. Unknown (tmux timed out) keeps it hidden.
      gone = tag !== null || !(await this.deps.tmux.sessionExists(name));
    }
    if (gone) this.deps.unhide(name);
    else this.log(`Profiles: could not remove login session "${name}"; it goes at the next start`);
    await fs.promises.rm(e.exitFile, { force: true }).catch(() => undefined);
  }

  private pruneEnded(): void {
    const now = this.now();
    for (const [id, e] of this.flows) {
      if (e.endedAt !== undefined && now - e.endedAt >= ENDED_KEEP_MS) this.flows.delete(id);
    }
  }
}
