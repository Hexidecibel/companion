/**
 * The setup wizard's server side: status, prerequisite checks, settings and
 * secret writes, the directory picker, the first session, user services,
 * remote-access facts and app downloads. Transport-agnostic (handlers/setup.ts
 * wires it to the WebSocket and enforces the access gate).
 */
import * as os from 'os';
import { parseHeraldConfigBlock } from '../herald/config';
import type { DaemonConfig } from '../types';
import { isSetupMode, readRawConfig, resolveConfigPath, updateConfigFile } from '../config';
import type {
  AppDownloads,
  DirListing,
  PrereqCheck,
  PrereqId,
  RemoteAccessInfo,
  SecretName,
  ServiceInstallResult,
  ServiceStatus,
  ServiceTarget,
  SessionProgress,
  SetupErrorCode,
  SetupStatus,
  SetupStepId,
  SetupStepState,
} from './protocol';
import { SETUP_STEPS } from './protocol';
import { CheckRunner, Runner } from './checks';
import { DirError, listDirs, resolveInHome } from './dirs';
import { appDownloads, remoteAccessInfo, ServicePaths, servicePlan, serviceStatus, sessionHint } from './info';
import {
  SECRET_ENV_KEYS,
  secretStatuses,
  SecretError,
  secretsFilePath,
  validateSecretValue,
  writeSecretsFileKey,
} from './secrets';
import { applySettingsPatch, readSettings, SettingsError } from './settings';
import { SetupStateStore, SKIPPABLE_STEPS } from './state';

export class SetupError extends Error {
  constructor(
    readonly code: SetupErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface SetupServiceDeps {
  config: DaemonConfig;
  configPath?: () => string;
  identity: () => { id: string; name: string; version: string };
  /** Apply a new display name live (pairing, hello, status). */
  rename: (name: string) => void;
  deviceCount: () => number;
  checks: CheckRunner;
  run: Runner;
  state: SetupStateStore;
  home?: string;
  feedDir: () => string;
  lanAddresses: () => string[];
  servicePaths: () => ServicePaths;
  /** Re-create Herald's brain from the current config/env; 'restart' when only a restart can apply it. */
  reloadHerald: () => 'live' | 'restart' | 'unavailable';
  spawnSession: (dir: string) => Promise<{ ok: boolean; sessionName?: string; error?: string }>;
  sessionExists: (name: string) => Promise<boolean>;
  capturePane: (name: string) => Promise<string>;
  conversationFor: (name: string) => boolean;
  sendToSession: (name: string, text: string) => Promise<boolean>;
  /** Env keys copied from secrets.env at startup (for "where is it set"). */
  secretsFromFile: Set<string>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export class SetupService {
  private restartNeeded = false;
  private installing = new Set<ServiceTarget>();
  /** Sessions the wizard started (progress/send only work on these). */
  private started = new Set<string>();

  constructor(private readonly d: SetupServiceDeps) {}

  private get home(): string {
    return this.d.home || os.homedir();
  }
  private get env(): NodeJS.ProcessEnv {
    return this.d.env || process.env;
  }
  private log(line: string): void {
    (this.d.log || ((l: string) => console.log(l)))(line);
  }
  private configPath(): string {
    return (this.d.configPath || resolveConfigPath)();
  }

  setupMode(): boolean {
    return isSetupMode(this.d.config);
  }

  status(): SetupStatus {
    const id = this.d.identity();
    const st = this.d.state.get();
    return {
      setupMode: this.setupMode(),
      setupComplete: !this.setupMode(),
      daemonId: id.id,
      serverName: id.name,
      hostname: os.hostname(),
      platform: process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : 'other',
      version: id.version,
      home: this.home,
      steps: { ...st.steps },
      settings: readSettings(this.d.config, id.name, st.notifications),
      secrets: secretStatuses(this.env, secretsFilePath(this.env), this.d.secretsFromFile),
      deviceCount: this.d.deviceCount(),
      restartNeeded: this.restartNeeded,
      secretsFile: secretsFilePath(this.env),
    };
  }

  checks(only?: unknown): Promise<PrereqCheck[]> {
    const ids = Array.isArray(only) ? (only.filter((x) => typeof x === 'string') as PrereqId[]) : undefined;
    return this.d.checks.run(ids);
  }

  /** Validate, write the raw config (other keys kept), then apply live where possible. */
  updateSettings(patch: unknown): SetupStatus {
    let outcome: ReturnType<typeof applySettingsPatch> | undefined;
    try {
      // Validate against a scratch copy first so a bad field never writes.
      applySettingsPatch(JSON.parse(JSON.stringify(readRawConfig(this.configPath()))), patch, this.home);
      const raw = updateConfigFile((r) => {
        outcome = applySettingsPatch(r, patch, this.home);
      }, this.configPath());
      this.applyLive(raw);
    } catch (err) {
      if (err instanceof SettingsError) throw new SetupError('bad_request', err.message);
      throw err;
    }
    if (outcome?.notifications) this.d.state.setNotifications(outcome.notifications);
    if (outcome?.restartNeeded) this.restartNeeded = true;
    if (outcome?.heraldChanged) {
      const r = this.d.reloadHerald();
      if (r === 'restart') this.restartNeeded = true;
    }
    this.log('Setup: settings updated');
    return this.status();
  }

  private applyLive(raw: Record<string, unknown>): void {
    const c = this.d.config;
    if (typeof raw.name === 'string' && raw.name !== c.name) {
      c.name = raw.name;
      this.d.rename(raw.name);
    }
    if (Array.isArray(raw.project_roots)) c.projectRoots = raw.project_roots as string[];
    if (typeof raw.pairing === 'boolean') c.pairing = raw.pairing;
    if (typeof raw.pairing_allow_public === 'boolean') c.pairingAllowPublic = raw.pairing_allow_public;
    c.herald = parseHeraldConfigBlock(raw.herald);
  }

  listDirs(p: { path?: unknown; showHidden?: unknown }): DirListing {
    try {
      return listDirs(p.path, this.home, { showHidden: p.showHidden === true });
    } catch (err) {
      if (err instanceof DirError) throw new SetupError(err.code, err.message);
      throw err;
    }
  }

  /** Store a secret in secrets.env (0600) and in this process; never logged or returned. */
  setSecret(name: unknown, value: unknown): SetupStatus {
    if (typeof name !== 'string' || !(name in SECRET_ENV_KEYS)) {
      throw new SetupError('bad_request', 'Unknown secret');
    }
    const envKey = SECRET_ENV_KEYS[name as SecretName];
    let v: string | null;
    try {
      v = value === null ? null : validateSecretValue(value);
      writeSecretsFileKey(envKey, v, secretsFilePath(this.env));
    } catch (err) {
      if (err instanceof SecretError) throw new SetupError('bad_request', err.message);
      throw new SetupError('unavailable', 'Could not save the secret');
    }
    if (v === null) delete this.env[envKey];
    else this.env[envKey] = v;
    this.d.secretsFromFile.add(envKey);
    v = null;
    this.log(`Setup: ${envKey} ${value === null ? 'removed from' : 'saved to'} ${secretsFilePath(this.env)}`);
    const r = this.d.reloadHerald();
    if (r === 'restart') this.restartNeeded = true;
    return this.status();
  }

  markStep(step: unknown, state: unknown): SetupStatus {
    if (typeof step !== 'string' || !(SETUP_STEPS as string[]).includes(step)) {
      throw new SetupError('bad_request', 'Unknown step');
    }
    if (state !== 'done' && state !== 'skipped' && state !== null) {
      throw new SetupError('bad_request', 'state must be done, skipped or null');
    }
    if (state === 'skipped' && !SKIPPABLE_STEPS.has(step as SetupStepId)) {
      throw new SetupError('bad_request', 'That step cannot be skipped');
    }
    this.d.state.markStep(step as SetupStepId, state as SetupStepState | null);
    return this.status();
  }

  /** End setup mode. Re-running the wizard later never re-enters it. */
  complete(): SetupStatus {
    updateConfigFile((r) => {
      r.setup_complete = true;
    }, this.configPath());
    this.d.config.setupComplete = true;
    this.d.state.markStep('done', 'done');
    this.log('Setup: complete');
    return this.status();
  }

  async startSession(dirIn: unknown): Promise<SessionProgress> {
    let dir: string;
    try {
      dir = resolveInHome(dirIn, this.home);
    } catch (err) {
      if (err instanceof DirError) throw new SetupError(err.code, err.message);
      throw err;
    }
    const roots = this.d.config.projectRoots ?? [];
    if (roots.length > 0 && !roots.some((r) => dir === r || dir.startsWith(r + '/'))) {
      throw new SetupError('forbidden', 'Pick a folder inside one of your project folders');
    }
    const r = await this.d.spawnSession(dir);
    if (!r.ok || !r.sessionName) throw new SetupError('unavailable', r.error || 'Could not start the session');
    this.started.add(r.sessionName);
    this.log(`Setup: started first session "${r.sessionName}" in ${dir}`);
    return this.sessionProgress(r.sessionName);
  }

  async sessionProgress(name: unknown): Promise<SessionProgress> {
    if (typeof name !== 'string' || !this.started.has(name)) {
      throw new SetupError('not_found', 'Not a session started by the wizard');
    }
    const exists = await this.d.sessionExists(name);
    const conversation = exists && this.d.conversationFor(name);
    const pane = exists && !conversation ? await this.d.capturePane(name).catch(() => '') : '';
    const h = sessionHint(pane, { exists, conversation });
    return {
      sessionName: name,
      exists,
      conversationDetected: conversation,
      hint: h.hint,
      guidance: h.guidance,
      attachCommand: `tmux attach -t ${name}`,
    };
  }

  /** "Say hello" to the wizard's session so a conversation file appears. */
  async sendHello(name: unknown, text: unknown): Promise<SessionProgress> {
    if (typeof name !== 'string' || !this.started.has(name)) {
      throw new SetupError('not_found', 'Not a session started by the wizard');
    }
    const t = typeof text === 'string' && text.trim() ? text.trim().slice(0, 500) : 'Hello! Say hi back in one short line.';
    const ok = await this.d.sendToSession(name, t);
    if (!ok) throw new SetupError('unavailable', 'Could not type into the session');
    return this.sessionProgress(name);
  }

  services(): ServiceStatus {
    return serviceStatus(this.d.servicePaths());
  }

  /** Runs only on an explicit click (confirm: true). Never restarts the running daemon. */
  async installService(target: unknown, confirm: unknown): Promise<ServiceInstallResult> {
    if (target !== 'daemon' && target !== 'voice') throw new SetupError('bad_request', 'Unknown service');
    if (confirm !== true) throw new SetupError('bad_request', 'Confirm the install first');
    const plan = servicePlan(target, this.d.servicePaths());
    if (plan.info.installed) {
      return { target, ok: true, output: '', note: 'Already installed; nothing was changed.' };
    }
    if (!plan.exec) throw new SetupError('unavailable', plan.info.blocker || 'Cannot install here');
    if (this.installing.has(target)) throw new SetupError('busy', 'Already installing');
    this.installing.add(target);
    try {
      this.log(`Setup: installing ${target} service: ${plan.info.command}`);
      const r = await this.d.run(plan.exec.cmd, plan.exec.args, 120_000);
      const output = r.stdout.split('\n').slice(-15).join('\n').slice(-2000);
      return {
        target,
        ok: r.ok,
        output,
        note:
          target === 'daemon'
            ? 'Enabled for the next login / boot. The running daemon was not restarted.'
            : 'The voice service unit was installed and started.',
      };
    } finally {
      this.installing.delete(target);
    }
  }

  remote(): Promise<RemoteAccessInfo> {
    const l = this.d.config.listeners[0];
    return remoteAccessInfo({ run: this.d.run, port: l.port, tls: !!l.tls, lan: this.d.lanAddresses() });
  }

  downloads(): AppDownloads {
    return appDownloads(this.d.feedDir());
  }
}
