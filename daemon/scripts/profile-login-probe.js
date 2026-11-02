#!/usr/bin/env node
/**
 * profile-login-probe: live check of the one-tap account login on the
 * throwaway probe instance with a PRIVATE tmux server and throwaway homes. No
 * login is completed: the real CLIs are only started and cancelled, and every
 * success / failure / paste path runs a fake login script.
 *
 *   real       claude + codex: the link (and Codex code) reach the client; the
 *              flow survives a reconnect; a second tap attaches; session lists
 *              stay clean though tmux has the session; cancel leaves no session
 *              and no process
 *   fakes      success without a code, success after a pasted code, a rejected
 *              code then a good one, failure, missing command, timeout,
 *              unreadable output (second tap restarts), foreign-host link
 *   user's     a session of the user's named login-<id> is left alone
 *   secrets    link query, device code and pasted code are in neither the
 *              daemon log nor the audit log
 *
 * How to run (from the repo root):
 *   (cd daemon && npm run build)
 *   T=/tmp/claude-1000/plgp; mkdir -p -m 700 $T $T/fake
 *   env -u TMUX -u TMUX_PANE TMUX_TMPDIR=$T COMPANION_PROFILE_LOGIN_TEST_DIR=$T/fake \
 *     bin/herald-sandbox --instance probe start
 *   env -u TMUX -u TMUX_PANE node daemon/scripts/profile-login-probe.js --tmux-tmpdir $T [--json out.json]
 *   bin/herald-sandbox --instance probe stop; rm -rf $T   # always
 *
 * Safety: refuses production / the user's sandbox ports, checks the daemon has
 * that TMUX_TMPDIR, no TMUX and sandbox mode, and that its tmux listing is the
 * private server's. The real link's query and real codes are never printed.
 * The config is restored and the private tmux server killed on exit.
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
const CONFIG = path.join(SANDBOX_DIR, 'config.json');
const TMUX_TMPDIR = opt('--tmux-tmpdir') && path.resolve(opt('--tmux-tmpdir'));
const JSON_OUT = opt('--json');
if (!TMUX_TMPDIR || !fs.existsSync(CONFIG)) {
  console.error('usage: profile-login-probe.js --tmux-tmpdir <dir the probe started with> [--json out]');
  process.exit(2);
}
const FAKE_DIR = path.join(TMUX_TMPDIR, 'fake');
const SOCK = path.join(TMUX_TMPDIR, `tmux-${os.userInfo().uid}`, 'default');
const DEFAULT_SOCK = path.join('/tmp', `tmux-${os.userInfo().uid}`, 'default');
const WORK = path.join(
  os.homedir(),
  '.cache',
  'companion-profile-login-probe',
  crypto.randomBytes(3).toString('hex')
);
const PASTED = `PROBEPASTED${crypto.randomBytes(4).toString('hex')}`;
const FAKE_QUERY = `PROBEQUERY${crypto.randomBytes(4).toString('hex')}`;
const FAKE_URL = `https://claude.com/cai/oauth/authorize?state=${FAKE_QUERY}`;

const original = fs.readFileSync(CONFIG, 'utf-8');
const cfg = JSON.parse(original);
const listener = (cfg.listeners && cfg.listeners[0]) || { port: cfg.port, token: cfg.token };

const t0 = Date.now();
const log = (l) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${l}`);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}
class Abort extends Error {}

const cleanEnv = { TERM: 'xterm-256color', TMUX_TMPDIR };
for (const k of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'XDG_RUNTIME_DIR'])
  if (process.env[k]) cleanEnv[k] = process.env[k];
const tmux = (a) =>
  execFileSync('tmux', ['-S', SOCK, ...a], {
    env: cleanEnv,
    encoding: 'utf-8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const tmuxNames = (sock = SOCK) => {
  if (!fs.existsSync(sock)) return [];
  try {
    return execFileSync('tmux', ['-S', sock, 'list-sessions', '-F', '#{session_name}'], {
      env: cleanEnv,
      encoding: 'utf-8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};
const envOf = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
  } catch {
    return '';
  }
};
/** Live processes whose environment names this run's throwaway homes. */
const leftoverProcesses = () =>
  fs
    .readdirSync('/proc')
    .filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid && envOf(d).includes(WORK)).length;

// ---------------------------------------------------------------- websocket
class Client {
  constructor() {
    this.seq = 0;
    this.waiters = new Map();
    this.updates = [];
    this.changed = 0;
    this.ws = new WebSocket(`ws://localhost:${listener.port}`);
    this.ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.requestId && this.waiters.has(m.requestId)) {
        const w = this.waiters.get(m.requestId);
        this.waiters.delete(m.requestId);
        w(m);
      } else if (m.type === 'profile_login_update') this.updates.push(m.payload.flow);
      else if (m.type === 'profiles_changed') this.changed++;
    });
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    const auth = await this.request('authenticate', {});
    if (!auth.success) throw new Abort('authentication failed');
    await this.request('subscribe', {});
    return this;
  }
  request(type, payload, timeoutMs = 20000) {
    const requestId = `plg-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`${type} timed out`));
      }, timeoutMs);
      this.waiters.set(requestId, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.ws.send(
        JSON.stringify({
          type,
          payload,
          requestId,
          ...(type === 'authenticate' ? { token: listener.token } : {}),
        })
      );
    });
  }
  close() {
    this.ws.close();
  }
}

async function until(fn, timeoutMs, stepMs = 300) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await delay(stepMs);
  }
}
let client;
const flowOf = async (id) => {
  const r = await client.request('profile_login_status', {});
  return ((r.payload && r.payload.flows) || []).find((f) => f.profileId === id) || null;
};
const waitFlow = (id, test, ms = 20000) =>
  until(async () => {
    const f = await flowOf(id);
    return f && test(f) ? f : null;
  }, ms);
const start = (id) => client.request('profile_login', { profileId: id });
const stateIs = (s) => (f) => f.state === s;
const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

async function assertIsolated() {
  if ([9877, 9878, 9887].includes(Number(listener.port)))
    throw new Abort(`refusing port ${listener.port}`);
  if (SOCK.length >= 108) throw new Abort('tmux socket path too long');
  if (path.resolve(SOCK) === path.resolve(DEFAULT_SOCK))
    throw new Abort('the private socket IS the default one');
  const pid = Number(fs.readFileSync(path.join(SANDBOX_DIR, 'sandbox.pid'), 'utf-8').trim());
  const env = Object.fromEntries(
    envOf(pid)
      .split('\0')
      .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])
  );
  if (path.resolve(env.TMUX_TMPDIR || '') !== TMUX_TMPDIR)
    throw new Abort(`probe daemon lacks TMUX_TMPDIR=${TMUX_TMPDIR}`);
  if (env.TMUX) throw new Abort('probe daemon has TMUX set');
  if (env.COMPANION_SANDBOX !== '1') throw new Abort('probe daemon is not in sandbox mode');
  if (path.resolve(env.COMPANION_PROFILE_LOGIN_TEST_DIR || '') !== FAKE_DIR)
    throw new Abort(`probe daemon lacks COMPANION_PROFILE_LOGIN_TEST_DIR=${FAKE_DIR}`);
  const r = await client.request('list_tmux_sessions', {});
  const seen = ((r.payload && r.payload.sessions) || []).map((s) => s.name).sort();
  if (JSON.stringify(seen) !== JSON.stringify(tmuxNames().sort()))
    throw new Abort(`listing [${seen}] != private server's`);
  return env;
}

const fakes = {
  fyes: `echo "Opening browser to sign in"\necho "visit: ${FAKE_URL}"\nsleep 2\nexit 0\n`,
  fpaste: `echo "visit: ${FAKE_URL}"\nprintf 'Paste code here if prompted > '\nread code\n[ "$code" = "${PASTED}" ] && exit 0\nexit 9\n`,
  fretry: `echo "visit: ${FAKE_URL}"\nwhile :; do\n  printf 'Paste code here if prompted > '\n  read code\n  [ "$code" = "${PASTED}" ] && exit 0\n  echo "Invalid code"\ndone\n`,
  ffail: `echo "visit: ${FAKE_URL}"\nsleep 1\nexit 3\n`,
  fmiss: `exit 127\n`,
  ftime: `echo "visit: ${FAKE_URL}"\nsleep 600\n`,
  fodd: `echo "Something this version says differently"\nsleep 600\n`,
  fhost: `echo "visit: https://evil.example.com/${FAKE_QUERY}"\nprintf 'Paste code here if prompted > '\nsleep 600\n`,
  fuser: `echo "visit: ${FAKE_URL}"\nsleep 600\n`,
};

async function main() {
  client = await new Client().open();
  await assertIsolated();
  log(`isolated: probe on port ${listener.port}, private tmux ${SOCK}`);

  fs.mkdirSync(FAKE_DIR, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
  const profiles = [
    { id: 'pclaude', label: 'Real Claude', agent: 'claude' },
    { id: 'pcodex', label: 'Real Codex', agent: 'codex' },
  ];
  for (const [id, body] of Object.entries(fakes)) {
    fs.writeFileSync(path.join(FAKE_DIR, `${id}.sh`), body);
    profiles.push({ id, label: `Fake ${id}`, agent: 'claude' });
  }
  fs.writeFileSync(path.join(FAKE_DIR, 'ftime.timeout-ms'), '5000\n');
  const tmp = `${CONFIG}.tmp-probe`;
  fs.writeFileSync(
    tmp,
    JSON.stringify(
      { ...cfg, profiles: profiles.map((p) => ({ ...p, home: path.join(WORK, p.id) })) },
      null,
      2
    ) + '\n',
    { mode: fs.statSync(CONFIG).mode & 0o777 }
  );
  fs.renameSync(tmp, CONFIG);
  for (const p of profiles) fs.mkdirSync(path.join(WORK, p.id), { recursive: true, mode: 0o700 });
  const loaded = await until(async () => {
    const r = await client.request('profiles_list', {});
    return r.payload.profiles.length === profiles.length + 2;
  }, 20000);
  if (!loaded) throw new Error('profiles not picked up');

  // ---- real Claude
  const c = await start('pclaude');
  record('real Claude: login accepted', c.success === true && !!c.payload.flow, c.error || '');
  const cf = await waitFlow('pclaude', stateIs('awaiting_code'));
  record(
    'real Claude: link and paste prompt reach the client',
    !!cf && cf.url.startsWith('https://') && hostOf(cf.url) === 'claude.com',
    cf ? `host ${hostOf(cf.url)}, url length ${cf.url.length}` : 'no flow'
  );
  const inTmux = tmuxNames().includes('login-pclaude');
  const summary = await client.request('get_server_summary', {});
  const listed = await client.request('list_tmux_sessions', {});
  const inSummary = (summary.payload.sessions || []).some((s) => /login-/.test(s.id + (s.name || '')));
  const inList = (listed.payload.sessions || []).some((s) => /^login-/.test(s.name));
  record('session exists in tmux yet is in no listing', inTmux && !inSummary && !inList);
  await delay(6000); // past a watcher refresh
  const summary2 = await client.request('get_server_summary', {});
  record(
    'still not in the summary after a watcher refresh',
    !(summary2.payload.sessions || []).some((s) => /login-/.test(s.id + (s.name || '')))
  );
  const again = await start('pclaude');
  record('second tap attaches', again.payload && again.payload.alreadyRunning === true);
  const term = await client.request('get_terminal_output', { sessionName: 'login-pclaude' });
  record('"Open terminal" can read the hidden session', term.success && !!term.payload.output);
  client.close();
  client = await new Client().open();
  const back = await flowOf('pclaude');
  record(
    'after a reconnect the flow is restored with its link',
    !!back && back.state === 'awaiting_code' && back.url === cf.url
  );
  const cancelled = await client.request('profile_login_cancel', { profileId: 'pclaude' });
  record('cancel: state cancelled, link dropped', cancelled.payload.flow.state === 'cancelled' && !cancelled.payload.flow.url);
  record('cancel: no tmux session', !tmuxNames().includes('login-pclaude'));

  // ---- real Codex
  await start('pcodex');
  const xf = await waitFlow('pcodex', stateIs('open_link'));
  record(
    'real Codex: link and one-time code reach the client',
    !!xf && hostOf(xf.url) === 'auth.openai.com' && /^[A-Z0-9-]{4,24}$/.test(xf.deviceCode || ''),
    xf ? `host ${hostOf(xf.url)}, code length ${xf.deviceCode.length}` : 'no flow'
  );
  const coderef = await client.request('profile_login_code', { profileId: 'pcodex', code: 'x' });
  record('Codex refuses a pasted code', coderef.success === false);
  await client.request('profile_login_cancel', { profileId: 'pcodex' });
  record('Codex cancel: no tmux session', !tmuxNames().includes('login-pcodex'));
  const gone = await until(() => leftoverProcesses() === 0, 8000);
  record('no login process is left running', !!gone, `${leftoverProcesses()} left`);

  // ---- fakes
  const changedBefore = client.changed;
  await start('fyes');
  const yes = await waitFlow('fyes', stateIs('success'), 15000);
  record('success without a code', !!yes);
  record('success: session gone', !tmuxNames().includes('login-fyes'));
  record('success: profiles_changed sent', await until(() => client.changed > changedBefore, 5000));
  record('ended flow carries no link', !!yes && !yes.url);

  await start('fpaste');
  await waitFlow('fpaste', stateIs('awaiting_code'));
  const sent = await client.request('profile_login_code', { profileId: 'fpaste', code: PASTED });
  record('paste code accepted for sending', sent.success === true);
  const pasted = await waitFlow('fpaste', stateIs('success'), 10000);
  record('pasted code reached the login literally -> success (exit 0)', !!pasted);
  record('paste: session gone', !tmuxNames().includes('login-fpaste'));

  await start('fretry');
  await waitFlow('fretry', stateIs('awaiting_code'));
  await client.request('profile_login_code', { profileId: 'fretry', code: 'wrong "$(touch /tmp/x)" code' });
  const rejected = await waitFlow('fretry', (f) => f.state === 'awaiting_code' && !!f.message, 15000);
  record('a rejected code returns to the prompt with a message', !!rejected);
  await client.request('profile_login_code', { profileId: 'fretry', code: PASTED });
  record('then the good code succeeds', !!(await waitFlow('fretry', stateIs('success'), 10000)));

  await start('ffail');
  const failed = await waitFlow('ffail', stateIs('failed'), 10000);
  record('non-zero exit: failed', !!failed, failed ? failed.message : '');
  record('failure: session gone', !tmuxNames().includes('login-ffail'));

  await start('fmiss');
  const miss = await waitFlow('fmiss', stateIs('failed'), 10000);
  record('exit 127: says the command is missing', !!miss && /not found/.test(miss.message || ''));

  await start('ftime');
  const timed = await waitFlow('ftime', stateIs('expired'), 15000);
  record('timeout: expired', !!timed);
  record('timeout: session gone', !tmuxNames().includes('login-ftime'));

  await start('fodd');
  const odd = await waitFlow('fodd', (f) => f.unparsed === true, 30000);
  record('unknown output: flagged unparsed', !!odd);
  const retap = await start('fodd');
  record(
    'second tap restarts an unreadable login',
    !!odd && retap.payload.flow.flowId !== odd.flowId && !retap.payload.alreadyRunning
  );
  await client.request('profile_login_cancel', { profileId: 'fodd' });
  record('unparsed cancel: no session', !tmuxNames().includes('login-fodd'));

  await start('fhost');
  const host = await waitFlow('fhost', (f) => f.unparsed === true, 10000);
  record('foreign-host link is never passed on', !!host && !host.url && host.state === 'starting');
  await client.request('profile_login_cancel', { profileId: 'fhost' });

  // ---- a user's own session under the same name
  tmux(['new-session', '-d', '-s', 'login-fuser']);
  const u = await start('fuser');
  record(
    "user's own login-<id> session: the flow uses another name",
    u.success && u.payload.flow.sessionName !== 'login-fuser',
    u.payload && u.payload.flow.sessionName
  );
  await client.request('profile_login_cancel', { profileId: 'fuser' });
  record("cancel leaves the user's session alone", tmuxNames().includes('login-fuser'));
  const stillListed = await until(async () => {
    const r = await client.request('list_tmux_sessions', {});
    return r.payload.sessions.some((s) => s.name === 'login-fuser');
  }, 5000);
  record("the user's session stays in the listing", !!stillListed);
  tmux(['kill-session', '-t', 'login-fuser']);

  record(
    'tmux has no login session left',
    !tmuxNames().some((n) => n.startsWith('login-')),
    tmuxNames().join(',')
  );

  // ---- secrets
  await delay(500);
  const logDir = SANDBOX_DIR;
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.log$|audit/.test(e.name)) files.push(p);
    }
  };
  walk(logDir);
  const text = files.map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
  const checks = {
    'pasted code': PASTED,
    'link query': FAKE_QUERY,
    'real Claude link': cf ? cf.url.slice(0, 60) : 'x'.repeat(40),
    'real Codex code': xf ? xf.deviceCode : 'x'.repeat(40),
    'oauth path': 'oauth/authorize',
  };
  const leaks = Object.entries(checks).filter(([, v]) => text.includes(v)).map(([k]) => k);
  record(
    `no secret in ${files.length} log / audit files`,
    files.length > 0 && leaks.length === 0 && /profile_login_start/.test(text),
    leaks.join(', ')
  );
}

async function cleanup() {
  try {
    fs.writeFileSync(CONFIG, original);
  } catch (e) {
    console.error(`could not restore ${CONFIG}: ${e.message}`);
  }
  try {
    tmux(['kill-server']);
  } catch {
    /* already gone */
  }
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
    for (const f of fs.readdirSync(FAKE_DIR)) fs.rmSync(path.join(FAKE_DIR, f), { force: true });
  } catch {
    /* leave it */
  }
  try {
    client.close();
  } catch {
    /* gone */
  }
}

main()
  .catch((e) => {
    record(e instanceof Abort ? 'ABORT (isolation)' : 'probe error', false, e.message);
  })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ results }, null, 2));
    process.exit(failed.length ? 1 : 0);
  });
