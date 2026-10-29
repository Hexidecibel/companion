#!/usr/bin/env node
/**
 * profile-probe: live check of account profiles on the throwaway probe
 * instance with a PRIVATE tmux server. No login is run and no credentials are
 * copied: the extra profiles get fresh, empty homes, so their agents show a
 * login / onboarding screen (expected, reported as such).
 *
 *   config     two profiles appended to the probe's config.json (claude p2c,
 *              codex p2x) -> profiles_list shows 4 within a few seconds (no
 *              restart), the extra ones logged_out
 *   default    create_tmux_session (no profile): claude WITHOUT CLAUDE_CONFIG_DIR,
 *              no profileId in the summary (the old launch, unchanged)
 *   claude     create_tmux_session {profileId: p2c}: the claude process has
 *              CLAUDE_CONFIG_DIR = the p2c home and the env file's variable,
 *              tmux's session env does NOT have that variable, the summary
 *              carries profileId / profileLabel; a transcript written under
 *              <p2c home>/projects/<cwd> is discovered and shown (highlights)
 *   codex      create_tmux_session {profileId: p2x, permissionMode: 'default'}:
 *              codex has CODEX_HOME = the p2x home, listed as codex + p2x; a
 *              rollout written under <p2x home>/sessions is discovered
 *   mismatch   {agent: 'claude', profileId: 'p2x'} is refused
 *   restore    the config is put back -> profiles_list = the 2 defaults
 *
 * How to run (from the repo root):
 *   (cd daemon && npm run build)
 *   T=/tmp/claude-1000/prfp; mkdir -p -m 700 $T
 *   env -u TMUX -u TMUX_PANE TMUX_TMPDIR=$T bin/herald-sandbox --instance probe start
 *   env -u TMUX -u TMUX_PANE node daemon/scripts/profile-probe.js --tmux-tmpdir $T [--json out.json]
 *   bin/herald-sandbox --instance probe stop; rm -rf $T   # always
 *
 * Safety: refuses production / the user's sandbox ports, checks the daemon has
 * that TMUX_TMPDIR, no TMUX and sandbox mode, and that its tmux listing is the
 * private server's. Every tmux call names the private socket. The probe's
 * config is restored and the private tmux server killed on exit.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const SANDBOX_DIR =
  (process.env.HERALD_SANDBOX_DIR ||
    path.join(os.homedir(), '.cache', 'companion-herald-sandbox')) + '-probe';
const CONFIG = opt('--config') || path.join(SANDBOX_DIR, 'config.json');
const TMUX_TMPDIR = opt('--tmux-tmpdir') && path.resolve(opt('--tmux-tmpdir'));
const JSON_OUT = opt('--json');
if (!TMUX_TMPDIR || !fs.existsSync(CONFIG)) {
  console.error(
    'usage: profile-probe.js --tmux-tmpdir <dir the probe was started with> [--json out]'
  );
  process.exit(2);
}
const UID = os.userInfo().uid;
const SOCK = path.join(TMUX_TMPDIR, `tmux-${UID}`, 'default');
const DEFAULT_SOCK = path.join('/tmp', `tmux-${UID}`, 'default');
// Homes outside /tmp (Codex refuses helper binaries under a temp dir).
const WORK = path.join(
  os.homedir(),
  '.cache',
  'companion-profile-probe',
  crypto.randomBytes(3).toString('hex')
);
const CLAUDE_HOME = path.join(WORK, 'claude-p2c');
const CODEX_HOME = path.join(WORK, 'codex-p2x');
const PROJECT = path.join(WORK, 'proj');
const ENV_FILE = path.join(path.dirname(CONFIG), 'profiles', 'p2c.env');
const MARK = `probe-${crypto.randomBytes(4).toString('hex')}`;

const original = fs.readFileSync(CONFIG, 'utf-8');
const cfg = JSON.parse(original);
const listener = (cfg.listeners && cfg.listeners[0]) || { port: cfg.port, token: cfg.token };

const t0 = Date.now();
const log = (l) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${l}`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const cleanEnv = { TERM: 'xterm-256color', TMUX_TMPDIR };
for (const k of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'XDG_RUNTIME_DIR'])
  if (process.env[k]) cleanEnv[k] = process.env[k];
const tmuxAt = (sock, a) =>
  execFileSync('tmux', ['-S', sock, ...a], {
    env: cleanEnv,
    encoding: 'utf-8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const tmux = (a) => tmuxAt(SOCK, a);
const tmuxNames = (sock) => {
  if (!fs.existsSync(sock)) return [];
  try {
    return tmuxAt(sock, ['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const screen = (s) => {
  try {
    return tmux(['capture-pane', '-p', '-t', s]);
  } catch {
    return '';
  }
};

function children(pid) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf-8');
      if (Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) === pid) out.push(Number(d));
    } catch {
      /* gone */
    }
  }
  return out;
}
const argvOf = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
};
const envOf = (pid) => {
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
};
/** The agent process (argv[0..1] basename = name) under a session's pane. */
function agentPid(session, name) {
  let pane;
  try {
    pane = Number(tmux(['display-message', '-p', '-t', session, '#{pane_pid}']).trim());
  } catch {
    return null;
  }
  const queue = [pane];
  const seen = new Set();
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    if (
      p !== pane &&
      argvOf(p)
        .slice(0, 2)
        .some((x) => path.basename(x) === name)
    )
      return p;
    queue.push(...children(p));
  }
  return null;
}

// ---------------------------------------------------------------- websocket
const ws = new WebSocket(`ws://localhost:${listener.port}`);
let seq = 0;
const waiters = new Map();
const events = [];
function request(type, payload, timeoutMs = 20000) {
  const requestId = `prf-${++seq}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      waiters.delete(requestId);
      reject(new Error(`${type} timed out`));
    }, timeoutMs);
    waiters.set(requestId, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    ws.send(
      JSON.stringify({
        type,
        payload,
        requestId,
        ...(type === 'authenticate' ? { token: listener.token } : {}),
      })
    );
  });
}
ws.on('message', (raw) => {
  let m;
  try {
    m = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (m.requestId && waiters.has(m.requestId)) {
    const w = waiters.get(m.requestId);
    waiters.delete(m.requestId);
    w(m);
  } else if (m.type === 'profiles_changed') events.push(m);
});

const results = [];
const notes = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}
class Abort extends Error {}
async function until(fn, timeoutMs, stepMs = 700) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await delay(stepMs);
  }
}
const summaryOf = async (id) => {
  const r = await request('get_server_summary', {});
  return ((r.payload && r.payload.sessions) || []).find((s) => s.id === id) || null;
};
const profilesList = async () =>
  ((await request('profiles_list', {})).payload || {}).profiles || [];

async function assertIsolated() {
  if ([9877, 9878, 9887].includes(Number(listener.port)))
    throw new Abort(`refusing port ${listener.port}`);
  if (SOCK.length >= 108) throw new Abort('tmux socket path too long');
  if (path.resolve(SOCK) === path.resolve(DEFAULT_SOCK))
    throw new Abort('the private socket IS the default one');
  const pid = Number(fs.readFileSync(path.join(SANDBOX_DIR, 'sandbox.pid'), 'utf-8').trim());
  const env = envOf(pid);
  if (path.resolve(env.TMUX_TMPDIR || '') !== TMUX_TMPDIR)
    throw new Abort(`probe daemon lacks TMUX_TMPDIR=${TMUX_TMPDIR}`);
  if (env.TMUX) throw new Abort('probe daemon has TMUX set');
  if (env.COMPANION_SANDBOX !== '1') throw new Abort('probe daemon is not in sandbox mode');
  const r = await request('list_tmux_sessions', {});
  const seen = ((r.payload && r.payload.sessions) || []).map((s) => s.name).sort();
  const mine = tmuxNames(SOCK).sort();
  const theirs = new Set(tmuxNames(DEFAULT_SOCK));
  if (seen.some((n) => theirs.has(n) && !mine.includes(n)))
    throw new Abort('the probe daemon sees the default tmux server');
  if (JSON.stringify(seen) !== JSON.stringify(mine))
    throw new Abort(`listing [${seen}] != private [${mine}]`);
}

function writeConfig(obj) {
  const tmp = `${CONFIG}.tmp-probe`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', {
    mode: fs.statSync(CONFIG).mode & 0o777,
  });
  fs.renameSync(tmp, CONFIG);
}

function claudeTranscript(file, cwd) {
  const now = Date.now();
  const sid = path.basename(file, '.jsonl');
  const lines = [
    {
      type: 'user',
      uuid: 'u-1',
      parentUuid: null,
      sessionId: sid,
      cwd,
      timestamp: new Date(now).toISOString(),
      message: { role: 'user', content: `hello from ${MARK}` },
    },
    {
      type: 'assistant',
      uuid: 'a-1',
      parentUuid: 'u-1',
      sessionId: sid,
      cwd,
      timestamp: new Date(now + 10).toISOString(),
      message: {
        role: 'assistant',
        model: 'probe',
        content: [{ type: 'text', text: `reply for ${MARK}` }],
        stop_reason: 'end_turn',
      },
    },
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function codexRollout(home, cwd) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const id = crypto.randomUUID();
  const dir = path.join(
    home,
    'sessions',
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  );
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const file = path.join(dir, `rollout-${ts}-${id}.jsonl`);
  const iso = now.toISOString();
  const turn = crypto.randomUUID();
  const lines = [
    {
      timestamp: iso,
      type: 'session_meta',
      payload: {
        id,
        session_id: id,
        timestamp: iso,
        cwd,
        originator: 'codex-tui',
        cli_version: '0.165.0',
      },
    },
    { timestamp: iso, type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    {
      timestamp: iso,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `codex hello ${MARK}` }],
        internal_chat_message_metadata_passthrough: {
          turn_id: turn,
          content_item_kinds: ['user.text'],
        },
      },
    },
    {
      timestamp: iso,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: `codex reply ${MARK}` }],
      },
    },
    {
      timestamp: iso,
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: turn, last_agent_message: `codex reply ${MARK}` },
    },
  ];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { file, id };
}

async function main() {
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  const auth = await request('authenticate', {});
  if (!auth.success) throw new Abort('authentication failed');
  await request('subscribe', {}); // global events (profiles_changed) go to subscribed clients
  await assertIsolated();
  log(`isolated: probe on port ${listener.port}, private tmux ${SOCK}`);

  // ---- config: two extra profiles, picked up without a restart
  fs.mkdirSync(CLAUDE_HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ENV_FILE, `PROFILE_PROBE_MARK=${MARK}\n`, { mode: 0o600 });
  const before = await profilesList();
  record(
    'before: only the two default profiles',
    before.length === 2 && before.every((p) => p.isDefault),
    before.map((p) => p.id).join(',')
  );
  writeConfig({
    ...cfg,
    profiles: [
      { id: 'p2c', label: 'Probe C', agent: 'claude', home: CLAUDE_HOME },
      { id: 'p2x', label: 'Probe X', agent: 'codex', home: CODEX_HOME },
    ],
  });
  const four = await until(
    async () => {
      const l = await profilesList();
      return l.length === 4 ? l : null;
    },
    20000,
    1000
  );
  record(
    'config change picked up without a restart (profiles_list = 4)',
    !!four,
    four ? four.map((p) => `${p.id}:${p.loginState}`).join(', ') : ''
  );
  if (four) {
    const by = Object.fromEntries(four.map((p) => [p.id, p]));
    record(
      'new profiles are logged_out (fresh homes, nothing copied)',
      by.p2c.loginState === 'logged_out' && by.p2x.loginState === 'logged_out'
    );
    record(
      'env file names only (no values) in the listing',
      JSON.stringify(by.p2c.envKeys) === '["PROFILE_PROBE_MARK"]' &&
        !JSON.stringify(four).includes(MARK)
    );
  }
  const ev = await until(() => (events.length ? events : null), 5000, 250);
  record(
    'profiles_changed event broadcast with the new list',
    !!ev && ev[ev.length - 1].payload.profiles.length === 4,
    `${events.length} event(s)`
  );

  // ---- default Claude: unchanged launch
  const def = await request('create_tmux_session', {
    workingDir: PROJECT,
    name: 'prf-default',
    startCli: true,
  });
  record('default spawn accepted', def.success === true, def.error || '');
  const defPid = await until(() => agentPid('prf-default', 'claude'), 15000);
  const defEnv = defPid ? envOf(defPid) : {};
  record(
    'default claude has no CLAUDE_CONFIG_DIR and no env-file variable',
    !!defPid && !('CLAUDE_CONFIG_DIR' in defEnv) && !defEnv.PROFILE_PROBE_MARK,
    defPid ? `pid ${defPid}` : 'no claude process'
  );
  const defSum = await until(() => summaryOf('prf-default'), 10000);
  record(
    'default session summary has no profileId',
    !!defSum && defSum.profileId === undefined && defSum.agent === undefined
  );
  tmux(['kill-session', '-t', 'prf-default']);

  // ---- Claude profile p2c
  const c = await request('create_tmux_session', {
    workingDir: PROJECT,
    name: 'prf-claude',
    startCli: true,
    profileId: 'p2c',
  });
  record(
    'p2c spawn accepted',
    c.success === true && c.payload && c.payload.profileId === 'p2c',
    c.error || JSON.stringify(c.payload)
  );
  const cPid = await until(() => agentPid('prf-claude', 'claude'), 15000);
  const cEnv = cPid ? envOf(cPid) : {};
  record(
    'p2c claude has CLAUDE_CONFIG_DIR = its home',
    cEnv.CLAUDE_CONFIG_DIR === CLAUDE_HOME,
    cEnv.CLAUDE_CONFIG_DIR || 'unset'
  );
  record(
    'p2c claude got the env file variable (sourced by the launch line)',
    cEnv.PROFILE_PROBE_MARK === MARK
  );
  let tmuxEnv = '';
  try {
    tmuxEnv = tmux(['show-environment', '-t', 'prf-claude']);
  } catch {
    /* none */
  }
  record(
    "the env file's value is not in tmux's session environment",
    !tmuxEnv.includes(MARK) && tmuxEnv.includes(`CLAUDE_CONFIG_DIR=${CLAUDE_HOME}`)
  );
  const cSum = await until(async () => {
    const s = await summaryOf('prf-claude');
    return s && s.profileId ? s : null;
  }, 15000);
  record(
    'summary: profileId p2c + label',
    !!cSum && cSum.profileId === 'p2c' && cSum.profileLabel === 'Probe C',
    cSum ? `${cSum.profileId} / ${cSum.profileLabel}` : 'none'
  );
  await delay(1500);
  const cScreen = screen('prf-claude');
  const onboarding =
    /Let's get started|Choose the text style|Select login method|log in|Login/i.test(cScreen);
  notes.push(
    `p2c pane: ${onboarding ? 'onboarding / login screen (expected: fresh home, not logged in)' : 'other screen'}`
  );
  record('p2c shows the onboarding / login screen (not logged in), not a hang', onboarding);
  // Discovery under ITS home: a transcript written in <p2c>/projects/<cwd>.
  const encoded = fs.realpathSync(PROJECT).replace(/[^a-zA-Z0-9]/g, '-');
  const convFile = path.join(CLAUDE_HOME, 'projects', encoded, `${crypto.randomUUID()}.jsonl`);
  claudeTranscript(convFile, fs.realpathSync(PROJECT));
  const seenConv = await until(
    async () => {
      const r = await request('get_highlights', { sessionId: 'prf-claude', limit: 10 });
      const hl = (r.payload && r.payload.highlights) || [];
      return hl.some((h) => String(h.content || '').includes(MARK)) ? hl : null;
    },
    25000,
    1000
  );
  record(
    'a transcript under the p2c home is discovered for the p2c session',
    !!seenConv,
    seenConv ? `${seenConv.length} highlights` : 'not found'
  );
  const defaultSide = path.join(os.homedir(), '.claude', 'projects', encoded);
  record(
    'nothing was written under the default ~/.claude/projects for this folder',
    !fs.existsSync(defaultSide)
  );

  // ---- Codex profile p2x
  const x = await request('create_tmux_session', {
    workingDir: PROJECT,
    name: 'prf-codex',
    startCli: true,
    profileId: 'p2x',
    permissionMode: 'default',
  });
  record(
    'p2x spawn accepted (agent follows the profile)',
    x.success === true && x.payload && x.payload.agent === 'codex',
    x.error || JSON.stringify(x.payload)
  );
  const xPid = await until(() => agentPid('prf-codex', 'codex'), 15000);
  const xEnv = xPid ? envOf(xPid) : {};
  record(
    'p2x codex has CODEX_HOME = its home',
    xEnv.CODEX_HOME === CODEX_HOME,
    xEnv.CODEX_HOME || 'unset'
  );
  const xSum = await until(async () => {
    const s = await summaryOf('prf-codex');
    return s && s.agent === 'codex' && s.profileId === 'p2x' ? s : null;
  }, 15000);
  record('summary: agent codex + profileId p2x', !!xSum);
  await delay(2000);
  const xScreen = screen('prf-codex');
  const xLogin = /Sign in|sign in|API key|Welcome to Codex|login/i.test(xScreen);
  notes.push(`p2x pane: ${xLogin ? 'login screen (expected: fresh CODEX_HOME)' : 'other screen'}`);
  record('p2x shows the Codex sign-in screen, not a hang', xLogin);
  const roll = codexRollout(CODEX_HOME, fs.realpathSync(PROJECT));
  const xConv = await until(
    async () => {
      const r = await request('get_highlights', { sessionId: 'prf-codex', limit: 10 });
      const hl = (r.payload && r.payload.highlights) || [];
      return hl.some((h) => String(h.content || '').includes(MARK)) ? hl : null;
    },
    25000,
    1000
  );
  record(
    'a rollout under the p2x home is discovered for the p2x session',
    !!xConv,
    xConv ? roll.id.slice(0, 8) : 'not found'
  );

  // ---- mismatch
  const bad = await request('create_tmux_session', {
    workingDir: PROJECT,
    name: 'prf-bad',
    agent: 'claude',
    profileId: 'p2x',
  });
  record(
    'agent / profile mismatch refused',
    bad.success === false && /codex profile/.test(bad.error || ''),
    bad.error || ''
  );
  const unknown = await request('create_tmux_session', {
    workingDir: PROJECT,
    name: 'prf-bad',
    profileId: 'nope',
  });
  record(
    'unknown profile refused',
    unknown.success === false && /Unknown profile/.test(unknown.error || ''),
    unknown.error || ''
  );
}

async function cleanup() {
  try {
    fs.writeFileSync(CONFIG, original);
  } catch (e) {
    console.error(`could not restore ${CONFIG}: ${e.message}`);
  }
  try {
    const two = await until(
      async () => {
        const l = await profilesList();
        return l.length === 2 ? l : null;
      },
      15000,
      1000
    );
    record('config restored: profiles_list back to the 2 defaults', !!two);
  } catch {
    /* ws gone */
  }
  try {
    tmux(['kill-server']);
  } catch {
    /* already gone */
  }
  try {
    fs.rmSync(ENV_FILE, { force: true });
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* leave it */
  }
  ws.close();
}

main()
  .catch((e) => {
    record(e instanceof Abort ? 'ABORT (isolation)' : 'probe error', false, e.message);
  })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    for (const n of notes) console.log(`note: ${n}`);
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ results, notes }, null, 2));
    process.exit(failed.length ? 1 : 0);
  });
