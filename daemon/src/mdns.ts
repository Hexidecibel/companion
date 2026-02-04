import Bonjour, { Service } from 'bonjour-service';
import * as os from 'os';

export class MdnsAdvertiser {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;
  private port: number;
  private tls: boolean;

  constructor(port: number, tls: boolean) {
    this.port = port;
    this.tls = tls;
  }

  start(): void {
    this.bonjour = new Bonjour();

    const hostname = os.hostname();

    this.service = this.bonjour.publish({
      name: `Companion on ${hostname}`,
      type: 'companion',
      protocol: 'tcp',
      port: this.port,
      txt: {
        version: '1.0',
        tls: this.tls ? 'true' : 'false',
        hostname: hostname,
      },
    });

    console.log(`mDNS: Advertising _companion._tcp on port ${this.port}`);

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
    this.port = port;
    if (this.service) {
      this.stop();
      this.start();
    }
  }
}
