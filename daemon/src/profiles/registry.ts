/**
 * Account profiles: several logins per coding agent. A profile is a home
 * directory the agent keeps everything in (Claude Code: CLAUDE_CONFIG_DIR,
 * Codex: CODEX_HOME), plus optional non-secret env and a 0600 env file for
 * API keys. Two implicit defaults always exist: `claude` (code_home) and
 * `codex` (the resolved Codex home), so a config without `profiles` behaves
 * exactly as before.
 *
 * Secrets: the env file is never parsed for values here. Only its variable
 * NAMES are read (login state); the launched agent sources it itself
 * (scripts/profile-exec.sh), so values never reach config.json, tmux's
 * environment, argv or a log.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveCodexHome } from '../agents/codex/discovery';
import type { AccountProfileInfo, ProfileAgent, ProfileLoginState } from './protocol';

export interface AgentProfile {
  id: string;
  label: string;
  agent: ProfileAgent;
  /** Absolute home (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  home: string;
  /** Non-secret variables for the agent's tmux session. */
  env: Record<string, string>;
  /** Configured env file (absolute); absent = `<config dir>/profiles/<id>.env` when it exists. */
  envFile?: string;
  isDefault: boolean;
}

export const DEFAULT_PROFILE_IDS: Record<ProfileAgent, string> = {
  claude: 'claude',
  codex: 'codex',
};

const AGENTS: ProfileAgent[] = ['claude', 'codex'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Set by the profile itself or by Companion; never through `env`. */
const RESERVED_ENV = new Set([
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COMPANION_APP',
  'HOME',
  'PATH',
  'TMUX',
  'TMUX_PANE',
]);
/** Path characters that cannot be single-quoted the same way in sh and fish. */
const UNSAFE_PATH_RE = /['\\\n\r\0]/;

/** Variable naming an API key per agent (login state `api_key`). */
const API_KEY_VARS: Record<ProfileAgent, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
};

/** Variable that points the agent at a profile home. */
export const HOME_ENV_VAR: Record<ProfileAgent, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

export function expandHome(p: string, homeDir: string = os.homedir()): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
  return p;
}

export function isValidProfileId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/** A path that can be single-quoted identically in sh / bash / fish. */
export function isShellSafePath(p: string): boolean {
  return path.isAbsolute(p) && !UNSAFE_PATH_RE.test(p);
}

/**
 * The `profiles` config block -> configured profiles (pure). Invalid entries
 * are skipped with a warning; nothing throws.
 */
export function parseProfilesBlock(
  raw: unknown,
  opts: { homeDir?: string } = {}
): { profiles: AgentProfile[]; warnings: string[] } {
  const warnings: string[] = [];
  const profiles: AgentProfile[] = [];
  if (raw === undefined || raw === null) return { profiles, warnings };
  if (!Array.isArray(raw)) {
    warnings.push('profiles: expected an array; ignored');
    return { profiles, warnings };
  }
  const homeDir = opts.homeDir ?? os.homedir();
  for (const [i, e] of raw.entries()) {
    const where = `profiles[${i}]`;
    if (!e || typeof e !== 'object') {
      warnings.push(`${where}: not an object; skipped`);
      continue;
    }
    const o = e as Record<string, unknown>;
    if (!isValidProfileId(o.id)) {
      warnings.push(`${where}: id must match ${ID_RE}; skipped`);
      continue;
    }
    const agent = o.agent;
    if (agent !== 'claude' && agent !== 'codex') {
      warnings.push(`${where} (${o.id}): agent must be "claude" or "codex"; skipped`);
      continue;
    }
    if (typeof o.home !== 'string' || !o.home.trim()) {
      warnings.push(`${where} (${o.id}): home is required; skipped`);
      continue;
    }
    const home = path.resolve(expandHome(o.home.trim(), homeDir));
    if (!isShellSafePath(home)) {
      warnings.push(`${where} (${o.id}): home must be absolute without quotes / backslashes; skipped`);
      continue;
    }
    const env: Record<string, string> = {};
    if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
      for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
        if (!ENV_KEY_RE.test(k) || RESERVED_ENV.has(k) || typeof v !== 'string') {
          warnings.push(`${where} (${o.id}): env ${k} ignored`);
          continue;
        }
        env[k] = v;
      }
    }
    const rawEnvFile = o.env_file ?? o.envFile;
    let envFile: string | undefined;
    if (typeof rawEnvFile === 'string' && rawEnvFile.trim()) {
      const f = path.resolve(expandHome(rawEnvFile.trim(), homeDir));
      if (isShellSafePath(f)) envFile = f;
      else warnings.push(`${where} (${o.id}): env_file must be absolute without quotes; ignored`);
    }
    const label =
      typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 40) : o.id;
    profiles.push({ id: o.id, label, agent, home, env, envFile, isDefault: false });
  }
  return { profiles, warnings };
}

/** Defaults first, then the configured ones that do not clash with them or each other. */
export function buildProfiles(
  defaults: { codeHome: string; codexHome: string },
  configured: AgentProfile[],
  warn: (line: string) => void = () => undefined
): AgentProfile[] {
  const out: AgentProfile[] = [
    {
      id: DEFAULT_PROFILE_IDS.claude,
      label: 'Claude',
      agent: 'claude',
      home: path.resolve(defaults.codeHome),
      env: {},
      isDefault: true,
    },
    {
      id: DEFAULT_PROFILE_IDS.codex,
      label: 'Codex',
      agent: 'codex',
      home: path.resolve(defaults.codexHome),
      env: {},
      isDefault: true,
    },
  ];
  for (const p of configured) {
    if (out.some((q) => q.id === p.id)) {
      warn(`Profiles: "${p.id}" is taken (default or duplicate id); skipped`);
      continue;
    }
    if (out.some((q) => q.agent === p.agent && q.home === p.home)) {
      warn(`Profiles: "${p.id}" uses the same ${p.agent} home as another profile; skipped`);
      continue;
    }
    out.push({ ...p, isDefault: false });
  }
  return out;
}

/** Variable names an env file sets (`KEY=...` / `export KEY=...`); values are never kept. */
export function envFileKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export interface ProfileRegistryOptions {
  codeHome: string;
  /** Configured codex_home (resolved like the watcher always did). */
  codexHome?: string;
  /** Config file to re-read on change (null = never reload). */
  configPath?: string | null;
  /** Initial `profiles` block (else read from configPath). */
  profilesRaw?: unknown;
  /** Directory holding `profiles/<id>.env` (default: the config file's directory). */
  configDir?: string;
  log?: (line: string) => void;
}

export class ProfileRegistry extends EventEmitter {
  readonly codeHome: string;
  readonly codexHome: string;
  private profiles: AgentProfile[] = [];
  private realHomes = new Map<string, string>(); // profile id -> real path of home
  private dirCache = new Map<string, string>(); // seen dir -> real path
  private configMtime = -1;
  private readonly configPath: string | null;
  private readonly configDir: string;
  private readonly log: (line: string) => void;

  constructor(opts: ProfileRegistryOptions) {
    super();
    this.codeHome = path.resolve(opts.codeHome);
    this.codexHome = path.resolve(
      resolveCodexHome({ configured: opts.codexHome, codeHome: opts.codeHome })
    );
    this.configPath = opts.configPath ?? null;
    this.configDir =
      opts.configDir ??
      (this.configPath ? path.dirname(this.configPath) : path.join(os.homedir(), '.companion'));
    this.log = opts.log ?? ((l) => console.log(l));
    let raw = opts.profilesRaw;
    if (raw === undefined && this.configPath) {
      try {
        const st = fs.statSync(this.configPath);
        this.configMtime = st.mtimeMs;
        raw = (JSON.parse(fs.readFileSync(this.configPath, 'utf-8')) || {}).profiles;
      } catch {
        raw = undefined;
      }
    }
    this.apply(raw, false);
  }

  private apply(raw: unknown, emit: boolean): void {
    const { profiles, warnings } = parseProfilesBlock(raw);
    for (const w of warnings) this.log(`Profiles: ${w}`);
    const next = buildProfiles({ codeHome: this.codeHome, codexHome: this.codexHome }, profiles, this.log);
    const before = JSON.stringify(this.profiles);
    this.profiles = next;
    this.realHomes.clear();
    for (const p of next) this.realHomes.set(p.id, realOrResolved(p.home));
    if (emit && JSON.stringify(next) !== before) {
      const extra = next.filter((p) => !p.isDefault).map((p) => `${p.id} (${p.agent})`);
      this.log(`Profiles: ${extra.length ? extra.join(', ') : 'defaults only'}`);
      this.emit('changed', this.list());
    }
  }

  /**
   * Re-read the config's `profiles` when the file changed (one stat). Called
   * from the watcher's refresh; returns true when the list changed.
   */
  async refresh(): Promise<boolean> {
    if (!this.configPath) return false;
    let mtime: number;
    try {
      mtime = (await fs.promises.stat(this.configPath)).mtimeMs;
    } catch {
      return false;
    }
    if (mtime === this.configMtime) return false;
    this.configMtime = mtime;
    let raw: unknown;
    try {
      raw = (JSON.parse(await fs.promises.readFile(this.configPath, 'utf-8')) || {}).profiles;
    } catch {
      return false; // half-written / invalid: keep the current list
    }
    const before = JSON.stringify(this.profiles);
    this.apply(raw, true);
    return JSON.stringify(this.profiles) !== before;
  }

  list(): AgentProfile[] {
    return this.profiles.slice();
  }

  get(id: string | null | undefined): AgentProfile | undefined {
    if (!id) return undefined;
    return this.profiles.find((p) => p.id === id);
  }

  defaultFor(agent: ProfileAgent): AgentProfile {
    return this.profiles.find((p) => p.agent === agent && p.isDefault)!;
  }

  ofAgent(agent: ProfileAgent): AgentProfile[] {
    return this.profiles.filter((p) => p.agent === agent);
  }

  /** More than the two defaults exist. */
  hasExtra(): boolean {
    return this.profiles.some((p) => !p.isDefault);
  }

  /**
   * The profile whose home is `dir` (the CLAUDE_CONFIG_DIR / CODEX_HOME a
   * process runs with); unset or unknown = the agent's default.
   */
  forHome(agent: ProfileAgent, dir: string | null | undefined): AgentProfile {
    const def = this.defaultFor(agent);
    if (!dir) return def;
    const resolved = path.resolve(dir);
    let real = this.dirCache.get(resolved);
    if (real === undefined) {
      real = realOrResolved(resolved);
      if (this.dirCache.size > 200) this.dirCache.clear();
      this.dirCache.set(resolved, real);
    }
    for (const p of this.profiles) {
      if (p.agent !== agent) continue;
      if (p.home === resolved || this.realHomes.get(p.id) === real) return p;
    }
    return def;
  }

  /** The env file a profile uses (configured, else `<config dir>/profiles/<id>.env` if present). */
  async envFileOf(p: AgentProfile): Promise<string | undefined> {
    const f = p.envFile ?? path.join(this.configDir, 'profiles', `${p.id}.env`);
    try {
      const st = await fs.promises.stat(f);
      return st.isFile() && isShellSafePath(f) ? f : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What a launched agent needs: the tmux session env (home variable + the
   * profile's non-secret env) and the env file its launch line sources. The
   * default Claude profile gets nothing (exactly the old launch); the default
   * Codex profile gets CODEX_HOME as before.
   */
  async launchPlan(p: AgentProfile): Promise<{ env: Record<string, string>; envFile?: string }> {
    const env: Record<string, string> = { ...p.env };
    if (!(p.isDefault && p.agent === 'claude')) env[HOME_ENV_VAR[p.agent]] = p.home;
    const envFile = await this.envFileOf(p);
    return envFile ? { env, envFile } : { env };
  }

  /** Variable names the profile sets (env + env file). */
  async envKeys(p: AgentProfile): Promise<string[]> {
    const keys = Object.keys(p.env);
    const f = await this.envFileOf(p);
    if (f) {
      try {
        for (const k of envFileKeys(await fs.promises.readFile(f, 'utf-8'))) {
          if (!keys.includes(k)) keys.push(k);
        }
      } catch {
        /* unreadable: no names */
      }
    }
    return keys;
  }

  /** Cheap login state: a credentials file exists (never read), else an API key variable. */
  async loginState(p: AgentProfile, keys?: string[]): Promise<ProfileLoginState> {
    const exists = (f: string) =>
      fs.promises.access(f).then(
        () => true,
        () => false
      );
    if (p.agent === 'claude') {
      if (await exists(path.join(p.home, '.credentials.json'))) return 'logged_in';
      // macOS keeps the token in the keychain: the account record says it.
      if (process.platform === 'darwin') {
        const cfg = p.isDefault
          ? path.join(path.dirname(p.home), '.claude.json')
          : path.join(p.home, '.claude.json');
        try {
          const j = JSON.parse(await fs.promises.readFile(cfg, 'utf-8'));
          if (j && typeof j === 'object' && j.oauthAccount) return 'logged_in';
        } catch {
          /* none */
        }
      }
    } else if (await exists(path.join(p.home, 'auth.json'))) {
      return 'logged_in';
    }
    const names = keys ?? (await this.envKeys(p));
    return API_KEY_VARS[p.agent].some((k) => names.includes(k)) ? 'api_key' : 'logged_out';
  }

  async info(): Promise<AccountProfileInfo[]> {
    const out: AccountProfileInfo[] = [];
    for (const p of this.profiles) {
      const envKeys = await this.envKeys(p);
      out.push({
        id: p.id,
        label: p.label,
        agent: p.agent,
        home: p.home,
        isDefault: p.isDefault,
        loginState: await this.loginState(p, envKeys),
        ...(envKeys.length ? { envKeys } : {}),
      });
    }
    return out;
  }
}

export function isProfileAgent(a: unknown): a is ProfileAgent {
  return typeof a === 'string' && (AGENTS as string[]).includes(a);
}
