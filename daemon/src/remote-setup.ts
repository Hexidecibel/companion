/**
 * `companion enable-remote` — interactive and non-interactive configurator
 * for the `remote_capabilities` block in the daemon config.
 *
 * Interactive usage:
 *   companion enable-remote
 *
 * Non-interactive usage:
 *   companion enable-remote --enable exec,write,dispatch --write-roots /tmp/foo,/tmp/bar --allowed-origins mcp-abc
 *   companion enable-remote --disable
 *
 * Writes back the same file verbatim (preserving key order + extra keys) with
 * `remote_capabilities` inserted/updated either at the root (flat config) or on
 * the first listener (listeners[] array form).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import { resolveConfigPath } from './config';
import { atomicWriteFileSync } from './utils';

// ANSI colors (matching cli.ts style)
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

type SubCap = 'exec' | 'dispatch' | 'write';

interface CliFlags {
  enabled: boolean;
  enable: Set<SubCap>;
  writeRoots: string[];
  allowedOrigins: string[];
  nonInteractive: boolean;
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = {
    enabled: true,
    enable: new Set(),
    writeRoots: [],
    allowedOrigins: [],
    nonInteractive: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--disable':
        flags.enabled = false;
        flags.nonInteractive = true;
        break;
      case '--enable': {
        const val = args[++i] || '';
        flags.nonInteractive = true;
        for (const part of val.split(',').map((s) => s.trim()).filter(Boolean)) {
          if (part === 'exec' || part === 'dispatch' || part === 'write') {
            flags.enable.add(part);
          } else {
            console.error(red(`Unknown capability: ${part}`));
            console.error('  Valid: exec, dispatch, write');
            process.exit(1);
          }
        }
        break;
      }
      case '--write-roots': {
        const val = args[++i] || '';
        flags.writeRoots = val.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--allowed-origins': {
        const val = args[++i] || '';
        flags.allowedOrigins = val.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      default:
        console.error(red(`Unknown option: ${arg}`));
        process.exit(1);
    }
  }
  return flags;
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer)));
}

async function yesNo(
  rl: readline.Interface,
  question: string,
  defaultYes: boolean
): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await prompt(rl, `${question} ${hint} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function buildRemoteCapabilitiesBlock(
  wantedEnabled: boolean,
  enable: Set<SubCap>,
  writeRoots: string[],
  allowedOrigins: string[]
): Record<string, unknown> {
  const block: Record<string, unknown> = { enabled: wantedEnabled };
  block.exec = { enabled: enable.has('exec') };
  block.dispatch = { enabled: enable.has('dispatch') };
  block.write = {
    enabled: enable.has('write'),
    roots: enable.has('write') ? writeRoots : [],
  };
  if (allowedOrigins.length > 0) {
    block.allowed_origins = allowedOrigins;
  }
  return block;
}

/**
 * Apply the `remote_capabilities` block onto a parsed config object, preserving
 * all other keys. Returns a description of where it was applied (root vs. listener[i]).
 */
function applyToConfig(
  parsed: Record<string, unknown>,
  block: Record<string, unknown>
): { location: 'root' | 'listener'; listenerIndex?: number; listenerPort?: number } {
  if (Array.isArray((parsed as any).listeners) && (parsed as any).listeners.length > 0) {
    const listeners = (parsed as any).listeners as Array<Record<string, unknown>>;
    // Edit the first listener — if there are multiple, we could prompt, but
    // for now apply to the first (the common case).
    listeners[0].remote_capabilities = block;
    return {
      location: 'listener',
      listenerIndex: 0,
      listenerPort: (listeners[0] as any).port as number | undefined,
    };
  }
  parsed.remote_capabilities = block;
  return { location: 'root' };
}

function getListenerForMcp(parsed: Record<string, unknown>): {
  port: number | undefined;
  token: string | undefined;
  tls: boolean;
} {
  if (Array.isArray((parsed as any).listeners) && (parsed as any).listeners.length > 0) {
    const l = (parsed as any).listeners[0] as any;
    return { port: l.port, token: l.token, tls: Boolean(l.tls) };
  }
  return {
    port: (parsed as any).port as number | undefined,
    token: (parsed as any).token as string | undefined,
    tls: Boolean((parsed as any).tls),
  };
}

function printResult(
  configPath: string,
  block: Record<string, unknown>,
  listenerInfo: { port: number | undefined; token: string | undefined; tls: boolean }
): void {
  const exec = block.exec as { enabled: boolean };
  const dispatch = block.dispatch as { enabled: boolean };
  const write = block.write as { enabled: boolean; roots: string[] };
  const allowedOrigins = (block.allowed_origins as string[] | undefined) || [];

  const state = (on: boolean) => (on ? green('enabled') : dim('disabled'));

  console.log('');
  console.log(bold(`Remote capabilities updated in ${configPath}:`));
  console.log(`  master:          ${state(Boolean(block.enabled))}`);
  console.log(`  exec:            ${state(exec.enabled)}`);
  console.log(`  dispatch:        ${state(dispatch.enabled)}`);
  const rootsStr = write.roots.length > 0 ? `  roots: [${write.roots.join(', ')}]` : '';
  console.log(`  write:           ${state(write.enabled)}${rootsStr}`);
  console.log(
    `  allowed_origins: ${allowedOrigins.length > 0 ? `[${allowedOrigins.join(', ')}]` : dim('unrestricted')}`
  );
  console.log('');
  console.log(dim('Restart the daemon: ') + bold('bin/companion restart'));
  console.log('');
  console.log(dim('For the MCP side, add to ~/.companion/mcp-servers.json:'));

  const hostname = os.hostname();
  const snippet = {
    name: hostname,
    host: '127.0.0.1',
    port: listenerInfo.port ?? 9877,
    token: listenerInfo.token ?? '<token>',
    useTls: listenerInfo.tls,
    trustedNetwork: false,
  };
  console.log(JSON.stringify(snippet, null, 2));
  console.log('');
}

export async function cmdEnableRemote(args: string[]): Promise<void> {
  const configPath = resolveConfigPath();

  // If config doesn't exist, suggest running setup first.
  if (!fs.existsSync(configPath)) {
    console.error(red(`No config file found at ${configPath}`));
    console.error('');
    console.error('Run ' + bold('bin/companion setup') + ' first to create one.');
    process.exit(1);
  }

  let raw: string;
  let parsed: Record<string, unknown>;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Config is not a JSON object');
    }
  } catch (err) {
    console.error(red(`Failed to read/parse config at ${configPath}: ${err}`));
    process.exit(1);
    return;
  }

  const flags = parseFlags(args);

  // Determine current values (for interactive defaults)
  let currentBlock: Record<string, unknown> | undefined;
  if (Array.isArray((parsed as any).listeners) && (parsed as any).listeners.length > 0) {
    currentBlock = (parsed as any).listeners[0].remote_capabilities;
  } else {
    currentBlock = (parsed as any).remote_capabilities;
  }

  let enabled: boolean;
  const enableSet: Set<SubCap> = new Set();
  let writeRoots: string[] = [];
  let allowedOrigins: string[] = [];

  if (flags.nonInteractive) {
    enabled = flags.enabled;
    for (const c of flags.enable) enableSet.add(c);
    writeRoots = flags.writeRoots;
    allowedOrigins = flags.allowedOrigins;
    // If --disable was passed, zero everything out
    if (!enabled) {
      enableSet.clear();
      writeRoots = [];
    }
  } else {
    // Interactive flow
    console.log('');
    console.log(bold('Configure remote capabilities'));
    console.log(dim(`Config file: ${configPath}`));
    console.log('');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
      const currentEnabled = Boolean(currentBlock?.enabled);
      const currentExec = Boolean((currentBlock?.exec as any)?.enabled);
      const currentDispatch = Boolean((currentBlock?.dispatch as any)?.enabled);
      const currentWrite = Boolean((currentBlock?.write as any)?.enabled);
      const currentWriteRoots: string[] = Array.isArray((currentBlock?.write as any)?.roots)
        ? ((currentBlock?.write as any).roots as string[])
        : [];
      const currentAllowedOrigins: string[] = Array.isArray(
        (currentBlock as any)?.allowed_origins
      )
        ? ((currentBlock as any).allowed_origins as string[])
        : [];

      enabled = await yesNo(rl, 'Enable remote capabilities (master switch)?', currentEnabled || true);

      if (!enabled) {
        console.log(dim('Remote capabilities will be disabled.'));
      } else {
        if (await yesNo(rl, '  Enable exec (run shell commands)?', currentExec)) {
          enableSet.add('exec');
        }
        if (await yesNo(rl, '  Enable dispatch (spawn sub-agents)?', currentDispatch)) {
          enableSet.add('dispatch');
        }
        if (await yesNo(rl, '  Enable write (filesystem writes)?', currentWrite)) {
          enableSet.add('write');
          const defaultRoots = currentWriteRoots.join(',');
          const rootsAnswer = (
            await prompt(
              rl,
              `    Comma-separated absolute write roots${defaultRoots ? ` [${defaultRoots}]` : ''}: `
            )
          ).trim();
          const rootsInput = rootsAnswer || defaultRoots;
          writeRoots = rootsInput.split(',').map((s) => s.trim()).filter(Boolean);
          for (const r of writeRoots) {
            if (!r.startsWith('/')) {
              console.error(red(`Write root must be an absolute path: ${r}`));
              process.exit(1);
            }
          }
        }

        const defaultOrigins = currentAllowedOrigins.join(',');
        const originsAnswer = (
          await prompt(
            rl,
            `  Allowed origins (comma-separated, blank = unrestricted)${
              defaultOrigins ? ` [${defaultOrigins}]` : ''
            }: `
          )
        ).trim();
        const originsInput = originsAnswer || defaultOrigins;
        allowedOrigins = originsInput.split(',').map((s) => s.trim()).filter(Boolean);
      }
    } finally {
      rl.close();
    }
  }

  // Validate write roots if write is enabled
  if (enableSet.has('write') && writeRoots.length === 0) {
    console.error(red('Write capability enabled but no write roots provided.'));
    console.error('  Use --write-roots /abs/path,/other/path');
    process.exit(1);
  }
  for (const r of writeRoots) {
    if (!r.startsWith('/')) {
      console.error(red(`Write root must be an absolute path: ${r}`));
      process.exit(1);
    }
  }

  const block = buildRemoteCapabilitiesBlock(enabled, enableSet, writeRoots, allowedOrigins);
  const applied = applyToConfig(parsed, block);

  atomicWriteFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n');

  if (applied.location === 'listener') {
    console.log(
      dim(
        `Applied to listeners[${applied.listenerIndex}]` +
          (applied.listenerPort ? ` (port ${applied.listenerPort})` : '')
      )
    );
  } else {
    console.log(dim('Applied to root config (flat format)'));
  }

  const listenerInfo = getListenerForMcp(parsed);
  printResult(configPath, block, listenerInfo);

  if (!listenerInfo.port || !listenerInfo.token) {
    console.log(yellow('Warning: could not find port/token in config for MCP snippet.'));
  }
}
