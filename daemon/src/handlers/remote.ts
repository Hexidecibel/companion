import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn, spawnSync } from 'child_process';
import { HandlerContext, MessageHandler, AuthenticatedClient } from '../handler-context';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const daemonPackage = require('../../package.json');

interface CapabilitiesResponse {
  daemonVersion: string;
  protocolVersion: 1;
  remoteCapabilities: {
    enabled: boolean;
    exec: boolean;
    dispatch: boolean;
    write: { enabled: boolean; roots: string[] };
  };
}

interface DispatchSpawnPayload {
  prompt?: string;
  cwd?: string;
  sessionName?: string;
  oneShot?: boolean;
}

interface DispatchSpawnResult {
  tmuxSessionName: string;
  createdAt: number;
  sessionId: string | null;
  claudePath: string;
}

interface ExecCommandPayload {
  command?: string;
  cwd?: string;
  timeout?: number;
}

interface ExecCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  signal: string | null;
}

interface WriteFilePayload {
  path?: string;
  content?: string;
  encoding?: 'utf8' | 'base64';
  createDirs?: boolean;
}

interface WriteFileResult {
  path: string;
  bytesWritten: number;
}

const DISPATCH_RESPONSE_TYPE = 'remote_dispatch_spawned';
const EXEC_RESPONSE_TYPE = 'command_executed';
const WRITE_RESPONSE_TYPE = 'file_written';
const AUDIT_LOG_RESPONSE_TYPE = 'audit_log';
const SESSION_ID_WAIT_MS = 5000;
const POST_SPAWN_DELAY_MS = 300;
const CLAUDE_READY_TIMEOUT_MS = 10_000;
const CLAUDE_READY_POLL_INTERVAL_MS = 250;
const TMUX_CAPTURE_TIMEOUT_MS = 2_000;
const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
const EXEC_MAX_TIMEOUT_MS = 300_000;
const EXEC_OUTPUT_CAP_BYTES = 1_048_576;
const EXEC_KILL_GRACE_MS = 2_000;
const AUDIT_LOG_DEFAULT_LIMIT = 200;
const AUDIT_LOG_MAX_LIMIT = 1000;

function getOrigin(client: AuthenticatedClient, listenerTls: boolean) {
  const remoteAddr =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((client.ws as any)?._socket?.remoteAddress as string | undefined) || '';
  return {
    addr: remoteAddr,
    clientId: client.id,
    isLocal: client.isLocal,
    tls: listenerTls,
    origin: client.origin,
  };
}

function isCwdAllowed(ctx: HandlerContext, cwd: string): boolean {
  const homeDir = ctx.tmux.getHomeDir();
  const resolved = path.normalize(path.resolve(cwd));
  const configPaths = (ctx.config.allowedPaths || []).map((p) => path.normalize(p));
  const allowedPaths = [homeDir, '/tmp', '/var/tmp', ...configPaths];
  return allowedPaths.some((allowed) => resolved.startsWith(allowed));
}

function isUnderRoot(resolved: string, root: string): boolean {
  const normalizedRoot = path.resolve(root);
  if (resolved === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  return resolved.startsWith(prefix);
}

async function uniqueSessionName(ctx: HandlerContext, base: string): Promise<string> {
  let candidate = base;
  let n = 1;
  while (await ctx.tmux.sessionExists(candidate)) {
    candidate = `${base}-d${n}`;
    n++;
    if (n > 100) break;
  }
  return candidate;
}

/**
 * Poll the tmux pane until Claude's REPL is ready to receive input, or until
 * `timeoutMs` elapses. Looks for the prompt character or other stable startup
 * markers. Returns true if readiness was detected, false on timeout.
 */
async function waitForClaudeReady(sessionName: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const readyMarkers = ['❯', 'for shortcuts', 'Try "', 'shortcuts'];
  while (Date.now() < deadline) {
    const result = spawnSync(
      'tmux',
      ['capture-pane', '-t', sessionName, '-p', '-S', '-200'],
      { timeout: TMUX_CAPTURE_TIMEOUT_MS }
    );
    if (result.status === 0) {
      const pane = (result.stdout?.toString() || '');
      if (readyMarkers.some((m) => pane.includes(m))) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, CLAUDE_READY_POLL_INTERVAL_MS));
  }
  return false;
}

export function registerRemoteHandlers(
  ctx: HandlerContext
): Record<string, MessageHandler> {
  return {
    get_capabilities(client, _payload, requestId) {
      const listener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
      const caps = listener?.remoteCapabilities;
      const masterEnabled = Boolean(caps?.enabled);

      const payload: CapabilitiesResponse = {
        daemonVersion: String(daemonPackage.version || '0.0.0'),
        protocolVersion: 1,
        remoteCapabilities: {
          enabled: masterEnabled,
          exec: masterEnabled && Boolean(caps?.exec?.enabled),
          dispatch: masterEnabled && Boolean(caps?.dispatch?.enabled),
          write: {
            enabled: masterEnabled && Boolean(caps?.write?.enabled),
            roots: masterEnabled && caps?.write?.enabled ? caps?.write?.roots ?? [] : [],
          },
        },
      };

      ctx.send(client.ws, {
        type: 'capabilities',
        success: true,
        payload,
        requestId,
      });
    },

    async remote_dispatch_spawn(client, payload, requestId) {
      const startedAt = Date.now();
      const listener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
      const listenerTls = Boolean(listener?.tls);
      const dispatchPayload = (payload || {}) as DispatchSpawnPayload;
      const prompt = typeof dispatchPayload.prompt === 'string' ? dispatchPayload.prompt : '';
      const cwd = typeof dispatchPayload.cwd === 'string' ? dispatchPayload.cwd : '';
      const requestedName =
        typeof dispatchPayload.sessionName === 'string' && dispatchPayload.sessionName
          ? dispatchPayload.sessionName
          : undefined;
      const oneShot = dispatchPayload.oneShot === true;

      const auditPayload = {
        promptLength: prompt.length,
        cwd,
        sessionName: requestedName,
        oneShot,
      };

      const sendError = (errorCode: string, extra?: Record<string, unknown>) => {
        ctx.send(client.ws, {
          type: DISPATCH_RESPONSE_TYPE,
          success: false,
          error: errorCode,
          payload: extra,
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'remote_dispatch_spawn',
          payload: auditPayload,
          result: { ok: false, error: errorCode, ...(extra || {}) },
          durationMs: Date.now() - startedAt,
        });
      };

      const capError = ctx.requireRemoteCapability(client, 'dispatch');
      if (capError) {
        sendError(capError);
        return;
      }

      const retryAfterMs = ctx.rateLimiter.check(client.id, 'dispatch');
      if (retryAfterMs !== null) {
        ctx.send(client.ws, {
          type: DISPATCH_RESPONSE_TYPE,
          success: false,
          error: 'rate_limited',
          payload: { retryAfterMs },
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'remote_dispatch_spawn',
          payload: auditPayload,
          result: { ok: false, reason: 'rate_limited', retryAfterMs },
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (!prompt) {
        sendError('invalid_payload', { detail: 'Missing prompt' });
        return;
      }
      if (!cwd) {
        sendError('invalid_payload', { detail: 'Missing cwd' });
        return;
      }

      if (!isCwdAllowed(ctx, cwd)) {
        sendError('invalid_cwd', { cwd });
        return;
      }

      let claudePath: string;
      try {
        const out = execSync('which claude', { encoding: 'utf-8' });
        claudePath = out.trim();
        if (!claudePath) throw new Error('empty which output');
      } catch {
        sendError('claude_not_found', { searchedPath: process.env.PATH || '' });
        return;
      }

      const baseName = requestedName || ctx.tmux.generateSessionName(cwd);
      const tmuxSessionName = await uniqueSessionName(ctx, baseName);

      if (oneShot) {
        // Headless mode: launch claude -p "<prompt>" directly as the tmux window
        // command so the session auto-terminates when claude prints its response
        // and exits. No REPL injection; no readiness polling.
        const safeName = tmuxSessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
        // Single-quote escape the prompt for /bin/sh:  ' -> '\''
        const shQuoted = `'${prompt.replace(/'/g, `'\\''`)}'`;
        // Use the resolved absolute claude path so PATH differences between
        // the daemon's environment and an interactive shell don't matter.
        const shCmd = `${claudePath} -p ${shQuoted}`;
        try {
          execSync(
            `tmux new-session -d -s "${safeName}" -c "${cwd}" ${JSON.stringify(shCmd)}`,
            { stdio: 'pipe' }
          );
          execSync(`tmux set-environment -t "${safeName}" COMPANION_APP 1`, { stdio: 'pipe' });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendError('tmux_create_failed', { detail: message });
          return;
        }

        ctx.storeTmuxSessionConfig(tmuxSessionName, cwd, true);
        ctx.watcher.markSessionAsNew(tmuxSessionName);
        await ctx.watcher.refreshTmuxPaths();
        ctx.broadcast('tmux_sessions_changed', { action: 'created', sessionName: tmuxSessionName });

        // Try to resolve sessionId from the watcher. Short window — for a
        // very fast-completing prompt the session may die before the JSONL
        // file is observed. Null is an acceptable result per design.
        const sessionId = await ctx.watcher.waitForSessionInCwd(cwd, SESSION_ID_WAIT_MS);

        const result: DispatchSpawnResult = {
          tmuxSessionName,
          createdAt: startedAt,
          sessionId,
          claudePath,
        };

        ctx.send(client.ws, {
          type: DISPATCH_RESPONSE_TYPE,
          success: true,
          payload: result,
          requestId,
        });

        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'remote_dispatch_spawn',
          payload: auditPayload,
          result: {
            ok: true,
            tmuxSessionName,
            sessionId,
            oneShot: true,
          },
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      const createResult = await ctx.tmux.createSession(tmuxSessionName, cwd, true);
      if (!createResult.success) {
        sendError('tmux_create_failed', { detail: createResult.error });
        return;
      }

      ctx.storeTmuxSessionConfig(tmuxSessionName, cwd, true);
      // TODO(phase4): tag TmuxSessionConfig with remoteDispatch metadata for TTL cleanup
      ctx.injector.setActiveSession(tmuxSessionName);
      ctx.watcher.markSessionAsNew(tmuxSessionName);
      await ctx.watcher.refreshTmuxPaths();
      ctx.broadcast('tmux_sessions_changed', { action: 'created', sessionName: tmuxSessionName });

      await new Promise((resolve) => setTimeout(resolve, POST_SPAWN_DELAY_MS));
      const ready = await waitForClaudeReady(tmuxSessionName, CLAUDE_READY_TIMEOUT_MS);
      if (!ready) {
        console.warn(
          `[remote_dispatch_spawn] Claude readiness not detected in ${tmuxSessionName} after ${CLAUDE_READY_TIMEOUT_MS}ms; attempting injection anyway`
        );
      }
      await ctx.injector.sendInput(prompt, tmuxSessionName);

      const sessionId = await ctx.watcher.waitForSessionInCwd(cwd, SESSION_ID_WAIT_MS);

      const result: DispatchSpawnResult = {
        tmuxSessionName,
        createdAt: startedAt,
        sessionId,
        claudePath,
      };

      ctx.send(client.ws, {
        type: DISPATCH_RESPONSE_TYPE,
        success: true,
        payload: result,
        requestId,
      });

      ctx.auditLog.append({
        ts: startedAt,
        origin: getOrigin(client, listenerTls),
        action: 'remote_dispatch_spawn',
        payload: auditPayload,
        result: {
          ok: true,
          tmuxSessionName,
          sessionId,
        },
        durationMs: Date.now() - startedAt,
      });
    },

    async exec_command(client, payload, requestId) {
      const startedAt = Date.now();
      const listener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
      const listenerTls = Boolean(listener?.tls);
      const execPayload = (payload || {}) as ExecCommandPayload;
      const command = typeof execPayload.command === 'string' ? execPayload.command : '';
      const cwd = typeof execPayload.cwd === 'string' && execPayload.cwd ? execPayload.cwd : undefined;
      const requestedTimeout =
        typeof execPayload.timeout === 'number' && execPayload.timeout > 0
          ? Math.min(execPayload.timeout, EXEC_MAX_TIMEOUT_MS)
          : EXEC_DEFAULT_TIMEOUT_MS;

      const auditPayload: Record<string, unknown> = {
        commandLength: command.length,
        cwd: cwd ?? null,
        timeout: requestedTimeout,
      };

      const sendError = (errorCode: string, extra?: Record<string, unknown>) => {
        ctx.send(client.ws, {
          type: EXEC_RESPONSE_TYPE,
          success: false,
          error: errorCode,
          payload: extra,
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'exec_command',
          payload: auditPayload,
          result: { ok: false, error: errorCode, ...(extra || {}) },
          durationMs: Date.now() - startedAt,
        });
      };

      const capError = ctx.requireRemoteCapability(client, 'exec');
      if (capError) {
        sendError(capError);
        return;
      }

      const retryAfterMs = ctx.rateLimiter.check(client.id, 'exec');
      if (retryAfterMs !== null) {
        ctx.send(client.ws, {
          type: EXEC_RESPONSE_TYPE,
          success: false,
          error: 'rate_limited',
          payload: { retryAfterMs },
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'exec_command',
          payload: auditPayload,
          result: { ok: false, reason: 'rate_limited', retryAfterMs },
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (!command) {
        sendError('invalid_payload', { detail: 'Missing command' });
        return;
      }

      if (cwd && !isCwdAllowed(ctx, cwd)) {
        sendError('invalid_cwd', { cwd });
        return;
      }

      const allowlist = listener?.remoteCapabilities?.exec?.commandAllowlist;
      if (Array.isArray(allowlist) && allowlist.length > 0) {
        const matched = allowlist.some((pattern) => {
          try {
            return new RegExp(pattern).test(command);
          } catch {
            return false;
          }
        });
        if (!matched) {
          sendError('command_blocked', { command });
          return;
        }
      }

      const child = spawn('/bin/sh', ['-c', command], {
        cwd: cwd || process.cwd(),
        detached: true,
      });

      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;
      let closed = false;

      // Kill the entire process group so children (e.g. the `sleep` grandchild
      // under `/bin/sh -c ...`) are signaled, not just the shell. `detached: true`
      // makes the child a process-group leader so negative PID addresses the group.
      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (typeof child.pid === 'number') {
            process.kill(-child.pid, sig);
          }
        } catch {
          // ESRCH / EPERM: group already reaped or we don't own it; nothing to do.
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBuf.length < EXEC_OUTPUT_CAP_BYTES) {
          const remaining = EXEC_OUTPUT_CAP_BYTES - stdoutBuf.length;
          if (chunk.length <= remaining) {
            stdoutBuf = Buffer.concat([stdoutBuf, chunk], stdoutBuf.length + chunk.length);
          } else {
            stdoutBuf = Buffer.concat(
              [stdoutBuf, chunk.subarray(0, remaining)],
              stdoutBuf.length + remaining
            );
            truncated = true;
          }
        } else {
          truncated = true;
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBuf.length < EXEC_OUTPUT_CAP_BYTES) {
          const remaining = EXEC_OUTPUT_CAP_BYTES - stderrBuf.length;
          if (chunk.length <= remaining) {
            stderrBuf = Buffer.concat([stderrBuf, chunk], stderrBuf.length + chunk.length);
          } else {
            stderrBuf = Buffer.concat(
              [stderrBuf, chunk.subarray(0, remaining)],
              stderrBuf.length + remaining
            );
            truncated = true;
          }
        } else {
          truncated = true;
        }
      });

      let graceHandle: NodeJS.Timeout | null = null;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        graceHandle = setTimeout(() => {
          // Always escalate unless the child has actually closed. We cannot rely
          // on child.signalCode here: SIGTERM may set it even if descendants in
          // the group are still alive (e.g. a shell that forwards but waits).
          if (!closed) {
            killGroup('SIGKILL');
          }
        }, EXEC_KILL_GRACE_MS);
      }, requestedTimeout);

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on('error', () => {
            closed = true;
            resolve({ code: null, signal: null });
          });
          child.on('close', (code, signal) => {
            closed = true;
            resolve({ code, signal });
          });
        }
      );
      clearTimeout(timeoutHandle);
      if (graceHandle) clearTimeout(graceHandle);

      void stdoutBytes;
      void stderrBytes;

      const exitCode = timedOut ? -1 : exit.code ?? -1;
      // Report the ACTUAL terminating signal from the close event, not an
      // intended/pre-set value. If the process exited normally, signal is null.
      const signalName = exit.signal ?? null;

      const result: ExecCommandResult = {
        exitCode,
        stdout: stdoutBuf.toString('utf-8'),
        stderr: stderrBuf.toString('utf-8'),
        truncated,
        durationMs: Date.now() - startedAt,
        signal: signalName,
      };

      ctx.send(client.ws, {
        type: EXEC_RESPONSE_TYPE,
        success: true,
        payload: result,
        requestId,
      });

      ctx.auditLog.append({
        ts: startedAt,
        origin: getOrigin(client, listenerTls),
        action: 'exec_command',
        payload: auditPayload,
        result: {
          ok: true,
          exitCode,
          truncated,
          signal: signalName,
          timedOut,
        },
        durationMs: Date.now() - startedAt,
      });
    },

    async write_file(client, payload, requestId) {
      const startedAt = Date.now();
      const listener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
      const listenerTls = Boolean(listener?.tls);
      const writePayload = (payload || {}) as WriteFilePayload;
      const rawPath = typeof writePayload.path === 'string' ? writePayload.path : '';
      const content = typeof writePayload.content === 'string' ? writePayload.content : '';
      const encoding = writePayload.encoding === 'base64' ? 'base64' : writePayload.encoding;
      const createDirs = Boolean(writePayload.createDirs);

      const auditPayload: Record<string, unknown> = {
        path: rawPath,
        encoding: encoding ?? 'utf8',
        createDirs,
        contentLength: content.length,
      };

      const sendError = (errorCode: string, extra?: Record<string, unknown>) => {
        ctx.send(client.ws, {
          type: WRITE_RESPONSE_TYPE,
          success: false,
          error: errorCode,
          payload: extra,
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'write_file',
          payload: auditPayload,
          result: { ok: false, error: errorCode, ...(extra || {}) },
          durationMs: Date.now() - startedAt,
        });
      };

      const capError = ctx.requireRemoteCapability(client, 'write');
      if (capError) {
        sendError(capError);
        return;
      }

      const retryAfterMs = ctx.rateLimiter.check(client.id, 'write');
      if (retryAfterMs !== null) {
        ctx.send(client.ws, {
          type: WRITE_RESPONSE_TYPE,
          success: false,
          error: 'rate_limited',
          payload: { retryAfterMs },
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'write_file',
          payload: auditPayload,
          result: { ok: false, reason: 'rate_limited', retryAfterMs },
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (!rawPath) {
        sendError('invalid_payload', { detail: 'Missing path' });
        return;
      }
      if (typeof writePayload.content !== 'string') {
        sendError('invalid_payload', { detail: 'Missing content' });
        return;
      }
      if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
        sendError('invalid_payload', { detail: 'Invalid encoding' });
        return;
      }

      if (!path.isAbsolute(rawPath)) {
        sendError('invalid_path', { path: rawPath, reason: 'not_absolute' });
        return;
      }
      if (rawPath.split(path.sep).includes('..')) {
        sendError('invalid_path', { path: rawPath, reason: 'traversal' });
        return;
      }

      const resolved = path.resolve(rawPath);

      const roots = listener?.remoteCapabilities?.write?.roots ?? [];
      if (!roots.length) {
        sendError('invalid_path', { path: resolved, reason: 'no_roots_configured' });
        return;
      }
      const allowed = roots.some((root) => isUnderRoot(resolved, root));
      if (!allowed) {
        sendError('invalid_path', { path: resolved, reason: 'outside_roots' });
        return;
      }

      try {
        if (fs.existsSync(resolved)) {
          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) {
            sendError('invalid_path', { path: resolved, reason: 'is_directory' });
            return;
          }
        }
      } catch (err) {
        sendError('write_failed', { detail: String((err as Error).message || err) });
        return;
      }

      let buffer: Buffer;
      try {
        buffer = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
      } catch (err) {
        sendError('invalid_payload', { detail: `decode_failed: ${String((err as Error).message || err)}` });
        return;
      }

      try {
        if (createDirs) {
          await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
        }
        await fs.promises.writeFile(resolved, buffer);
      } catch (err) {
        sendError('write_failed', { detail: String((err as Error).message || err) });
        return;
      }

      const result: WriteFileResult = {
        path: resolved,
        bytesWritten: buffer.length,
      };

      ctx.send(client.ws, {
        type: WRITE_RESPONSE_TYPE,
        success: true,
        payload: result,
        requestId,
      });

      ctx.auditLog.append({
        ts: startedAt,
        origin: getOrigin(client, listenerTls),
        action: 'write_file',
        payload: auditPayload,
        result: {
          ok: true,
          path: resolved,
          bytesWritten: buffer.length,
        },
        durationMs: Date.now() - startedAt,
      });
    },

    get_audit_log(client, payload, requestId) {
      const auditPayload = (payload || {}) as { limit?: number; sinceTs?: number };
      const rawLimit =
        typeof auditPayload.limit === 'number' ? auditPayload.limit : AUDIT_LOG_DEFAULT_LIMIT;
      const sinceTs = typeof auditPayload.sinceTs === 'number' ? auditPayload.sinceTs : undefined;

      if (rawLimit < 0 || rawLimit > AUDIT_LOG_MAX_LIMIT) {
        ctx.send(client.ws, {
          type: AUDIT_LOG_RESPONSE_TYPE,
          success: false,
          error: 'invalid_payload',
          payload: { detail: `limit must be between 0 and ${AUDIT_LOG_MAX_LIMIT}` },
          requestId,
        });
        return;
      }

      const limit = Math.floor(rawLimit);

      try {
        const { entries, hasMore } = ctx.auditLog.read({ limit, sinceTs });
        ctx.send(client.ws, {
          type: AUDIT_LOG_RESPONSE_TYPE,
          success: true,
          payload: { entries, hasMore },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: AUDIT_LOG_RESPONSE_TYPE,
          success: false,
          error: 'audit_log_unavailable',
          payload: { detail: String((err as Error).message || err) },
          requestId,
        });
      }
    },
  };
}
