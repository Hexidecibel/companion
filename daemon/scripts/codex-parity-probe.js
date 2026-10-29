#!/usr/bin/env node
/**
 * codex-parity-probe: live end-to-end check of the Codex parity work on the
 * throwaway probe instance only (private tmux server, real Codex, tiny prompts).
 *
 *   review   a hand-started Codex (bypass; the folder becomes a git repo only
 *            after Codex started, so no trust prompt is shown or saved) in a
 *            throwaway repo under ~/.cache applies one
 *            apply_patch (update + add) and runs `sed -i`: review_get shows the
 *            patched files attributed to the turn with exact hunks, the sed
 *            change as unattributed; review_mark_reviewed empties since_checkpoint
 *   stuck    failureRepeats lowered to 3 on the probe: three failing `cat` runs
 *            then a `sleep` keep the turn working; stuck_list reports a finding
 *            for the session while it sleeps
 *   herald   (only when the probe was started with HERALD_SPAWN_ROOTS covering
 *            the probe's folder) herald_send "start a new Codex session ..." ->
 *            a hard_confirm propose_spawn_session card with agent codex ->
 *            herald_confirm -> a Codex session listed with agent codex
 *   config   ~/.codex/config.toml is byte-identical afterwards (restored on exit
 *            if Codex changed it anyway)
 *
 * How to run (from the repo root):
 *
 *   (cd daemon && npm run build)
 *   T=/tmp/claude-1000/cdxq; mkdir -p -m 700 $T
 *   W=$HOME/.cache/codex-parity-probe; mkdir -p $W
 *   env -u TMUX -u TMUX_PANE TMUX_TMPDIR=$T HERALD_SPAWN_ROOTS=$W bin/herald-sandbox --instance probe start
 *   env -u TMUX -u TMUX_PANE node daemon/scripts/codex-parity-probe.js --tmux-tmpdir $T [--json out.json] [--verbose]
 *   bin/herald-sandbox --instance probe stop; rm -rf $T $W   # always
 *
 * Same isolation checks as codex-control-probe.js; the private tmux server is
 * killed on exit. Exit code 0 = every assertion passed.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

function parseArgs(argv) {
  const out = { config: null, tmuxTmpdir: null, session: 'cdx-par', dir: null, json: null, verbose: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--tmux-tmpdir') out.tmuxTmpdir = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--keep') out.keep = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SANDBOX_DIR =
  (process.env.HERALD_SANDBOX_DIR || path.join(os.homedir(), '.cache', 'companion-herald-sandbox')) + '-probe';
if (!args.config) args.config = path.join(SANDBOX_DIR, 'config.json');
if (!args.tmuxTmpdir) {
  console.error('usage: codex-control-probe.js --tmux-tmpdir <dir the probe daemon was started with> [--json out] [--verbose]');
  process.exit(2);
}
if (!fs.existsSync(args.config)) {
  console.error(`config not found: ${args.config} (start the probe instance first)`);
  process.exit(2);
}

const UID = os.userInfo().uid;
const TMUX_TMPDIR = path.resolve(args.tmuxTmpdir);
const SOCK = path.join(TMUX_TMPDIR, `tmux-${UID}`, 'default');
const DEFAULT_SOCK = path.join('/tmp', `tmux-${UID}`, 'default');
/** The session the helpers act on (switched per phase). */
let SESSION = args.session;
const SPAWNED = args.session;
const ANCHOR = 'cdx-anchor';
const WORK = path.resolve(args.dir || path.join(os.homedir(), '.cache', 'codex-parity-probe'));
const REPO = path.join(WORK, 'repo');
// A plain (non-git) folder: Codex asks no trust question there (Herald spawn).
// Fresh name per run: Herald's conversation on the probe survives runs and
// would answer "I already started that session" for a reused folder.
const PLAIN = path.join(WORK, `plain-${Date.now().toString(36)}`);
const PROJECT = REPO;
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

const cfg = JSON.parse(fs.readFileSync(args.config, 'utf-8'));
const listener = (cfg.listeners && cfg.listeners[0]) || { port: cfg.port, token: cfg.token };
const url = `ws://localhost:${listener.port}`;
const token = listener.token;

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (line) => console.log(`[${stamp()}] ${line}`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const cleanEnv = {};
for (const k of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'NVM_DIR'])
  if (process.env[k]) cleanEnv[k] = process.env[k];
cleanEnv.TERM = 'xterm-256color';
cleanEnv.TMUX_TMPDIR = TMUX_TMPDIR;

function tmuxAt(sock, argv) {
  return execFileSync('tmux', ['-S', sock, ...argv], { env: cleanEnv, encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const tmux = (argv) => tmuxAt(SOCK, argv);
function tmuxNames(sock) {
  if (!fs.existsSync(sock)) return [];
  try {
    return tmuxAt(sock, ['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
function screen() {
  try {
    return tmux(['capture-pane', '-p', '-t', SESSION]);
  } catch {
    return '';
  }
}
const tail = (text, n = 14) =>
  text.split('\n').filter((l) => l.trim()).slice(-n).map((l) => `      | ${l.slice(0, 150)}`).join('\n');

// ----------------------------------------------------------------- /proc

function children(pid) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf-8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === pid) out.push(Number(d));
    } catch {
      /* gone */
    }
  }
  return out;
}
function argvOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}
function envOf(pid) {
  const env = {};
  try {
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf-8').split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  } catch {
    /* gone */
  }
  return env;
}
/** The codex process under the session's pane (BFS, first argv mentioning codex). */
function codexPid() {
  let panePid;
  try {
    panePid = Number(tmux(['display-message', '-p', '-t', SESSION, '#{pane_pid}']).trim());
  } catch {
    return null;
  }
  const queue = [panePid];
  const seen = new Set();
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const a = argvOf(p);
    if (p !== panePid && a.slice(0, 2).some((x) => path.basename(x) === 'codex')) return p;
    queue.push(...children(p));
  }
  return null;
}

// ----------------------------------------------------------------- websocket

const ws = new WebSocket(url);
let reqSeq = 0;
const waiters = new Map();
function request(type, payload, timeoutMs = 20_000) {
  const requestId = `cdxp-${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      waiters.delete(requestId);
      reject(new Error(`${type} timed out`));
    }, timeoutMs);
    waiters.set(requestId, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
    ws.send(JSON.stringify({ type, payload, requestId, ...(type === 'authenticate' ? { token } : {}) }));
  });
}
ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (msg.requestId && waiters.has(msg.requestId)) {
    const w = waiters.get(msg.requestId);
    waiters.delete(msg.requestId);
    w(msg);
    return;
  }
  if (msg.type === 'herald_event' && msg.payload && msg.payload.kind === 'action' && msg.payload.action)
    heraldActions.push(msg.payload.action);
});
const heraldActions = [];

// ----------------------------------------------------------------- results

const results = [];
const timeline = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}
class Abort extends Error {}

async function until(what, fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) {
      log(`timed out waiting for: ${what}`);
      console.log(tail(screen(), 20));
      return null;
    }
    await delay(700);
  }
}

async function summary() {
  const r = await request('get_server_summary', {});
  return ((r.payload && r.payload.sessions) || []).find((s) => s.id === SESSION) || null;
}
async function highlights() {
  const r = await request('get_highlights', { sessionId: SESSION, limit: 30 });
  return (r.payload && r.payload.highlights) || [];
}
async function liveChoice() {
  const hl = await highlights();
  const last = hl[hl.length - 1];
  return last && last.isWaitingForChoice && last.questions && last.questions[0] ? last.questions[0] : null;
}
const lastAssistantText = async () => {
  const hl = await highlights();
  const a = hl.filter((h) => h.type === 'assistant' && !h.isWaitingForChoice).pop();
  return a ? a.content || '' : '';
};
/** Status from the summary; also note every change in the timeline. */
let lastStatus = null;
async function status() {
  const s = await summary();
  const st = s ? s.status : 'absent';
  if (st !== lastStatus) {
    timeline.push({ at: Date.now() - t0, status: st, activity: s && s.currentActivity });
    if (args.verbose) log(`status: ${st}${s && s.currentActivity ? ` (${s.currentActivity})` : ''}`);
    lastStatus = st;
  }
  return st;
}
async function sendInput(text) {
  const r = await request('send_input', { input: text, tmuxSessionName: SESSION, sessionId: SESSION });
  return r;
}

// ----------------------------------------------------------------- isolation

function daemonEnv() {
  const pid = Number(fs.readFileSync(path.join(SANDBOX_DIR, 'sandbox.pid'), 'utf-8').trim());
  return { pid, env: envOf(pid) };
}
async function assertIsolated(expectNames) {
  if ([9877, 9878, 9887].includes(Number(listener.port)))
    throw new Abort(`refusing to run against port ${listener.port} (production / the user's sandbox)`);
  if (SOCK.length >= 108) throw new Abort(`tmux socket path too long (${SOCK.length} chars)`);
  if (path.resolve(SOCK) === path.resolve(DEFAULT_SOCK)) throw new Abort('the private tmux socket IS the default one');
  const { pid, env } = daemonEnv();
  if (path.resolve(env.TMUX_TMPDIR || '') !== TMUX_TMPDIR)
    throw new Abort(`probe daemon (pid ${pid}) was not started with TMUX_TMPDIR=${TMUX_TMPDIR}`);
  if (env.TMUX) throw new Abort(`probe daemon (pid ${pid}) has TMUX set`);
  if (env.COMPANION_SANDBOX !== '1') throw new Abort('probe daemon is not in sandbox mode');
  // The daemon's tmux listing is cached for ~2 s: let it catch up.
  let seen = [];
  let mine = [];
  for (let i = 0; i < 10; i++) {
    const r = await request('list_tmux_sessions', {});
    seen = ((r.payload && r.payload.sessions) || []).map((s) => s.name).sort();
    mine = tmuxNames(SOCK).sort();
    if (JSON.stringify(seen) === JSON.stringify(mine)) break;
    await delay(700);
  }
  const theirs = new Set(tmuxNames(DEFAULT_SOCK));
  if (seen.some((n) => theirs.has(n) && !mine.includes(n)))
    throw new Abort('the probe daemon sees sessions of the default tmux server');
  if (JSON.stringify(seen) !== JSON.stringify(mine))
    throw new Abort(`the probe daemon's tmux listing [${seen}] is not the private server's [${mine}]`);
  if (JSON.stringify(seen) !== JSON.stringify([...expectNames].sort()))
    throw new Abort(`expected [${expectNames.join(', ')}] on the private server, found [${seen.join(', ')}]`);
  if (mine.some((n) => theirs.has(n))) throw new Abort('a private session name is also on the default server');
  return { pid, seen };
}

// ----------------------------------------------------------------- scenario

const CODEX_CONFIG = path.join(CODEX_HOME, 'config.toml');
let CONFIG_SNAPSHOT;
const readConfig = () => (fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf-8') : null);
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf-8', env: { ...cleanEnv, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@p', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@p' } });
const isReady = () => /Ask Codex to do anything|\? for shortcuts/.test(screen());

async function startCodexByHand(name, dir, extra) {
  SESSION = name;
  tmux(['new-session', '-d', '-s', name, '-x', '160', '-y', '45', '-c', dir, '-e', `CODEX_HOME=${CODEX_HOME}`]);
  tmux(['set-environment', '-t', name, 'COMPANION_APP', '1']);
  await delay(300);
  tmux(['send-keys', '-t', name, `codex ${extra}`, 'Enter']);
  const ok = await until(`${name}: Codex ready`, async () => (isReady() ? true : null), 60_000);
  if (!ok) throw new Abort(`${name}: Codex did not become ready (trust prompt? ${/Trust this folder/.test(screen())})`);
  // The composer draws before the TUI takes input: a paste right away can lose its Enter.
  await delay(3000);
  const listed = await until(`${name}: listed as Codex`, async () => {
    const s = await summary();
    return s && s.agent === 'codex' ? s : null;
  }, 30_000);
  record(`${name}: a hand-started Codex is listed with agent codex`, !!listed, '');
}

async function turn(text, doneRe, timeoutMs = 150_000) {
  lastStatus = null;
  const sent = await sendInput(text);
  if (!sent.success) return { ok: false, why: sent.error };
  let started = await until('turn starts', async () => ((await status()) === 'working' ? true : null), 15_000);
  if (!started && screen().includes(text.slice(0, 40))) {
    // The paste landed but its Enter did not (TUI still settling): submit it.
    log('turn: the prompt sits in the composer, pressing Enter');
    tmux(['send-keys', '-t', SESSION, 'Enter']);
    started = await until('turn starts (after Enter)', async () => ((await status()) === 'working' ? true : null), 20_000);
  }
  const done = await until('turn done', async () => (doneRe.test(await lastAssistantText()) && (await status()) !== 'working' ? true : null), timeoutMs);
  return { ok: !!done };
}

async function run(report) {
  const auth = await request('authenticate', {});
  if (auth.success === false) throw new Abort(`authenticate failed: ${auth.error}`);
  await request('subscribe', {});
  const configBefore = readConfig();
  CONFIG_SNAPSHOT = configBefore;

  // 1. Isolation + a throwaway git repo.
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(PLAIN, { recursive: true });
  fs.writeFileSync(path.join(REPO, 'a.txt'), 'alpha\nbeta\ngamma\ndelta\n');
  fs.writeFileSync(path.join(REPO, 's.txt'), 'one\ntwo\n');
  // NOT a git repo yet: Codex asks its (saved) trust question only for a git
  // folder, and only at start-up. The repo is made once Codex is running.
  if (tmuxNames(SOCK).length) throw new Abort(`the private server already has sessions: ${tmuxNames(SOCK)}`);
  tmux(['new-session', '-d', '-s', ANCHOR, '-c', PLAIN]);
  const iso = await assertIsolated([ANCHOR]);
  record('isolation: the probe daemon sees only the private tmux server', true, `pid ${iso.pid}`);

  // 2. Review: apply_patch + sed in one turn.
  await startCodexByHand(args.session, REPO, '--dangerously-bypass-approvals-and-sandbox');
  await assertIsolated([ANCHOR, args.session]);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const t1 = await turn(
    "Use the apply_patch tool once, in a single patch: in a.txt change the line 'gamma' to 'GAMMA', and add a file b.txt containing the line 'new'. Then run this shell command: sed -i 's/two/TWO/' s.txt . Then reply with just the word DONE.",
    /DONE/
  );
  record('review: the patch + sed turn finished', t1.ok, t1.why || `status ${lastStatus}`);
  const files = await until('review: files view attributes the patch', async () => {
    const r = await request('review_get', { sessionId: SESSION, scope: 'all', view: 'files' }, 30_000);
    const p = r.payload || {};
    const a = (p.files || []).find((f) => f.path === 'a.txt');
    const u = (p.unattributed || []).find((f) => f.path === 's.txt');
    return a && u ? p : null;
  }, 30_000);
  const by = (p) => files && (files.files || []).find((f) => f.path === p);
  record('review: a.txt is modified and attributed to the turn', !!by('a.txt') && by('a.txt').turnIds.length === 1 && by('a.txt').additions === 1, JSON.stringify(by('a.txt') && { s: by('a.txt').status, t: by('a.txt').turnIds.length, a: by('a.txt').additions, d: by('a.txt').deletions }));
  record('review: b.txt is added and attributed', !!by('b.txt') && by('b.txt').status === 'added' && by('b.txt').turnIds.length === 1, '');
  record('review: the sed -i change to s.txt is unattributed', !!files && (files.unattributed || []).some((f) => f.path === 's.txt'), files ? JSON.stringify((files.unattributed || []).map((f) => f.path)) : 'no files view');
  const turns = await request('review_get', { sessionId: SESSION, scope: 'all', view: 'turns' }, 30_000);
  const edits = (turns.payload && turns.payload.edits) || [];
  const ea = edits.find((e) => e.path === 'a.txt');
  record('review: turns view carries exact apply_patch hunks (line numbers from FileChange)', !!ea && ea.hunks.length === 1 && ea.hunks[0].oldStart >= 1 && ea.tool === 'Edit', ea ? `${ea.tool} @@ -${ea.hunks[0] && ea.hunks[0].oldStart}` : JSON.stringify(edits.map((e) => e.path)));
  const mark = await request('review_mark_reviewed', { sessionId: SESSION, through: Date.now(), device: 'probe' }, 30_000);
  const after = await request('review_get', { sessionId: SESSION, scope: 'since_checkpoint', view: 'files' }, 30_000);
  const ap = after.payload || {};
  record('review: mark reviewed empties since_checkpoint', mark.success === true && (ap.files || []).length === 0 && (ap.unattributed || []).length === 0, mark.error || JSON.stringify({ f: (ap.files || []).length, u: (ap.unattributed || []).length }));

  let seenFindings = [];
  // 3. Stuck: three failing runs, then a sleep keeps the turn working.
  const set = await request('stuck_set_settings', { settings: { failureRepeats: 3, loopRepeats: 3 } });
  record('stuck: thresholds lowered on the probe', set.success === true, set.error || '');
  lastStatus = null;
  // The repeated-failure signal wants the failures spread over 2+ minutes.
  await sendInput("Run these shell commands one at a time, as separate tool calls, in this order (the cat ones fail, that is expected): `cat ./no-such-file.txt`, then `sleep 65`, then `cat ./no-such-file.txt`, then `sleep 65`, then `cat ./no-such-file.txt`, then `sleep 90`. Then reply with just the word STUCKDONE.");
  const finding = await until('stuck: a finding for the session while it sleeps', async () => {
    const r = await request('stuck_list', {});
    const all = (r.payload && r.payload.findings) || [];
    if (all.length) seenFindings = all.map((x) => `${x.sessionId}:${x.kind}`);
    const f = all.find((x) => x.sessionId === SESSION);
    return f || null;
  }, 330_000);
  record('stuck: stuck_list reports the repeated failure while Codex works', !!finding && /repeated_failure|loop/.test(finding.kind), finding ? `${finding.kind}: ${finding.summary}` : `seen: ${JSON.stringify(seenFindings)} (session ${SESSION})`);
  await until('stuck turn done', async () => (/STUCKDONE/.test(await lastAssistantText()) && (await status()) !== 'working' ? true : null), 200_000);
  const cleared = await until('stuck: finding clears once the turn ended', async () => {
    const r = await request('stuck_list', {});
    return !((r.payload && r.payload.findings) || []).some((x) => x.sessionId === SESSION) ? true : null;
  }, 30_000);
  record('stuck: the finding clears when the turn ends', !!cleared, '');

  // 4. Herald spawns Codex (needs HERALD_SPAWN_ROOTS on the probe).
  const roots = (daemonEnv().env.HERALD_SPAWN_ROOTS || '').split(':').filter(Boolean).map((r) => path.resolve(r));
  if (!roots.some((r) => PLAIN === r || PLAIN.startsWith(r + path.sep))) {
    record('herald: spawn skipped (start the probe with HERALD_SPAWN_ROOTS covering ' + WORK + ')', false, '');
  } else {
    heraldActions.length = 0;
    const before = new Set(tmuxNames(SOCK));
    await request('herald_send', { text: `Start a new Codex session in the folder ${PLAIN} and tell it: Reply with just the word HELLO.` }, 60_000).catch(() => null);
    const card = await until('herald: spawn card', async () => heraldActions.find((a) => a.kind === 'spawn_session') || null, 60_000);
    record('herald: propose_spawn_session card for Codex (hard_confirm, "New Codex session ...")', !!card && card.tier === 'hard_confirm' && /^New Codex session/.test(card.readback || ''), card ? JSON.stringify({ kind: card.kind, tier: card.tier, readback: card.readback }) : JSON.stringify(heraldActions.map((a) => a.kind)));
    if (card) {
      const conf = await request('herald_confirm', { actionId: card.id, decision: 'confirm', method: 'tap' }, 60_000);
      record('herald: confirm accepted', conf.success === true, conf.error || '');
      const fresh = await until('herald: new Codex session on the private server', async () => {
        const n = tmuxNames(SOCK).find((x) => !before.has(x));
        if (!n) return null;
        SESSION = n;
        const s = await summary();
        return s && s.agent === 'codex' ? n : null;
      }, 90_000);
      record('herald: the spawned session runs Codex (listed with agent codex)', !!fresh, fresh || '');
      if (fresh) {
        await assertIsolated([...before, fresh]);
        const hello = await until('herald: first prompt answered', async () => (/HELLO/.test(await lastAssistantText()) ? true : null), 120_000);
        record('herald: the first prompt reached Codex (HELLO)', !!hello, '');
      }
    }
  }

  // 5. The user's Codex config is untouched (the trust override was never saved).
  record('config: ~/.codex/config.toml unchanged', readConfig() === configBefore, '');
}

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // Safety net: Codex may save a folder as trusted in the user's config.
  if (CONFIG_SNAPSHOT !== undefined && readConfig() !== CONFIG_SNAPSHOT) {
    if (CONFIG_SNAPSHOT === null) fs.rmSync(CODEX_CONFIG, { force: true });
    else fs.writeFileSync(CODEX_CONFIG, CONFIG_SNAPSHOT);
    log('restored ~/.codex/config.toml (Codex had changed it)');
  }
  if (args.keep) {
    log(`--keep: private tmux server left running (tmux -S ${SOCK} attach -t ${SESSION})`);
    return;
  }
  try {
    if (fs.existsSync(SOCK)) tmux(['kill-server']);
  } catch {
    /* already gone */
  }
  log(`private tmux server ${fs.existsSync(SOCK) && tmuxNames(SOCK).length ? 'STILL RUNNING' : 'gone'}`);
}

ws.on('error', (e) => {
  console.error(`WebSocket error: ${e.message}`);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void cleanup().finally(() => process.exit(130)));

ws.on('open', async () => {
  const report = { url, session: SESSION, project: PROJECT, results };
  let aborted = null;
  try {
    await run(report);
  } catch (e) {
    aborted = e.message;
    console.error(`${e instanceof Abort ? 'ABORTED' : 'probe failed'}: ${e.message}`);
    if (!(e instanceof Abort)) console.error(e.stack);
    if (fs.existsSync(SOCK) && tmuxNames(SOCK).includes(SESSION)) console.log(tail(screen(), 30));
  } finally {
    await cleanup();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed${aborted ? ' (run aborted)' : ''}`);
    report.aborted = aborted;
    if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    process.exitCode = aborted || failed.length ? 1 : 0;
    ws.close();
    setTimeout(() => process.exit(), 300);
  }
});
