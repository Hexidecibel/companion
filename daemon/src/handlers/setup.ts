import type { WebSocket } from 'ws';
import type { AuthenticatedClient, MessageHandler } from '../handler-context';
import type { PairingNetwork } from '../pairing/manager';
import type { WebSocketResponse } from '../types';
import { setupAccessError } from '../setup/gate';
import { SetupError, SetupService } from '../setup/service';

export interface SetupHandlerDeps {
  setup: SetupService;
  send: (ws: WebSocket, r: WebSocketResponse) => void;
  network: (client: AuthenticatedClient) => PairingNetwork;
  audit: (
    action: string,
    client: AuthenticatedClient,
    info: Record<string, unknown>,
    ok: boolean
  ) => void;
}

type Obj = Record<string, unknown>;
const obj = (p: unknown): Obj =>
  p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : {};

/**
 * Setup wizard endpoints. Every one answers with a response of the SAME type
 * ({ type, success, payload | error, requestId }); failures carry
 * `payload: { code: SetupErrorCode }`. Access: see setup/gate.ts.
 */
export function registerSetupHandlers(d: SetupHandlerDeps): Record<string, MessageHandler> {
  const handle =
    (
      type: string,
      fn: (client: AuthenticatedClient, p: Obj) => unknown,
      opts: { audit?: boolean } = {}
    ): MessageHandler =>
    async (client, payload, requestId) => {
      const denied = setupAccessError(client, d.network(client));
      if (denied) {
        d.audit(type, client, { reason: denied.code }, false);
        d.send(client.ws, {
          type,
          success: false,
          error: denied.error,
          payload: { code: denied.code },
          requestId,
        });
        return;
      }
      try {
        const out = await fn(client, obj(payload));
        if (opts.audit) d.audit(type, client, {}, true);
        d.send(client.ws, { type, success: true, payload: out, requestId });
      } catch (err) {
        const code = err instanceof SetupError ? err.code : 'unavailable';
        if (!(err instanceof SetupError)) console.error(`Setup: ${type} failed:`, err);
        if (opts.audit) d.audit(type, client, { reason: code }, false);
        d.send(client.ws, {
          type,
          success: false,
          error: err instanceof SetupError ? err.message : 'Setup request failed',
          payload: { code },
          requestId,
        });
      }
    };

  const s = d.setup;
  return {
    setup_status: handle('setup_status', () => s.status()),
    setup_checks: handle('setup_checks', (_c, p) =>
      s.checks(p.only).then((checks) => ({ checks }))
    ),
    setup_update: handle('setup_update', (_c, p) => s.updateSettings(p.patch), { audit: true }),
    setup_list_dirs: handle('setup_list_dirs', (_c, p) => s.listDirs(p)),
    // The value is never logged: only the secret's name goes to the audit log.
    setup_set_secret: handle(
      'setup_set_secret',
      (_c, p) => s.setSecret(p.name, p.value === null ? null : p.value),
      {
        audit: true,
      }
    ),
    setup_mark_step: handle('setup_mark_step', (_c, p) => s.markStep(p.step, p.state ?? null)),
    setup_complete: handle('setup_complete', () => s.complete(), { audit: true }),
    setup_start_session: handle('setup_start_session', (_c, p) => s.startSession(p.dir), {
      audit: true,
    }),
    setup_session_progress: handle('setup_session_progress', (_c, p) =>
      s.sessionProgress(p.sessionName)
    ),
    setup_session_hello: handle('setup_session_hello', (_c, p) =>
      s.sendHello(p.sessionName, p.text)
    ),
    setup_services: handle('setup_services', () => s.services()),
    setup_install_service: handle(
      'setup_install_service',
      (_c, p) => s.installService(p.target, p.confirm),
      {
        audit: true,
      }
    ),
    setup_remote: handle('setup_remote', () => s.remote()),
    setup_downloads: handle('setup_downloads', () => s.downloads()),
    setup_install_claude: handle('setup_install_claude', (_c, p) => s.installClaude(p.confirm), {
      audit: true,
    }),
  };
}
