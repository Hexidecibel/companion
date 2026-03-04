import * as fs from 'fs';
import * as path from 'path';
import { HandlerContext, MessageHandler } from '../handler-context';
import { DEFAULT_TOOL_CONFIG } from '../tool-config';
import {
  DEFAULT_TERMINAL_LINES,
  CLI_READY_POLL_INTERVAL_MS,
  CLI_READY_TIMEOUT_MS,
} from '../constants';

function dirToFriendlyName(dirPath: string): string {
  const base = path.basename(dirPath);
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export function registerTmuxHandlers(
  ctx: HandlerContext
): Record<string, MessageHandler> {
  return {
    async list_tmux_sessions(client, _payload, requestId) {
      console.log('WebSocket: Received list_tmux_sessions request');
      try {
        const sessions = await ctx.tmux.listSessions();
        const activeSession = ctx.injector.getActiveSession();

        ctx.send(client.ws, {
          type: 'tmux_sessions',
          success: true,
          payload: {
            sessions,
            activeSession,
            homeDir: ctx.tmux.getHomeDir(),
          },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'tmux_sessions',
          success: false,
          error: 'Failed to list sessions',
          requestId,
        });
      }
    },

    async get_terminal_output(client, payload, requestId) {
      const termPayload = payload as
        | { sessionName: string; lines?: number; offset?: number }
        | undefined;
      if (termPayload?.sessionName) {
        try {
          const output = await ctx.tmux.capturePane(
            termPayload.sessionName,
            termPayload.lines || DEFAULT_TERMINAL_LINES,
            termPayload.offset || 0
          );
          ctx.send(client.ws, {
            type: 'terminal_output',
            success: true,
            payload: { output, sessionName: termPayload.sessionName },
            requestId,
          });
        } catch {
          ctx.send(client.ws, {
            type: 'terminal_output',
            success: false,
            error: 'Failed to capture terminal output',
            requestId,
          });
        }
      } else {
        ctx.send(client.ws, {
          type: 'terminal_output',
          success: false,
          error: 'Missing sessionName',
          requestId,
        });
      }
    },

    async send_terminal_text(client, payload, requestId) {
      const termTextPayload = payload as { sessionName: string; text: string } | undefined;
      if (termTextPayload?.sessionName && typeof termTextPayload.text === 'string') {
        try {
          const ok = await ctx.tmux.sendKeys(termTextPayload.sessionName, termTextPayload.text);
          if (ok) {
            const enterOk = await ctx.tmux.sendRawKeys(termTextPayload.sessionName, ['Enter']);
            ctx.send(client.ws, {
              type: 'terminal_text_sent',
              success: enterOk,
              error: enterOk ? undefined : 'Failed to send text',
              requestId,
            });
          } else {
            ctx.send(client.ws, {
              type: 'terminal_text_sent',
              success: false,
              error: 'Failed to send text',
              requestId,
            });
          }
        } catch {
          ctx.send(client.ws, {
            type: 'terminal_text_sent',
            success: false,
            error: 'Failed to send terminal text',
            requestId,
          });
        }
      } else {
        ctx.send(client.ws, {
          type: 'terminal_text_sent',
          success: false,
          error: 'Missing sessionName or text',
          requestId,
        });
      }
    },

    async send_terminal_keys(client, payload, requestId) {
      const termKeysPayload = payload as { sessionName: string; keys: string[] } | undefined;
      if (termKeysPayload?.sessionName && termKeysPayload.keys?.length) {
        try {
          const ok = await ctx.tmux.sendRawKeys(termKeysPayload.sessionName, termKeysPayload.keys);
          ctx.send(client.ws, {
            type: 'terminal_keys_sent',
            success: ok,
            error: ok ? undefined : 'Failed to send keys',
            requestId,
          });
        } catch {
          ctx.send(client.ws, {
            type: 'terminal_keys_sent',
            success: false,
            error: 'Failed to send terminal keys',
            requestId,
          });
        }
      } else {
        ctx.send(client.ws, {
          type: 'terminal_keys_sent',
          success: false,
          error: 'Missing sessionName or keys',
          requestId,
        });
      }
    },

    get_tool_config(client, _payload, requestId) {
      ctx.send(client.ws, {
        type: 'tool_config',
        success: true,
        payload: { tools: DEFAULT_TOOL_CONFIG },
        requestId,
      });
    },

    async create_tmux_session(client, payload, requestId) {
      const createPayload = payload as { name?: string; workingDir: string; startCli?: boolean } | undefined;
      if (!createPayload?.workingDir) {
        ctx.send(client.ws, {
          type: 'tmux_session_created',
          success: false,
          error: 'Missing workingDir',
          requestId,
        });
        return;
      }

      if (!fs.existsSync(createPayload.workingDir)) {
        ctx.send(client.ws, {
          type: 'tmux_session_created',
          success: false,
          error: `Directory does not exist: ${createPayload.workingDir}`,
          requestId,
        });
        return;
      }

      const sessionName = createPayload.name || ctx.tmux.generateSessionName(createPayload.workingDir);
      const startCli = createPayload.startCli !== false;

      console.log(`WebSocket: Creating tmux session "${sessionName}" in ${createPayload.workingDir}`);

      // Pre-write bypass permissions so Claude starts without prompting
      // Sessions created via Companion have no terminal for interactive approval
      if (startCli) {
        const settingsDir = path.join(createPayload.workingDir, '.claude');
        const settingsPath = path.join(settingsDir, 'settings.json');
        if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });
        let existing: Record<string, unknown> = {};
        if (fs.existsSync(settingsPath)) {
          try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { existing = {}; }
        }
        const perms = (existing.permissions || {}) as Record<string, unknown>;
        perms.allow = perms.allow || ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'];
        perms.defaultMode = 'bypassPermissions';
        existing.permissions = perms;
        fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
        console.log(`WebSocket: Pre-wrote bypass permissions for ${createPayload.workingDir}`);
      }

      const result = await ctx.tmux.createSession(sessionName, createPayload.workingDir, startCli);

      if (result.success) {
        ctx.storeTmuxSessionConfig(sessionName, createPayload.workingDir, startCli);
        // Auto-generate friendly name from directory if not already set
        if (!ctx.sessionNameStore.get(sessionName)) {
          ctx.sessionNameStore.set(sessionName, dirToFriendlyName(createPayload.workingDir));
        }
        ctx.injector.setActiveSession(sessionName);
        ctx.watcher.markSessionAsNew(sessionName);
        ctx.watcher.clearActiveSession();
        console.log(`WebSocket: Cleared active session after creating tmux session "${sessionName}"`);
        await ctx.watcher.refreshTmuxPaths();

        ctx.send(client.ws, {
          type: 'tmux_session_created',
          success: true,
          payload: {
            sessionName,
            workingDir: createPayload.workingDir,
          },
          requestId,
        });

        ctx.broadcast('tmux_sessions_changed', { action: 'created', sessionName });
      } else {
        ctx.send(client.ws, {
          type: 'tmux_session_created',
          success: false,
          error: result.error,
          requestId,
        });
      }
    },

    async scaffold_open_session(client, payload, requestId) {
      const scaffoldPayload = payload as {
        workingDir: string;
        projectName: string;
        projectDescription?: string;
        templateName?: string;
      } | undefined;

      if (!scaffoldPayload?.workingDir || !scaffoldPayload?.projectName) {
        ctx.send(client.ws, {
          type: 'scaffold_session_opened',
          success: false,
          error: 'Missing workingDir or projectName',
          requestId,
        });
        return;
      }

      const sessionName = ctx.tmux.generateSessionName(scaffoldPayload.workingDir);
      console.log(`WebSocket: scaffold_open_session "${sessionName}" in ${scaffoldPayload.workingDir}`);

      const result = await ctx.tmux.createSession(sessionName, scaffoldPayload.workingDir, true);

      if (!result.success) {
        ctx.send(client.ws, {
          type: 'scaffold_session_opened',
          success: false,
          error: result.error,
          requestId,
        });
        return;
      }

      ctx.storeTmuxSessionConfig(sessionName, scaffoldPayload.workingDir, true);
      ctx.injector.setActiveSession(sessionName);
      ctx.watcher.markSessionAsNew(sessionName);
      ctx.watcher.clearActiveSession();
      await ctx.watcher.refreshTmuxPaths();

      ctx.send(client.ws, {
        type: 'scaffold_session_opened',
        success: true,
        payload: { sessionName, workingDir: scaffoldPayload.workingDir },
        requestId,
      });
      ctx.broadcast('tmux_sessions_changed', { action: 'created', sessionName });

      // Fire-and-forget: poll for CLI readiness then inject initial message
      const { projectName, projectDescription, templateName } = scaffoldPayload;
      (async () => {
        const deadline = Date.now() + CLI_READY_TIMEOUT_MS;
        const promptRe = /[>$]\s*$/;

        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, CLI_READY_POLL_INTERVAL_MS));
          try {
            const paneContent = await ctx.injector.capturePaneContent(sessionName);
            if (promptRe.test(paneContent)) {
              console.log(`[SCAFFOLD] CLI ready in "${sessionName}", injecting initial message`);
              const templateNote = templateName ? ` The project has been scaffolded with the "${templateName}" template.` : '';
              const description = projectDescription ? ` ${projectDescription}` : '';
              const message = `I'm starting a new project called "${projectName}".${description}${templateNote} Please:\n1. Review the project structure and CLAUDE.md\n2. Create a prioritized todo list (TaskCreate) with concrete steps to accomplish the goal\n3. Begin working on the first task`;
              await ctx.injector.sendInput(message, sessionName);
              return;
            }
          } catch (err) {
            console.log(`[SCAFFOLD] Poll error: ${err}`);
          }
        }
        console.log(`[SCAFFOLD] CLI readiness timeout for "${sessionName}" after ${CLI_READY_TIMEOUT_MS}ms`);
      })().catch(err => console.error(`[SCAFFOLD] Unexpected error: ${err}`));
    },

    async kill_tmux_session(client, payload, requestId) {
      const killPayload = payload as { sessionName: string } | undefined;
      if (!killPayload?.sessionName) {
        ctx.send(client.ws, {
          type: 'tmux_session_killed',
          success: false,
          error: 'Missing sessionName',
          requestId,
        });
        return;
      }

      console.log(`WebSocket: Killing tmux session "${killPayload.sessionName}"`);

      const result = await ctx.tmux.killSession(killPayload.sessionName);

      if (result.success) {
        const config = ctx.tmuxSessionConfigs.get(killPayload.sessionName);
        if (config?.isWorktree && config.mainRepoDir) {
          console.log(`WebSocket: Cleaning up worktree at ${config.workingDir}`);
          await ctx.tmux.removeWorktree(config.mainRepoDir, config.workingDir);
        }

        if (ctx.injector.getActiveSession() === killPayload.sessionName) {
          const remaining = await ctx.tmux.listSessions();
          if (remaining.length > 0) {
            ctx.injector.setActiveSession(remaining[0].name);
          }
        }

        ctx.send(client.ws, {
          type: 'tmux_session_killed',
          success: true,
          payload: { sessionName: killPayload.sessionName },
          requestId,
        });

        ctx.broadcast('tmux_sessions_changed', {
          action: 'killed',
          sessionName: killPayload.sessionName,
        });
      } else {
        ctx.send(client.ws, {
          type: 'tmux_session_killed',
          success: false,
          error: result.error,
          requestId,
        });
      }
    },

    async switch_tmux_session(client, payload, requestId) {
      const switchPayload = payload as { sessionName: string } | undefined;
      if (!switchPayload?.sessionName) {
        ctx.send(client.ws, {
          type: 'tmux_session_switched',
          success: false,
          error: 'Missing sessionName',
          requestId,
        });
        return;
      }

      const exists = await ctx.tmux.sessionExists(switchPayload.sessionName);
      if (!exists) {
        ctx.send(client.ws, {
          type: 'tmux_session_switched',
          success: false,
          error: `Session "${switchPayload.sessionName}" does not exist`,
          requestId,
        });
        return;
      }

      ctx.injector.setActiveSession(switchPayload.sessionName);
      console.log(`WebSocket: Switched to tmux session "${switchPayload.sessionName}"`);

      await ctx.tmux.tagSession(switchPayload.sessionName);
      await ctx.watcher.refreshTmuxPaths();

      const sessions = await ctx.tmux.listSessions();
      const tmuxSession = sessions.find((s) => s.name === switchPayload.sessionName);
      let conversationSessionId: string | undefined;

      if (tmuxSession?.workingDir) {
        ctx.storeTmuxSessionConfig(switchPayload.sessionName, tmuxSession.workingDir, true);

        const convSessions = ctx.watcher.getSessions();
        const matchingConv = convSessions.find((cs) => cs.projectPath === tmuxSession!.workingDir);

        if (matchingConv) {
          ctx.watcher.setActiveSession(matchingConv.id);
          conversationSessionId = matchingConv.id;
          console.log(
            `WebSocket: Switched conversation to "${matchingConv.id}" for project ${tmuxSession.workingDir}`
          );
        } else {
          ctx.watcher.clearActiveSession();
          console.log(
            `WebSocket: No conversation found for ${tmuxSession!.workingDir}, cleared active session. Available: ${convSessions.map((c) => c.id).join(', ')}`
          );
        }
      } else {
        ctx.watcher.clearActiveSession();
        console.log(`WebSocket: No working directory for tmux session, cleared active session`);
      }

      ctx.send(client.ws, {
        type: 'tmux_session_switched',
        success: true,
        payload: {
          sessionName: switchPayload.sessionName,
          conversationSessionId,
        },
        requestId,
      });
    },

    async recreate_tmux_session(client, payload, requestId) {
      const recreatePayload = payload as { sessionName?: string } | undefined;
      const sessionName = recreatePayload?.sessionName || ctx.injector.getActiveSession();
      const savedConfig = ctx.tmuxSessionConfigs.get(sessionName);

      if (!savedConfig) {
        ctx.send(client.ws, {
          type: 'tmux_session_recreated',
          success: false,
          error: `No saved configuration for session "${sessionName}"`,
          requestId,
        });
        return;
      }

      if (!fs.existsSync(savedConfig.workingDir)) {
        ctx.send(client.ws, {
          type: 'tmux_session_recreated',
          success: false,
          error: `Working directory no longer exists: ${savedConfig.workingDir}`,
          requestId,
        });
        return;
      }

      const exists = await ctx.tmux.sessionExists(sessionName);
      if (exists) {
        ctx.send(client.ws, {
          type: 'tmux_session_recreated',
          success: true,
          payload: {
            sessionName,
            workingDir: savedConfig.workingDir,
            alreadyExisted: true,
          },
          requestId,
        });
        return;
      }

      console.log(`WebSocket: Recreating tmux session "${sessionName}" in ${savedConfig.workingDir}`);

      const result = await ctx.tmux.createSession(
        savedConfig.name,
        savedConfig.workingDir,
        savedConfig.startCli
      );

      if (result.success) {
        ctx.storeTmuxSessionConfig(savedConfig.name, savedConfig.workingDir, savedConfig.startCli);
        ctx.injector.setActiveSession(sessionName);

        ctx.send(client.ws, {
          type: 'tmux_session_recreated',
          success: true,
          payload: {
            sessionName,
            workingDir: savedConfig.workingDir,
          },
          requestId,
        });

        ctx.broadcast('tmux_sessions_changed', { action: 'recreated', sessionName });
      } else {
        ctx.send(client.ws, {
          type: 'tmux_session_recreated',
          success: false,
          error: result.error,
          requestId,
        });
      }
    },

    async create_worktree_session(client, payload, requestId) {
      if (!ctx.config.git) {
        ctx.send(client.ws, {
          type: 'worktree_session_created',
          success: false,
          error: 'Git integration is disabled',
          requestId,
        });
        return;
      }

      const wtPayload = payload as { parentDir: string; branch?: string; startCli?: boolean } | undefined;
      if (!wtPayload?.parentDir) {
        ctx.send(client.ws, {
          type: 'worktree_session_created',
          success: false,
          error: 'Missing parentDir',
          requestId,
        });
        return;
      }

      if (!(await ctx.tmux.isGitRepo(wtPayload.parentDir))) {
        ctx.send(client.ws, {
          type: 'worktree_session_created',
          success: false,
          error: 'Not a git repository',
          requestId,
        });
        return;
      }

      console.log(
        `WebSocket: Creating worktree session from ${wtPayload.parentDir}, branch: ${wtPayload.branch || 'auto'}`
      );

      const wtResult = await ctx.tmux.createWorktree(wtPayload.parentDir, wtPayload.branch);
      if (!wtResult.success || !wtResult.worktreePath) {
        ctx.send(client.ws, {
          type: 'worktree_session_created',
          success: false,
          error: wtResult.error || 'Failed to create worktree',
          requestId,
        });
        return;
      }

      const sessionName = ctx.tmux.generateSessionName(wtResult.worktreePath);
      const startCli = wtPayload.startCli !== false;
      const tmuxResult = await ctx.tmux.createSession(sessionName, wtResult.worktreePath, startCli);

      if (tmuxResult.success) {
        ctx.storeTmuxSessionConfig(sessionName, wtResult.worktreePath, startCli);

        const configs = ctx.tmuxSessionConfigs;
        const config = configs.get(sessionName);
        if (config) {
          config.isWorktree = true;
          config.mainRepoDir = wtPayload.parentDir;
          config.branch = wtResult.branch;
          ctx.saveTmuxSessionConfigs();
        }

        ctx.injector.setActiveSession(sessionName);
        ctx.watcher.clearActiveSession();
        await ctx.watcher.refreshTmuxPaths();

        ctx.send(client.ws, {
          type: 'worktree_session_created',
          success: true,
          payload: {
            sessionName,
            workingDir: wtResult.worktreePath,
            branch: wtResult.branch,
            mainRepoDir: wtPayload.parentDir,
          },
          requestId,
        });

        ctx.broadcast('tmux_sessions_changed', {
          action: 'created',
          sessionName,
          isWorktree: true,
          branch: wtResult.branch,
        });
      } else {
        await ctx.tmux.removeWorktree(wtPayload.parentDir, wtResult.worktreePath);
        ctx.send(client.ws, {
          type: 'worktree_session_created',
          success: false,
          error: tmuxResult.error || 'Failed to create tmux session',
          requestId,
        });
      }
    },

    async list_worktrees(client, payload, requestId) {
      if (!ctx.config.git) {
        ctx.send(client.ws, {
          type: 'worktrees_list',
          success: true,
          payload: { worktrees: [] },
          requestId,
        });
        return;
      }

      const listPayload = payload as { dir: string } | undefined;
      if (!listPayload?.dir) {
        ctx.send(client.ws, {
          type: 'worktrees_list',
          success: false,
          error: 'Missing dir',
          requestId,
        });
        return;
      }

      const worktrees = await ctx.tmux.listWorktrees(listPayload.dir);
      ctx.send(client.ws, {
        type: 'worktrees_list',
        success: true,
        payload: { worktrees },
        requestId,
      });
    },
  };
}
