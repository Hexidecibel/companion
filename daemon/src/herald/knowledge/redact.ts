/**
 * The one place Herald decides what it may read and what it may repeat.
 *
 *   - isDeniedPath: files Herald must never open (credentials, keys, env files,
 *     secret drop zones). Checked on the requested path AND its realpath, so a
 *     harmless-looking symlink cannot smuggle a secret in.
 *   - redactSecrets: scrubs token-shaped strings out of any text before it
 *     reaches the model, a log line or a reply. Secret REFERENCES (inf://, op://)
 *     are not secrets and are kept, so "where does X come from" stays answerable.
 *   - safeReadText: the only file reader the knowledge tools use (denylist +
 *     realpath + size cap + redaction).
 *
 * Every knowledge / cush tool result goes through redactSecrets on the way out.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const REDACTED = '[redacted]';
/** Largest file the knowledge tools will read (bytes). */
export const MAX_READ_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Denylist

/** Basenames never read, whatever directory they are in. */
const DENIED_BASENAMES: RegExp[] = [
  /^\.env(?:$|[.-])/i, // .env, .env.local, .env-prod (.env.example included: never needed)
  /\.env$/i, // infisical.env, op.env, prod.env
  /\.(?:key|pem|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i,
  /^id_[a-z0-9]+(?:\.pub)?$/i, // id_rsa, id_ed25519(.pub)
  /^config\.json$/i, // companion + many tools keep tokens here
  /^\.credentials\.json$/i,
  /^credentials(?:\.json)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pgpass$/i,
  /^secrets?\.(?:json|ya?ml|toml)$/i,
];

function homes(extra: string[] = []): string[] {
  const out = new Set<string>();
  for (const h of [os.homedir(), process.env.HERALD_USER_HOME, ...extra]) {
    if (h && path.isAbsolute(h)) out.add(path.resolve(h));
  }
  return Array.from(out);
}

/** Directories whose entire contents are off limits. */
export function deniedDirs(extraHomes: string[] = []): string[] {
  const dirs = ['/tmp/secure-entry', '/tmp/exchange', '/etc/ssl/private', '/root'];
  for (const h of homes(extraHomes)) {
    dirs.push(
      path.join(h, '.ssh'),
      path.join(h, '.gnupg'),
      path.join(h, '.aws'),
      path.join(h, '.config', 'cush-tools'),
      path.join(h, '.config', 'gh'),
      path.join(h, '.docker'),
      path.join(h, '.kube'),
      path.join(h, 'secrets')
    );
  }
  return dirs;
}

function isUnder(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Lexical check on one absolute path (no filesystem access). */
export function isDeniedPath(p: string, extraHomes: string[] = []): boolean {
  if (!p) return true;
  const abs = path.resolve(p);
  if (DENIED_BASENAMES.some((re) => re.test(path.basename(abs)))) return true;
  return deniedDirs(extraHomes).some((d) => isUnder(abs, d));
}

/**
 * Read a text file for a knowledge tool. Returns null (never throws) for a denied,
 * missing, unreadable, non-regular or oversized file. The returned text is
 * already redacted.
 */
export async function safeReadText(
  p: string,
  opts: { extraHomes?: string[]; maxBytes?: number } = {}
): Promise<{ text: string; mtimeMs: number; size: number; realPath: string } | null> {
  const extra = opts.extraHomes || [];
  if (!path.isAbsolute(p) || isDeniedPath(p, extra)) return null;
  let real: string;
  try {
    real = await fs.promises.realpath(p);
  } catch {
    return null;
  }
  if (isDeniedPath(real, extra)) return null;
  try {
    const st = await fs.promises.stat(real);
    if (!st.isFile() || st.size > (opts.maxBytes ?? MAX_READ_BYTES)) return null;
    const raw = await fs.promises.readFile(real, 'utf-8');
    return { text: redactSecrets(raw), mtimeMs: st.mtimeMs, size: st.size, realPath: real };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Redaction

/** Token formats with an unambiguous prefix: always redacted wherever they appear. */
const PREFIXED_TOKENS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{8,}/g,
  /(?<![A-Za-z0-9-])sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])xox[baprse]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /(?<![A-Za-z0-9])(?:glpat|npm|pypi|hf|rk_live|sk_live|pk_live|whsec)[-_][A-Za-z0-9_-]{16,}/g,
];

const SEP = '[\\s_-]?';
const SECRET_WORD =
  `(?:api${SEP}key|apikey|access${SEP}key|secret${SEP}key|client${SEP}secret|private${SEP}key|` +
  `auth${SEP}token|access${SEP}token|refresh${SEP}token|device${SEP}token|bearer|token|secret|` +
  `password|passwd|pwd|passphrase|credential|signing${SEP}key|webhook${SEP}secret)`;
/** Wider net for the blob rule only: a bare "key" next to a 32+ char blob is enough. */
const BLOB_WORD = `(?:${SECRET_WORD}|keys?)`;

/** `"token": "..."`, `token: 'as'`, `password = "..."` style quoted values, any length. */
const QUOTED_ASSIGNMENT = new RegExp(
  `(["']?[A-Za-z0-9_.-]*${SECRET_WORD}["']?\\s*[:=]\\s*)(["'])([^"'\\n]+)\\2`,
  'gi'
);

/** `ANTHROPIC_API_KEY=abc123...` / `token: abc123` unquoted values (4+ chars, no spaces). */
const BARE_ASSIGNMENT = new RegExp(
  `([A-Za-z0-9_.-]*${SECRET_WORD}\\s*[:=]\\s*)(?!["'])([^\\s"'\`,;)\\]}]{4,})`,
  'gi'
);

/** A long hex/base64 blob (32+ chars) within a few words of a secret-ish word. */
const NEAR_WORD_BLOB = new RegExp(
  `(${BLOB_WORD}[^\\n]{0,40}?)(?<![A-Za-z0-9+/_-])([A-Za-z0-9+/_-]{32,}={0,2})(?![A-Za-z0-9+/_=-])`,
  'gi'
);

/** Values that are references to a secret store, not secrets. */
function isReference(v: string): boolean {
  return /^(?:inf|op|vault|ssm|secretsmanager):\/\//i.test(v) || /^\$\{?[A-Z_]/.test(v);
}

/** Plausibly a secret value rather than a word, placeholder, path or reference. */
function looksSecret(v: string): boolean {
  if (isReference(v)) return false;
  if (/^\[redacted\]$/i.test(v)) return false;
  if (/^<[^>]*>$/.test(v)) return false; // <your-token>
  if (/^(?:true|false|null|none|undefined|required|optional|string|number)$/i.test(v)) return false;
  return true;
}

/**
 * A key-shaped blob rather than a path, URL tail or identifier: mixes letters and
 * digits, does not start with "/" (paths, "inf://..." tails) and is not a
 * slash-separated path (base64 has the odd "/", paths have many).
 */
function looksLikeBlob(blob: string): boolean {
  if (blob.startsWith('/')) return false;
  if (!/\d/.test(blob) || !/[A-Za-z]/.test(blob)) return false;
  if ((blob.match(/\//g) || []).length >= 3) return false;
  if (/^[A-Za-z]+(?:[_-][A-Za-z]+)+$/.test(blob)) return false; // SOME_LONG_IDENTIFIER_NAME
  return true;
}

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of PREFIXED_TOKENS) out = out.replace(re, REDACTED);
  out = out.replace(QUOTED_ASSIGNMENT, (m, pre: string, q: string, val: string) =>
    looksSecret(val) ? `${pre}${q}${REDACTED}${q}` : m
  );
  out = out.replace(BARE_ASSIGNMENT, (m, pre: string, val: string) => {
    if (!looksSecret(val)) return m;
    // Prose like "token rotation: see below" is not an assignment of a value;
    // a bare value must carry a digit or be long enough to be a key.
    if (!/\d/.test(val) && val.length < 20) return m;
    return `${pre}${REDACTED}`;
  });
  out = out.replace(NEAR_WORD_BLOB, (m, pre: string, blob: string) =>
    looksLikeBlob(blob) ? `${pre}${REDACTED}` : m
  );
  return out;
}
