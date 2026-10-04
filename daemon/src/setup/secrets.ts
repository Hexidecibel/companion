/**
 * Plain secrets file: ~/.companion/secrets.env (COMPANION_SECRETS_FILE
 * overrides), KEY=value lines, mode 0600 in a 0700 directory.
 *
 * Precedence: the process environment wins (systemd EnvironmentFile, the
 * cush-tools / Infisical path through `install-secrets`, a shell export), then
 * this file. Values are never logged, never returned over the wire, and never
 * echoed: callers only learn whether a key is set and where it came from.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SecretName, SecretStatus } from './protocol';
import { SETUP_LIMITS } from './protocol';

/** The wizard may write these env keys and nothing else. */
export const SECRET_ENV_KEYS: Record<SecretName, string> = {
  anthropic_api_key: 'ANTHROPIC_API_KEY',
};

/** Keys the daemon loads from the file (writable ones plus the local-LLM key). */
const LOADABLE = new Set(['ANTHROPIC_API_KEY', 'HERALD_LLM_API_KEY']);
const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function secretsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMPANION_SECRETS_FILE || path.join(os.homedir(), '.companion', 'secrets.env');
}

/** Parse KEY=value lines (optional `export `, optional single/double quotes). */
export function parseSecretsEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.length >= 2 ? v.slice(1, -1) : '';
    }
    out.set(m[1], v);
  }
  return out;
}

function readFileSecrets(file: string): Map<string, string> {
  try {
    return parseSecretsEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * At startup: copy known keys from the file into `env` when not already set
 * there. Returns the key NAMES loaded (never values). A file readable by
 * others is still used, with a warning to tighten it.
 */
export function loadSecretsEnv(
  env: NodeJS.ProcessEnv = process.env,
  file: string = secretsFilePath(env),
  warn: (line: string) => void = (l) => console.warn(l)
): string[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  if ((st.mode & 0o077) !== 0) {
    warn(`Secrets: ${file} is readable by other users; run: chmod 600 ${file}`);
  }
  const loaded: string[] = [];
  for (const [k, v] of readFileSecrets(file)) {
    if (!LOADABLE.has(k) || !v) continue;
    if ((env[k] || '').trim()) continue;
    env[k] = v;
    loaded.push(k);
  }
  return loaded;
}

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Reject anything that could break the file format or smuggle in another key. */
export function validateSecretValue(value: unknown): string {
  if (typeof value !== 'string') throw new SecretError('The value must be text');
  const v = value.trim();
  if (!v) throw new SecretError('The value is empty');
  if (v.length > SETUP_LIMITS.secretMaxLength) throw new SecretError('The value is too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s"'`\\$]/.test(v)) {
    throw new SecretError('The value contains characters a key never has (spaces, quotes, newlines)');
  }
  return v;
}

/**
 * Set (or with value null, remove) one key in the secrets file. Atomic: a
 * fresh 0600 temp file in the same directory, fsync, rename. Other lines are
 * kept as they were. The directory is created 0700.
 */
export function writeSecretsFileKey(
  envKey: string,
  value: string | null,
  file: string = secretsFilePath()
): void {
  if (!KEY_RE.test(envKey)) throw new SecretError('Bad key name');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    lines = ['# Companion secrets (KEY=value). Keep this file private: chmod 600.'];
  }
  const re = new RegExp(`^\\s*(?:export\\s+)?${envKey}\\s*=`);
  const kept = lines.filter((l) => !re.test(l));
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  if (value !== null) kept.push(`${envKey}=${value}`);
  const body = kept.join('\n') + '\n';
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    // Never include the value (or the file body) in what propagates.
    throw new SecretError(`Could not write ${file}: ${(err as NodeJS.ErrnoException).code || 'error'}`);
  }
}

/** Whether each wizard-managed secret is set, and where from. Values never leave this function. */
export function secretStatuses(
  env: NodeJS.ProcessEnv = process.env,
  file: string = secretsFilePath(env),
  /** Env keys whose value came from the file (loaded at startup or written by the wizard). */
  fromFile: ReadonlySet<string> = new Set()
): SecretStatus[] {
  const fileVals = readFileSecrets(file);
  return (Object.keys(SECRET_ENV_KEYS) as SecretName[]).map((name) => {
    const k = SECRET_ENV_KEYS[name];
    const inEnv = !!(env[k] || '').trim();
    const inFile = !!(fileVals.get(k) || '').trim();
    // The environment wins when it was set from outside (not copied from the file).
    const source: SecretStatus['source'] =
      inEnv && !fromFile.has(k) ? 'env' : inFile ? 'secrets_file' : 'none';
    return { name, set: source !== 'none', source };
  });
}
