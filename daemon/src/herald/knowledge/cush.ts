/**
 * cush-tools integration for Herald: read the live tool status, and run a small,
 * allowlisted set of commands through the action guardrails.
 *
 * Herald never builds a shell string. A command is a validated structure
 * ({ op, name, dir?, port? }) mapped to an absolute binary + argv here, and run
 * with guardedExecFile (timeout + SIGKILL + dedupe + bounded output + minimal env).
 *
 * Allowed ops: extend, close, serve, tunnel, drop. Everything else (secure-entry,
 * inject, stash, deploy, cert tools, expose, publish-tarball, ...) is refused in
 * code: it is not a tool option at all.
 *
 * After a launch, "it's up" is only claimed when BOTH the tool's local port
 * answers on 127.0.0.1 AND frpc logged "start proxy success" for it. The public
 * *.tunnel.cush.rocks URL is deliberately not fetched: this machine has no
 * hairpin NAT, so that check fails even when the link works for everyone else.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { guardedExecFile, GuardedExecResult } from './guarded-exec';
import { deniedDirs, isDeniedPath, redactSecrets } from './redact';

export type CushOp = 'extend' | 'close' | 'serve' | 'tunnel' | 'drop';
export const CUSH_OPS: readonly CushOp[] = ['extend', 'close', 'serve', 'tunnel', 'drop'];

/** Named explicitly so the refusal is specific. Anything not in CUSH_OPS is refused too. */
export const CUSH_FORBIDDEN_OPS = [
  'secure-entry',
  'inject',
  'stash',
  'deploy',
  'expose',
  'publish-tarball',
  'issue-cert',
  'renew-cert',
  'certbot',
  'auth-admin',
  'auth-deploy',
  'close-all',
  'exchange',
  'paste',
  'frps',
  'frpc',
];

export const CUSH_NAME_RE = /^[a-z0-9-]{2,32}$/;
export const TUNNEL_DOMAIN = 'tunnel.cush.rocks';
export const PRODUCTION_COMPANION_PORTS = [9877, 9878];
const STATUS_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 20_000;
const VERIFY_WINDOW_MS = 12_000;
const VERIFY_POLL_MS = 400;
const LOCAL_HTTP_TIMEOUT_MS = 3000;
const MAX_LOG_READ = 64 * 1024;
const WALK_MAX_ENTRIES = 5000;
const WALK_MAX_DEPTH = 8;
const WALK_TIME_BUDGET_MS = 1500;

export interface CushCommand {
  op: CushOp;
  name: string;
  /** serve: absolute realpath of the directory. */
  dir?: string;
  /** tunnel: local port. */
  port?: number;
}

export interface CushTool {
  name: string;
  type: string;
  url: string;
  uptime: string;
  expires: string | null;
  background: boolean;
  managed: boolean;
}

export interface CushStatus {
  ok: boolean;
  server: 'running' | 'stopped' | 'unknown';
  tools: CushTool[];
  error?: string;
}

export function publicUrl(name: string): string {
  return `https://${name}.${TUNNEL_DOMAIN}`;
}

// ---------------------------------------------------------------------------
// Status parsing

const ROW =
  /^\s{2}(\S+)\s+(.+?)\s+(https:\/\/[a-z0-9.-]+)\s+(unknown|<1m|\d+h \d+m|\d+m)\s+(.*?)\s*$/;

/** Parse ANSI-stripped `bin/status` output. */
export function parseCushStatus(text: string): Omit<CushStatus, 'ok'> {
  const lines = (text || '').split('\n');
  let server: CushStatus['server'] = 'unknown';
  const tools: CushTool[] = [];
  let inTunnels = false;
  for (const line of lines) {
    if (/^=== frp Server ===/.test(line)) continue;
    const st = line.match(/^Status:\s+(RUNNING|STOPPED)/);
    if (st) server = st[1] === 'RUNNING' ? 'running' : 'stopped';
    if (/^=== Active Tunnels ===/.test(line)) {
      inTunnels = true;
      continue;
    }
    if (!inTunnels) continue;
    const m = line.match(ROW);
    if (!m || m[1] === 'NAME') continue;
    const typeRaw = m[2].trim();
    const expiresRaw = m[5].trim();
    tools.push({
      name: m[1],
      type: typeRaw.replace(/\s*\(bg\)$/, ''),
      url: m[3],
      uptime: m[4],
      expires: expiresRaw === '--' || !expiresRaw ? null : expiresRaw,
      background: /\(bg\)$/.test(typeRaw),
      managed: typeRaw !== 'unmanaged',
    });
  }
  return { server, tools };
}

// ---------------------------------------------------------------------------
// Validation

export interface CushProposalInput {
  operation?: unknown;
  name?: unknown;
  dir?: unknown;
  port?: unknown;
}

/** Facts gathered while validating, used for tier reasons and the readback. */
export interface CushFacts {
  /** close: the tool was opened by Herald (tracked in Herald state). */
  openedByHerald?: boolean;
  /** serve: what exactly becomes public. */
  exposure?: string;
  /** tunnel: what the port registry says is on that port. */
  portService?: string | null;
  /** extra reasons to show (always shown on hard_confirm cards). */
  warnings: string[];
  /** Display form of the target (e.g. "~/local/src/companion/web/dist"). */
  target?: string;
}

export type CushValidation =
  | { ok: true; cmd: CushCommand; facts: CushFacts }
  | { ok: false; error: string };

export interface CushValidateContext {
  userHome: string;
  cushToolsDir: string;
  /** Live tools (null when bin/status could not be read). */
  active: CushTool[] | null;
  openedByHerald: ReadonlySet<string>;
  /** Port-registry lookup; may return null. */
  portInfo?: (port: number) => Promise<string | null>;
  /** Is anything listening on 127.0.0.1:port? */
  isListening?: (port: number) => Promise<boolean>;
  display?: (p: string) => string;
}

export function validateCushName(
  name: unknown
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof name !== 'string' || !name.trim())
    return { ok: false, error: 'A name is required (the subdomain, e.g. "phone-share").' };
  const n = name.trim();
  if (!CUSH_NAME_RE.test(n)) {
    return {
      ok: false,
      error: `"${n.slice(0, 40)}" is not a valid name: use 2 to 32 lowercase letters, digits or hyphens (it becomes the web address).`,
    };
  }
  if (n.startsWith('-') || n.endsWith('-')) {
    return { ok: false, error: `"${n}" is not a valid name: it can't start or end with a hyphen.` };
  }
  return { ok: true, name: n };
}

function isUnder(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Top-level/anywhere entry names that must never be published. */
const SECRET_ENTRY =
  /^(?:\.env(?:$|[.-])|.*\.env$|\.cush-secrets.*|.*\.(?:pem|key|p12|pfx)$|id_[a-z0-9]+(?:\.pub)?$|\.netrc$|\.npmrc$|\.git-credentials$|\.htpasswd$)/i;

export interface DirInspection {
  ok: boolean;
  error?: string;
  real?: string;
  files?: number;
  bytes?: number;
  partial?: boolean;
  hasGit?: boolean;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Decide whether a directory may be served publicly. Resolves symlinks, refuses
 * sensitive locations, and walks the tree (bounded) refusing secret-looking files
 * and symlinks that point outside the folder (python's http.server follows them).
 */
export async function inspectServeDir(
  rawDir: string,
  ctx: { userHome: string; cushToolsDir: string; display?: (p: string) => string }
): Promise<DirInspection> {
  const show = ctx.display || ((p: string) => p);
  let dir = rawDir.trim();
  if (dir === '~' || dir.startsWith('~/')) dir = path.join(ctx.userHome, dir.slice(1));
  if (!path.isAbsolute(dir)) {
    return { ok: false, error: `"${rawDir}" is not a full path. Give the folder's full path.` };
  }
  let real: string;
  try {
    real = await fs.promises.realpath(dir);
  } catch {
    return {
      ok: false,
      error: `The folder ${show(dir)} does not exist. Don't guess paths: find the project's folder with search_project_notes (projects live in ~/local/src/<project>) or ask the user.`,
    };
  }
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(real);
  } catch {
    return { ok: false, error: `The folder ${show(dir)} can't be read.` };
  }
  if (!st.isDirectory()) return { ok: false, error: `${show(dir)} is a file, not a folder.` };

  const home = path.resolve(ctx.userHome);
  const refuse = (why: string) => ({ ok: false, error: `Refusing to share ${show(real)}: ${why}` });
  if (real === '/') return refuse('that is the whole filesystem.');
  // $HOME itself, or anything that contains it (/home), exposes everything.
  if (isUnder(home, real)) return refuse('that would expose your entire home folder.');
  const sensitive = [
    path.join(home, '.ssh'),
    path.join(home, '.config'),
    path.join(home, '.claude'),
    path.join(home, '.companion'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.local', 'share', 'keyrings'),
    path.resolve(ctx.cushToolsDir),
    '/etc',
    '/root',
    '/proc',
    '/sys',
    '/dev',
    '/boot',
    '/var',
    '/run',
    ...deniedDirs([home]),
  ];
  const hit = sensitive.find((s) => isUnder(real, s));
  if (hit)
    return refuse(`it is inside ${show(hit)}, which holds private configuration or credentials.`);
  if (isDeniedPath(real, [home])) return refuse('that location is on the private-files denylist.');

  // Bounded walk.
  const started = Date.now();
  let files = 0;
  let bytes = 0;
  let seen = 0;
  let partial = false;
  let hasGit = false;
  const queue: Array<{ d: string; depth: number }> = [{ d: real, depth: 0 }];
  while (queue.length) {
    const { d, depth } = queue.shift()!;
    let ents: fs.Dirent[];
    try {
      ents = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (++seen > WALK_MAX_ENTRIES || Date.now() - started > WALK_TIME_BUDGET_MS) {
        partial = true;
        break;
      }
      const full = path.join(d, e.name);
      const rel = path.relative(real, full);
      if (SECRET_ENTRY.test(e.name) || (e.isFile() && isDeniedPath(full, [home]))) {
        return refuse(`it contains ${rel}, which looks like a secret or key file.`);
      }
      if (e.name === '.git' && depth === 0) hasGit = true;
      if (e.isSymbolicLink()) {
        let target: string;
        try {
          target = await fs.promises.realpath(full);
        } catch {
          continue; // dangling link: serves nothing
        }
        if (!isUnder(target, real)) {
          return refuse(
            `it contains a link (${rel}) that points outside the folder, to ${show(target)}.`
          );
        }
        continue;
      }
      if (e.isDirectory()) {
        if (depth + 1 <= WALK_MAX_DEPTH) queue.push({ d: full, depth: depth + 1 });
        else partial = true;
      } else if (e.isFile()) {
        files++;
        try {
          bytes += (await fs.promises.stat(full)).size;
        } catch {
          /* ignore */
        }
      }
    }
    if (partial) break;
  }
  return { ok: true, real, files, bytes, partial, hasGit };
}

function defaultIsListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(800, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Validate a proposed command. Refuses forbidden ops outright. */
export async function validateCushCommand(
  input: CushProposalInput,
  ctx: CushValidateContext
): Promise<CushValidation> {
  const show = ctx.display || ((p: string) => p);
  const opRaw = typeof input.operation === 'string' ? input.operation.trim().toLowerCase() : '';
  if (!opRaw)
    return { ok: false, error: 'An operation is required: extend, close, serve, tunnel or drop.' };
  if (!(CUSH_OPS as readonly string[]).includes(opRaw)) {
    const named = CUSH_FORBIDDEN_OPS.includes(opRaw) ? `"${opRaw}"` : `"${opRaw.slice(0, 30)}"`;
    return {
      ok: false,
      error: `I can't run ${named} from here: I can only extend, close, serve a folder, tunnel a port, or open a file drop. Secrets, deploys, certificates and permanent exposure stay manual. Tell the user they need to run it themselves.`,
    };
  }
  const op = opRaw as CushOp;
  const nv = validateCushName(input.name);
  if (!nv.ok) return nv;
  const name = nv.name;
  const active = ctx.active;
  const existing = active?.find((t) => t.name === name) || null;
  const facts: CushFacts = { warnings: [] };

  // Fields that don't belong to the op are rejected, never silently dropped.
  if (op !== 'serve' && input.dir !== undefined && input.dir !== null && input.dir !== '')
    return { ok: false, error: `"dir" only applies to serve.` };
  if (op !== 'tunnel' && input.port !== undefined && input.port !== null)
    return { ok: false, error: `"port" only applies to tunnel.` };

  if (op === 'extend' || op === 'close') {
    if (!active)
      return {
        ok: false,
        error: "I couldn't read the cush-tools status, so I can't check that tool is running.",
      };
    if (!existing) {
      const names = active.map((t) => t.name);
      return {
        ok: false,
        error: `No running tool is called "${name}". ${names.length ? `Running: ${names.join(', ')}.` : 'Nothing is running.'}`,
      };
    }
    if (op === 'extend' && !existing.managed)
      return {
        ok: false,
        error: `"${name}" was started outside cush-tools' tracking, so it has no timer to extend.`,
      };
    facts.openedByHerald = ctx.openedByHerald.has(name);
    facts.target = existing.url;
    return { ok: true, cmd: { op, name }, facts };
  }

  // Launches: the name must be free.
  if (existing) {
    return {
      ok: false,
      error: `The name "${name}" is already in use by a running ${existing.type}. Pick another name, or close that one first.`,
    };
  }
  if (!active) facts.warnings.push("couldn't read the cush-tools status to check the name is free");

  if (op === 'serve') {
    if (typeof input.dir !== 'string' || !input.dir.trim())
      return { ok: false, error: 'serve needs "dir": the full path of the folder to share.' };
    const insp = await inspectServeDir(input.dir, {
      userHome: ctx.userHome,
      cushToolsDir: ctx.cushToolsDir,
      display: show,
    });
    if (!insp.ok) return { ok: false, error: insp.error! };
    const count = `${insp.partial ? 'at least ' : ''}${insp.files} file${insp.files === 1 ? '' : 's'}, ${fmtBytes(insp.bytes || 0)}`;
    facts.target = show(insp.real!);
    facts.exposure = `makes every file in ${show(insp.real!)} (${count}) readable by anyone with the link ${publicUrl(name)}`;
    if (insp.hasGit) facts.warnings.push('the folder includes its .git history');
    if (insp.partial)
      facts.warnings.push('the folder is large; only part of it was checked for secret files');
    return { ok: true, cmd: { op, name, dir: insp.real }, facts };
  }

  if (op === 'tunnel') {
    const port =
      typeof input.port === 'string' && /^\d+$/.test(input.port) ? Number(input.port) : input.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
      return { ok: false, error: 'tunnel needs "port": a whole number from 1 to 65535.' };
    const listening = await (ctx.isListening || defaultIsListening)(port);
    if (!listening)
      return {
        ok: false,
        error: `Nothing is listening on local port ${port}, so there's nothing to tunnel.`,
      };
    facts.portService = ctx.portInfo ? await ctx.portInfo(port).catch(() => null) : null;
    facts.target = `local port ${port}`;
    if (PRODUCTION_COMPANION_PORTS.includes(port))
      facts.warnings.push(
        `port ${port} is the Companion daemon itself, which can type into your sessions`
      );
    else if (facts.portService)
      facts.warnings.push(`port ${port} is ${facts.portService} in the port registry`);
    return { ok: true, cmd: { op, name, port }, facts };
  }

  // drop
  facts.target = `~/drops/${name}`;
  return { ok: true, cmd: { op, name }, facts };
}

// ---------------------------------------------------------------------------
// Rendering

/** Exact argv (after the binary) for a command. `--bg` on every launch. */
export function cushArgv(cmd: CushCommand): { bin: string; args: string[] } {
  switch (cmd.op) {
    case 'extend':
      return { bin: 'status', args: ['extend', cmd.name] };
    case 'close':
      return { bin: 'status', args: ['close', cmd.name] };
    case 'serve':
      return { bin: 'serve', args: [cmd.dir!, cmd.name, '--bg'] };
    case 'tunnel':
      return { bin: 'tunnel', args: [String(cmd.port), cmd.name, '--bg'] };
    case 'drop':
      return { bin: 'drop', args: [cmd.name, '--bg'] };
  }
}

/** The command as shown on the card (the payload). */
export function cushCommandLine(cmd: CushCommand): string {
  const { bin, args } = cushArgv(cmd);
  return `${bin} ${args.join(' ')}`;
}

export function cushReadback(cmd: CushCommand, facts: CushFacts): string {
  const url = publicUrl(cmd.name);
  switch (cmd.op) {
    case 'extend':
      return `Keep ${cmd.name} open for another hour`;
    case 'close':
      return `Close ${cmd.name} (${url})`;
    case 'serve':
      return `Share the folder ${facts.target} publicly at ${url}`;
    case 'tunnel':
      return `Expose local port ${cmd.port} publicly at ${url}`;
    case 'drop':
      return `Open a file drop at ${url} (uploads land in ~/drops/${cmd.name})`;
  }
}

// ---------------------------------------------------------------------------
// Execution + verification

export interface CushRunResult {
  /** The command itself ran successfully. */
  ok: boolean;
  url?: string;
  /** Launches: both local port and frpc checks passed. */
  verified?: boolean;
  localPort?: number;
  checks?: { localHttp: string; tunnel: string };
  /** One or two plain sentences for the user. */
  message: string;
  error?: string;
}

export interface CushRunnerDeps {
  cushToolsDir: string;
  userHome: string;
  exec?: typeof guardedExecFile;
  /** Test hooks. */
  httpCheck?: (port: number) => Promise<{ ok: boolean; detail: string }>;
  sleep?: (ms: number) => Promise<void>;
  verifyWindowMs?: number;
  now?: () => number;
}

function localHttpCheck(port: number): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: LOCAL_HTTP_TIMEOUT_MS },
      (res) => {
        res.resume();
        const code = res.statusCode || 0;
        resolve(
          code > 0 && code < 500
            ? { ok: true, detail: `answered HTTP ${code}` }
            : { ok: false, detail: `answered HTTP ${code}` }
        );
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: 'did not answer in time' });
    });
    req.on('error', (e) =>
      resolve({
        ok: false,
        detail: `refused the connection (${(e as NodeJS.ErrnoException).code || 'error'})`,
      })
    );
  });
}

async function readFrom(file: string, offset: number): Promise<string> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const st = await fh.stat();
    const start = st.size < offset ? 0 : offset; // truncated/rotated: read from the top
    const len = Math.min(MAX_LOG_READ, st.size - start);
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Parse the local port + frpc outcome out of a tool's fresh log output. */
export function parseLaunchLog(
  text: string,
  name: string
): { port: number | null; proxyOk: boolean; proxyError: string | null } {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
  const portMatch =
    clean.match(/Tunneling localhost:(\d{1,5})\s/) ||
    clean.match(/Listening on :(\d{1,5})/) ||
    clean.match(/on http:\/\/localhost:(\d{1,5})/);
  const esc = name.replace(/[-]/g, '\\-');
  const proxyOk = new RegExp(`\\[${esc}\\] start proxy success`).test(clean);
  const errLine = clean
    .split('\n')
    .find((l) =>
      /start proxy error|login to server failed|already (?:exists|in use)|port already used|Error:/i.test(
        l
      )
    );
  return {
    port: portMatch ? Number(portMatch[1]) : null,
    proxyOk,
    proxyError: errLine ? redactSecrets(errLine.trim()).slice(0, 200) : null,
  };
}

export async function runCushCommand(
  cmd: CushCommand,
  deps: CushRunnerDeps
): Promise<CushRunResult> {
  const exec = deps.exec || guardedExecFile;
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const { bin, args } = cushArgv(cmd);
  const binPath = path.join(deps.cushToolsDir, 'bin', bin);
  const url = publicUrl(cmd.name);
  const logFile = path.join(deps.cushToolsDir, 'logs', `${cmd.name}.log`);
  const launch = cmd.op === 'serve' || cmd.op === 'tunnel' || cmd.op === 'drop';

  let logOffset = 0;
  if (launch) {
    try {
      logOffset = (await fs.promises.stat(logFile)).size;
    } catch {
      logOffset = 0;
    }
  }

  const res: GuardedExecResult = await exec(binPath, args, {
    key: `cush:${cmd.op}:${cmd.name}`,
    timeoutMs: COMMAND_TIMEOUT_MS,
    cwd: deps.cushToolsDir,
    home: deps.userHome,
  });
  const outText = `${res.stdout}\n${res.stderr}`.trim();
  if (!res.ok) {
    const why = res.error || (outText.split('\n').pop() || 'failed').slice(0, 200);
    return { ok: false, message: `That didn't work: ${why}.`, error: why };
  }

  if (cmd.op === 'extend') {
    const line = outText.split('\n').find((l) => /Extended/.test(l)) || `Extended ${cmd.name}.`;
    return { ok: true, url, message: `${line.trim().replace(/\.?$/, '.')}` };
  }
  if (cmd.op === 'close') {
    return { ok: true, url, message: `Closed ${cmd.name}; ${url} no longer works.` };
  }

  const printed = outText.match(/https:\/\/[a-z0-9-]+\.tunnel\.cush\.rocks/);
  const finalUrl = printed ? printed[0] : url;

  // Verify: local port answers + frpc reports the proxy started.
  const deadline = now() + (deps.verifyWindowMs ?? VERIFY_WINDOW_MS);
  let parsed = { port: null as number | null, proxyOk: false, proxyError: null as string | null };
  while (now() < deadline) {
    parsed = parseLaunchLog(await readFrom(logFile, logOffset), cmd.name);
    if ((parsed.port && parsed.proxyOk) || parsed.proxyError) break;
    await sleep(VERIFY_POLL_MS);
  }
  const port = parsed.port ?? (cmd.op === 'tunnel' ? cmd.port! : null);
  let localHttp = { ok: false, detail: 'never reported a local port' };
  if (port) localHttp = await (deps.httpCheck || localHttpCheck)(port);
  const tunnel = parsed.proxyOk
    ? { ok: true, detail: 'frpc reported the tunnel connected' }
    : { ok: false, detail: parsed.proxyError || 'frpc never reported the tunnel connected' };

  const what =
    cmd.op === 'serve'
      ? `Sharing ${cmd.dir ? path.basename(cmd.dir) : 'the folder'} at ${finalUrl}`
      : cmd.op === 'tunnel'
        ? `Port ${cmd.port} is exposed at ${finalUrl}`
        : `File drop open at ${finalUrl}`;
  const verified = localHttp.ok && tunnel.ok;
  const failed = [
    !localHttp.ok ? `the local server on port ${port ?? '?'} ${localHttp.detail}` : '',
    !tunnel.ok ? tunnel.detail : '',
  ].filter(Boolean);
  const message = verified
    ? `${what}. It's up: the local server answered and the tunnel connected. It closes on its own in about an hour.`
    : `${what}, but I couldn't confirm it's up: ${failed.join(', and ')}.`;
  return {
    ok: true,
    url: finalUrl,
    verified,
    localPort: port ?? undefined,
    checks: { localHttp: localHttp.detail, tunnel: tunnel.detail },
    message,
  };
}

export async function fetchCushStatus(deps: {
  cushToolsDir: string;
  userHome: string;
  exec?: typeof guardedExecFile;
}): Promise<CushStatus> {
  const exec = deps.exec || guardedExecFile;
  const res = await exec(path.join(deps.cushToolsDir, 'bin', 'status'), [], {
    key: 'cush:status',
    timeoutMs: STATUS_TIMEOUT_MS,
    cwd: deps.cushToolsDir,
    home: deps.userHome,
  });
  if (!res.ok) {
    return { ok: false, server: 'unknown', tools: [], error: res.error || 'bin/status failed' };
  }
  return { ok: true, ...parseCushStatus(res.stdout) };
}
