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

/** The permission mode app-spawned sessions run in. */
export const SPAWN_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface SessionSpawnDeps {
  tmux: Pick<TmuxManager, 'createSession' | 'generateSessionName'>;
  storeTmuxSessionConfig: (
    name: string,
    workingDir: string,
    startCli?: boolean,
    opts?: { permissionMode?: ClaudePermissionMode; agent?: AgentId }
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

export async function createAgentSession(
  deps: SessionSpawnDeps,
  req: {
    workingDir: string;
    name?: string;
    startCli?: boolean;
    agent?: AgentId;
    /** 'default' = the agent's own approval prompts (no bypass). */
    permissionMode?: 'default' | ClaudePermissionMode;
  }
): Promise<SessionSpawnResult> {
  const log = deps.log || ((l: string) => console.log(l));
  if (!fs.existsSync(req.workingDir)) {
    return { success: false, error: `Directory does not exist: ${req.workingDir}` };
  }
  const sessionName = req.name || deps.tmux.generateSessionName(req.workingDir);
  const startCli = req.startCli !== false;
  const agent = req.agent || DEFAULT_AGENT_ID;
  log(
    `Sessions: creating tmux session "${sessionName}" in ${req.workingDir}` +
      (agent !== DEFAULT_AGENT_ID ? ` (${agent})` : '')
  );
  const permissionMode =
    startCli && req.permissionMode !== 'default' ? SPAWN_PERMISSION_MODE : undefined;
  const result = await deps.tmux.createSession(sessionName, req.workingDir, startCli, {
    permissionMode,
    ...(agent !== DEFAULT_AGENT_ID ? { agent, env: agentLaunchEnv(agent, deps.watcher) } : {}),
  });
  if (!result.success) return { success: false, error: result.error };
  deps.storeTmuxSessionConfig(sessionName, req.workingDir, startCli, {
    permissionMode,
    ...(agent !== DEFAULT_AGENT_ID ? { agent } : {}),
  });
  if (startCli) deps.watcher.noteSessionAgent?.(sessionName, agent);
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
