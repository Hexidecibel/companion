/**
 * Nearby daemons over mDNS (`_companion._tcp`), through the native apps
 * (nativeBridge.discoverDaemonsNative). Browsers cannot browse mDNS: null.
 */
import { discoverDaemonsNative } from './nativeBridge';
import { PairingClient, PairTarget } from './pairing';

export interface DiscoveredDaemon {
  /** Stable list key: daemon id, else host:port. */
  key: string;
  name: string;
  host: string;
  /** Addresses to try, most likely first (the daemon's own LAN hint first). */
  candidates: string[];
  port: number;
  tls: boolean;
  daemonId?: string;
  version?: string;
  pairing: boolean;
}

interface RawService {
  name?: unknown;
  host?: unknown;
  addresses?: unknown;
  port?: unknown;
  txt?: unknown;
}

function isIpv4(a: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(a);
}

function addrRank(a: string): number {
  // Bridges / gateways usually end in .1 (docker, VPNs): try real hosts first.
  const gw = /\.1$/.test(a) ? 0.5 : 0;
  if (a.startsWith('192.168.')) return 0 + gw;
  if (a.startsWith('10.')) return 1 + gw;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 2 + gw;
  return 3 + gw;
}

/**
 * Addresses to try, best first: the daemon's TXT `ip` hint, then LAN IPv4s
 * (hosts with docker / VPN bridges advertise dozens), the .local name, IPv6.
 */
function candidatesFor(r: RawService, txt: Record<string, unknown>): string[] {
  const addrs = (Array.isArray(r.addresses) ? r.addresses : []).filter((a): a is string => typeof a === 'string');
  const hint = typeof txt.ip === 'string' ? txt.ip.split(',').map((x) => x.trim()).filter(isIpv4) : [];
  const v4 = addrs
    .filter(isIpv4)
    .filter((a) => !a.startsWith('127.') && !a.startsWith('169.254.'))
    .sort((a, b) => addrRank(a) - addrRank(b));
  const host = typeof r.host === 'string' ? r.host.replace(/\.$/, '') : '';
  const v6 = addrs.filter((a) => a.includes(':') && !a.toLowerCase().startsWith('fe80'));
  return Array.from(new Set([...hint, ...v4, ...(host ? [host] : []), ...v6]));
}

export function normalizeDiscovered(raw: unknown): DiscoveredDaemon[] {
  const list = Array.isArray(raw) ? (raw as RawService[]) : [];
  const out = new Map<string, DiscoveredDaemon>();
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const txt = (r.txt && typeof r.txt === 'object' ? r.txt : {}) as Record<string, unknown>;
    const candidates = candidatesFor(r, txt);
    const host = candidates[0];
    const port = Number(r.port ?? txt.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const id = typeof txt.id === 'string' && /^[0-9a-f]{32}$/.test(txt.id) ? txt.id : undefined;
    const name =
      (typeof txt.name === 'string' && txt.name.trim()) ||
      (typeof r.name === 'string' && r.name.trim()) ||
      host;
    const d: DiscoveredDaemon = {
      key: id || `${host}:${port}`,
      name: String(name).slice(0, 60),
      host,
      candidates,
      port,
      tls: txt.tls === '1' || txt.tls === 'true',
      ...(id ? { daemonId: id } : {}),
      ...(typeof txt.version === 'string' ? { version: txt.version } : {}),
      // Older daemons advertise no pairing flag: they need a manual token.
      pairing: txt.pairing === '1',
    };
    const prev = out.get(d.key);
    if (prev) {
      // The same daemon seen twice (several interfaces): merge what to try.
      const merged = Array.from(new Set([...prev.candidates, ...d.candidates]));
      prev.candidates = [...merged.filter(isIpv4), ...merged.filter((a) => !isIpv4(a))];
      if (!isIpv4(prev.host) && isIpv4(d.host)) prev.host = d.host;
    } else out.set(d.key, d);
  }
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Browse for ~timeoutMs. null when this platform cannot browse (browser). */
export async function discoverDaemons(timeoutMs = 3000): Promise<DiscoveredDaemon[] | null> {
  const raw = await discoverDaemonsNative(timeoutMs);
  if (raw === null) return null;
  return normalizeDiscovered(raw);
}

/**
 * The first candidate that answers pair_hello (tried in parallel, best first
 * wins ties), or null. Use it before pairing with a discovered daemon.
 */
export async function pickReachable(
  d: Pick<DiscoveredDaemon, 'candidates' | 'port' | 'tls'>,
  opts: { timeoutMs?: number; max?: number; WS?: typeof WebSocket } = {},
): Promise<PairTarget | null> {
  const list = d.candidates.slice(0, opts.max ?? 6);
  if (list.length === 0) return null;
  const clients = list.map((host) => new PairingClient({ host, port: d.port, tls: d.tls }, () => {}, opts.WS ?? WebSocket));
  try {
    return await new Promise<PairTarget | null>((resolve) => {
      let left = clients.length;
      const timer = setTimeout(() => resolve(null), opts.timeoutMs ?? 3000);
      clients.forEach((c) => {
        c.hello()
          .then(() => {
            clearTimeout(timer);
            resolve(c.target);
          })
          .catch(() => {
            if (--left === 0) {
              clearTimeout(timer);
              resolve(null);
            }
          });
      });
    });
  } finally {
    clients.forEach((c) => c.close());
  }
}
