/**
 * Pure text helpers for stuck detection: normalisation (numbers, paths,
 * timestamps, ids stripped so "the same failure" compares equal across runs),
 * failure-key extraction from tool output, command cores, pane classification.
 * No I/O, no LLM.
 */

import { detectActiveChoicePrompt } from '../parser';
import { clip, fnv1a, oneLine } from '../herald/text';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return (s || '').replace(ANSI, '');
}

/**
 * Canonical form for comparing failures and outputs: ANSI, timestamps, times,
 * uuids, hex ids, directory parts of paths and every number are replaced, and
 * whitespace collapsed. "src/api.test.ts:41:7 (12 ms)" -> "api.test.ts:#:# (# ms)".
 */
export function normalizeText(s: string): string {
  return stripAnsi(s)
    .replace(
      /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
      '<ts>'
    )
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<t>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/(?:[A-Za-z]:)?(?:~|\.{1,2})?[\\/]?(?:[\w.@+-]+[\\/])+([\w.@+-]+)/g, '$1')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exact identity of a tool input: whitespace collapsed, keys sorted; numbers kept (sed -n 1,50p != 51,100p). */
export function inputKey(tool: string, input: Record<string, unknown> | undefined): string {
  const i = input || {};
  if (tool === 'Bash') return `Bash:${oneLine(String(i.command ?? ''))}`;
  const keys = Object.keys(i)
    .filter((k) => k !== 'description')
    .sort();
  const parts = keys.map((k) => {
    const v = i[k];
    const s = typeof v === 'string' ? oneLine(v) : JSON.stringify(v);
    return `${k}=${clip(s ?? '', 400)}`;
  });
  return `${tool}:${parts.join('&')}`;
}

/**
 * The part of a shell command that says WHAT runs: leading `cd X &&` / nvm
 * sourcing / env assignments and trailing output filters (`2>&1 | tail -30`)
 * are dropped, so re-runs with a different tail length compare equal.
 */
export function commandCore(cmd: string): string {
  let c = oneLine(cmd || '');
  // Leading setup steps.
  for (let i = 0; i < 4; i++) {
    const m = c.match(
      /^(?:cd\s+\S+|source\s+\S+|\.\s+\S+|export\s+\S+|[A-Z_][A-Z0-9_]*=\S*)\s*(?:&&|;)\s*/
    );
    if (!m) break;
    c = c.slice(m[0].length);
  }
  c = c.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '');
  // Trailing filters.
  for (let i = 0; i < 4; i++) {
    const before = c;
    c = c
      .replace(
        /\s*\|\s*(?:tail|head|grep|less|more|cat|tee|sed|awk|sort|uniq|wc|cut|tr)\b[^|]*$/,
        ''
      )
      .replace(/\s*;\s*echo\b[^;|&]*$/, '')
      .replace(/\s*2>&1\s*$/, '')
      .trim();
    if (c === before) break;
  }
  return c.replace(/\s*2>&1\b/g, '').trim();
}

/** Commands that poll or wait on purpose: their repeats are not a loop. */
export function isPollingCommand(cmd: string): boolean {
  return /\bsleep\b|\bwatch\b|\bwait\b|\buntil\b|\btail\s+-[a-zA-Z]*f|\bgh\s+run\s+(?:view|watch|list)|\bgh\s+pr\s+checks|--watch\b|\bjournalctl\b.*-f/.test(
    cmd
  );
}

/** Builds, installs, test suites, image builds: plausibly long-running. */
export function isLongCommand(cmd: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|ci|install|i|e2e|lint|typecheck)\b|\bnpx\s+(?:jest|vitest|playwright|tsc|cypress)\b|\b(?:jest|vitest|pytest|tox|nox|playwright|cypress|mocha)\b|\bcargo\s+(?:build|test|check|clippy|tauri)\b|\bgo\s+(?:build|test)\b|\b(?:make|cmake|ninja|bazel|gradle|gradlew|mvn|ant)\b|\bdocker(?:-compose)?\s+(?:build|compose|pull|push)\b|\b(?:pip|pip3|uv|poetry|conda|apt|apt-get|brew|dnf)\s+(?:install|sync|update|upgrade)\b|\b(?:apksigner|xcodebuild|tauri)\b|\bbin\/(?:test|build|deploy)\b/.test(
    cmd
  );
}

// ---------------------------------------------------------------- failures

export type FailureKeyType = 'test' | 'error' | 'tool' | 'command';

export interface FailureKey {
  /** Normalised identity (what is compared). */
  key: string;
  /** Display text (raw, clipped). */
  label: string;
  type: FailureKeyType;
  /** Display preference within a type (lower first). */
  rank: number;
}

const MAX_KEYS = 8;
const SCAN_LINES = 400;

/** Patterns that mark a failure even when the command exited 0 (`... | tail` masks the exit code). */
const STRONG: Array<{
  re: RegExp;
  type: FailureKeyType;
  rank: number;
  label: (m: RegExpMatchArray) => string;
}> = [
  // jest / vitest list entries: "✕ retries backs off (12 ms)", "× suite > name"
  {
    re: /^\s*(?:✕|×|✗|✖)\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/,
    type: 'test',
    rank: 0,
    label: (m) => m[1],
  },
  // jest failure header: "● retries › backs off"
  { re: /^\s*●\s+(.+\s›\s.+)$/, type: 'test', rank: -1, label: (m) => m[1] },
  // go: "--- FAIL: TestRetries (0.01s)"
  { re: /^\s*--- FAIL:\s+(\S+)/, type: 'test', rank: 0, label: (m) => m[1] },
  // pytest: "FAILED tests/test_api.py::test_retries - AssertionError"
  { re: /^FAILED\s+(\S+?)(?:\s+-\s+.*)?$/, type: 'test', rank: 0, label: (m) => m[1] },
  // cargo: "test api::retries ... FAILED"
  { re: /^test\s+(\S+)\s+\.\.\.\s+FAILED\b/, type: 'test', rank: 0, label: (m) => m[1] },
  // jest / vitest file line: "FAIL src/api.test.ts" / "FAIL  src/a.test.ts > suite > name"
  { re: /^\s*FAIL\s+(\S.*)$/, type: 'test', rank: 1, label: (m) => m[1] },
  // TypeScript: "src/a.ts(12,5): error TS2345: ..." / "src/a.ts:12:5 - error TS2345: ..."
  {
    re: /^(?:(.+?)(?:\(\d+,\d+\)|:\d+:\d+)\s*[:-]\s*)?error\s+(TS\d+):\s*(.+)$/,
    type: 'error',
    rank: 0,
    label: (m) => `${m[2]}${m[1] ? ` in ${baseName(m[1])}` : ''}: ${m[3]}`,
  },
  // rustc: "error[E0308]: mismatched types"
  { re: /^error\[(E\d+)\]:\s*(.+)$/, type: 'error', rank: 0, label: (m) => `${m[1]}: ${m[2]}` },
  // gcc / clang / go vet / eslint-unix: "src/a.c:12:5: error: ..."
  {
    re: /^(.+?):\d+(?::\d+)?:\s+(?:fatal\s+)?error:\s*(.+)$/,
    type: 'error',
    rank: 0,
    label: (m) => `${baseName(m[1])}: ${m[2]}`,
  },
];

/** Generic error lines: only when the tool itself reported failure. */
const WEAK: Array<{ re: RegExp; label: (m: RegExpMatchArray) => string }> = [
  { re: /^\s*((?:[A-Z][\w.]*)?(?:Error|Exception)):\s*(.+)$/, label: (m) => `${m[1]}: ${m[2]}` },
  { re: /^\s*npm ERR!\s+(.+)$/, label: (m) => `npm ERR! ${m[1]}` },
  { re: /^\s*(?:error|ERROR|fatal):\s*(.+)$/, label: (m) => m[1] },
];

/** Tool results that are the USER saying no, not the work failing. */
const USER_REJECTION =
  /The user doesn't want to proceed|was rejected by the user|Request interrupted by user|user (?:denied|rejected)/i;

export function baseName(p: string): string {
  const t = (p || '').trim().replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i >= 0 ? t.slice(i + 1) : t;
}

function scanLines(output: string): string[] {
  const lines = stripAnsi(output || '').split('\n');
  if (lines.length <= SCAN_LINES * 2) return lines;
  return [...lines.slice(0, SCAN_LINES), ...lines.slice(-SCAN_LINES)];
}

export interface FailureInfo {
  failed: boolean;
  /** The user rejected the tool call (never a failure). */
  rejected: boolean;
  keys: FailureKey[];
  /** One or two raw lines that show the failure (evidence). */
  excerpt: string;
}

/**
 * What failed in one tool result. A failure is `isError` from the transcript,
 * or a strong test / compiler pattern in the output (a piped `| tail` exits 0).
 * Keys identify each distinct failure so "the same test failing 6 times" can be
 * counted per test, whatever else failed around it.
 */
export function analyzeFailure(
  tool: string,
  input: Record<string, unknown> | undefined,
  output: string | undefined,
  isError: boolean
): FailureInfo {
  const out = output || '';
  if (USER_REJECTION.test(out.slice(0, 2000)))
    return { failed: false, rejected: true, keys: [], excerpt: '' };
  const keys: FailureKey[] = [];
  const seen = new Set<string>();
  const excerptLines: string[] = [];
  const push = (type: FailureKeyType, rank: number, label: string, raw: string) => {
    const l = clip(oneLine(label), 160);
    const key = `${type}:${normalizeText(l)}`;
    if (!l || seen.has(key) || keys.length >= MAX_KEYS) return;
    seen.add(key);
    keys.push({ key, label: l, type, rank });
    if (excerptLines.length < 2) excerptLines.push(clip(oneLine(raw), 200));
  };
  const lines = tool === 'Bash' || isError ? scanLines(out) : [];
  for (const line of lines) {
    for (const p of STRONG) {
      const m = line.match(p.re);
      if (m) {
        push(p.type, p.rank, p.label(m), line);
        break;
      }
    }
  }
  if (isError && keys.length === 0) {
    for (const line of lines) {
      for (const p of WEAK) {
        const m = line.match(p.re);
        if (m) {
          push('error', 1, p.label(m), line);
          break;
        }
      }
      if (keys.length >= 3) break;
    }
  }
  const failed = isError || keys.some((k) => k.type === 'test' || k.type === 'error');
  if (failed && keys.length === 0) {
    const tail = lines
      .map((l) => l.trim())
      .filter((l) => l && !/^Exit code \d+$/i.test(l) && !/^Error: Exit code \d+$/i.test(l))
      .slice(-2);
    if (tool === 'Bash') {
      const cmd = commandCore(String(input?.command ?? ''));
      const label = clip(cmd, 120);
      const key = `command:${normalizeText(cmd)}|${normalizeText(tail.join(' ')).slice(0, 200)}`;
      keys.push({ key, label, type: 'command', rank: 0 });
      excerptLines.push(...tail.slice(0, 2).map((l) => clip(oneLine(l), 200)));
    } else {
      const first =
        stripAnsi(out)
          .split('\n')
          .map((l) => l.replace(/<\/?tool_use_error>/g, '').trim())
          .find((l) => l) || 'failed';
      const file = typeof input?.file_path === 'string' ? baseName(input.file_path) : '';
      const label = clip(`${file ? `${file}: ` : ''}${first}`, 140);
      keys.push({
        key: `tool:${tool}|${file}|${normalizeText(first).slice(0, 200)}`,
        label,
        type: 'tool',
        rank: 0,
      });
      excerptLines.push(clip(oneLine(first), 200));
    }
  }
  return { failed, rejected: false, keys, excerpt: excerptLines.slice(0, 2).join('\n') };
}

/** Hash of a normalised output (identical results compare equal; timings ignored). */
export function outputHash(output: string | undefined): string {
  const o = output || '';
  const head = o.length > 6000 ? `${o.slice(0, 3000)}\n${o.slice(-3000)}` : o;
  return fnv1a(`${o.length > 6000 ? 'L' : 'S'}|${normalizeText(head)}`);
}

/** Content hash for edit states (trailing whitespace per line ignored). */
export function contentHash(s: string): string {
  return fnv1a(
    (s || '')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
  );
}

// ---------------------------------------------------------------- pane

export interface PaneReading {
  /** Hash of the pane with the spinner / status / toolbar lines and numbers stripped. */
  hash: string;
  /** A choice / approval prompt is on screen: blocked, the inbox owns it. */
  prompt: boolean;
  /** Claude's own UI (input box / status line) is visible: the CLI is alive. */
  alive: boolean;
}

const TOOLBAR =
  /⏵⏵|bypass permissions|esc to interrupt|for agents|shift\+tab to cycle|^[ \t]*❯[ \t]*$/;
const SPINNER = /…\s*\(|esc to interrupt|↓\s*[\d.]+k?\s*tokens|^\s*[^\w\s]\s+[A-Z][\w-]*…/;
const PERMISSION = /Do you want to (?:proceed|make this edit|create|allow|run)/;

export function readPane(text: string): PaneReading {
  const lines = stripAnsi(text || '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-40);
  let prompt = !!detectActiveChoicePrompt(text || '');
  if (!prompt) {
    // A permission box near the bottom with no normal toolbar below it.
    for (let i = tail.length - 1; i >= Math.max(0, tail.length - 25); i--) {
      if (TOOLBAR.test(tail[i])) break;
      if (PERMISSION.test(tail[i])) {
        prompt = true;
        break;
      }
    }
  }
  const alive = prompt || tail.slice(-20).some((l) => TOOLBAR.test(l));
  const body = tail
    .filter((l) => l.trim() && !TOOLBAR.test(l) && !SPINNER.test(l) && !/^[\s─━═╭╮╰╯│]+$/.test(l))
    .map((l) => normalizeText(l));
  return { hash: fnv1a(body.join('\n')), prompt, alive };
}
