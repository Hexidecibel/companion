import Bonjour, { Service } from 'bonjour-service';
import * as os from 'os';

/**
 * `_companion._tcp` advertisement so the apps can list nearby daemons.
 *
 * TXT carries public facts only (see buildMdnsTxt); never a token, pairing
 * code, QR secret or path.
 */
export interface MdnsInfo {
  port: number;
  tls: boolean;
  /** Stable public daemon id (pairing/identity.ts). */
  id: string;
  /** Display name; also the service instance name. */
  name: string;
  version: string;
  /** Pairing is enabled (config `pairing` !== false). */
  pairing: boolean;
  /** Likely-reachable LAN IPv4s (lanAddresses()); hosts with docker / VPN bridges advertise dozens. */
  addresses?: string[];
}

export const MDNS_TXT_KEYS = [
  'id',
  'name',
  'version',
  'pairing',
  'tls',
  'port',
  'proto',
  'ip',
] as const;

/** Virtual / container / VPN interfaces: their addresses are useless to a phone on the LAN. */
const VIRTUAL_IF =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|tailscale|tun|tap|wg|zt|cni|flannel|kube|lxc|lxd|podman|utun|awdl|llw|bridge|vEthernet)/i;

function lanRank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

/** Up to 3 LAN IPv4 addresses on physical interfaces, most likely first. */
export function lanAddresses(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL_IF.test(name)) continue;
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      if (
        i.address.startsWith('100.') &&
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address)
      )
        continue; // CGNAT / tailnet: not reachable over the LAN
      out.push(i.address);
    }
  }
  return Array.from(new Set(out))
    .sort((a, b) => lanRank(a) - lanRank(b))
    .slice(0, 3);
}

export function buildMdnsTxt(
  info: MdnsInfo
): Partial<Record<(typeof MDNS_TXT_KEYS)[number], string>> {
  return {
    ...(info.addresses && info.addresses.length
      ? { ip: info.addresses.slice(0, 3).join(',') }
      : {}),
    id: info.id,
    name: info.name.slice(0, 60),
    version: info.version,
    pairing: info.pairing ? '1' : '0',
    tls: info.tls ? '1' : '0',
    port: String(info.port),
    proto: '1',
  };
}

export class MdnsAdvertiser {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  constructor(private info: MdnsInfo) {}

  start(): void {
    this.bonjour = new Bonjour();

    this.service = this.bonjour.publish({
      name: this.info.name,
      type: 'companion',
      protocol: 'tcp',
      port: this.info.port,
      txt: buildMdnsTxt(this.info),
    });

    console.log(`mDNS: Advertising _companion._tcp "${this.info.name}" on port ${this.info.port}`);

    this.service.on('up', () => {
      console.log('mDNS: Service advertised successfully');
    });

    this.service.on('error', (err: Error) => {
      console.error('mDNS: Service advertisement error:', err);
    });
  }

  stop(): void {
    if (this.service && typeof this.service.stop === 'function') {
      this.service.stop();
    }
    this.service = null;

    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }

    console.log('mDNS: Service advertisement stopped');
  }

  updatePort(port: number): void {
    this.info = { ...this.info, port };
    if (this.service) {
      this.stop();
      this.start();
    }
  }
}
