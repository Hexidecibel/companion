/**
 * Creating a Claude Code session in a tmux session: the one path shared by the
 * app's `create_tmux_session` request and Herald's `propose_spawn_session`.
 *
 *   1. tmux new-session (tagged COMPANION_APP=1) and start
 *      `claude --permission-mode bypassPermissions` in it (sessions created
 *      from Companion have no terminal for interactive approval). Nothing is
 *      written into the project's .claude/settings.json any more; settings an
 *      older version wrote there are left alone.
 *   2. Remember its config (recreate, with the same permission mode), give it
 *      a friendly name, and tell the watcher about it.
 *
 * Callers decide what else happens (the app also makes it the active session;
 * Herald does not, so it never switches the user's view).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TmuxManager, ClaudePermissionMode } from './tmux-manager';

/** The permission mode app-spawned sessions run in. */
export const SPAWN_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface SessionSpawnDeps {
  tmux: Pick<TmuxManager, 'createSession' | 'generateSessionName'>;
  storeTmuxSessionConfig: (
    name: string,
    workingDir: string,
    startCli?: boolean,
    opts?: { permissionMode?: ClaudePermissionMode }
  ) => void;
  sessionNameStore: {
    get(name: string): string | undefined;
    set(name: string, friendly: string): void;
  };
  watcher: { markSessionAsNew(name: string): void; refreshTmuxPaths(): Promise<void> };
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

export async function createClaudeSession(
  deps: SessionSpawnDeps,
  req: { workingDir: string; name?: string; startCli?: boolean }
): Promise<SessionSpawnResult> {
  const log = deps.log || ((l: string) => console.log(l));
  if (!fs.existsSync(req.workingDir)) {
    return { success: false, error: `Directory does not exist: ${req.workingDir}` };
  }
  const sessionName = req.name || deps.tmux.generateSessionName(req.workingDir);
  const startCli = req.startCli !== false;
  log(`Sessions: creating tmux session "${sessionName}" in ${req.workingDir}`);
  const permissionMode = startCli ? SPAWN_PERMISSION_MODE : undefined;
  const result = await deps.tmux.createSession(sessionName, req.workingDir, startCli, {
    permissionMode,
  });
  if (!result.success) return { success: false, error: result.error };
  deps.storeTmuxSessionConfig(sessionName, req.workingDir, startCli, { permissionMode });
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
