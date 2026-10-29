#!/usr/bin/env node
/**
 * codex-control-probe: live end-to-end test of driving a REAL Codex CLI session
 * through the daemon, the way the app does, on the throwaway probe instance only.
 *
 *   spawn      create_tmux_session {agent: 'codex', permissionMode: 'default'}
 *              -> plain `codex` in the private tmux server, CODEX_HOME = the real home;
 *              without permissionMode (the app's default) -> the bypass flag
 *   detect     the daemon lists it with agent 'codex'
 *   (a Codex the probe starts itself with `-a on-request`: in a folder Codex
 *   does not trust, plain `codex` rejects escalations without asking, and the
 *   probe stays out of the user's trusted folders so production's discovery
 *   never sees its threads)
 *   prompt     send_input -> working -> the approval box as a live choice (get_highlights)
 *   approve    send_choice index 0 (what QuestionBlock sends) -> the command runs, turn ends
 *   decline    send_choice with otherText (the "Other" field) -> Esc + feedback message
 *   follow-up  send_input -> answered
 *   interrupt  send_terminal_keys ['C-c'] (the stop button) -> Esc: the turn stops,
 *              Codex keeps running (a real Ctrl+C would quit it)
 *   bypass     get_bypass_permissions reports how each Codex was LAUNCHED (read-only);
 *              set_bypass_permissions is refused and writes no .claude/settings.json
 *   edits      an apply_patch outside the workspace: the edit-approval box (no
 *              transcript mark) makes the summary say waiting; approve -> file written
 *   project    scaffold_open_session {agent: 'codex'} (New Project's "Open Session")
 *              -> plain `codex`, listed as codex, kickoff prompt sent once ready
 *   isolation  a Codex session (app default = bypass) in a fresh GIT folder that has an
 *              old Claude-style transcript in code_home's projects dir: never shows it
 *   trust      that folder's "Trust this folder?" prompt is a live choice ("Yes, trust" /
 *              "No"), the session reads waiting, send_input is refused (the paste used to
 *              be dropped and its Enter answered "Trust and continue"), "Yes, trust" via
 *              send_choice -> the composer, config gains that folder (restored at once)
 *   first msg  the first message after that is mapped to its new rollout within ~2 s
 *   trust: no  a second folder (plain `codex`): "No" via send_choice -> Codex exits (an
 *              untrusted folder gets no working Codex session), config.toml untouched
 *
 * ~/.codex/config.toml is snapshotted before the trust phase and restored byte for
 * byte afterwards (and on any exit); the fake Claude transcript dir is removed.
 *
 * Costs a few small turns of the user's OpenAI quota (tiny prompts).
 *
 * How to run (from the repo root; the daemon must see ONLY the private tmux server):
 *
 *   (cd daemon && npm run build)
 *   T=/tmp/claude-1000/cdxp; mkdir -p -m 700 $T   # short: the socket path must stay under 108 chars
 *   env -u TMUX -u TMUX_PANE TMUX_TMPDIR=$T bin/herald-sandbox --instance probe start
 *   env -u TMUX -u TMUX_PANE node daemon/scripts/codex-control-probe.js --tmux-tmpdir $T [--json out.json] [--verbose]
 *   bin/herald-sandbox --instance probe stop; rm -rf $T   # always
 *
 * Safety: before anything is created it checks that the daemon process has that
 * TMUX_TMPDIR, no TMUX, sandbox mode and a non-production port, and that the
 * daemon's tmux listing is exactly the private server's (sharing no name with
 * the default server). Every tmux call here names the private socket with -S.
 * On exit it kills the private tmux server. Exit code 0 = every assertion passed.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

function parseArgs(argv) {
  const out = { config: null, tmuxTmpdir: null, session: 'cdx-probe', dir: null, json: null, verbose: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--tmux-tmpdir') out.tmuxTmpdir = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--trust-only') out.trustOnly = true;
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
const CONTROL = 'cdx-ctl';
const BYPASS = 'cdx-bypass';
const ANCHOR = 'cdx-anchor';
// A plain (non-git) folder: Codex asks no trust question there.
const PROJECT = path.resolve(args.dir || path.join(TMUX_TMPDIR, 'proj'));
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
  const requestId = `cdx-${++reqSeq}`;
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
  }
});

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

/** Prompt -> working -> approval box as a live choice. Returns the choice or null. */
async function promptToApproval(prompt, label) {
  const sent = await sendInput(prompt);
  record(`${label}: send_input accepted`, sent.success === true, sent.error || '');
  const working = await until(`${label}: working`, async () => ((await status()) === 'working' ? true : (await liveChoice()) ? true : null), 60_000);
  record(`${label}: session goes working`, !!working, `timeline ${JSON.stringify(timeline.slice(-3).map((t) => t.status))}`);
  const choice = await until(`${label}: approval box as a live choice`, liveChoice, 120_000);
  return choice;
}

async function run(report) {
  const auth = await request('authenticate', {});
  if (auth.success === false) throw new Abort(`authenticate failed: ${auth.error}`);

  // 1. Isolation. The private server gets an anchor session first so the
  //    daemon's create_tmux_session joins a running server (never starts one).
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  fs.mkdirSync(PROJECT, { recursive: true });
  if (tmuxNames(SOCK).length) throw new Abort(`the private server already has sessions: ${tmuxNames(SOCK)}`);
  tmux(['new-session', '-d', '-s', ANCHOR, '-c', PROJECT]);
  const iso = await assertIsolated([ANCHOR]);
  record('isolation: the probe daemon sees only the private tmux server', true, `pid ${iso.pid}`);

  if (args.trustOnly) {
    // Only phase 8 (the spawned/control sessions are not created).
    await trustPhaseOnly(report);
    return;
  }

  // 2. Spawn through the app's request.
  const created = await request('create_tmux_session', {
    workingDir: PROJECT,
    name: SESSION,
    startCli: true,
    agent: 'codex',
    permissionMode: 'default',
  });
  record('spawn: create_tmux_session {agent: codex} succeeds', created.success === true && created.payload && created.payload.agent === 'codex', created.error || JSON.stringify(created.payload));
  if (!created.success) throw new Abort('spawn failed');
  await assertIsolated([ANCHOR, SESSION]);
  const ready = await until('Codex ready', async () => (/Ask Codex to do anything|\? for shortcuts/.test(screen()) ? true : null), 60_000);
  if (!ready) throw new Abort('Codex did not become ready');
  const pid = codexPid();
  const argv = pid ? argvOf(pid) : [];
  record('spawn: plain `codex` (no bypass flag) runs under the pane', !!pid && !argv.includes('--dangerously-bypass-approvals-and-sandbox'), argv.slice(1).join(' '));
  const codexEnv = pid ? envOf(pid) : {};
  record('spawn: CODEX_HOME is the real Codex home', codexEnv.CODEX_HOME === CODEX_HOME, `${codexEnv.CODEX_HOME} (HOME=${codexEnv.HOME})`);
  const tagged = tmux(['show-environment', '-t', SESSION, 'COMPANION_APP']).trim();
  record('spawn: session tagged COMPANION_APP=1', tagged === 'COMPANION_APP=1', tagged);
  const listed = await until('listed as a Codex session', async () => {
    const s = await summary();
    return s && s.agent === 'codex' ? s : null;
  }, 30_000);
  record('detect: get_server_summary lists it with agent "codex"', !!listed, listed ? `status ${listed.status}` : '');

  // 2b. The app's default spawn mode = Claude's bypass equivalent.
  const byp = await request('create_tmux_session', { workingDir: PROJECT, name: BYPASS, startCli: true, agent: 'codex' });
  SESSION = BYPASS;
  const bypReady = await until('bypass Codex ready', async () => (/Ask Codex to do anything|\? for shortcuts/.test(screen()) ? true : null), 60_000);
  const bypArgv = bypReady && codexPid() ? argvOf(codexPid()) : [];
  record('spawn (default mode): codex --dangerously-bypass-approvals-and-sandbox', byp.success === true && bypArgv.includes('--dangerously-bypass-approvals-and-sandbox'), bypArgv.slice(1).join(' '));
  const bypGet = await request('get_bypass_permissions', { sessionId: BYPASS });
  const bp = bypGet.payload || {};
  record('bypass switch: a bypass-launched Codex reads ON and read-only', bp.enabled === true && bp.readOnly === true && bp.launchedWith === 'bypass', JSON.stringify({ enabled: bp.enabled, readOnly: bp.readOnly, launchedWith: bp.launchedWith }));
  const killed = await request('kill_tmux_session', { sessionName: BYPASS });
  await until('bypass session gone', async () => (!tmuxNames(SOCK).includes(BYPASS) ? true : null), 20_000);
  record('spawn (default mode): kill_tmux_session removes it', killed.success === true && !tmuxNames(SOCK).includes(BYPASS), killed.error || '');

  // 2b'. The bypass switch on the plain-`codex` spawn: OFF, read-only, and a
  //      set is refused without touching Claude's project settings.
  const plainGet = await request('get_bypass_permissions', { sessionId: SPAWNED });
  const pp = plainGet.payload || {};
  record('bypass switch: a plain Codex reads OFF and read-only', pp.enabled === false && pp.readOnly === true && pp.launchedWith === 'default', JSON.stringify({ enabled: pp.enabled, readOnly: pp.readOnly, launchedWith: pp.launchedWith }));
  const plainSet = await request('set_bypass_permissions', { sessionId: SPAWNED, enabled: true });
  record(
    'bypass switch: set is refused for Codex and writes no .claude/settings.json',
    plainSet.success === false && !!(plainSet.payload && plainSet.payload.readOnly) && !fs.existsSync(path.join(PROJECT, '.claude')),
    plainSet.error || ''
  );

  // 2c. The control session: Codex with on-request approvals, tagged like an app session.
  SESSION = CONTROL;
  tmux(['new-session', '-d', '-s', CONTROL, '-x', '160', '-y', '45', '-c', PROJECT, '-e', `CODEX_HOME=${CODEX_HOME}`]);
  tmux(['set-environment', '-t', CONTROL, 'COMPANION_APP', '1']);
  await delay(300);
  tmux(['send-keys', '-t', CONTROL, 'codex -a on-request', 'Enter']);
  await assertIsolated([ANCHOR, SPAWNED, CONTROL]);
  const ctlReady = await until('control Codex ready', async () => (/Ask Codex to do anything|\? for shortcuts/.test(screen()) ? true : null), 60_000);
  if (!ctlReady) throw new Abort('control Codex did not become ready');
  const ctlListed = await until('control session listed as Codex', async () => {
    const s = await summary();
    return s && s.agent === 'codex' ? s : null;
  }, 30_000);
  record('detect: a Codex started by hand in a tagged session is listed as codex', !!ctlListed, '');

  // 3. Prompt -> approval -> approve (index 0).
  const choice = await promptToApproval(
    'Run exactly this shell command and nothing else, with escalated permissions because it needs network access: curl -sI https://example.net | head -1',
    'approve'
  );
  record('approve: the approval box surfaces as a live choice', !!choice && /Would you like to run/.test(choice.question), choice ? `${choice.header}: ${choice.question.split('\n')[0]} / ${choice.options.map((o) => o.label).join(' | ')}` : '');
  if (!choice) throw new Abort('no approval box');
  const waitingBox = await until('approve: summary says waiting while the box is up', async () => ((await status()) === 'waiting' ? true : null), 10_000);
  const sNow = await summary();
  record('approve: summary status is waiting while the box is up', !!waitingBox, `${lastStatus}${sNow && sNow.currentActivity ? ` (${sNow.currentActivity})` : ''}`);
  const answered = await request('send_choice', { selectedIndices: [0], optionCount: choice.options.length, multiSelect: false, sessionId: SESSION, tmuxSessionName: SESSION });
  record('approve: send_choice index 0 accepted', answered.success === true, answered.error || '');
  const ran = await until('approve: command ran and the turn ended', async () => {
    const scr = screen();
    return /HTTP\/[\d.]+ \d{3}/.test(scr) && /Ask Codex to do anything/.test(scr) && !/esc to interrupt/.test(scr) && (await status()) !== 'working' ? true : null;
  }, 90_000);
  record('approve: the command ran (HTTP status line) and the turn ended', !!ran, `status ${lastStatus}`);
  report.afterApprove = tail(screen(), 8);

  // 4. Decline with feedback (QuestionBlock's "Other" field).
  const choice2 = await promptToApproval(
    'Run exactly this shell command and nothing else, with escalated permissions because it needs network access: curl -sI https://example.org | head -1',
    'decline'
  );
  if (choice2) {
    const declined = await request('send_choice', { selectedIndices: [], optionCount: choice2.options.length, multiSelect: false, otherText: 'Do not run it. Reply with just the word SKIPPED.', sessionId: SESSION, tmuxSessionName: SESSION });
    record('decline: send_choice with otherText accepted', declined.success === true, declined.error || '');
    const skipped = await until('decline: feedback answered', async () => (/SKIPPED/.test(await lastAssistantText()) && (await status()) !== 'working' ? true : null), 90_000);
    const scr2 = screen();
    record(
      'decline: the box is gone, the command did not run, the feedback was answered',
      !!skipped && !/Ran curl -sI https:\/\/example\.org/.test(scr2) && !(await liveChoice()),
      skipped ? `last reply "${(await lastAssistantText()).slice(0, 40)}"` : ''
    );
  } else record('decline: approval box', false, 'no box');

  // 4b. Edit approval outside the workspace: Codex writes nothing to the rollout
  //     until it is answered, so only the pane shows the box (gap: status stayed
  //     working). The summary must say waiting while it is up.
  const outside = path.join(TMUX_TMPDIR, 'outside', 'x.txt');
  lastStatus = null;
  const editChoice = await promptToApproval(
    `Use apply_patch (not a shell command) to create the file ${outside} containing the single line: hi`,
    'edits'
  );
  record('edits: the edit-approval box surfaces as a live choice', !!editChoice && /make the following edits/i.test(editChoice.question), editChoice ? editChoice.question.split('\n')[0] : '');
  if (editChoice) {
    const editWaiting = await until('edits: summary says waiting while the box is up', async () => ((await status()) === 'waiting' ? true : null), 20_000);
    const sEdit = await summary();
    record('edits: summary status is waiting while the edit box is up', !!editWaiting, `${lastStatus}${sEdit && sEdit.currentActivity ? ` (${sEdit.currentActivity})` : ''}`);
    const st = await request('get_status', { sessionId: SESSION });
    record('edits: get_status says waiting too', !!(st.payload && st.payload.isWaitingForInput), JSON.stringify(st.payload && { w: st.payload.isWaitingForInput, a: st.payload.currentActivity }));
    const okEdit = await request('send_choice', { selectedIndices: [0], optionCount: editChoice.options.length, multiSelect: false, sessionId: SESSION, tmuxSessionName: SESSION });
    const written = await until('edits: file written and the session left waiting', async () => (fs.existsSync(outside) && (await status()) !== 'waiting' ? true : null), 90_000);
    record('edits: approve writes the file and the status leaves waiting', okEdit.success === true && !!written, `status ${lastStatus}`);
    await until('edits: turn ended', async () => ((await status()) !== 'working' ? true : null), 60_000);
  }

  // 5. Follow-up text (in the app-spawned session too).
  SESSION = SPAWNED;
  lastStatus = null;
  const fu0 = await sendInput('Reply with just the word READY.');
  const ready0 = await until('spawned session answers', async () => (/READY/.test(await lastAssistantText()) && (await status()) !== 'working' ? true : null), 90_000);
  record('spawned session: send_input answered (READY)', fu0.success === true && !!ready0, `status ${lastStatus}`);
  SESSION = CONTROL;
  lastStatus = null;
  const fu = await sendInput('Reply with just the word PONG.');
  record('follow-up: send_input accepted', fu.success === true, fu.error || '');
  const pong = await until('follow-up answered', async () => (/PONG/.test(await lastAssistantText()) && (await status()) !== 'working' ? true : null), 90_000);
  record('follow-up: answered (PONG) and idle again', !!pong, `status ${lastStatus}`);

  // 6. Interrupt a running turn with the app's stop button (C-c -> Esc for Codex).
  const pidBefore = codexPid();
  await sendInput('Write a 400 word poem about tea.');
  const working = await until('poem turn working', async () => (/esc to interrupt/.test(screen()) ? true : null), 30_000);
  record('interrupt: turn is running', !!working, `status ${await status()}`);
  await delay(1500);
  const stop = await request('send_terminal_keys', { sessionName: SESSION, keys: ['C-c'] });
  record('interrupt: send_terminal_keys [C-c] accepted', stop.success === true, stop.error || '');
  const stopped = await until('interrupted', async () => {
    const scr = screen();
    return /Conversation interrupted/.test(scr) && !/esc to interrupt/.test(scr) ? true : null;
  }, 20_000);
  record('interrupt: the turn stopped ("Conversation interrupted")', !!stopped, '');
  await delay(1500);
  const scr = screen();
  record('interrupt: Codex is still running (no quit, no "Task is still running" dialog)', codexPid() === pidBefore && !!pidBefore && !/Task is still running/.test(scr) && /Ask Codex to do anything/.test(scr), `pid ${pidBefore} -> ${codexPid()}`);
  const idle = await until('status not working after interrupt', async () => ((await status()) !== 'working' ? true : null), 30_000);
  record('interrupt: summary leaves working', !!idle, `status ${lastStatus}`);

  // 7. New Project's "Open Session" with Codex (scaffold_open_session).
  const PROJ2 = path.join(TMUX_TMPDIR, 'newproj');
  fs.mkdirSync(PROJ2, { recursive: true });
  fs.writeFileSync(path.join(PROJ2, 'README.md'), '# probe\n');
  const opened = await request('scaffold_open_session', { workingDir: PROJ2, projectName: 'probe', agent: 'codex', permissionMode: 'default' }, 30_000);
  const scName = opened.payload && opened.payload.sessionName;
  record('project: scaffold_open_session {agent: codex} succeeds', opened.success === true && !!scName && opened.payload.agent === 'codex', opened.error || JSON.stringify(opened.payload));
  if (scName) {
    SESSION = scName;
    await assertIsolated([ANCHOR, SPAWNED, CONTROL, scName]);
    const scReady = await until('project Codex ready', async () => (/Ask Codex to do anything|\? for shortcuts|starting a new project/.test(screen()) ? true : null), 60_000);
    const scPid = scReady ? codexPid() : null;
    const scArgv = scPid ? argvOf(scPid) : [];
    record('project: plain `codex` runs (bypass unchecked)', !!scPid && !scArgv.includes('--dangerously-bypass-approvals-and-sandbox'), scArgv.slice(1).join(' '));
    const scListed = await until('project session listed as Codex', async () => {
      const s = await summary();
      return s && s.agent === 'codex' ? s : null;
    }, 30_000);
    record('project: listed with agent "codex"', !!scListed, '');
    const kicked = await until('project: kickoff prompt sent', async () => (/starting a new project called "probe"/.test(screen()) ? true : null), 45_000);
    record('project: the kickoff prompt reached Codex', !!kicked, '');
    await request('kill_tmux_session', { sessionName: scName });
    await until('project session gone', async () => (!tmuxNames(SOCK).includes(scName) ? true : null), 20_000);
  }

  // 8. A new Codex session never shows a Claude transcript; the trust prompt
  //    is a choice only the user answers; the first message maps quickly.
  await trustPhase(report);
  report.timeline = timeline;
}

// ----------------------------------------------------------------- isolation + trust

const CODEX_CONFIG = path.join(CODEX_HOME, 'config.toml');
let configSnapshot = null;
const fakeClaudeDirs = [];
const trustDirs = [];
function snapshotCodexConfig() {
  if (configSnapshot === null) configSnapshot = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG) : Buffer.alloc(0);
}
function codexConfigChanged() {
  const now = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG) : Buffer.alloc(0);
  return configSnapshot !== null && !now.equals(configSnapshot);
}
function restoreCodexConfig() {
  if (configSnapshot === null) return true;
  if (codexConfigChanged()) fs.writeFileSync(CODEX_CONFIG, configSnapshot);
  return !codexConfigChanged();
}
const encodeProjectDir = (d) => d.replace(/[^a-zA-Z0-9]/g, '-');
function gitFolder(name) {
  const dir = path.join(os.homedir(), '.cache', 'codex-control-probe', `${name}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { env: cleanEnv, timeout: 8000 });
  fs.writeFileSync(path.join(dir, 'README.md'), '# trust probe\n');
  trustDirs.push(dir);
  return dir;
}
const OLD_MARKER = 'OLD CLAUDE TRANSCRIPT MARKER';

async function trustPhaseOnly(report) {
  trustExpect = [ANCHOR];
  await trustPhase(report);
  report.timeline = timeline;
}
let trustExpect = null;

async function trustPhase(report) {
  snapshotCodexConfig();
  const before = configSnapshot.toString('utf-8');
  const codeHome = path.resolve((cfg.code_home || path.join(os.homedir(), '.claude')).replace(/^~(?=$|\/)/, os.homedir()));
  const dir = gitFolder('trust-yes');
  // An OLD Claude transcript of this folder (what the bug showed in a new Codex session).
  const claudeDir = path.join(codeHome, 'projects', encodeProjectDir(dir));
  fs.mkdirSync(claudeDir, { recursive: true });
  fakeClaudeDirs.push(claudeDir);
  const old = new Date(Date.now() - 7 * 86_400_000).toISOString();
  fs.writeFileSync(
    path.join(claudeDir, 'c9562fb3-3611-45df-a6cb-d28302f4d830.jsonl'),
    [
      { type: 'user', uuid: 'u-old', timestamp: old, cwd: dir, sessionId: 'c9562fb3-3611-45df-a6cb-d28302f4d830', message: { role: 'user', content: OLD_MARKER } },
      { type: 'assistant', uuid: 'a-old', parentUuid: 'u-old', timestamp: old, cwd: dir, message: { role: 'assistant', content: [{ type: 'text', text: `${OLD_MARKER} reply` }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n'
  );

  const TRUST = 'cdx-trust';
  SESSION = TRUST;
  lastStatus = null;
  const created = await request('create_tmux_session', { workingDir: dir, name: TRUST, startCli: true, agent: 'codex' });
  record('isolation: create_tmux_session {agent: codex} (bypass) in a git folder with an old Claude transcript', created.success === true, created.error || '');
  if (!created.success) return;
  await assertIsolated([...(trustExpect || [ANCHOR, SPAWNED, CONTROL]), TRUST]);
  // Hammer the read paths the app uses while Codex starts (the bug's window).
  let leaked = '';
  const tEnd = Date.now() + 8000;
  while (Date.now() < tEnd) {
    await request('switch_session', { sessionId: TRUST }).catch(() => null);
    const hl = await highlights();
    const hit = hl.find((h) => (h.content || '').includes(OLD_MARKER));
    if (hit) leaked = hit.content.slice(0, 60);
    const st = await request('get_status', { sessionId: TRUST });
    if (st.payload && st.payload.conversationId && st.payload.conversationId.endsWith('.jsonl') && !/rollout-/.test(st.payload.conversationId))
      leaked = leaked || `get_status conversationId ${st.payload.conversationId}`;
    await delay(400);
  }
  record('isolation: no Claude transcript in the new Codex session (highlights / status)', !leaked, leaked);

  // The trust prompt as a live choice.
  const trust = await until('trust prompt as a live choice', async () => {
    const c = await liveChoice();
    return c && /Trust this folder\?/.test(c.question) ? c : null;
  }, 45_000);
  record(
    'trust: the prompt is a live choice "Yes, trust" / "No"',
    !!trust && trust.options.map((o) => o.label).join('|') === 'Yes, trust|No',
    trust ? `${trust.header}: ${trust.question.replace(/\n/g, ' ')} / ${trust.options.map((o) => o.label).join(' | ')}` : ''
  );
  if (!trust) return;
  const waiting = await until('trust: summary waiting', async () => ((await status()) === 'waiting' ? true : null), 15_000);
  const st = await request('get_status', { sessionId: TRUST });
  record('trust: summary + get_status say waiting while it is up', !!waiting && !!(st.payload && st.payload.isWaitingForInput), `${lastStatus} / ${st.payload && st.payload.currentActivity}`);
  const refused = await sendInput('Yoyo');
  await delay(1500);
  record(
    'trust: send_input is refused (never answers the prompt), config.toml untouched',
    refused.success === false && refused.error === 'prompt_waiting' && /Trust this folder\?/.test(screen()) && !codexConfigChanged(),
    `${refused.error}: ${refused.payload && refused.payload.message}`
  );
  const yes = await request('send_choice', { selectedIndices: [0], optionCount: 2, multiSelect: false, sessionId: TRUST, tmuxSessionName: TRUST });
  const in1 = await until('trust: composer', async () => (/Ask Codex to do anything|\? for shortcuts/.test(screen()) && !/Trust this folder\?/.test(screen()) ? true : null), 20_000);
  const saved = fs.readFileSync(CODEX_CONFIG, 'utf-8').includes(`[projects."${dir}"]`);
  record('trust: "Yes, trust" via send_choice -> the composer, Codex saved the folder', yes.success === true && !!in1 && saved, yes.error || '');
  record('trust: config.toml restored right away', restoreCodexConfig(), '');
  const left = await until('trust: status leaves waiting', async () => ((await status()) !== 'waiting' ? true : null), 15_000);
  record('trust: status leaves waiting once answered', !!left, `status ${lastStatus}`);

  // First message -> mapped to its new rollout quickly.
  const sentAt = Date.now();
  const first = await sendInput('Reply with just the word TRUSTPONG.');
  const mapped = await until('first message mapped', async () => {
    const r = await request('get_status', { sessionId: TRUST });
    return r.payload && /rollout-.*\.jsonl$/.test(r.payload.conversationId || '') ? Date.now() : null;
  }, 30_000);
  const mapMs = mapped ? mapped - sentAt : null;
  report.firstMessageMapMs = mapMs;
  record('first message: send accepted and mapped to its rollout within 3 s', first.success === true && mapMs !== null && mapMs < 3000, `${mapMs} ms`);
  const pong = await until('first message answered', async () => (/TRUSTPONG/.test(await lastAssistantText()) && (await status()) !== 'working' ? true : null), 90_000);
  const hlAll = await highlights();
  record(
    'first message: answered, and still no Claude transcript',
    !!pong && !hlAll.some((h) => (h.content || '').includes(OLD_MARKER)),
    `status ${lastStatus}`
  );
  await request('kill_tmux_session', { sessionName: TRUST });
  await until('trust session gone', async () => (!tmuxNames(SOCK).includes(TRUST) ? true : null), 20_000);
  restoreCodexConfig();

  // "No" on plain `codex` in a second folder: Codex exits, nothing saved.
  const dir2 = gitFolder('trust-no');
  const TRUST2 = 'cdx-trust2';
  SESSION = TRUST2;
  lastStatus = null;
  const c2 = await request('create_tmux_session', { workingDir: dir2, name: TRUST2, startCli: true, agent: 'codex', permissionMode: 'default' });
  const t2 = c2.success
    ? await until('trust 2: live choice', async () => {
        const c = await liveChoice();
        return c && /Trust this folder\?/.test(c.question) ? c : null;
      }, 45_000)
    : null;
  record('trust: no (plain codex): the prompt is a live choice', !!t2, c2.error || '');
  if (t2) {
    const pidBefore = codexPid();
    const no = await request('send_choice', { selectedIndices: [1], optionCount: 2, multiSelect: false, sessionId: TRUST2, tmuxSessionName: TRUST2 });
    const gone = await until('trust 2: Codex exited', async () => (!codexPid() ? true : null), 20_000);
    record(
      'trust: "No" via send_choice -> Codex exits, config.toml untouched',
      no.success === true && !!pidBefore && !!gone && !codexConfigChanged(),
      no.error || tail(screen(), 2)
    );
    const st2 = await until('trust 2: not waiting', async () => ((await status()) !== 'waiting' ? true : null), 15_000);
    record('trust: no: status leaves waiting', !!st2, `status ${lastStatus}`);
  }
  const restored = restoreCodexConfig();
  const after = fs.readFileSync(CODEX_CONFIG, 'utf-8');
  const kept = [...before.matchAll(/^\[projects\."([^"]+)"\]/gm)].map((m) => m[1]);
  record(
    'config.toml restored byte for byte (existing project entries untouched)',
    restored && after === before && kept.every((k) => after.includes(`[projects."${k}"]`)),
    `entries: ${kept.map((k) => path.basename(k)).join(', ')}`
  );
  await request('kill_tmux_session', { sessionName: TRUST2 });
  await until('trust 2 session gone', async () => (!tmuxNames(SOCK).includes(TRUST2) ? true : null), 20_000);
}

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    if (configSnapshot !== null) log(`codex config.toml ${restoreCodexConfig() ? 'restored' : 'NOT RESTORED'}`);
  } catch (e) {
    log(`codex config.toml restore FAILED: ${e.message}`);
  }
  for (const d of [...fakeClaudeDirs, ...trustDirs]) fs.rmSync(d, { recursive: true, force: true });
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
