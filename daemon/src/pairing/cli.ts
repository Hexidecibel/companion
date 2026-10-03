/**
 * `companion pair` and `companion devices`: talk to the running daemon over
 * loopback with the listener token (from the config file); `devices` falls
 * back to editing devices.json directly when the daemon is not running.
 *
 *   companion pair                 Watch pairing requests; approve / deny each (y/n/s)
 *   companion pair --once          Print waiting requests and exit
 *   companion pair --approve <id>  Approve one request
 *   companion pair --deny <id>     Deny one request
 *   companion pair --qr [--host H] [--port P] [--tls|--no-tls]
 *                                  One-time pairing QR (10 min, single use)
 *   companion devices list
 *   companion devices revoke <id|name>
 *   companion devices rename <id|name> <new name>
 */
import * as os from 'os';
import * as readline from 'readline';
import QRCode from 'qrcode';
import WebSocket from 'ws';
import { loadConfig } from '../config';
import { DeviceInfo, DeviceRegistry } from './registry';
import type { PendingPairing } from './manager';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

interface Msg {
  type: string;
  success?: boolean;
  payload?: any;
  error?: string;
  requestId?: string;
}

class DaemonLink {
  private ws: WebSocket;
  private n = 0;
  private waiters = new Map<string, (m: Msg) => void>();
  private listeners: Array<(m: Msg) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      let m: Msg;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m.requestId && this.waiters.has(m.requestId)) {
        const w = this.waiters.get(m.requestId)!;
        this.waiters.delete(m.requestId);
        w(m);
        return;
      }
      for (const l of this.listeners) l(m);
    });
  }

  static async open(): Promise<DaemonLink> {
    const config = loadConfig();
    const l = config.listeners[0];
    const url = `${l.tls ? 'wss' : 'ws'}://127.0.0.1:${l.port}`;
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 4000 });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const link = new DaemonLink(ws);
    const auth = await link.request('authenticate', undefined, { token: l.token });
    if (!auth.success) throw new Error(`authentication failed: ${auth.error || 'unknown'}`);
    return link;
  }

  request(type: string, payload?: unknown, extra: Record<string, unknown> = {}): Promise<Msg> {
    const requestId = `cli_${++this.n}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`${type}: timed out`));
      }, 10_000);
      this.waiters.set(requestId, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.ws.send(JSON.stringify({ type, payload, requestId, ...extra }));
    });
  }

  on(fn: (m: Msg) => void): void {
    this.listeners.push(fn);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function localIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function printPending(p: PendingPairing): void {
  const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
  console.log(
    `  ${bold(p.deviceName)} ${dim(`(${p.platform}, ${p.addr})`)}  code ${bold(p.code)}  ${dim(`id ${p.pairingId}, ${left}s left`)}`
  );
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim().toLowerCase())));
}

export async function cmdPair(args: string[]): Promise<void> {
  let link: DaemonLink;
  try {
    link = await DaemonLink.open();
  } catch (err) {
    console.error(red(`Cannot reach the running daemon: ${(err as Error).message}`));
    console.error('Start it first (companion start).');
    process.exit(1);
  }

  const approveId = flag(args, '--approve');
  const denyId = flag(args, '--deny');
  if (approveId || denyId) {
    const r = await link.request(approveId ? 'pair_approve' : 'pair_deny', {
      pairingId: approveId || denyId,
    });
    link.close();
    if (!r.success) {
      console.error(red(r.error || 'failed'));
      process.exit(1);
    }
    console.log(approveId ? green('Approved.') : 'Denied.');
    return;
  }

  if (args.includes('--qr')) {
    const config = loadConfig();
    const l = config.listeners[0];
    const host = flag(args, '--host') || localIp();
    const port = Number(flag(args, '--port')) || l.port;
    const tls = args.includes('--tls') ? true : args.includes('--no-tls') ? false : !!l.tls;
    const r = await link.request('pair_qr_create', { host, port, tls });
    link.close();
    if (!r.success) {
      console.error(red(r.error || 'failed'));
      process.exit(1);
    }
    const qr = await QRCode.toString(r.payload.link, { type: 'terminal', small: true });
    console.log('');
    console.log('  Scan with the Companion app (Add server > Scan QR):');
    console.log('');
    console.log(qr);
    console.log(`  Or open this link on the device: ${r.payload.link}`);
    console.log(
      dim(
        `  One device, single use, expires ${new Date(r.payload.expiresAt).toLocaleTimeString()}. Wrong address? Use --host / --port / --tls.`
      )
    );
    return;
  }

  const first = await link.request('pair_pending_list');
  const pending: PendingPairing[] = first.payload?.pending ?? [];
  if (args.includes('--once')) {
    link.close();
    if (pending.length === 0) console.log('No pairing requests waiting.');
    else {
      console.log('Waiting pairing requests:');
      pending.forEach(printPending);
    }
    return;
  }

  const interactive = process.stdin.isTTY && !args.includes('--no-prompt');
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const seen = new Set<string>();
  const queue: PendingPairing[] = [];
  let busy = false;

  const pump = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const p = queue.shift()!;
      if (p.expiresAt <= Date.now()) continue;
      console.log('');
      console.log('New device wants to pair:');
      printPending(p);
      if (!rl) continue;
      const a = await ask(rl, '  Approve? [y]es / [n]o / [s]kip: ');
      if (a === 'y' || a === 'yes') {
        const r = await link.request('pair_approve', { pairingId: p.pairingId });
        console.log(r.success ? green('  Approved.') : red(`  ${r.error}`));
      } else if (a === 'n' || a === 'no') {
        const r = await link.request('pair_deny', { pairingId: p.pairingId });
        console.log(r.success ? '  Denied.' : red(`  ${r.error}`));
      } else {
        console.log(dim('  Skipped (the device can still enter the code).'));
      }
    }
    busy = false;
  };

  const offer = (list: PendingPairing[]) => {
    for (const p of list) {
      if (seen.has(p.pairingId)) continue;
      seen.add(p.pairingId);
      queue.push(p);
    }
    void pump();
  };

  console.log(
    `Watching for pairing requests ${dim('(Ctrl-C to stop; a new device: Add server > pick this server)')}`
  );
  link.on((m) => {
    if (m.type === 'pair_pending') offer(m.payload?.pending ?? []);
  });
  offer(pending);
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      rl?.close();
      link.close();
      resolve();
    });
  });
}

function resolveDevice(devices: DeviceInfo[], ref: string): DeviceInfo {
  const byId = devices.find((d) => d.id === ref);
  if (byId) return byId;
  const byName = devices.filter((d) => d.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    console.error(red(`Several devices are named "${ref}"; use the id.`));
    process.exit(1);
  }
  console.error(red(`No device "${ref}" (companion devices list).`));
  process.exit(1);
}

export async function cmdDevices(args: string[]): Promise<void> {
  const sub = args[0] || 'list';
  let link: DaemonLink | null = null;
  try {
    link = await DaemonLink.open();
  } catch {
    link = null; // daemon down: edit the file directly
  }
  const registry = new DeviceRegistry();
  const devices: DeviceInfo[] = link
    ? ((await link.request('devices_list')).payload?.devices ?? [])
    : registry.list();

  try {
    if (sub === 'list') {
      if (!link) console.log(dim('(daemon not running: reading devices.json)'));
      if (devices.length === 0) {
        console.log('No paired devices. Pair one: open the app > Add server, then: companion pair');
        return;
      }
      for (const d of devices) {
        console.log(
          `  ${bold(d.name)}  ${dim(d.id)}  ${d.platform}  paired ${new Date(d.createdAt).toLocaleDateString()} via ${d.via}  last seen ${ago(d.lastSeenAt)}`
        );
      }
      return;
    }
    if (sub === 'revoke') {
      if (!args[1]) throw new Error('Usage: companion devices revoke <id|name>');
      const d = resolveDevice(devices, args[1]);
      if (link) {
        const r = await link.request('device_revoke', { deviceId: d.id });
        if (!r.success) throw new Error(r.error || 'failed');
      } else if (!registry.revoke(d.id)) throw new Error('failed');
      console.log(green(`Revoked "${d.name}". It is signed out and must pair again.`));
      return;
    }
    if (sub === 'rename') {
      if (!args[1] || !args[2])
        throw new Error('Usage: companion devices rename <id|name> <new name>');
      const d = resolveDevice(devices, args[1]);
      const name = args.slice(2).join(' ');
      if (link) {
        const r = await link.request('device_rename', { deviceId: d.id, name });
        if (!r.success) throw new Error(r.error || 'failed');
      } else if (!registry.rename(d.id, name)) throw new Error('failed');
      console.log(green(`Renamed to "${name}".`));
      return;
    }
    throw new Error(
      'Usage: companion devices list | revoke <id|name> | rename <id|name> <new name>'
    );
  } catch (err) {
    console.error(red((err as Error).message));
    process.exitCode = 1;
  } finally {
    link?.close();
  }
}
