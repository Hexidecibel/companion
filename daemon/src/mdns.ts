import Bonjour, { Service } from 'bonjour-service';

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
}

export const MDNS_TXT_KEYS = ['id', 'name', 'version', 'pairing', 'tls', 'port', 'proto'] as const;

export function buildMdnsTxt(info: MdnsInfo): Record<(typeof MDNS_TXT_KEYS)[number], string> {
  return {
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
