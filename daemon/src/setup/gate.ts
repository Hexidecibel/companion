/**
 * Who may use the setup API, and when a browser on this machine may pair
 * without a code.
 *
 * Setup API: an authenticated, full-scope socket signed in with a paired device
 * token or the listener token (never a Herald trigger token or a per-origin
 * remote credential), connecting from loopback / LAN / tailnet. Anything that
 * classifies as public (including through a reverse proxy: X-Forwarded-For
 * from an untrusted proxy counts as public) is refused, so the HAProxy route
 * can never reach it.
 *
 * Local auto-pair (the wizard's "Pair this device" on the server itself):
 * only in setup mode, only while NO device is paired yet, only from a loopback
 * TCP peer with no proxy headers, with a loopback Host header (DNS rebinding)
 * and, for browsers, an Origin that is this same loopback host (a web page on
 * some other site cannot open a socket to localhost and pair itself).
 */
import * as net from 'net';
import type { PairingNetwork } from '../pairing/manager';
import type { SetupErrorCode } from './protocol';

export interface GateClient {
  authenticated: boolean;
  scope?: 'full' | 'trigger';
  authKind?: 'device' | 'legacy' | 'origin' | 'trigger';
}

export function setupAccessError(
  client: GateClient,
  network: PairingNetwork
): { code: SetupErrorCode; error: string } | null {
  if (!client.authenticated || client.scope === 'trigger') {
    return { code: 'forbidden', error: 'Sign in first' };
  }
  if (client.authKind !== 'device' && client.authKind !== 'legacy') {
    return { code: 'forbidden', error: 'Setup needs a paired device' };
  }
  if (network !== 'local' && network !== 'lan' && network !== 'tailnet') {
    return {
      code: 'untrusted_network',
      error: 'Setup is only available on your local network or tailnet',
    };
  }
  return null;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackAddress(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  if (a === '::1') return true;
  return net.isIPv4(a) && a.startsWith('127.');
}

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

export interface UpgradeInfo {
  peer: string;
  /** Any of X-Forwarded-For / Forwarded / X-Real-IP / X-Forwarded-Host was present. */
  proxied: boolean;
  host?: string;
  origin?: string;
}

export function localAutoPairAllowed(opts: {
  setupMode: boolean;
  deviceCount: number;
  pairingEnabled: boolean;
  upgrade: UpgradeInfo;
}): boolean {
  const { setupMode, deviceCount, pairingEnabled, upgrade } = opts;
  if (!setupMode || deviceCount > 0 || !pairingEnabled) return false;
  if (!isLoopbackAddress(upgrade.peer) || upgrade.proxied) return false;
  const host = (upgrade.host || '').trim().toLowerCase();
  if (!host || !LOOPBACK_NAMES.has(hostnameOf(host))) return false;
  if (upgrade.origin !== undefined) {
    let o: URL;
    try {
      o = new URL(upgrade.origin);
    } catch {
      return false;
    }
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
    if (o.host.toLowerCase() !== host) return false;
  }
  return true;
}
