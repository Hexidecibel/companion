/**
 * Herald self-knowledge: where the Companion web UI is reachable, derived once at
 * startup from the listener config and the host's network interfaces. Only the
 * port, scheme and IPv4 addresses are used; tokens never leave the config.
 */

import * as os from 'os';

export interface HeraldSelfInfo {
  /** Web UI URLs the user can open, best first (e.g. "http://192.168.1.48:9877/web"). */
  webUrls: string[];
}

type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** Container/VM bridge interfaces never reachable from the user's other devices. */
const VIRTUAL_IFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|cali|lxc|lxd|podman|kube|tun-docker)/i;
const MAX_ADDRESSES = 3;

function ipv4Octets(addr: string): number[] | null {
  const parts = addr.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
}

/** Rank an address: 0 = LAN 192.168.x, 1 = tailnet 100.64/10, 2 = other; null = skip. */
function rankAddress(addr: string): number | null {
  const o = ipv4Octets(addr);
  if (!o) return null;
  if (o[0] === 127 || o[0] === 0) return null; // loopback / unspecified
  if (o[0] === 169 && o[1] === 254) return null; // link-local
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return null; // docker default ranges
  if (o[0] === 10 && o[1] === 200) return null; // docker bridge pool on this fleet
  if (o[0] === 192 && o[1] === 168) return 0;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 1;
  return 2;
}

/** Reachable non-loopback IPv4 addresses, LAN first, then tailnet, docker/bridges skipped. */
export function reachableAddresses(interfaces: Interfaces = os.networkInterfaces()): string[] {
  const found: { addr: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (!list || VIRTUAL_IFACE.test(name)) continue;
    for (const iface of list) {
      const family = iface.family as unknown;
      if (iface.internal || (family !== 'IPv4' && family !== 4)) continue;
      const rank = rankAddress(iface.address);
      if (rank === null || found.some((f) => f.addr === iface.address)) continue;
      found.push({ addr: iface.address, rank });
    }
  }
  return found
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_ADDRESSES)
    .map((f) => f.addr);
}

/** Build the self-info from the primary listener (port + TLS flag only). */
export function deriveSelfInfo(
  listener: { port: number; tls?: boolean } | undefined,
  interfaces?: Interfaces
): HeraldSelfInfo {
  if (!listener || !Number.isInteger(listener.port)) return { webUrls: [] };
  const scheme = listener.tls ? 'https' : 'http';
  const webUrls = reachableAddresses(interfaces).map(
    (addr) => `${scheme}://${addr}:${listener.port}/web`
  );
  return { webUrls };
}
