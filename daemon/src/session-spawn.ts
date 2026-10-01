/**
 * Creating a Claude Code session in a tmux session: the one path shared by the
 * app's `create_tmux_session` request and Herald's `propose_spawn_session`.
 *
 *   1. Pre-write bypass permissions into <dir>/.claude/settings.json (sessions
 *      created from Companion have no terminal for interactive approval).
 *   2. tmux new-session (tagged COMPANION_APP=1) and start `claude` in it.
 *   3. Remember its config (recreate), give it a friendly name, and tell the
 *      watcher about it.
 *
 * Callers decide what else happens (the app also makes it the active session;
 * Herald does not, so it never switches the user's view).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TmuxManager } from './tmux-manager';

export interface SessionSpawnDeps {
  tmux: Pick<TmuxManager, 'createSession' | 'generateSessionName'>;
  storeTmuxSessionConfig: (name: string, workingDir: string, startCli?: boolean) => void;
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

/** Bypass permissions for sessions started from Companion (merged into existing settings). */
export function prewriteBypassPermissions(workingDir: string): void {
  const settingsDir = path.join(workingDir, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const perms = (existing.permissions || {}) as Record<string, unknown>;
  perms.allow = perms.allow || [
    'Bash',
    'Edit',
    'Write',
    'Read',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
    'Task',
    'NotebookEdit',
  ];
  perms.defaultMode = 'bypassPermissions';
  existing.permissions = perms;
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
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
  if (startCli) {
    prewriteBypassPermissions(req.workingDir);
    log(`Sessions: pre-wrote bypass permissions for ${req.workingDir}`);
  }
  const result = await deps.tmux.createSession(sessionName, req.workingDir, startCli);
  if (!result.success) return { success: false, error: result.error };
  deps.storeTmuxSessionConfig(sessionName, req.workingDir, startCli);
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
