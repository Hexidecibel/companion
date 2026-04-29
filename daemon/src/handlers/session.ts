import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import { HandlerContext, MessageHandler } from '../handler-context';
import {
  extractHighlights,
  extractTasks,
  extractFileChanges,
  parseConversationChain,
  parseConversationFile,
} from '../parser';
import { WebSocketResponse } from '../types';
import {
  SLOW_OPERATION_THRESHOLD_MS,
  EXEC_OPERATION_TIMEOUT_MS,
  DEFAULT_SEARCH_RESULT_LIMIT,
  MAX_SEARCH_RESULT_LIMIT,
  SEARCH_SNIPPET_CONTEXT_CHARS,
  DEFAULT_SEARCH_SNIPPET_LENGTH,
  DEFAULT_HIGHLIGHTS_LIMIT,
} from '../constants';

const execAsync = promisify(exec);

/**
 * Resolve a sessionId to a tmux session name.
 */
async function resolveTmuxSession(ctx: HandlerContext, sessionId: string): Promise<string | null> {
  const tmuxSessions = await ctx.tmux.listSessions();
  if (tmuxSessions.some((ts) => ts.name === sessionId)) {
    return sessionId;
  }

  const status = ctx.watcher.getStatus(sessionId);
  if (status?.projectPath) {
    const match = tmuxSessions.find((ts) => ts.workingDir === status.projectPath);
    if (match) return match.name;
  }

  return null;
}

/**
 * Escape a string for safe use as a shell argument (single-quote wrapping).
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function registerSessionHandlers(
  ctx: HandlerContext
): Record<string, MessageHandler> {
  return {
    subscribe(client, payload, requestId) {
      const subscribePayload = payload as { sessionId?: string } | undefined;
      client.subscribed = true;
      if (subscribePayload?.sessionId) {
        client.subscribedSessionId = subscribePayload.sessionId;
      } else {
        client.subscribedSessionId = ctx.watcher.getActiveSessionId() || undefined;
      }
      console.log(
        `WebSocket: Client subscribed (${client.id}) to session ${client.subscribedSessionId}`
      );
      const sessions = ctx.watcher.getSessions();
      ctx.send(client.ws, {
        type: 'subscribed',
        success: true,
        sessionId: client.subscribedSessionId,
        sessions,
        requestId,
      } as WebSocketResponse);
    },

    unsubscribe(client, _payload, requestId) {
      client.subscribed = false;
      ctx.send(client.ws, {
        type: 'unsubscribed',
        success: true,
        requestId,
      });
    },

    get_highlights(client, payload, requestId) {
      const hlParams = payload as
        | { limit?: number; offset?: number; sessionId?: string }
        | undefined;
      const t0 = Date.now();
      const hlSessionId =
        hlParams?.sessionId || client.subscribedSessionId || ctx.watcher.getActiveSessionId();
      const limit = hlParams?.limit && hlParams.limit > 0 ? hlParams.limit : 0;
      const offset = hlParams?.offset || 0;

      let chain = hlSessionId ? ctx.watcher.getConversationChain(hlSessionId) : [];

      // If no chain found, try on-demand loading (conversation may exist on
      // disk but was skipped by the watcher's initial age filter)
      if (chain.length === 0 && hlSessionId) {
        if (ctx.watcher.ensureConversationLoaded(hlSessionId)) {
          chain = ctx.watcher.getConversationChain(hlSessionId);
        }
      }

      let resultHighlights: ReturnType<typeof extractHighlights>;
      let total: number;
      let hasMore: boolean;

      if (chain.length > 1 && limit > 0) {
        const result = parseConversationChain(chain, limit, offset);
        resultHighlights = result.highlights;
        total = result.total;
        hasMore = result.hasMore;
      } else {
        const messages = ctx.watcher.getMessages(hlSessionId || undefined);
        const allHighlights = extractHighlights(messages);
        total = allHighlights.length;

        if (limit > 0) {
          const startIdx = Math.max(0, total - offset - limit);
          const endIdx = total - offset;
          resultHighlights = allHighlights.slice(startIdx, endIdx);
          hasMore = startIdx > 0;
        } else {
          resultHighlights = allHighlights;
          hasMore = false;
        }
      }

      // Suppress approval options when session is actively running
      const sessionStatus = ctx.watcher.getStatus(hlSessionId || undefined);
      if (!sessionStatus.isWaitingForInput && resultHighlights.length > 0) {
        const last = resultHighlights[resultHighlights.length - 1];
        if (last.isWaitingForChoice && !last.questions) {
          resultHighlights[resultHighlights.length - 1] = {
            ...last,
            options: undefined,
            isWaitingForChoice: false,
          };
        }
      }

      // Inject pending sent messages that haven't appeared in JSONL yet
      const tmuxNameForPending = hlSessionId
        ? ctx.watcher.getTmuxSessionForConversation(hlSessionId)
        : null;
      if (tmuxNameForPending) {
        const pending = ctx.pendingSentMessages.get(tmuxNameForPending);
        if (pending && pending.length > 0) {
          const now = Date.now();
          const unconfirmed = pending.filter((p) => {
            if (now - p.sentAt > ctx.PENDING_SENT_TTL) return false;
            return !resultHighlights.some(
              (h) => h.type === 'user' && h.content.trim() === p.content.trim()
            );
          });
          ctx.pendingSentMessages.set(tmuxNameForPending, unconfirmed);

          for (const p of unconfirmed) {
            resultHighlights.push({
              id: p.clientMessageId,
              type: 'user' as const,
              content: p.content,
              timestamp: p.sentAt,
              isWaitingForChoice: false,
            });
          }
          total += unconfirmed.length;
        }
      }

      const t1 = Date.now();
      if (t1 - t0 > SLOW_OPERATION_THRESHOLD_MS) {
        console.log(
          `WebSocket: get_highlights - ${t1 - t0}ms (slow), chain: ${chain.length} files, returning ${resultHighlights.length}/${total}`
        );
      }
      ctx.send(client.ws, {
        type: 'highlights',
        success: true,
        payload: { highlights: resultHighlights, total, hasMore },
        sessionId: hlSessionId,
        requestId,
      } as WebSocketResponse);
    },

    get_full(client, payload, requestId) {
      const fullParams = payload as { sessionId?: string } | undefined;
      const t0 = Date.now();
      const fullSessionId =
        fullParams?.sessionId || client.subscribedSessionId || ctx.watcher.getActiveSessionId();
      const fullMessages = ctx.watcher.getMessages(fullSessionId || undefined);
      const t1 = Date.now();
      console.log(
        `WebSocket: get_full - getMessages: ${t1 - t0}ms, ${fullMessages.length} msgs, session: ${fullSessionId}`
      );
      ctx.send(client.ws, {
        type: 'full',
        success: true,
        payload: { messages: fullMessages },
        sessionId: fullSessionId,
        requestId,
      } as WebSocketResponse);
    },

    get_status(client, payload, requestId) {
      const statusParams = payload as { sessionId?: string } | undefined;
      const t0 = Date.now();
      const statusSessionId =
        statusParams?.sessionId ||
        client.subscribedSessionId ||
        ctx.watcher.getActiveSessionId();
      const status = ctx.watcher.getStatus(statusSessionId || undefined);
      const t1 = Date.now();
      console.log(
        `WebSocket: get_status - ${t1 - t0}ms - waiting: ${status.isWaitingForInput}, running: ${status.isRunning}, session: ${statusSessionId}`
      );

      ctx.send(client.ws, {
        type: 'status',
        success: true,
        payload: status,
        sessionId: statusSessionId,
        requestId,
      } as WebSocketResponse);
    },

    async get_server_summary(client, _payload, requestId) {
      try {
        const tmuxSessions = await ctx.tmux.listSessions();
        const summary = await ctx.watcher.getServerSummary(tmuxSessions);
        const friendlyNames = ctx.sessionNameStore.getAll();
        for (const session of summary.sessions) {
          const fn = friendlyNames[session.id];
          if (fn) (session as Record<string, unknown>).friendlyName = fn;
          if (ctx.subAgentWatcher) {
            const convInfo = ctx.watcher.getConversationInfo(session.id);
            if (convInfo) {
              const basename = convInfo.path.split('/').pop()?.replace('.jsonl', '');
              if (basename) {
                const tree = ctx.subAgentWatcher.getAgentTree([basename]);
                if (tree.totalAgents > 0) {
                  (session as Record<string, unknown>).subagentRunning = tree.runningCount;
                  (session as Record<string, unknown>).subagentTotal = tree.totalAgents;
                }
              }
            }
          }
        }
        ctx.send(client.ws, {
          type: 'server_summary',
          success: true,
          payload: summary,
          requestId,
        });
      } catch (err) {
        console.error('Failed to get server summary:', err);
        ctx.send(client.ws, {
          type: 'server_summary',
          success: false,
          error: 'Failed to get server summary',
          requestId,
        });
      }
    },

    get_sessions(client, _payload, requestId) {
      const sessions = ctx.watcher.getSessions();
      const activeSessionId = ctx.watcher.getActiveSessionId();
      ctx.send(client.ws, {
        type: 'sessions',
        success: true,
        payload: { sessions, activeSessionId },
        requestId,
      });
    },

    get_tasks(client, payload, requestId) {
      const tasksPayload = payload as { sessionId?: string } | undefined;
      const tasksSessionId = tasksPayload?.sessionId || ctx.watcher.getActiveSessionId();
      if (tasksSessionId) {
        const sessionSessions = ctx.watcher.getSessions();
        const session = sessionSessions.find((s) => s.id === tasksSessionId);
        if (session?.conversationPath) {
          try {
            const content = fs.readFileSync(session.conversationPath, 'utf-8');
            const tasks = extractTasks(content);
            ctx.send(client.ws, {
              type: 'tasks',
              success: true,
              payload: { tasks, sessionId: tasksSessionId },
              requestId,
            });
          } catch (err) {
            ctx.send(client.ws, {
              type: 'tasks',
              success: false,
              error: 'Failed to read session file',
              requestId,
            });
          }
        } else {
          ctx.send(client.ws, {
            type: 'tasks',
            success: true,
            payload: { tasks: [], sessionId: tasksSessionId },
            requestId,
          });
        }
      } else {
        ctx.send(client.ws, {
          type: 'tasks',
          success: false,
          error: 'No session specified',
          requestId,
        });
      }
    },

    async get_session_diff(client, payload, requestId) {
      const diffPayload = payload as { sessionId?: string } | undefined;
      const sessionId = diffPayload?.sessionId || ctx.watcher.getActiveSessionId();
      if (!sessionId) {
        ctx.send(client.ws, {
          type: 'session_diff',
          success: false,
          error: 'No session specified',
          requestId,
        });
        return;
      }

      const sessions = ctx.watcher.getSessions();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session?.conversationPath) {
        ctx.send(client.ws, {
          type: 'session_diff',
          success: true,
          payload: { fileChanges: [], sessionId },
          requestId,
        });
        return;
      }

      try {
        const content = fs.readFileSync(session.conversationPath, 'utf-8');
        const fileChanges = extractFileChanges(content);

        const workingDir = session.projectPath;
        if (workingDir && ctx.config.git) {
          const diffPromises = fileChanges.map(async (fc) => {
            try {
              const { stdout } = await execAsync(
                `git diff HEAD -- ${JSON.stringify(fc.path)} 2>/dev/null || git diff -- ${JSON.stringify(fc.path)} 2>/dev/null`,
                { cwd: workingDir, timeout: EXEC_OPERATION_TIMEOUT_MS }
              );
              return { ...fc, diff: stdout || undefined };
            } catch {
              return fc;
            }
          });
          const changesWithDiffs = await Promise.all(diffPromises);

          let untrackedFiles: Set<string> | undefined;
          try {
            const { stdout: statusOut } = await execAsync('git status --porcelain 2>/dev/null', {
              cwd: workingDir,
              timeout: EXEC_OPERATION_TIMEOUT_MS,
            });
            untrackedFiles = new Set(
              statusOut
                .split('\n')
                .filter((l) => l.startsWith('??'))
                .map((l) => l.slice(3).trim())
            );
          } catch {
            // If git status fails, skip filtering
          }

          const filtered = untrackedFiles
            ? changesWithDiffs.filter(
                (fc) => (fc as { diff?: string }).diff || untrackedFiles!.has(fc.path)
              )
            : changesWithDiffs;

          ctx.send(client.ws, {
            type: 'session_diff',
            success: true,
            payload: { fileChanges: filtered, sessionId },
            requestId,
          });
        } else {
          ctx.send(client.ws, {
            type: 'session_diff',
            success: true,
            payload: { fileChanges, sessionId },
            requestId,
          });
        }
      } catch (err) {
        ctx.send(client.ws, {
          type: 'session_diff',
          success: false,
          error: `Failed to get session diff: ${err}`,
          requestId,
        });
      }
    },

    async switch_session(client, payload, requestId) {
      const switchPayload = payload as { sessionId: string | null; epoch?: number } | undefined;

      // Clear subscription when sessionId is null
      if (switchPayload && switchPayload.sessionId === null) {
        client.subscribedSessionId = undefined;
        console.log('WebSocket: Cleared session subscription');
        ctx.send(client.ws, {
          type: 'session_switched',
          success: true,
          payload: { sessionId: null },
          requestId,
        });
        return;
      }

      if (!switchPayload?.sessionId) {
        ctx.send(client.ws, {
          type: 'session_switched',
          success: false,
          error: 'Missing sessionId',
          requestId,
        });
        return;
      }

      const { sessionId, epoch } = switchPayload;
      console.log(`WebSocket: Switching to session ${sessionId} (epoch: ${epoch})`);

      client.subscribedSessionId = sessionId;

      const tmuxName = await resolveTmuxSession(ctx, sessionId);
      if (tmuxName) {
        ctx.injector.setActiveSession(tmuxName);
      }

      ctx.send(client.ws, {
        type: 'session_switched',
        success: true,
        payload: {
          sessionId,
          tmuxSession: tmuxName || sessionId,
          epoch,
        },
        sessionId,
        requestId,
      } as WebSocketResponse);

      // Acknowledge session — user is viewing it, cancel push escalation
      ctx.escalation.acknowledgeSession(sessionId);
    },

    get_agent_tree(client, payload, requestId) {
      if (!ctx.subAgentWatcher) {
        ctx.send(client.ws, {
          type: 'agent_tree',
          success: false,
          error: 'Sub-agent watcher not initialized',
          requestId,
        });
        return;
      }

      const treePayload = payload as { sessionId?: string } | undefined;

      try {
        let sessionIds: string[] | undefined;
        if (treePayload?.sessionId) {
          const convInfo = ctx.watcher.getConversationInfo(treePayload.sessionId);
          if (convInfo) {
            const basename = convInfo.path.split('/').pop()?.replace('.jsonl', '');
            if (basename) sessionIds = [basename];
          }
          if (!sessionIds || sessionIds.length === 0) sessionIds = [treePayload.sessionId];
        }
        const tree = ctx.subAgentWatcher.getAgentTree(sessionIds);
        ctx.send(client.ws, {
          type: 'agent_tree',
          success: true,
          payload: tree,
          requestId,
        });
      } catch (err) {
        console.error('Failed to get agent tree:', err);
        ctx.send(client.ws, {
          type: 'agent_tree',
          success: false,
          error: 'Failed to get agent tree',
          requestId,
        });
      }
    },

    get_agent_detail(client, payload, requestId) {
      if (!ctx.subAgentWatcher) {
        ctx.send(client.ws, {
          type: 'agent_detail',
          success: false,
          error: 'Sub-agent watcher not initialized',
          requestId,
        });
        return;
      }

      const detailPayload = payload as { agentId: string } | undefined;
      if (!detailPayload?.agentId) {
        ctx.send(client.ws, {
          type: 'agent_detail',
          success: false,
          error: 'Missing agentId',
          requestId,
        });
        return;
      }

      try {
        const detail = ctx.subAgentWatcher.getAgentDetail(detailPayload.agentId);
        if (!detail) {
          ctx.send(client.ws, {
            type: 'agent_detail',
            success: false,
            error: 'Agent not found',
            requestId,
          });
          return;
        }

        ctx.send(client.ws, {
          type: 'agent_detail',
          success: true,
          payload: detail,
          requestId,
        });
      } catch (err) {
        console.error('Failed to get agent detail:', err);
        ctx.send(client.ws, {
          type: 'agent_detail',
          success: false,
          error: 'Failed to get agent detail',
          requestId,
        });
      }
    },

    async search_conversations(client, payload, requestId) {
      const searchPayload = payload as { query: string; limit?: number } | undefined;
      if (!searchPayload?.query || !searchPayload.query.trim()) {
        ctx.send(client.ws, {
          type: 'search_conversations',
          success: false,
          error: 'Missing query',
          requestId,
        });
        return;
      }

      const query = searchPayload.query.trim();
      const resultLimit = Math.min(searchPayload.limit || DEFAULT_SEARCH_RESULT_LIMIT, MAX_SEARCH_RESULT_LIMIT);

      try {
        const activeSessionId = ctx.watcher.getActiveSessionId();
        if (!activeSessionId) {
          ctx.send(client.ws, {
            type: 'search_conversations',
            success: true,
            payload: { results: [] },
            requestId,
          });
          return;
        }

        const sessions = ctx.watcher.getSessions();
        const activeSession = sessions.find((s) => s.id === activeSessionId);
        if (!activeSession?.conversationPath) {
          ctx.send(client.ws, {
            type: 'search_conversations',
            success: true,
            payload: { results: [] },
            requestId,
          });
          return;
        }

        const projectDir = path.dirname(activeSession.conversationPath);

        let files: { path: string; name: string; mtime: number }[];
        try {
          const entries = fs.readdirSync(projectDir);
          files = entries
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => {
              const fullPath = path.join(projectDir, f);
              try {
                const stats = fs.statSync(fullPath);
                return { path: fullPath, name: f, mtime: stats.mtimeMs };
              } catch {
                return null;
              }
            })
            .filter((f): f is { path: string; name: string; mtime: number } => f !== null)
            .sort((a, b) => b.mtime - a.mtime);
        } catch {
          files = [];
        }

        const escaped = shellEscape(query);
        const results: Array<{
          filePath: string;
          fileName: string;
          lastModified: number;
          snippet: string;
          matchCount: number;
        }> = [];

        for (const file of files) {
          if (results.length >= resultLimit) break;

          try {
            const { stdout: countOut } = await execAsync(
              `grep -i -c ${escaped} ${shellEscape(file.path)}`,
              { timeout: 3000 }
            ).catch((err) => {
              if (err.code === 1) return { stdout: '0' };
              throw err;
            });
            const matchCount = parseInt(countOut.trim(), 10);
            if (!matchCount || matchCount === 0) continue;

            const { stdout: matchOut } = await execAsync(
              `grep -i -m 5 ${escaped} ${shellEscape(file.path)}`,
              { timeout: 3000 }
            ).catch(() => ({ stdout: '' }));

            let snippet = '';
            const matchLines = matchOut.trim().split('\n').filter(Boolean);
            const lowerQuery = query.toLowerCase();
            for (const matchLine of matchLines) {
              try {
                const entry = JSON.parse(matchLine);
                const msg = entry.message;
                if (!msg?.content) continue;
                let text = '';
                if (typeof msg.content === 'string') {
                  text = msg.content;
                } else if (Array.isArray(msg.content)) {
                  text = msg.content
                    .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
                    .map((b: { text: string }) => b.text)
                    .join(' ');
                }
                if (!text.trim()) continue;
                const lowerText = text.toLowerCase();
                const idx = lowerText.indexOf(lowerQuery);
                if (idx >= 0) {
                  const start = Math.max(0, idx - SEARCH_SNIPPET_CONTEXT_CHARS);
                  const end = Math.min(text.length, idx + query.length + SEARCH_SNIPPET_CONTEXT_CHARS);
                  snippet =
                    (start > 0 ? '...' : '') +
                    text.slice(start, end).replace(/\n/g, ' ') +
                    (end < text.length ? '...' : '');
                } else {
                  snippet = text.slice(0, DEFAULT_SEARCH_SNIPPET_LENGTH).replace(/\n/g, ' ');
                }
                break;
              } catch {
                continue;
              }
            }

            results.push({
              filePath: file.path,
              fileName: file.name,
              lastModified: file.mtime,
              snippet,
              matchCount,
            });
          } catch {
            continue;
          }
        }

        ctx.send(client.ws, {
          type: 'search_conversations',
          success: true,
          payload: { results },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'search_conversations',
          success: false,
          error: String(err),
          requestId,
        });
      }
    },

    get_conversation_file(client, payload, requestId) {
      const filePayload = payload as { filePath: string; limit?: number; offset?: number } | undefined;
      if (!filePayload?.filePath) {
        ctx.send(client.ws, {
          type: 'conversation_file',
          success: false,
          error: 'Missing filePath',
          requestId,
        });
        return;
      }

      const projectsDir = path.join(ctx.config.codeHome, 'projects');
      const resolved = path.resolve(filePayload.filePath);
      if (!resolved.startsWith(projectsDir)) {
        ctx.send(client.ws, {
          type: 'conversation_file',
          success: false,
          error: 'Invalid file path',
          requestId,
        });
        return;
      }

      if (!fs.existsSync(resolved)) {
        ctx.send(client.ws, {
          type: 'conversation_file',
          success: false,
          error: 'File not found',
          requestId,
        });
        return;
      }

      try {
        const messages = parseConversationFile(resolved);
        const allHighlights = extractHighlights(messages);
        const total = allHighlights.length;
        const limit = filePayload.limit || DEFAULT_HIGHLIGHTS_LIMIT;
        const offset = filePayload.offset || 0;
        const startIdx = Math.max(0, total - offset - limit);
        const endIdx = Math.max(total - offset, 0);
        const highlights = allHighlights.slice(startIdx, endIdx);
        const hasMore = startIdx > 0;

        ctx.send(client.ws, {
          type: 'conversation_file',
          success: true,
          payload: { highlights, total, hasMore, filePath: resolved },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'conversation_file',
          success: false,
          error: String(err),
          requestId,
        });
      }
    },

    rename_session(client, payload, requestId) {
      const renamePayload = payload as { sessionId: string; name: string } | undefined;
      if (!renamePayload?.sessionId) {
        ctx.send(client.ws, {
          type: 'session_renamed',
          success: false,
          error: 'Missing sessionId',
          requestId,
        });
        return;
      }
      if (renamePayload.name) {
        ctx.sessionNameStore.set(renamePayload.sessionId, renamePayload.name);
      } else {
        ctx.sessionNameStore.delete(renamePayload.sessionId);
      }
      ctx.send(client.ws, {
        type: 'session_renamed',
        success: true,
        payload: { sessionId: renamePayload.sessionId, friendlyName: renamePayload.name || null },
        requestId,
      });
      ctx.broadcast('session_renamed', {
        sessionId: renamePayload.sessionId,
        friendlyName: renamePayload.name || null,
      });
    },

    async remove_session(client, payload, requestId) {
      const removePayload = payload as { sessionId: string } | undefined;
      if (!removePayload?.sessionId) {
        ctx.send(client.ws, {
          type: 'session_removed',
          success: false,
          error: 'Missing sessionId',
          requestId,
        });
        return;
      }

      const sessionId = removePayload.sessionId;
      console.log(`WebSocket: remove_session "${sessionId}"`);

      // Capture conversation file path BEFORE we forget the session — once
      // the watcher drops it, getConversationInfo() may not find it anymore.
      const convInfo = ctx.watcher.getConversationInfo(sessionId);
      const conversationPath = convInfo?.path;

      // Step 1: best-effort tmux kill (ignore "already dead").
      let tmuxKilled = false;
      try {
        const exists = await ctx.tmux.sessionExists(sessionId);
        if (exists) {
          const result = await ctx.tmux.killSession(sessionId);
          tmuxKilled = result.success;
          if (!result.success) {
            console.log(
              `WebSocket: remove_session tmux kill failed for "${sessionId}": ${result.error}`
            );
          }
          const tmuxConfig = ctx.tmuxSessionConfigs.get(sessionId);
          if (tmuxConfig?.isWorktree && tmuxConfig.mainRepoDir) {
            await ctx.tmux.removeWorktree(tmuxConfig.mainRepoDir, tmuxConfig.workingDir);
          }
        } else {
          console.log(`WebSocket: remove_session tmux session "${sessionId}" already gone`);
        }
      } catch (err) {
        console.log(`WebSocket: remove_session tmux check error: ${err}`);
      }

      // Step 2 & 3: drop persisted snapshot, conversations, mappings.
      const forgot = ctx.watcher.forgetSession(sessionId);

      // Drop friendly name + tmux session config too — these are session-bound.
      ctx.sessionNameStore.delete(sessionId);
      if (ctx.tmuxSessionConfigs.delete(sessionId)) {
        ctx.saveTmuxSessionConfigs();
      }
      ctx.autoApproveSessions.delete(sessionId);

      // Step 4: archive the JSONL by renaming with a `.removed` suffix.
      // The watcher's chokidar pattern is `*.jsonl` so `.jsonl.removed` is
      // outside the glob and will not be re-discovered.
      let jsonlArchived = false;
      let archivePath: string | undefined;
      if (conversationPath) {
        try {
          if (fs.existsSync(conversationPath)) {
            const ts = Date.now();
            archivePath = `${conversationPath}.${ts}.removed`;
            fs.renameSync(conversationPath, archivePath);
            jsonlArchived = true;
            console.log(`WebSocket: remove_session archived JSONL → ${archivePath}`);
          } else {
            console.log(`WebSocket: remove_session JSONL already missing: ${conversationPath}`);
          }
        } catch (err) {
          console.error(`WebSocket: remove_session failed to archive JSONL: ${err}`);
        }
      }

      ctx.send(client.ws, {
        type: 'session_removed',
        success: true,
        payload: {
          sessionId,
          tmuxKilled,
          persistedRemoved: forgot.persistedRemoved,
          conversationsRemoved: forgot.conversationsRemoved,
          mappingRemoved: forgot.mappingRemoved,
          jsonlArchived,
          archivePath,
        },
        requestId,
      });

      // Notify other connected clients so dashboards can refresh promptly.
      ctx.broadcast('session_removed', { sessionId });
      ctx.broadcast('tmux_sessions_changed', {
        action: 'removed',
        sessionName: sessionId,
      });
    },

    set_auto_approve(client, payload, requestId) {
      const autoApprovePayload = payload as { enabled: boolean; sessionId?: string };
      const targetSessionId = autoApprovePayload?.sessionId || ctx.watcher.getActiveSessionId();
      const enabled = autoApprovePayload?.enabled ?? false;

      if (targetSessionId) {
        if (enabled) {
          ctx.autoApproveSessions.add(targetSessionId);
        } else {
          ctx.autoApproveSessions.delete(targetSessionId);
        }
        console.log(
          `Auto-approve ${enabled ? 'enabled' : 'disabled'} for session ${targetSessionId} (${ctx.autoApproveSessions.size} sessions active)`
        );
      }

      ctx.send(client.ws, {
        type: 'auto_approve_set',
        success: true,
        payload: { enabled, sessionId: targetSessionId },
        requestId,
      });

      if (enabled && targetSessionId) {
        ctx.watcher.checkAndEmitPendingApproval(targetSessionId);
      }
    },

    set_bypass_permissions(client, payload, requestId) {
      const bypassPayload = payload as { enabled: boolean; sessionId?: string };
      const bypassSessionId = bypassPayload?.sessionId || ctx.watcher.getActiveSessionId();
      const bypassEnabled = bypassPayload?.enabled ?? false;

      if (!bypassSessionId) {
        ctx.send(client.ws, { type: 'bypass_permissions_set', success: false, error: 'No active session', requestId });
        return;
      }

      const convInfo = ctx.watcher.getConversationInfo(bypassSessionId);
      if (!convInfo?.projectPath) {
        ctx.send(client.ws, { type: 'bypass_permissions_set', success: false, error: 'No project path found', requestId });
        return;
      }

      try {
        const settingsDir = path.join(convInfo.projectPath, '.claude');
        const settingsPath = path.join(settingsDir, 'settings.json');

        if (bypassEnabled) {
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
        } else {
          if (fs.existsSync(settingsPath)) {
            let existing: Record<string, unknown> = {};
            try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { existing = {}; }
            const perms = (existing.permissions || {}) as Record<string, unknown>;
            delete perms.defaultMode;
            existing.permissions = perms;
            fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
          }
        }

        console.log(`Bypass permissions ${bypassEnabled ? 'enabled' : 'disabled'} for ${convInfo.projectPath}`);
        ctx.send(client.ws, { type: 'bypass_permissions_set', success: true, payload: { enabled: bypassEnabled, projectPath: convInfo.projectPath }, requestId });
      } catch (err) {
        console.error('Failed to set bypass permissions:', err);
        ctx.send(client.ws, { type: 'bypass_permissions_set', success: false, error: String(err), requestId });
      }
    },

    get_bypass_permissions(client, payload, requestId) {
      const getBypassPayload = payload as { sessionId?: string };
      const getBypassSessionId = getBypassPayload?.sessionId || ctx.watcher.getActiveSessionId();

      if (!getBypassSessionId) {
        ctx.send(client.ws, { type: 'bypass_permissions', success: true, payload: { enabled: false }, requestId });
        return;
      }

      const getConvInfo = ctx.watcher.getConversationInfo(getBypassSessionId);
      if (!getConvInfo?.projectPath) {
        ctx.send(client.ws, { type: 'bypass_permissions', success: true, payload: { enabled: false }, requestId });
        return;
      }

      try {
        const settingsPath = path.join(getConvInfo.projectPath, '.claude', 'settings.json');
        if (fs.existsSync(settingsPath)) {
          const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
          const mode = content?.permissions?.defaultMode;
          ctx.send(client.ws, { type: 'bypass_permissions', success: true, payload: { enabled: mode === 'bypassPermissions' }, requestId });
        } else {
          ctx.send(client.ws, { type: 'bypass_permissions', success: true, payload: { enabled: false }, requestId });
        }
      } catch {
        ctx.send(client.ws, { type: 'bypass_permissions', success: true, payload: { enabled: false }, requestId });
      }
    },

    client_error(client, payload, requestId) {
      const errorPayload = payload as {
        message: string;
        stack?: string;
        componentStack?: string;
        timestamp: number;
      };

      console.error('Client error:', errorPayload.message);
      if (errorPayload.stack) {
        console.error('Stack:', errorPayload.stack);
      }

      const error = {
        message: errorPayload.message,
        stack: errorPayload.stack,
        componentStack: errorPayload.componentStack,
        timestamp: errorPayload.timestamp || Date.now(),
        deviceId: client.deviceId,
      };

      ctx.clientErrors.unshift(error);
      if (ctx.clientErrors.length > ctx.MAX_CLIENT_ERRORS) {
        ctx.clientErrors.length = ctx.MAX_CLIENT_ERRORS;
      }

      ctx.send(client.ws, {
        type: 'client_error',
        success: true,
        requestId,
      });
    },

    get_client_errors(client, _payload, requestId) {
      ctx.send(client.ws, {
        type: 'client_errors',
        success: true,
        payload: {
          errors: ctx.clientErrors,
          count: ctx.clientErrors.length,
        },
        requestId,
      });
    },

    scroll_log(_client, payload, _requestId) {
      const logPayload = payload as { event: string; ts: number; [key: string]: unknown };
      ctx.scrollLogs.push(logPayload);
      if (ctx.scrollLogs.length > ctx.MAX_SCROLL_LOGS) {
        ctx.scrollLogs.length = ctx.MAX_SCROLL_LOGS;
      }
      console.log(`[SCROLL] ${logPayload.event}:`, JSON.stringify(logPayload));
    },

    get_scroll_logs(client, _payload, requestId) {
      ctx.send(client.ws, {
        type: 'scroll_logs',
        success: true,
        payload: {
          logs: ctx.scrollLogs,
          count: ctx.scrollLogs.length,
        },
        requestId,
      });
    },

    clear_scroll_logs(client, _payload, requestId) {
      ctx.scrollLogs.length = 0;
      ctx.send(client.ws, { type: 'scroll_logs_cleared', success: true, requestId });
    },
  };
}
