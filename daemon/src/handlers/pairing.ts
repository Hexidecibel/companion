/**
 * Authenticated pairing / device-management requests (full scope only):
 *   pair_pending_list, pair_approve, pair_deny, pair_qr_create,
 *   devices_list, device_revoke, device_rename, device_upgrade.
 * The unauthenticated side (pair_hello / pair_request / pair_confirm /
 * pair_redeem_qr) is handled in websocket.ts before the auth gate.
 */
import QRCode from 'qrcode';
import type { AuthenticatedClient, MessageHandler } from '../handler-context';
import type { WebSocketResponse } from '../types';
import type { WebSocket } from 'ws';
import type { PairingManager } from '../pairing/manager';
import type { DeviceRegistry } from '../pairing/registry';
import type { DaemonIdentity } from '../pairing/identity';
import { cleanDeviceName } from '../pairing/registry';

export interface PairingHandlerDeps {
  pairing: PairingManager;
  devices: DeviceRegistry;
  identity: () => DaemonIdentity;
  send: (ws: WebSocket, response: WebSocketResponse) => void;
  /** Close every socket of a revoked device. */
  disconnectDevice: (deviceId: string) => number;
  /** Listener TLS flag for a client (QR default). */
  listenerTls: (client: AuthenticatedClient) => boolean;
  audit: (
    action: string,
    client: AuthenticatedClient,
    info: Record<string, unknown>,
    ok: boolean
  ) => void;
}

export function clientLabel(c: AuthenticatedClient): string {
  if (c.authKind === 'device' && c.pairedDeviceId) return `device ${c.pairedDeviceId}`;
  return c.isLocal ? 'local client' : `client ${c.id.slice(0, 8)}`;
}

export function buildPairLink(p: {
  host: string;
  port: number;
  tls: boolean;
  daemonId: string;
  name: string;
  otp: string;
}): string {
  const q = new URLSearchParams({
    host: p.host,
    port: String(p.port),
    tls: p.tls ? '1' : '0',
    id: p.daemonId,
    name: p.name,
    otp: p.otp,
  });
  return `companion://pair?${q.toString()}`;
}

export function registerPairingHandlers(deps: PairingHandlerDeps): Record<string, MessageHandler> {
  const reply = (
    client: AuthenticatedClient,
    type: string,
    requestId: string | undefined,
    r: { ok: boolean; payload?: unknown; error?: string; code?: string }
  ) =>
    deps.send(client.ws, {
      type,
      success: r.ok,
      ...(r.payload !== undefined ? { payload: r.payload } : {}),
      ...(r.ok ? {} : { error: r.error || 'failed', payload: { code: r.code } }),
      requestId,
    });

  const by = (c: AuthenticatedClient) => ({
    clientId: c.id,
    addr: c.remoteAddress,
    label: clientLabel(c),
  });

  return {
    pair_pending_list: (client, _payload, requestId) => {
      reply(client, 'pair_pending_list', requestId, {
        ok: true,
        payload: { pending: deps.pairing.list() },
      });
    },

    pair_approve: (client, payload, requestId) => {
      const r = deps.pairing.approve(payload?.pairingId, by(client));
      reply(
        client,
        'pair_approve',
        requestId,
        r.ok
          ? { ok: true, payload: { deviceId: r.deviceId } }
          : { ok: false, error: r.error, code: r.code }
      );
    },

    pair_deny: (client, payload, requestId) => {
      const r = deps.pairing.deny(payload?.pairingId, by(client));
      reply(
        client,
        'pair_deny',
        requestId,
        r.ok ? { ok: true } : { ok: false, error: r.error, code: r.code }
      );
    },

    pair_qr_create: async (client, payload, requestId) => {
      const r = deps.pairing.createQr(by(client));
      if (!r.ok)
        return reply(client, 'pair_qr_create', requestId, {
          ok: false,
          error: r.error,
          code: r.code,
        });
      const id = deps.identity();
      const host =
        typeof payload?.host === 'string' && payload.host.trim()
          ? payload.host.trim().slice(0, 253)
          : '';
      const port =
        Number.isInteger(payload?.port) && payload.port > 0 && payload.port < 65536
          ? payload.port
          : client.listenerPort;
      const tls = typeof payload?.tls === 'boolean' ? payload.tls : deps.listenerTls(client);
      if (!host || !port) {
        return reply(client, 'pair_qr_create', requestId, {
          ok: false,
          error: 'host and port are required',
          code: 'bad_request',
        });
      }
      const link = buildPairLink({ host, port, tls, daemonId: id.id, name: id.name, otp: r.otp });
      let qrDataUrl: string | undefined;
      try {
        qrDataUrl = await QRCode.toDataURL(link, { margin: 2, width: 360 });
      } catch {
        /* the link alone still works */
      }
      reply(client, 'pair_qr_create', requestId, {
        ok: true,
        payload: { link, expiresAt: r.expiresAt, qrDataUrl },
      });
    },

    devices_list: (client, _payload, requestId) => {
      reply(client, 'devices_list', requestId, {
        ok: true,
        payload: {
          devices: deps.devices.list(),
          currentDeviceId: client.pairedDeviceId ?? null,
          daemonId: deps.identity().id,
        },
      });
    },

    device_revoke: (client, payload, requestId) => {
      const id = typeof payload?.deviceId === 'string' ? payload.deviceId : '';
      const removed = id ? deps.devices.revoke(id) : null;
      deps.audit('device_revoke', client, { deviceId: id, deviceName: removed?.name }, !!removed);
      if (!removed)
        return reply(client, 'device_revoke', requestId, {
          ok: false,
          error: 'No such device',
          code: 'not_found',
        });
      console.log(`Devices: "${removed.name}" (${removed.id}) revoked by ${clientLabel(client)}`);
      // Reply first: the requester may be the revoked device itself.
      reply(client, 'device_revoke', requestId, { ok: true, payload: { deviceId: id } });
      deps.disconnectDevice(id);
    },

    device_rename: (client, payload, requestId) => {
      const id = typeof payload?.deviceId === 'string' ? payload.deviceId : '';
      const name = cleanDeviceName(payload?.name);
      const updated = id && name ? deps.devices.rename(id, name) : null;
      deps.audit('device_rename', client, { deviceId: id, name }, !!updated);
      if (!updated)
        return reply(client, 'device_rename', requestId, {
          ok: false,
          error: 'No such device or empty name',
          code: 'not_found',
        });
      reply(client, 'device_rename', requestId, { ok: true, payload: { device: updated } });
    },

    device_upgrade: (client, payload, requestId) => {
      if (client.authKind !== 'legacy') {
        return reply(client, 'device_upgrade', requestId, {
          ok: false,
          error: 'Only a client signed in with the server token can upgrade',
          code: 'not_legacy',
        });
      }
      const r = deps.pairing.upgrade({
        clientId: client.id,
        addr: client.remoteAddress || '',
        deviceName: payload?.deviceName,
        platform: payload?.platform,
      });
      if (!r.ok)
        return reply(client, 'device_upgrade', requestId, {
          ok: false,
          error: r.error,
          code: r.code,
        });
      reply(client, 'device_upgrade', requestId, { ok: true, payload: r.result });
    },
  };
}
