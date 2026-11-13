/**
 * Live contract test against the installed Claude Code (bin/test-cc-contract).
 *
 * Starts a real `claude --model haiku` on a PRIVATE tmux server (own
 * TMUX_TMPDIR, never the user's), makes it ask deterministic AskUserQuestion
 * prompts, and checks, for every screen:
 *   - agents/claude/auq-box.ts reads exactly the spec (labels in full at
 *     120/80/60 columns, descriptions, tabs, Other row, review), with no
 *     unparsed line and a known footer;
 *   - our injector (InputInjector.sendChoiceDetailed) answers it with the
 *     expected outcome;
 *   - the transcript records the expected answers, and the AskUserQuestion
 *     tool_use / toolUseResult shapes the daemon parser relies on;
 * plus the raw `type:"system", subtype:"away_summary"` entry shape (from the
 * user's recent transcripts of the same version; skipped if there is none).
 *
 * Every capture is saved (ANSI) with the parse expected from the spec as a
 * candidate fixture; failures also write drift.txt (expected vs got).
 *
 *   ts-node scripts/cc-contract.ts [--if-changed] [--out DIR] [--keep] [--only a,b]
 *
 * State (last passing version, the fixed work dir Claude trusts once):
 * ${COMPANION_CC_CONTRACT_DIR:-~/.companion/cc-contract}.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InputInjector } from '../src/input-injector';
import { parseClaudeAuqBox, type ParsedAuqBox } from '../src/agents/claude/auq-box';
import {
  KNOWN_AUQ_FOOTERS,
  auqContractView,
  type AuqContractView,
} from '../src/agents/claude/auq-contract';
import { defaultAgent } from '../src/agents';
import { stripAnsi } from '../src/prompt-guard';

// ---------------------------------------------------------------- spec ----

interface Opt {
  label: string;
  description: string;
  preview?: string;
}
interface Q {
  header: string;
  question: string;
  multiSelect: boolean;
  options: Opt[];
}
type Outcome = 'answered' | 'next_question' | 'review' | 'submitted' | 'cancelled' | 'navigated';
interface Step {
  /** What the screen must show before the step ('review' = the review screen). */
  screen: { question: number } | 'review';
  /** Multi-select: which options are already checked (default none). */
  checked?: number[];
  /** Review screen: the answers it lists. */
  review?: Array<{ question: string; answer: string }>;
  send: {
    selectedIndices: number[];
    otherText?: string;
    navigate?: 'back' | 'next';
    submit?: boolean;
  };
  outcome: Outcome;
}
interface Scenario {
  name: string;
  width: number;
  questions: Q[];
  steps: Step[];
  /** Expected toolUseResult.answers. */
  answers: Record<string, string>;
}

const LONG =
  'Rewrite the session watcher so it streams JSONL appends incrementally instead of re-reading whole files, keeping the cache semantics (Phase 2)';
const LONG_DESC =
  'Touches watcher.ts and parser.ts; the transcript cache keeps its current keys and eviction order, so nothing downstream changes.';

const longScenario = (width: number): Scenario => ({
  name: `long-label`,
  width,
  questions: [
    {
      header: 'Plan',
      question: 'Which refactor should come first?',
      multiSelect: false,
      options: [
        { label: LONG, description: LONG_DESC },
        { label: 'Leave the watcher alone', description: 'Ship the UI fixes first.' },
      ],
    },
  ],
  steps: [{ screen: { question: 0 }, send: { selectedIndices: [0] }, outcome: 'answered' }],
  answers: { 'Which refactor should come first?': LONG },
});

const previewScenario = (width: number): Scenario => ({
  name: 'preview',
  width,
  questions: [
    {
      header: 'Database',
      question: 'Which database should the demo use?',
      multiSelect: false,
      options: [
        {
          label: 'Postgres (Recommended)',
          description: 'Full SQL, runs in the compose file.',
          preview: 'services:\n  db:\n    image: postgres:16',
        },
        {
          label: 'SQLite',
          description: 'One file, no server.',
          preview: 'DATABASE_URL=file:./demo.db',
        },
      ],
    },
  ],
  steps: [{ screen: { question: 0 }, send: { selectedIndices: [1] }, outcome: 'answered' }],
  answers: { 'Which database should the demo use?': 'SQLite' },
});

const SCENARIOS: Scenario[] = [
  {
    name: 'single',
    width: 120,
    questions: [
      {
        header: 'Lunch',
        question: 'Which lunch should I order?',
        multiSelect: false,
        options: [
          { label: 'Ramen', description: 'Tonkotsu, extra egg.' },
          { label: 'Burrito', description: 'Carnitas with salsa verde.' },
          { label: 'Salad', description: 'Greek, dressing on the side.' },
        ],
      },
    ],
    steps: [{ screen: { question: 0 }, send: { selectedIndices: [1] }, outcome: 'answered' }],
    answers: { 'Which lunch should I order?': 'Burrito' },
  },
  {
    name: 'single-other',
    width: 120,
    questions: [
      {
        header: 'Snack',
        question: 'Which snack should I bring?',
        multiSelect: false,
        options: [
          { label: 'Pretzels', description: 'Salted.' },
          { label: 'Grapes', description: 'Green, seedless.' },
        ],
      },
    ],
    steps: [
      {
        screen: { question: 0 },
        send: { selectedIndices: [], otherText: 'Tacos al pastor 2x' },
        outcome: 'answered',
      },
    ],
    answers: { 'Which snack should I bring?': 'Tacos al pastor 2x' },
  },
  {
    name: 'multi',
    width: 120,
    questions: [
      {
        header: 'Toppings',
        question: 'Which toppings should go on the pizza?',
        multiSelect: true,
        options: [
          { label: 'Cheese', description: 'Mozzarella.' },
          { label: 'Olives', description: 'Kalamata.' },
          { label: 'Corn', description: 'Sweet corn.' },
        ],
      },
    ],
    steps: [
      {
        screen: { question: 0 },
        send: { selectedIndices: [0, 2], submit: true },
        outcome: 'submitted',
      },
    ],
    answers: { 'Which toppings should go on the pizza?': 'Cheese, Corn' },
  },
  {
    name: 'multi-question',
    width: 120,
    questions: [
      {
        header: 'Food',
        question: 'Which main course?',
        multiSelect: false,
        options: [
          { label: 'Pasta', description: 'Penne arrabbiata.' },
          { label: 'Curry', description: 'Green curry with rice.' },
        ],
      },
      {
        header: 'Sides',
        question: 'Which sides?',
        multiSelect: true,
        options: [
          { label: 'Bread', description: 'Garlic bread.' },
          { label: 'Soup', description: 'Miso soup.' },
          { label: 'Fries', description: 'Thin cut.' },
        ],
      },
      {
        header: 'Drink',
        question: 'Which drink?',
        multiSelect: false,
        options: [
          { label: 'Water', description: 'Still.' },
          { label: 'Lemonade', description: 'Fresh.' },
          { label: 'Tea', description: 'Iced.' },
        ],
      },
    ],
    steps: [
      { screen: { question: 0 }, send: { selectedIndices: [1] }, outcome: 'next_question' },
      { screen: { question: 1 }, send: { selectedIndices: [1, 2] }, outcome: 'next_question' },
      { screen: { question: 2 }, send: { selectedIndices: [1] }, outcome: 'review' },
      {
        screen: 'review',
        review: [
          { question: 'Which main course?', answer: 'Curry' },
          { question: 'Which sides?', answer: 'Soup, Fries' },
          { question: 'Which drink?', answer: 'Lemonade' },
        ],
        send: { selectedIndices: [], navigate: 'back' },
        outcome: 'navigated',
      },
      // Back on an answered single-select question: its row carries a check.
      { screen: { question: 2 }, checked: [1], send: { selectedIndices: [2] }, outcome: 'review' },
      {
        screen: 'review',
        review: [
          { question: 'Which main course?', answer: 'Curry' },
          { question: 'Which sides?', answer: 'Soup, Fries' },
          { question: 'Which drink?', answer: 'Tea' },
        ],
        send: { selectedIndices: [0] },
        outcome: 'submitted',
      },
    ],
    answers: {
      'Which main course?': 'Curry',
      'Which sides?': 'Soup, Fries',
      'Which drink?': 'Tea',
    },
  },
  previewScenario(120),
  longScenario(120),
  longScenario(80),
  longScenario(60),
  previewScenario(60),
];

// --------------------------------------------------------------- setup ----

const argv = process.argv.slice(2);
const flag = (f: string): boolean => argv.includes(f);
const value = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const STATE_DIR =
  process.env.COMPANION_CC_CONTRACT_DIR || path.join(os.homedir(), '.companion', 'cc-contract');
const WORK = path.join(STATE_DIR, 'work');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const only = value('--only')?.split(',');
const SESSION = 'cc';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function claudeVersion(): string {
  const out = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000 }).trim();
  return out.match(/\d+\.\d+\.\d+/)?.[0] ?? out;
}

const failures: string[] = [];
const log = (s: string): void => console.log(s);
function fail(what: string, expected: unknown, got: unknown): void {
  failures.push(
    `### ${what}\n--- expected\n${JSON.stringify(expected, null, 2)}\n--- got\n${JSON.stringify(got, null, 2)}\n`
  );
  log(`  FAIL ${what}`);
}

function tmux(args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8', timeout: 10000 });
}
function capture(): string {
  try {
    return tmux(['capture-pane', '-t', SESSION, '-p', '-e', '-S', '-60']);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------- transcript ----

function projectDir(): string {
  return path.join(os.homedir(), '.claude', 'projects', WORK.replace(/[^a-zA-Z0-9]/g, '-'));
}
interface Entry {
  type?: string;
  subtype?: string;
  message?: { content?: unknown };
  toolUseResult?: unknown;
  [k: string]: unknown;
}
function readTranscript(since: number): Entry[] {
  const dir = projectDir();
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f))
      .filter((f) => fs.statSync(f).mtimeMs >= since);
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* partial line */
      }
    }
  }
  return out;
}
interface ToolUse {
  id: string;
  name: string;
  input: { questions?: unknown };
}
function auqToolUses(entries: Entry[]): ToolUse[] {
  const out: ToolUse[] = [];
  for (const e of entries) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message!.content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion') out.push(b as unknown as ToolUse);
    }
  }
  return out;
}
function toolResultFor(
  entries: Entry[],
  id: string
): { entry: Entry; block: Record<string, unknown> } | null {
  for (const e of entries) {
    if (e.type !== 'user' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message!.content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_result' && b.tool_use_id === id) return { entry: e, block: b };
    }
  }
  return null;
}

/** The tool_use input the daemon parser reads (parser.ts AskUserQuestionInput). */
function checkToolUseSchema(name: string, input: unknown): void {
  const qs = (input as { questions?: unknown })?.questions;
  const ok =
    Array.isArray(qs) &&
    qs.every(
      (q) =>
        typeof q?.question === 'string' &&
        typeof q?.header === 'string' &&
        (q.multiSelect === undefined || typeof q.multiSelect === 'boolean') &&
        Array.isArray(q?.options) &&
        q.options.every(
          (o: { label?: unknown; description?: unknown }) =>
            typeof o?.label === 'string' && typeof o?.description === 'string'
        )
    );
  if (!ok)
    fail(
      `${name}: AskUserQuestion tool_use input schema`,
      'questions[{question,header,options[{label,description}],multiSelect?}]',
      input
    );
}
function checkToolResultSchema(
  name: string,
  r: { entry: Entry; block: Record<string, unknown> }
): void {
  const tur = r.entry.toolUseResult as { questions?: unknown; answers?: unknown } | undefined;
  const ok =
    !!tur &&
    Array.isArray(tur.questions) &&
    typeof tur.answers === 'object' &&
    tur.answers !== null &&
    Object.values(tur.answers as object).every((v) => typeof v === 'string');
  if (!ok)
    fail(`${name}: AskUserQuestion toolUseResult schema`, '{questions[], answers{q: string}}', tur);
  const content = r.block.content;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (!/answered/i.test(text)) fail(`${name}: tool_result text`, 'mentions the answers', text);
}

// -------------------------------------------------------------- parse ----

/** What the reader must produce for a screen, derived from the spec. */
function expectedParse(s: Scenario, step: Step): AuqContractView {
  const tabbed = s.questions.length > 1 || s.questions.some((q) => q.multiSelect);
  if (step.screen === 'review') {
    return { screen: 'review', review: step.review, unparsed: undefined };
  }
  const qi = step.screen.question;
  const q = s.questions[qi];
  const preview = q.options.some((o) => o.preview);
  const checked = new Set(step.checked ?? []);
  return {
    screen: 'question',
    header: q.header,
    question: q.question,
    multiSelect: !!q.multiSelect,
    // Claude Code draws no description on a box with previews.
    options: q.options.map((o, i) => ({
      label: o.label,
      ...(preview ? {} : { description: o.description }),
      ...(q.multiSelect || checked.has(i) ? { selected: checked.has(i) } : {}),
    })),
    tabs: tabbed ? s.questions.map((x) => x.header) : undefined,
    activeTab: tabbed ? qi : undefined,
    preview: preview ? true : undefined,
    hasOther: !preview,
    submitRow: q.multiSelect ? (qi === s.questions.length - 1 ? 'Submit' : 'Next') : undefined,
    unparsed: undefined,
  };
}
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ------------------------------------------------------------ the run ----

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms: number,
  every = 300
): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

function promptReady(pane: string): boolean {
  const plain = stripAnsi(pane);
  return /^\s*❯/m.test(plain) && !parseClaudeAuqBox(pane) && !/esc to interrupt/i.test(plain);
}

async function start(injector: InputInjector): Promise<boolean> {
  tmux([
    'new-session',
    '-d',
    '-s',
    SESSION,
    '-x',
    '120',
    '-y',
    '50',
    '-c',
    WORK,
    'claude --model haiku',
  ]);
  const agent = defaultAgent();
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    await sleep(1000);
    const pane = capture();
    const box = agent.terminal.detectActiveChoicePrompt(pane);
    if (box?.kind === 'trust') {
      log('  trust prompt: answering Yes through the injector (work dir is fixed, once only)');
      const r = await injector.sendChoiceDetailed(
        [0],
        box.options.length,
        false,
        undefined,
        SESSION,
        {
          answerTrust: true,
          promptKind: 'trust',
        }
      );
      if (!r.ok) return false;
      continue;
    }
    if (promptReady(pane)) return true;
  }
  return false;
}

function prompt(s: Scenario): string {
  const input = { questions: s.questions };
  return (
    'Call the AskUserQuestion tool exactly once with exactly this input, copying every string ' +
    'character for character: ' +
    JSON.stringify(input) +
    ' After the user answers, reply with only the word OK. Say nothing else and use no other tool.'
  );
}

async function runScenario(
  injector: InputInjector,
  s: Scenario,
  ver: string,
  outDir: string,
  attempt: number
): Promise<'pass' | 'fail' | 'retry'> {
  const tag = `${s.name}-w${s.width}`;
  log(`- ${tag}${attempt ? ' (retry)' : ''}`);
  tmux(['resize-window', '-t', SESSION, '-x', String(s.width), '-y', '50']);
  await waitFor(() => promptReady(capture()), 60000);
  const since = Date.now() - 1000;
  const seen = new Set(auqToolUses(readTranscript(since - 3600000)).map((t) => t.id));
  const fresh = (entries: Entry[]): ToolUse[] =>
    auqToolUses(entries).filter((t) => !seen.has(t.id));
  const sent = await injector.sendInputDetailed(prompt(s), SESSION);
  if (!sent.ok) {
    fail(`${tag}: could not send the prompt`, 'ok', sent);
    return 'fail';
  }

  for (let i = 0; i < s.steps.length; i++) {
    const step = s.steps[i];
    const exp = expectedParse(s, step);
    const want = (b: ParsedAuqBox | null): boolean => {
      if (!b) return false;
      if (step.screen === 'review') return b.auq.screen === 'review';
      return b.auq.screen === 'question' && (b.auq.activeTab ?? 0) === (exp.activeTab ?? 0);
    };
    const pane = await waitFor(
      () => {
        const p = capture();
        return want(parseClaudeAuqBox(p)) ? p : null;
      },
      i === 0 ? 120000 : 10000
    );
    const finalPane = pane ?? capture();
    const box = parseClaudeAuqBox(finalPane);
    const got = box ? auqContractView(box) : null;
    const base = path.join(outDir, `auq-cc${ver}-${tag}-s${i + 1}`);
    fs.writeFileSync(`${base}.txt`, finalPane + '\n');
    fs.writeFileSync(`${base}.expected.json`, JSON.stringify(exp, null, 2) + '\n');

    if (!eq(got, exp)) {
      if (i === 0 && attempt === 0) {
        // Model deviation (it changed a string) or real drift? Decline, then
        // compare the tool_use Claude actually sent with the spec.
        tmux(['send-keys', '-t', SESSION, 'Escape']);
        const tu = await waitFor(() => fresh(readTranscript(since))[0], 30000);
        if (
          tu &&
          !eq((tu.input as { questions?: unknown }).questions, stripPreview(s.questions, tu))
        ) {
          log('  model changed the input; retrying once');
          await waitFor(() => promptReady(capture()), 60000);
          return 'retry';
        }
      }
      fail(`${tag} step ${i + 1}: parse`, exp, got);
      fs.writeFileSync(`${base}.got.json`, JSON.stringify(got, null, 2) + '\n');
      tmux(['send-keys', '-t', SESSION, 'Escape']);
      return 'fail';
    }
    if (box && box.auq.screen === 'question' && !KNOWN_AUQ_FOOTERS.includes(box.auq.footer || '')) {
      fail(`${tag} step ${i + 1}: footer`, KNOWN_AUQ_FOOTERS, box.auq.footer);
      tmux(['send-keys', '-t', SESSION, 'Escape']);
      return 'fail';
    }

    const r = await injector.sendChoiceDetailed(
      step.send.selectedIndices,
      box!.options.length,
      !!box!.multiSelect,
      step.send.otherText,
      SESSION,
      {
        ...(step.send.navigate ? { navigate: step.send.navigate } : {}),
        ...(step.send.submit ? { submit: true } : {}),
      }
    );
    if (!r.ok || r.outcome !== step.outcome) {
      fail(`${tag} step ${i + 1}: injector`, { ok: true, outcome: step.outcome }, r);
      tmux(['send-keys', '-t', SESSION, 'Escape']);
      return 'fail';
    }
  }

  // The transcript: tool_use + toolUseResult with the expected answers.
  const rec = await waitFor(() => {
    const entries = readTranscript(since);
    const tu = fresh(entries).pop();
    const res = tu && toolResultFor(entries, tu.id);
    return tu && res ? { tu, res } : null;
  }, 30000);
  if (!rec) {
    fail(`${tag}: transcript`, 'AskUserQuestion tool_use + tool_result', null);
    return 'fail';
  }
  checkToolUseSchema(tag, rec.tu.input);
  checkToolResultSchema(tag, rec.res);
  const answers = (rec.res.entry.toolUseResult as { answers?: unknown })?.answers;
  if (!eq(answers, s.answers)) {
    fail(`${tag}: answers in the transcript`, s.answers, answers);
    return 'fail';
  }
  fs.writeFileSync(
    path.join(outDir, `auq-cc${ver}-${tag}.jsonl`),
    // Only the parts the parser reads (no paths, session ids or user names).
    [
      rec.tu,
      {
        type: 'user',
        message: { role: 'user', content: [rec.res.block] },
        toolUseResult: rec.res.entry.toolUseResult,
      },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n'
  );
  log('  ok');
  return 'pass';
}

/** Claude may drop `preview` it was not asked to keep; compare like for like. */
function stripPreview(qs: Q[], tu: ToolUse): unknown {
  const sent = (tu.input as { questions?: Q[] }).questions;
  const keep = !!sent?.some((q) => q.options?.some((o) => 'preview' in o));
  return keep
    ? qs
    : qs.map((q) => ({ ...q, options: q.options.map(({ preview: _p, ...o }) => o) }));
}

/** Raw shape of the recap entry, from the user's recent transcripts of this version. */
function checkAwaySummary(ver: string): string {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const cutoff = Date.now() - 30 * 86400000;
  const required = ['type', 'subtype', 'content', 'timestamp', 'uuid', 'sessionId', 'version'];
  let other: string | null = null;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return 'skipped (no transcripts)';
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(root, d, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff || st.size > 64 * 1024 * 1024) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (!text.includes('"away_summary"')) continue;
      for (const line of text.split('\n')) {
        if (!line.includes('"away_summary"')) continue;
        let e: Entry;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type !== 'system' || e.subtype !== 'away_summary') continue;
        if (e.version !== ver) {
          other = String(e.version);
          continue;
        }
        const missing = required.filter((k) => !(k in e));
        if (missing.length || typeof e.content !== 'string') {
          fail(
            'away_summary entry shape',
            { required, content: 'string' },
            { keys: Object.keys(e).sort(), contentType: typeof e.content }
          );
          return 'FAIL';
        }
        return `ok (keys: ${Object.keys(e).sort().join(', ')})`;
      }
    }
  }
  return `skipped (no sample for ${ver}${other ? `; newest other version seen: ${other}` : ''})`;
}

async function main(): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });
  const ver = claudeVersion();
  let state: { version?: string; result?: string } = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    /* first run */
  }
  if (flag('--if-changed') && state.version === ver && state.result === 'pass') {
    log(`Claude Code ${ver}: unchanged since the last passing run, nothing to do.`);
    return;
  }
  const outDir = path.resolve(
    value('--out') || path.join(STATE_DIR, 'runs', `${ver}-${Date.now()}`)
  );
  fs.mkdirSync(outDir, { recursive: true });
  log(`Claude Code ${ver}; candidates -> ${outDir}`);

  // A private tmux server: never the user's sessions.
  const tmuxDir = fs.mkdtempSync('/tmp/ccc-');
  process.env.TMUX_TMPDIR = tmuxDir;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  const injector = new InputInjector(SESSION);
  let ok = false;
  try {
    if (!(await start(injector))) {
      fail('start', 'Claude prompt ready', stripAnsi(capture()));
    } else {
      for (const s of SCENARIOS) {
        if (only && !only.some((o) => s.name.includes(o))) continue;
        let r = await runScenario(injector, s, ver, outDir, 0);
        if (r === 'retry') r = await runScenario(injector, s, ver, outDir, 1);
        if (r !== 'pass') {
          await waitFor(() => promptReady(capture()), 30000);
        }
      }
    }
    log(`away_summary: ${checkAwaySummary(ver)}`);
    ok = failures.length === 0;
  } finally {
    if (flag('--keep')) {
      log(`Kept: TMUX_TMPDIR=${tmuxDir} tmux attach -t ${SESSION}`);
    } else {
      try {
        tmux(['kill-server']);
      } catch {
        /* already gone */
      }
      fs.rmSync(tmuxDir, { recursive: true, force: true });
    }
  }
  if (!ok) fs.writeFileSync(path.join(outDir, 'drift.txt'), failures.join('\n'));
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      { version: ver, result: ok ? 'pass' : 'fail', at: new Date().toISOString(), outDir },
      null,
      2
    ) + '\n'
  );
  log(
    ok
      ? `PASS (Claude Code ${ver})`
      : `FAIL: ${failures.length} problem(s); see ${path.join(outDir, 'drift.txt')}`
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
