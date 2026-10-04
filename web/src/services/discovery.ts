/**
 * Nearby daemons over mDNS (`_companion._tcp`), through the native apps
 * (nativeBridge.discoverDaemonsNative). Browsers cannot browse mDNS: null.
 */
import { discoverDaemonsNative } from './nativeBridge';

export interface DiscoveredDaemon {
  /** Stable list key: daemon id, else host:port. */
  key: string;
  name: string;
  host: string;
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

/** Pick the most useful address: a LAN IPv4, else any IPv4, else the host name. */
function pickHost(r: RawService): string | null {
  const addrs = (Array.isArray(r.addresses) ? r.addresses : []).filter((a): a is string => typeof a === 'string');
  const v4 = addrs.filter(isIpv4).filter((a) => !a.startsWith('127.') && !a.startsWith('169.254.'));
  if (v4.length) return v4[0];
  const host = typeof r.host === 'string' ? r.host.replace(/\.$/, '') : '';
  if (host) return host;
  const v6 = addrs.find((a) => a.includes(':') && !a.toLowerCase().startsWith('fe80'));
  return v6 || null;
}

export function normalizeDiscovered(raw: unknown): DiscoveredDaemon[] {
  const list = Array.isArray(raw) ? (raw as RawService[]) : [];
  const out = new Map<string, DiscoveredDaemon>();
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const txt = (r.txt && typeof r.txt === 'object' ? r.txt : {}) as Record<string, unknown>;
    const host = pickHost(r);
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
      port,
      tls: txt.tls === '1' || txt.tls === 'true',
      ...(id ? { daemonId: id } : {}),
      ...(typeof txt.version === 'string' ? { version: txt.version } : {}),
      // Older daemons advertise no pairing flag: they need a manual token.
      pairing: txt.pairing === '1',
    };
    const prev = out.get(d.key);
    // Prefer an IPv4 address when the same daemon shows up twice.
    if (!prev || (!isIpv4(prev.host) && isIpv4(d.host))) out.set(d.key, d);
  }
  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Browse for ~timeoutMs. null when this platform cannot browse (browser). */
export async function discoverDaemons(timeoutMs = 3000): Promise<DiscoveredDaemon[] | null> {
  const raw = await discoverDaemonsNative(timeoutMs);
  if (raw === null) return null;
  return normalizeDiscovered(raw);
}
