/**
 * Git unified-diff parsing (pure). Handles renames/copies, new/deleted files,
 * mode changes, `Binary files … differ`, `\ No newline at end of file`, CRLF
 * bodies, C-quoted paths, and `--numstat -z` output.
 *
 * Callers run diffs with explicit `--src-prefix=a/ --dst-prefix=b/` so user
 * config (diff.noprefix, mnemonicPrefix) cannot change the headers.
 */

import type { ReviewFileStatus } from './protocol';

export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string;
  lines: string[];
}

export interface ParsedFileDiff {
  /** Repo-relative paths; null for /dev/null. */
  oldPath: string | null;
  newPath: string | null;
  status: ReviewFileStatus | 'copied';
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: ParsedHunk[];
  additions: number;
  deletions: number;
  /** This file's raw patch text (compat view). */
  raw: string;
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '"': '"',
  '\\': '\\',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
};

/** Undo git's C-style path quoting ("a/sp\303\251cial" -> a/spécial). */
export function unquotePath(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const n = body[i + 1];
    if (n !== undefined && /[0-7]/.test(n)) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else if (n !== undefined && ESCAPES[n] !== undefined) {
      for (const b of Buffer.from(ESCAPES[n], 'utf8')) bytes.push(b);
      i += 1;
    } else {
      bytes.push(0x5c);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string, prefix: 'a/' | 'b/'): string | null {
  const u = unquotePath(p.trim());
  if (u === '/dev/null') return null;
  return u.startsWith(prefix) ? u.slice(2) : u;
}

/** Paths from `diff --git a/X b/Y` when no ---/+++ or rename lines are present. */
function headerPaths(rest: string): { a: string | null; b: string | null } {
  if (rest.startsWith('"')) {
    // Quoted a-path: find its closing quote.
    let i = 1;
    while (i < rest.length && !(rest[i] === '"' && rest[i - 1] !== '\\')) i++;
    const a = rest.slice(0, i + 1);
    const b = rest.slice(i + 2);
    return { a: stripPrefix(a, 'a/'), b: stripPrefix(b, 'b/') };
  }
  if (rest.endsWith('"')) {
    const q = rest.lastIndexOf(' "');
    return { a: stripPrefix(rest.slice(0, q), 'a/'), b: stripPrefix(rest.slice(q + 1), 'b/') };
  }
  // Unquoted, same path both sides: "a/P b/P" -> |P| = (len - 5) / 2.
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && len > 0) {
    const a = rest.slice(2, 2 + len);
    const b = rest.slice(len + 5);
    if (a === b) return { a, b };
  }
  const idx = rest.indexOf(' b/');
  if (idx > 0) return { a: rest.slice(2, idx), b: rest.slice(idx + 3) };
  return { a: null, b: null };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(text: string): ParsedFileDiff[] {
  const out: ParsedFileDiff[] = [];
  if (!text) return out;
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let cur: ParsedFileDiff | null = null;
  let curStart = 0;
  let hunk: ParsedHunk | null = null;
  let headerA: string | null = null;
  let headerB: string | null = null;
  let sawMinus = false;
  let sawPlus = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let isNew = false;
  let isDeleted = false;
  let isCopy = false;

  const finish = (endLine: number) => {
    if (!cur) return;
    if (!sawMinus && !sawPlus) {
      cur.oldPath = renameFrom ?? (isNew ? null : headerA);
      cur.newPath = renameTo ?? (isDeleted ? null : headerB);
    }
    if (isNew) cur.status = 'added';
    else if (isDeleted) cur.status = 'deleted';
    else if (isCopy) cur.status = 'copied';
    else if (renameFrom !== null || (cur.oldPath && cur.newPath && cur.oldPath !== cur.newPath))
      cur.status = 'renamed';
    else if (cur.oldMode && cur.newMode && cur.oldMode !== cur.newMode && cur.hunks.length === 0 && !cur.binary)
      cur.status = 'mode_changed';
    else cur.status = 'modified';
    cur.raw = lines.slice(curStart, endLine).join('\n') + '\n';
    out.push(cur);
    cur = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      finish(i);
      curStart = i;
      const hp = headerPaths(line.slice('diff --git '.length));
      headerA = hp.a;
      headerB = hp.b;
      sawMinus = sawPlus = false;
      renameFrom = renameTo = null;
      isNew = isDeleted = isCopy = false;
      cur = {
        oldPath: headerA,
        newPath: headerB,
        status: 'modified',
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
        raw: '',
      };
      continue;
    }
    if (!cur) continue;
    const c: ParsedFileDiff = cur;
    if (hunk) {
      const ch = line[0];
      if (ch === ' ' || ch === '+' || ch === '-' || ch === '\\' || line === '') {
        // An empty line inside a hunk is a context line whose leading space was lost.
        const l = line === '' ? ' ' : line;
        hunk.lines.push(l);
        if (ch === '+') c.additions++;
        else if (ch === '-') c.deletions++;
        continue;
      }
      if (!line.startsWith('@@')) hunk = null;
    }
    const m = line.match(HUNK_RE);
    if (m) {
      hunk = {
        oldStart: parseInt(m[1], 10),
        oldLines: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newLines: m[4] === undefined ? 1 : parseInt(m[4], 10),
        ...(m[5] ? { section: m[5] } : {}),
        lines: [],
      };
      c.hunks.push(hunk);
      continue;
    }
    if (line.startsWith('old mode ')) c.oldMode = line.slice(9).trim();
    else if (line.startsWith('new mode ')) c.newMode = line.slice(9).trim();
    else if (line.startsWith('new file mode ')) {
      isNew = true;
      c.newMode = line.slice(14).trim();
    } else if (line.startsWith('deleted file mode ')) {
      isDeleted = true;
      c.oldMode = line.slice(18).trim();
    } else if (line.startsWith('rename from ')) renameFrom = unquotePath(line.slice(12));
    else if (line.startsWith('rename to ')) renameTo = unquotePath(line.slice(10));
    else if (line.startsWith('copy from ')) {
      isCopy = true;
      renameFrom = unquotePath(line.slice(10));
    } else if (line.startsWith('copy to ')) {
      isCopy = true;
      renameTo = unquotePath(line.slice(8));
    } else if (line.startsWith('similarity index ')) c.similarity = parseInt(line.slice(17), 10);
    else if (line.startsWith('index ')) {
      const mm = line.match(/ (\d{6})$/);
      if (mm && !c.oldMode) c.oldMode = c.newMode = mm[1];
    } else if (line.startsWith('--- ')) {
      sawMinus = true;
      c.oldPath = stripPrefix(line.slice(4).replace(/\t.*$/, ''), 'a/');
      if (c.oldPath === null) isNew = true;
    } else if (line.startsWith('+++ ')) {
      sawPlus = true;
      c.newPath = stripPrefix(line.slice(4).replace(/\t.*$/, ''), 'b/');
      if (c.newPath === null) isDeleted = true;
    } else if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') {
      c.binary = true;
    }
  }
  finish(lines.length);
  return out;
}

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** Parse `git diff --numstat -z` (renames: `A\tD\t\0old\0new\0`). */
export function parseNumstatZ(text: string): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const m = p.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    const binary = m[1] === '-' && m[2] === '-';
    const additions = binary ? null : parseInt(m[1], 10);
    const deletions = binary ? null : parseInt(m[2], 10);
    if (m[3] === '') {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      i += 2;
      if (newPath !== undefined) out.push({ path: newPath, oldPath, additions, deletions, binary });
    } else {
      out.push({ path: m[3], additions, deletions, binary });
    }
  }
  return out;
}

/** Clip long lines; returns whether anything was clipped. */
export function clipLines(lines: string[], maxChars: number): { lines: string[]; clipped: boolean } {
  let clipped = false;
  const out = lines.map((l) => {
    if (l.length <= maxChars) return l;
    clipped = true;
    return l.slice(0, maxChars);
  });
  return { lines: out, clipped };
}

/** Render hunks as a unified diff (used for synthesized patches + compat). */
export function renderPatch(aPath: string | null, bPath: string | null, hunks: ParsedHunk[]): string {
  const a = aPath === null ? '/dev/null' : `a/${aPath}`;
  const b = bPath === null ? '/dev/null' : `b/${bPath}`;
  let s = `--- ${a}\n+++ ${b}\n`;
  for (const h of hunks) {
    s += `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ` ${h.section}` : ''}\n`;
    for (const l of h.lines) s += `${l}\n`;
  }
  return s;
}
