import * as fs from 'fs';
import { HandlerContext, MessageHandler } from '../handler-context';
import { DEFAULT_TOOL_CONFIG } from '../tool-config';
import {
  DEFAULT_TERMINAL_LINES,
  CLI_READY_POLL_INTERVAL_MS,
  CLI_READY_TIMEOUT_MS,
} from '../constants';
import { createAgentSession, agentLaunchOpts, resolveSpawnProfile } from '../session-spawn';
import { getAgentAdapter } from '../agents';

export function registerTmuxHandlers(ctx: HandlerContext): Record<string, MessageHandler> {
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
          // Only surface a tappable choice prompt for the live view (offset 0);
          // paginated history captures should never drive the selector.
          const choicePrompt =
            (termPayload.offset || 0) === 0
              ? ctx.watcher
                  .agentFor(termPayload.sessionName)
                  .terminal.detectActiveChoicePrompt(output)
              : null;
          ctx.send(client.ws, {
            type: 'terminal_output',
            success: true,
            payload: { output, sessionName: termPayload.sessionName, choicePrompt },
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
          // The app's stop button / terminal-mode Ctrl+C send C-c. Codex quits
          // on Ctrl+C when idle (and opens a dialog when working); its
          // interrupt is Esc, so a lone C-c becomes the agent's interrupt.
          let keys = termKeysPayload.keys;
          const agent = ctx.watcher.agentFor(termKeysPayload.sessionName);
          if (agent.id !== 'claude' && keys.length === 1 && keys[0] === 'C-c') {
            keys = agent.terminal.interruptKeys().flatMap((k) => (k.type === 'key' ? [k.key] : []));
          }
          const ok = await ctx.tmux.sendRawKeys(termKeysPayload.sessionName, keys);
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
      const createPayload = payload as
        | {
            name?: string;
            workingDir: string;
            startCli?: boolean;
            /** Optional: 'claude' (default) | 'codex'. */
            agent?: string;
            /** Optional account profile id (the agent follows it). */
            profileId?: string;
            /** Optional: 'default' = the agent's own approval prompts instead of bypass. */
            permissionMode?: string;
          }
        | undefined;
      if (!createPayload?.workingDir) {
        ctx.send(client.ws, {
          type: 'tmux_session_created',
          success: false,
          error: 'Missing workingDir',
          requestId,
        });
        return;
      }
      const spawnRef = resolveSpawnProfile(
        ctx.watcher.profiles,
        createPayload.agent,
        createPayload.profileId
      );
      if ('error' in spawnRef) {
        ctx.send(client.ws, {
          type: 'tmux_session_created',
          success: false,
          error: spawnRef.error,
          requestId,
        });
        return;
      }
      const agent = spawnRef.agent;

      const result = await createAgentSession(
        {
          tmux: ctx.tmux,
          storeTmuxSessionConfig: ctx.storeTmuxSessionConfig,
          sessionNameStore: ctx.sessionNameStore,
          watcher: ctx.watcher,
        },
        {
          workingDir: createPayload.workingDir,
          name: createPayload.name,
          startCli: createPayload.startCli,
          agent,
          ...(spawnRef.profile ? { profile: spawnRef.profile } : {}),
          ...(createPayload.permissionMode === 'default'
            ? { permissionMode: 'default' as const }
            : {}),
        }
      );

      if (result.success && result.sessionName) {
        const sessionName = result.sessionName;
        ctx.injector.setActiveSession(sessionName);
        ctx.watcher.clearActiveSession();
        console.log(
          `WebSocket: Cleared active session after creating tmux session "${sessionName}"`
        );

        ctx.send(client.ws, {
          type: 'tmux_session_created',
          success: true,
          payload: {
            sessionName,
            workingDir: createPayload.workingDir,
            ...(agent !== 'claude' ? { agent } : {}),
            ...(spawnRef.profile && !spawnRef.profile.isDefault
              ? { profileId: spawnRef.profile.id }
              : {}),
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
      const scaffoldPayload = payload as
        | {
            workingDir: string;
            projectName: string;
            projectDescription?: string;
            templateName?: string;
            /** Optional: 'claude' (default) | 'codex'. */
            agent?: string;
            /** Optional account profile id (the agent follows it). */
            profileId?: string;
            /** Optional, Codex only: 'default' = Codex's own approval prompts instead of bypass. */
            permissionMode?: string;
          }
        | undefined;

      if (!scaffoldPayload?.workingDir || !scaffoldPayload?.projectName) {
        ctx.send(client.ws, {
          type: 'scaffold_session_opened',
          success: false,
          error: 'Missing workingDir or projectName',
          requestId,
        });
        return;
      }
      const scaffoldRef = resolveSpawnProfile(
        ctx.watcher.profiles,
        scaffoldPayload.agent,
        scaffoldPayload.profileId
      );
      if ('error' in scaffoldRef) {
        ctx.send(client.ws, {
          type: 'scaffold_session_opened',
          success: false,
          error: scaffoldRef.error,
          requestId,
        });
        return;
      }
      const agentId = scaffoldRef.agent;
      const scaffoldProfile =
        scaffoldRef.profile && !scaffoldRef.profile.isDefault ? scaffoldRef.profile : undefined;

      const sessionName = ctx.tmux.generateSessionName(scaffoldPayload.workingDir);
      console.log(
        `WebSocket: scaffold_open_session "${sessionName}" in ${scaffoldPayload.workingDir}` +
          (agentId !== 'claude' ? ` (${agentId})` : '')
      );

      let result: { success: boolean; error?: string };
      if (agentId === 'claude') {
        // Claude reads bypass from the project's .claude/settings.json (the scaffold wrote it).
        // Another account profile: its CLAUDE_CONFIG_DIR + env file (default: nothing).
        const launch = scaffoldProfile
          ? await agentLaunchOpts('claude', scaffoldProfile, ctx.watcher)
          : {};
        result = await ctx.tmux.createSession(
          sessionName,
          scaffoldPayload.workingDir,
          true,
          launch
        );
        if (result.success) {
          ctx.storeTmuxSessionConfig(
            sessionName,
            scaffoldPayload.workingDir,
            true,
            scaffoldProfile ? { profileId: scaffoldProfile.id } : undefined
          );
          if (scaffoldProfile) ctx.watcher.noteSessionProfile?.(sessionName, scaffoldProfile.id);
          ctx.watcher.markSessionAsNew(sessionName);
        }
      } else {
        // Same path as create_tmux_session: launch flag, CODEX_HOME, saved config
        // with the agent, friendly name, missing-command check.
        result = await createAgentSession(
          {
            tmux: ctx.tmux,
            storeTmuxSessionConfig: ctx.storeTmuxSessionConfig,
            sessionNameStore: ctx.sessionNameStore,
            watcher: ctx.watcher,
          },
          {
            workingDir: scaffoldPayload.workingDir,
            name: sessionName,
            agent: agentId,
            ...(scaffoldRef.profile ? { profile: scaffoldRef.profile } : {}),
            ...(scaffoldPayload.permissionMode === 'default'
              ? { permissionMode: 'default' as const }
              : {}),
          }
        );
      }

      if (!result.success) {
        ctx.send(client.ws, {
          type: 'scaffold_session_opened',
          success: false,
          error: result.error,
          requestId,
        });
        return;
      }

      ctx.injector.setActiveSession(sessionName);
      ctx.watcher.clearActiveSession();
      await ctx.watcher.refreshTmuxPaths();

      ctx.send(client.ws, {
        type: 'scaffold_session_opened',
        success: true,
        payload: {
          sessionName,
          workingDir: scaffoldPayload.workingDir,
          ...(agentId !== 'claude' ? { agent: agentId } : {}),
        },
        requestId,
      });
      ctx.broadcast('tmux_sessions_changed', { action: 'created', sessionName });

      // Fire-and-forget: poll for CLI readiness then inject initial message
      const { projectName, projectDescription, templateName } = scaffoldPayload;
      const terminal = getAgentAdapter(agentId).terminal;
      (async () => {
        const deadline = Date.now() + CLI_READY_TIMEOUT_MS;
        const promptRe = /[>$]\s*$/;
        const isReady = (pane: string) =>
          agentId === 'claude'
            ? promptRe.test(pane)
            : terminal.classifyStartupPane(pane) === 'ready';

        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, CLI_READY_POLL_INTERVAL_MS));
          try {
            const paneContent = await ctx.injector.capturePaneContent(sessionName);
            if (isReady(paneContent)) {
              console.log(`[SCAFFOLD] CLI ready in "${sessionName}", injecting initial message`);
              const templateNote = templateName
                ? ` The project has been scaffolded with the "${templateName}" template.`
                : '';
              const description = projectDescription ? ` ${projectDescription}` : '';
              const message =
                agentId === 'claude'
                  ? `I'm starting a new project called "${projectName}".${description}${templateNote} Please:\n1. Review the project structure and CLAUDE.md\n2. Create a prioritized todo list (TaskCreate) with concrete steps to accomplish the goal\n3. Begin working on the first task`
                  : `I'm starting a new project called "${projectName}".${description}${templateNote} Please: 1. Review the project structure and its notes (CLAUDE.md / README). 2. Make a short prioritized plan with concrete steps to accomplish the goal. 3. Begin working on the first step.`;
              await ctx.injector.sendInput(message, sessionName);
              return;
            }
          } catch (err) {
            console.log(`[SCAFFOLD] Poll error: ${err}`);
          }
        }
        console.log(
          `[SCAFFOLD] CLI readiness timeout for "${sessionName}" after ${CLI_READY_TIMEOUT_MS}ms`
        );
      })().catch((err) => console.error(`[SCAFFOLD] Unexpected error: ${err}`));
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
        // Keep what the session was started with (agent, permission mode): a
        // switch must not turn a saved Codex session back into Claude on recreate.
        const prev = ctx.tmuxSessionConfigs.get(switchPayload.sessionName);
        const same = prev && prev.workingDir === tmuxSession.workingDir;
        const seenAgent = ctx.watcher.agentFor(switchPayload.sessionName).id;
        const agentToKeep = seenAgent !== 'claude' ? seenAgent : same ? prev.agent : undefined;
        ctx.storeTmuxSessionConfig(switchPayload.sessionName, tmuxSession.workingDir, true, {
          ...(same && prev.permissionMode && (prev.agent || 'claude') === (agentToKeep || 'claude')
            ? { permissionMode: prev.permissionMode }
            : {}),
          ...(agentToKeep ? { agent: agentToKeep } : {}),
          ...(() => {
            // Keep the account profile the session runs under (else the saved one).
            const live = ctx.watcher.profileFor?.(switchPayload.sessionName);
            const keep =
              live && !live.isDefault
                ? live.id
                : same && (prev.agent || 'claude') === (agentToKeep || 'claude')
                  ? prev.profileId
                  : undefined;
            return keep ? { profileId: keep } : {};
          })(),
        });

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

      console.log(
        `WebSocket: Recreating tmux session "${sessionName}" in ${savedConfig.workingDir}`
      );

      const savedAgent =
        savedConfig.agent && savedConfig.agent !== 'claude' ? savedConfig.agent : undefined;
      // The saved account profile, if it still exists for that agent (else the default).
      const savedProfileRaw = ctx.watcher.profiles?.get(savedConfig.profileId);
      const savedProfile =
        savedProfileRaw &&
        !savedProfileRaw.isDefault &&
        savedProfileRaw.agent === (savedAgent || 'claude')
          ? savedProfileRaw
          : undefined;
      const launch =
        savedAgent || savedProfile
          ? await agentLaunchOpts(savedAgent || 'claude', savedProfile, ctx.watcher)
          : {};
      const result = await ctx.tmux.createSession(
        savedConfig.name,
        savedConfig.workingDir,
        savedConfig.startCli,
        {
          permissionMode: savedConfig.permissionMode,
          ...(savedAgent ? { agent: savedAgent } : {}),
          ...launch,
        }
      );

      if (result.success) {
        ctx.storeTmuxSessionConfig(savedConfig.name, savedConfig.workingDir, savedConfig.startCli, {
          permissionMode: savedConfig.permissionMode,
          ...(savedAgent ? { agent: savedAgent } : {}),
          ...(savedProfile ? { profileId: savedProfile.id } : {}),
        });
        if (savedAgent && savedConfig.startCli)
          ctx.watcher.noteSessionAgent(savedConfig.name, savedAgent);
        if (savedProfile) ctx.watcher.noteSessionProfile?.(savedConfig.name, savedProfile.id);
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

      const wtPayload = payload as
        | { parentDir: string; branch?: string; startCli?: boolean }
        | undefined;
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
