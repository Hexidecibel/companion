import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, spawnSync } from 'child_process';
import { HandlerContext, MessageHandler, AuthenticatedClient } from '../handler-context';
import { OriginCredential } from '../types';
import { loadConfig, saveConfig } from '../config';
import { getCertFingerprint } from '../cert-generator';

const SYNC_MCP_RESPONSE_TYPE = 'concierge_mcp_synced';
const OPEN_RESPONSE_TYPE = 'concierge_opened';
const REGISTER_ORIGIN_RESPONSE_TYPE = 'concierge_origin_registered';
const CERT_FINGERPRINT_RESPONSE_TYPE = 'cert_fingerprint';

const CONCIERGE_TMUX_SESSION = 'concierge';
const POST_SPAWN_DELAY_MS = 300;
const CLAUDE_READY_TIMEOUT_MS = 10_000;
const CLAUDE_READY_POLL_INTERVAL_MS = 250;
const TMUX_CAPTURE_TIMEOUT_MS = 2_000;
const SESSION_ID_WAIT_MS = 20_000;

interface PushedServer {
  name: string;
  host: string;
  port: number;
  token: string;
  useTls: boolean;
  trustedNetwork?: boolean;
  certFingerprint?: string;
}

interface SyncMcpPayload {
  servers?: PushedServer[];
}

interface OpenPayload {
  servers?: PushedServer[];
}

interface RegisterOriginPayload {
  origin?: string;
  token?: string;
  label?: string;
  capabilities?: { exec?: boolean; dispatch?: boolean; write?: boolean };
}

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

/**
 * Locate the concierge directory (containing .mcp.json.template). Resolution order:
 *   1. config.concierge_dir if set
 *   2. walk up from __dirname looking for <dir>/concierge/.mcp.json.template
 *   3. fall back to /home/hexi/local/src/companion/concierge
 * Logs which path was chosen.
 */
function resolveConciergeDir(ctx: HandlerContext): string {
  const configured = ctx.config.concierge_dir;
  if (configured && fs.existsSync(path.join(configured, '.mcp.json.template'))) {
    console.log(`[concierge] using configured concierge_dir: ${configured}`);
    return configured;
  }
  if (configured) {
    console.warn(
      `[concierge] config.concierge_dir=${configured} has no .mcp.json.template; falling back to discovery`
    );
  }

  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'concierge', '.mcp.json.template');
    if (fs.existsSync(candidate)) {
      const resolved = path.join(dir, 'concierge');
      console.log(`[concierge] discovered concierge dir by walking up: ${resolved}`);
      return resolved;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const fallback = '/home/hexi/local/src/companion/concierge';
  console.warn(`[concierge] using hardcoded fallback concierge dir: ${fallback}`);
  return fallback;
}

/** Resolve the path to the built MCP entry (mcp/dist/index.js) relative to the concierge dir's repo root. */
function resolveMcpEntry(conciergeDir: string): string {
  const repoRoot = path.dirname(conciergeDir);
  return path.join(repoRoot, 'mcp', 'dist', 'index.js');
}

function getMcpServersPath(): string {
  return path.join(os.homedir(), '.companion', 'mcp-servers.json');
}

/** Build the `local` loopback entry from the daemon's own first listener (mirrors bin/concierge). */
function buildLocalEntry(ctx: HandlerContext): PushedServer {
  const listener = ctx.config.listeners[0];
  return {
    name: 'local',
    host: '127.0.0.1',
    port: listener?.port ?? 9877,
    token: listener?.token ?? '',
    useTls: false,
    trustedNetwork: true,
  };
}

/**
 * Merge the pushed servers (plus an always-present `local` entry) into
 * ~/.companion/mcp-servers.json, preserving manually-added entries by name.
 * Returns the number of entries written and the file path.
 */
function syncMcpServers(ctx: HandlerContext, pushed: PushedServer[]): { written: number; path: string } {
  const mcpPath = getMcpServersPath();
  const dir = path.dirname(mcpPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let mcp: { version: number; servers: PushedServer[] } = { version: 1, servers: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    if (raw && typeof raw === 'object') {
      mcp.version = typeof raw.version === 'number' ? raw.version : 1;
      mcp.servers = Array.isArray(raw.servers) ? raw.servers : [];
    }
  } catch {
    // No existing file or unparseable — start fresh.
  }

  const upsert = (entry: PushedServer) => {
    const existing = mcp.servers.find((s) => s && s.name === entry.name);
    if (existing) {
      Object.assign(existing, entry);
    } else {
      mcp.servers.push(entry);
    }
  };

  // Always ensure a local loopback entry.
  upsert(buildLocalEntry(ctx));

  for (const s of pushed) {
    if (!s || typeof s.name !== 'string' || !s.name) continue;
    if (s.name === 'local') continue; // local is daemon-derived, never overwritten by push
    const entry: PushedServer = {
      name: s.name,
      host: String(s.host),
      port: Number(s.port),
      token: String(s.token),
      useTls: Boolean(s.useTls),
    };
    if (typeof s.trustedNetwork === 'boolean') entry.trustedNetwork = s.trustedNetwork;
    if (typeof s.certFingerprint === 'string' && s.certFingerprint) {
      entry.certFingerprint = s.certFingerprint;
    }
    upsert(entry);
  }

  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n', { mode: 0o600 });
  // Enforce 0o600 even if the file pre-existed with looser perms.
  try {
    fs.chmodSync(mcpPath, 0o600);
  } catch {
    // best effort
  }

  return { written: mcp.servers.length, path: mcpPath };
}

/** Render concierge/.mcp.json from the template (replacing __MCP_DIST_INDEX__). */
function renderConciergeMcpJson(conciergeDir: string, mcpEntry: string): void {
  const tplPath = path.join(conciergeDir, '.mcp.json.template');
  if (!fs.existsSync(tplPath)) return;
  const raw = fs.readFileSync(tplPath, 'utf-8').replace(/__MCP_DIST_INDEX__/g, mcpEntry);
  const obj = JSON.parse(raw);
  delete obj._comment;
  fs.writeFileSync(path.join(conciergeDir, '.mcp.json'), JSON.stringify(obj, null, 2) + '\n');
}

async function waitForClaudeReady(sessionName: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const readyMarkers = ['❯', 'for shortcuts', 'Try "', 'shortcuts'];
  while (Date.now() < deadline) {
    const result = spawnSync('tmux', ['capture-pane', '-t', sessionName, '-p', '-S', '-200'], {
      timeout: TMUX_CAPTURE_TIMEOUT_MS,
    });
    if (result.status === 0) {
      const pane = result.stdout?.toString() || '';
      if (readyMarkers.some((m) => pane.includes(m))) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, CLAUDE_READY_POLL_INTERVAL_MS));
  }
  return false;
}

export function registerConciergeHandlers(ctx: HandlerContext): Record<string, MessageHandler> {
  return {
    async concierge_sync_mcp(client, payload, requestId) {
      const startedAt = Date.now();
      const listener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
      const listenerTls = Boolean(listener?.tls);
      const p = (payload || {}) as SyncMcpPayload;
      const servers = Array.isArray(p.servers) ? p.servers : [];

      const sendError = (errorCode: string, extra?: Record<string, unknown>) => {
        ctx.send(client.ws, {
          type: SYNC_MCP_RESPONSE_TYPE,
          success: false,
          error: errorCode,
          payload: extra,
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'concierge_sync_mcp',
          payload: { serverCount: servers.length },
          result: { ok: false, error: errorCode, ...(extra || {}) },
          durationMs: Date.now() - startedAt,
        });
      };

      const capError = ctx.requireRemoteCapability(client, 'dispatch');
      if (capError) {
        sendError(capError);
        return;
      }

      try {
        const result = syncMcpServers(ctx, servers);
        ctx.send(client.ws, {
          type: SYNC_MCP_RESPONSE_TYPE,
          success: true,
          payload: result,
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'concierge_sync_mcp',
          payload: { serverCount: servers.length },
          result: { ok: true, written: result.written, path: result.path },
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        sendError('sync_failed', { detail: String((err as Error).message || err) });
      }
    },

    async concierge_open(client, payload, requestId) {
      const startedAt = Date.now();
      const listener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
      const listenerTls = Boolean(listener?.tls);
      const p = (payload || {}) as OpenPayload;
      const servers = Array.isArray(p.servers) ? p.servers : undefined;

      const sendError = (errorCode: string, extra?: Record<string, unknown>) => {
        ctx.send(client.ws, {
          type: OPEN_RESPONSE_TYPE,
          success: false,
          error: errorCode,
          payload: extra,
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'concierge_open',
          payload: { serverCount: servers?.length ?? 0 },
          result: { ok: false, error: errorCode, ...(extra || {}) },
          durationMs: Date.now() - startedAt,
        });
      };

      const capError = ctx.requireRemoteCapability(client, 'dispatch');
      if (capError) {
        sendError(capError);
        return;
      }

      const conciergeDir = resolveConciergeDir(ctx);

      // 1. Sync the MCP config first if a server list was pushed.
      if (servers) {
        try {
          syncMcpServers(ctx, servers);
        } catch (err) {
          sendError('sync_failed', { detail: String((err as Error).message || err) });
          return;
        }
      }

      // 2. If the concierge session already exists, attach to it.
      let created = false;
      const exists = await ctx.tmux.sessionExists(CONCIERGE_TMUX_SESSION);
      if (!exists) {
        // 3. Spawn the concierge session.
        let claudePath: string;
        try {
          const out = execSync('which claude', { encoding: 'utf-8' });
          claudePath = out.trim();
          if (!claudePath) throw new Error('empty which output');
        } catch {
          sendError('claude_not_found', { searchedPath: process.env.PATH || '' });
          return;
        }

        // Render the project-scoped .mcp.json so the concierge gets the routing tools.
        try {
          const mcpEntry = resolveMcpEntry(conciergeDir);
          renderConciergeMcpJson(conciergeDir, mcpEntry);
        } catch (err) {
          sendError('mcp_render_failed', { detail: String((err as Error).message || err) });
          return;
        }

        const safeName = CONCIERGE_TMUX_SESSION;
        const shCmd = `${claudePath} --dangerously-skip-permissions`;
        try {
          execSync(
            `tmux new-session -d -s "${safeName}" -c "${conciergeDir}" ${JSON.stringify(shCmd)}`,
            { stdio: 'pipe' }
          );
          execSync(`tmux set-environment -t "${safeName}" COMPANION_APP 1`, { stdio: 'pipe' });
        } catch (err) {
          sendError('tmux_create_failed', { detail: String((err as Error).message || err) });
          return;
        }

        created = true;
        ctx.storeTmuxSessionConfig(CONCIERGE_TMUX_SESSION, conciergeDir, true);
        ctx.watcher.markSessionAsNew(CONCIERGE_TMUX_SESSION);
        await ctx.watcher.refreshTmuxPaths();
        ctx.broadcast('tmux_sessions_changed', {
          action: 'created',
          sessionName: CONCIERGE_TMUX_SESSION,
        });

        await new Promise((resolve) => setTimeout(resolve, POST_SPAWN_DELAY_MS));
        const ready = await waitForClaudeReady(CONCIERGE_TMUX_SESSION, CLAUDE_READY_TIMEOUT_MS);
        if (!ready) {
          console.warn(
            `[concierge_open] Claude readiness not detected in ${CONCIERGE_TMUX_SESSION} after ${CLAUDE_READY_TIMEOUT_MS}ms`
          );
        }
      }

      // Resolve the sessionId for the concierge session by its cwd.
      let sessionId = await ctx.watcher.waitForSessionInCwd(conciergeDir, SESSION_ID_WAIT_MS);
      if (!sessionId) {
        sessionId = ctx.watcher.resolveSessionByTmuxName(CONCIERGE_TMUX_SESSION, conciergeDir);
      }

      const result = {
        sessionId,
        tmuxSessionName: CONCIERGE_TMUX_SESSION,
        created,
      };

      ctx.send(client.ws, {
        type: OPEN_RESPONSE_TYPE,
        success: true,
        payload: result,
        requestId,
      });

      ctx.auditLog.append({
        ts: startedAt,
        origin: getOrigin(client, listenerTls),
        action: 'concierge_open',
        payload: { serverCount: servers?.length ?? 0, conciergeDir },
        result: { ok: true, sessionId, created },
        durationMs: Date.now() - startedAt,
      });
    },

    async concierge_register_origin(client, payload, requestId) {
      const startedAt = Date.now();
      const listener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
      const listenerTls = Boolean(listener?.tls);
      const p = (payload || {}) as RegisterOriginPayload;
      const origin = typeof p.origin === 'string' ? p.origin : '';
      const token = typeof p.token === 'string' ? p.token : '';

      const sendError = (errorCode: string, extra?: Record<string, unknown>) => {
        ctx.send(client.ws, {
          type: REGISTER_ORIGIN_RESPONSE_TYPE,
          success: false,
          error: errorCode,
          payload: extra,
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'concierge_register_origin',
          payload: { origin, hasToken: Boolean(token), label: p.label },
          result: { ok: false, error: errorCode, ...(extra || {}) },
          durationMs: Date.now() - startedAt,
        });
      };

      const capError = ctx.requireRemoteCapability(client, 'dispatch');
      if (capError) {
        sendError(capError);
        return;
      }

      if (!origin) {
        sendError('invalid_payload', { detail: 'Missing origin' });
        return;
      }
      if (!token) {
        sendError('invalid_payload', { detail: 'Missing token' });
        return;
      }
      if (!client.listenerPort) {
        sendError('no_listener', { detail: 'Client has no listener port' });
        return;
      }

      try {
        const cfg = loadConfig();
        const idx = cfg.listeners.findIndex((l) => l.port === client.listenerPort);
        if (idx === -1) {
          sendError('no_listener', { detail: `Listener not found for port ${client.listenerPort}` });
          return;
        }
        const target = cfg.listeners[idx];
        if (!target.remoteCapabilities) {
          target.remoteCapabilities = { enabled: false };
        }
        if (!Array.isArray(target.remoteCapabilities.origins)) {
          target.remoteCapabilities.origins = [];
        }
        const cred: OriginCredential = { origin, token };
        if (typeof p.label === 'string') cred.label = p.label;
        if (p.capabilities && typeof p.capabilities === 'object') {
          cred.capabilities = {
            ...(typeof p.capabilities.exec === 'boolean' ? { exec: p.capabilities.exec } : {}),
            ...(typeof p.capabilities.dispatch === 'boolean' ? { dispatch: p.capabilities.dispatch } : {}),
            ...(typeof p.capabilities.write === 'boolean' ? { write: p.capabilities.write } : {}),
          };
        }

        const origins = target.remoteCapabilities.origins;
        const existingIdx = origins.findIndex((o) => o.origin === origin);
        if (existingIdx >= 0) {
          origins[existingIdx] = cred;
        } else {
          origins.push(cred);
        }

        saveConfig(cfg);

        // Reflect the change in the live in-memory config so it takes effect
        // without a restart.
        const liveListener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
        if (liveListener) {
          if (!liveListener.remoteCapabilities) {
            liveListener.remoteCapabilities = { enabled: false };
          }
          liveListener.remoteCapabilities.origins = origins;
        }

        ctx.send(client.ws, {
          type: REGISTER_ORIGIN_RESPONSE_TYPE,
          success: true,
          payload: { registered: true },
          requestId,
        });
        ctx.auditLog.append({
          ts: startedAt,
          origin: getOrigin(client, listenerTls),
          action: 'concierge_register_origin',
          payload: { origin, hasToken: true, label: p.label },
          result: { ok: true },
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        sendError('register_failed', { detail: String((err as Error).message || err) });
      }
    },

    get_cert_fingerprint(client, _payload, requestId) {
      const listener = ctx.config.listeners.find((l) => l.port === client.listenerPort);
      let fingerprint: string | null = null;
      if (listener?.tls && listener.certPath) {
        fingerprint = getCertFingerprint(listener.certPath);
      }
      ctx.send(client.ws, {
        type: CERT_FINGERPRINT_RESPONSE_TYPE,
        success: true,
        payload: { fingerprint },
        requestId,
      });
    },
  };
}
