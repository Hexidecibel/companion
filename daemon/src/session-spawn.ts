/**
 * Creating a coding-agent session in a tmux session: the one path shared by
 * the app's `create_tmux_session` request and Herald's `propose_spawn_session`.
 *
 *   1. tmux new-session (tagged COMPANION_APP=1) and start the agent in it:
 *      Claude Code (default) as `claude --permission-mode bypassPermissions`
 *      (sessions created from Companion have no terminal for interactive
 *      approval), or Codex CLI as `codex --dangerously-bypass-approvals-and-
 *      sandbox` (the same trust; agents/codex/terminal.ts), with CODEX_HOME set
 *      to the Codex home the watcher reads. Nothing is written into the
 *      project's .claude/settings.json any more; settings an older version
 *      wrote there are left alone.
 *   2. Remember its config (recreate, with the same permission mode), give it
 *      a friendly name, and tell the watcher about it.
 *
 * Callers decide what else happens (the app also makes it the active session;
 * Herald does not, so it never switches the user's view).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TmuxManager, ClaudePermissionMode } from './tmux-manager';
import { DEFAULT_AGENT_ID, getAgentAdapter, listAgentIds, type AgentId } from './agents';
import { stripAnsi } from './prompt-guard';
import type { AgentProfile, ProfileRegistry } from './profiles/registry';

/** The permission mode app-spawned sessions run in. */
export const SPAWN_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface SessionSpawnDeps {
  tmux: Pick<TmuxManager, 'createSession' | 'generateSessionName'> &
    /** Optional: lets a non-Claude launch be checked (agent not installed). */
    Partial<Pick<TmuxManager, 'capturePane' | 'killSession'>>;
  storeTmuxSessionConfig: (
    name: string,
    workingDir: string,
    startCli?: boolean,
    opts?: { permissionMode?: ClaudePermissionMode; agent?: AgentId; profileId?: string }
  ) => void;
  sessionNameStore: {
    get(name: string): string | undefined;
    set(name: string, friendly: string): void;
  };
  watcher: {
    markSessionAsNew(name: string): void;
    refreshTmuxPaths(): Promise<void>;
    /** Remember the launched agent until its process is seen (optional). */
    noteSessionAgent?(name: string, agent: AgentId): void;
    /** Codex home handed to spawned Codex sessions as CODEX_HOME (optional). */
    getCodexHome?(): string;
    /** Account profiles (optional: without them every spawn uses the agent's default). */
    profiles?: Pick<ProfileRegistry, 'get' | 'defaultFor' | 'launchPlan'>;
    /** Remember the launched profile until the agent process is seen (optional). */
    noteSessionProfile?(name: string, profileId: string): void;
  };
  broadcast?: (type: string, payload: unknown) => void;
  log?: (line: string) => void;
}

export interface SessionSpawnResult {
  success: boolean;
  sessionName?: string;
  friendlyName?: string;
  error?: string;
}

export function dirToFriendlyName(dirPath: string): string {
  const base = path.basename(dirPath);
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A request's agent: a registered id, else the default (Claude). */
export function parseAgentId(raw: unknown): AgentId | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_AGENT_ID;
  return typeof raw === 'string' && (listAgentIds() as string[]).includes(raw)
    ? (raw as AgentId)
    : null;
}

/** Environment a launched agent needs in its tmux session. */
export function agentLaunchEnv(
  agent: AgentId | undefined,
  watcher: Pick<SessionSpawnDeps['watcher'], 'getCodexHome'>
): Record<string, string> {
  const t = getAgentAdapter(agent).terminal;
  return t.launchEnv ? t.launchEnv({ codexHome: watcher.getCodexHome?.() }) : {};
}

/**
 * A request's agent + account profile. `profileId` names a configured profile
 * (the agent follows it; an explicit agent that disagrees is refused); absent
 * = the agent's default profile.
 */
export function resolveSpawnProfile(
  profiles: Pick<ProfileRegistry, 'get'> | undefined,
  rawAgent: unknown,
  rawProfileId: unknown
): { agent: AgentId; profile?: AgentProfile } | { error: string } {
  const agent = parseAgentId(rawAgent);
  if (!agent) return { error: `Unknown agent: ${String(rawAgent).slice(0, 40)}` };
  if (rawProfileId === undefined || rawProfileId === null || rawProfileId === '') return { agent };
  const p = typeof rawProfileId === 'string' ? profiles?.get(rawProfileId) : undefined;
  if (!p) return { error: `Unknown profile: ${String(rawProfileId).slice(0, 40)}` };
  const explicit = rawAgent !== undefined && rawAgent !== null && rawAgent !== '';
  if (explicit && agent !== p.agent) {
    return { error: `Profile ${p.id} is a ${p.agent} profile, not ${agent}` };
  }
  return { agent: p.agent, profile: p };
}

/**
 * tmux env + env file for launching `agent` under `profile` (default: the
 * agent's default profile). The default Claude profile gets nothing (the
 * launch is exactly as before profiles); Codex always gets its CODEX_HOME.
 */
export async function agentLaunchOpts(
  agent: AgentId,
  profile: AgentProfile | undefined,
  watcher: Pick<SessionSpawnDeps['watcher'], 'getCodexHome' | 'profiles'>
): Promise<{ env?: Record<string, string>; envFile?: string }> {
  const reg = watcher.profiles;
  if (!reg) return agent !== DEFAULT_AGENT_ID ? { env: agentLaunchEnv(agent, watcher) } : {};
  const plan = await reg.launchPlan(profile ?? reg.defaultFor(agent));
  return {
    ...(Object.keys(plan.env).length ? { env: plan.env } : {}),
    ...(plan.envFile ? { envFile: plan.envFile } : {}),
  };
}

/** Command word each agent's launch line starts with. */
const AGENT_COMMANDS: Record<AgentId, string> = { claude: 'claude', codex: 'codex' };
const INSTALL_HINTS: Partial<Record<AgentId, string>> = {
  codex: 'npm install -g @openai/codex, then codex login',
};

/** The shell could not find `command` (bash, zsh, fish, dash/sh). */
export function agentCommandMissing(pane: string, command: string): boolean {
  const p = stripAnsi(pane || '');
  const c = command.replace(/[^a-z0-9_-]/gi, '');
  return new RegExp(
    `${c}: command not found|command not found: ${c}\\b|Unknown command:? '?${c}\\b|\\b${c}: not found`,
    'i'
  ).test(p);
}

/** How long a non-Claude launch is watched for a missing command (one-off, bounded). */
export const LAUNCH_CHECK_MS = 4000;
const LAUNCH_CHECK_STEP_MS = 500;

/**
 * Right after launching a non-Claude agent: watch its pane briefly (a few
 * bounded captures, stops as soon as the agent draws anything) for the shell
 * saying the command does not exist. Returns an error message, or null.
 */
async function checkAgentLaunch(
  deps: SessionSpawnDeps,
  sessionName: string,
  agent: AgentId,
  sleep: (ms: number) => Promise<void>
): Promise<string | null> {
  const capture = deps.tmux.capturePane?.bind(deps.tmux);
  if (!capture) return null;
  const terminal = getAgentAdapter(agent).terminal;
  const command = AGENT_COMMANDS[agent];
  for (let waited = 0; waited < LAUNCH_CHECK_MS; waited += LAUNCH_CHECK_STEP_MS) {
    await sleep(LAUNCH_CHECK_STEP_MS);
    let pane = '';
    try {
      pane = await capture(sessionName, 30);
    } catch {
      return null;
    }
    if (agentCommandMissing(pane, command)) {
      const name = getAgentAdapter(agent).displayName;
      const hint = INSTALL_HINTS[agent];
      return `${name} is not installed on this server (\`${command}\` not found in the tmux shell's PATH)${hint ? `. Install: ${hint}` : ''}`;
    }
    if (terminal.classifyStartupPane(pane) !== 'starting') return null;
  }
  return null;
}

export async function createAgentSession(
  deps: SessionSpawnDeps,
  req: {
    workingDir: string;
    name?: string;
    startCli?: boolean;
    agent?: AgentId;
    /** Account profile (its agent must equal `agent`; resolveSpawnProfile). */
    profile?: AgentProfile;
    /** 'default' = the agent's own approval prompts (no bypass). */
    permissionMode?: 'default' | ClaudePermissionMode;
  },
  opts: { sleep?: (ms: number) => Promise<void> } = {}
): Promise<SessionSpawnResult> {
  const log = deps.log || ((l: string) => console.log(l));
  if (!fs.existsSync(req.workingDir)) {
    return { success: false, error: `Directory does not exist: ${req.workingDir}` };
  }
  const sessionName = req.name || deps.tmux.generateSessionName(req.workingDir);
  const startCli = req.startCli !== false;
  const agent = req.profile?.agent ?? req.agent ?? DEFAULT_AGENT_ID;
  const profile = req.profile && !req.profile.isDefault ? req.profile : undefined;
  log(
    `Sessions: creating tmux session "${sessionName}" in ${req.workingDir}` +
      (agent !== DEFAULT_AGENT_ID ? ` (${agent})` : '') +
      (profile ? ` [profile ${profile.id}]` : '')
  );
  const permissionMode =
    startCli && req.permissionMode !== 'default' ? SPAWN_PERMISSION_MODE : undefined;
  const launch = await agentLaunchOpts(agent, req.profile, deps.watcher);
  const result = await deps.tmux.createSession(sessionName, req.workingDir, startCli, {
    permissionMode,
    ...(agent !== DEFAULT_AGENT_ID ? { agent } : {}),
    ...launch,
  });
  if (!result.success) return { success: false, error: result.error };
  if (startCli && agent !== DEFAULT_AGENT_ID) {
    const sleep = opts.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const launchError = await checkAgentLaunch(deps, sessionName, agent, sleep);
    if (launchError) {
      log(`Sessions: ${launchError}; removing "${sessionName}"`);
      await deps.tmux.killSession?.(sessionName).catch(() => undefined);
      return { success: false, error: launchError };
    }
  }
  deps.storeTmuxSessionConfig(sessionName, req.workingDir, startCli, {
    permissionMode,
    ...(agent !== DEFAULT_AGENT_ID ? { agent } : {}),
    ...(profile ? { profileId: profile.id } : {}),
  });
  if (startCli) deps.watcher.noteSessionAgent?.(sessionName, agent);
  if (profile) deps.watcher.noteSessionProfile?.(sessionName, profile.id);
  if (!deps.sessionNameStore.get(sessionName)) {
    deps.sessionNameStore.set(sessionName, dirToFriendlyName(req.workingDir));
  }
  deps.watcher.markSessionAsNew(sessionName);
  await deps.watcher.refreshTmuxPaths();
  deps.broadcast?.('tmux_sessions_changed', { action: 'created', sessionName });
  return {
    success: true,
    sessionName,
    friendlyName: deps.sessionNameStore.get(sessionName) || dirToFriendlyName(req.workingDir),
  };
}

/** The original name (every caller before Codex). */
export const createClaudeSession = createAgentSession;
