/* Flaky-network E2E (run through bin/e2e-flaky-net): puts a chaos WebSocket proxy
 * between the web client and the PROBE sandbox daemon (port 9888) and drives the
 * app in headless Chrome (one desktop page + one mobile page, each through its own
 * proxy) for DURATION_S seconds while the proxy randomly stalls (buffers both ways),
 * half-closes (TCP FIN, no close frame), drops (TCP reset) and stalls new
 * connections during auth.
 *
 * SAFETY: the proxy forwards only read-only message types (authenticate, subscribe,
 * ping, switch_session, get_*, list_*, *_list and a few named reads). Everything else, notably send_input, is
 * swallowed, so nothing typed by the harness ever reaches a session.
 *
 * Measures: session-list count (min after first load, samples at 0), concurrent open
 * sockets per page at the proxy (max, seconds with more than one, zombies = a socket
 * still open 15 s after a newer one was opened), messages delivered on a non-latest
 * socket (in-page), long tasks (PerformanceObserver), textarea disabled samples.
 *
 * Env: WEB_DIR (built web app, base /web/), UPSTREAM (ws://127.0.0.1:9888),
 * TOKEN_FILE (probe config.json), DURATION_S (180), OUT (json path), SEED,
 * PLAYWRIGHT_CORE, CHROME, WS_MODULE (path to the `ws` package). */
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const WebSocket = require(process.env.WS_MODULE || path.join(ROOT, 'daemon', 'node_modules', 'ws'));

const WEB_DIR = process.env.WEB_DIR;
const UPSTREAM = process.env.UPSTREAM || 'ws://127.0.0.1:9888';
const DURATION_S = Number(process.env.DURATION_S || 180);
const OUT = process.env.OUT;
const cfg = JSON.parse(fs.readFileSync(process.env.TOKEN_FILE, 'utf-8'));
const TOKEN = ((cfg.listeners && cfg.listeners[0]) || cfg).token;

// Deterministic-ish randomness so before/after runs see a similar storm.
let seed = Number(process.env.SEED || 1234567);
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const between = (a, b) => a + rand() * (b - a);
const log = (...a) => console.log('[flaky]', ...a);

const SAFE = /^(authenticate|subscribe|unsubscribe|ping|switch_session|get_[a-z_]+|list_[a-z_]+|[a-z_]+_list|herald_get_state|herald_voice_status|check_files_exist)$/;

// ---------------------------------------------------------------- static server
function startStatic() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.onnx': 'application/octet-stream', '.mjs': 'text/javascript', '.woff2': 'font/woff2' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let rel = u.pathname.replace(/^\/web\/?/, '');
    let file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR) || !rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html');
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// ---------------------------------------------------------------- chaos proxy
function startProxy(name) {
  const stats = { name, opened: 0, maxConcurrent: 0, multiSamples: 0, zombies: 0, dropped: 0, swallowed: {}, actions: { stall: 0, halfclose: 0, drop: 0, authstall: 0 } };
  const pairs = new Set();
  const wss = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (client) => {
    stats.opened++;
    const pair = { client, openedAt: Date.now(), stalledUntil: 0, downStalledUntil: 0, toUp: [], toDown: [], up: null, closed: false, zombieCounted: false };
    pairs.add(pair);
    // Auth stall: the daemon gets (and answers) the handshake, the answers are held
    // past the client's 10 s auth timeout (a link that dies mid-handshake).
    if (rand() < 0.3 && chaosOn) { pair.downStalledUntil = Date.now() + between(11000, 14000); stats.actions.authstall++; }
    const up = new WebSocket(UPSTREAM);
    pair.up = up;
    const flush = () => {
      if (pair.closed || Date.now() < pair.stalledUntil) return;
      if (up.readyState === 1) while (pair.toUp.length) up.send(pair.toUp.shift());
      if (client.readyState === 1 && Date.now() >= pair.downStalledUntil) while (pair.toDown.length) client.send(pair.toDown.shift());
    };
    pair.flush = flush;
    up.on('open', flush);
    up.on('message', (d) => { pair.toDown.push(d.toString()); flush(); });
    client.on('message', (d) => {
      const s = d.toString();
      let type = '';
      try { type = JSON.parse(s).type || ''; } catch { /* ignore */ }
      if (!SAFE.test(type)) { stats.swallowed[type] = (stats.swallowed[type] || 0) + 1; return; }
      pair.toUp.push(s); flush();
    });
    const end = () => { if (pair.closed) return; pair.closed = true; pairs.delete(pair); try { up.terminate(); } catch { /* */ } try { client.terminate(); } catch { /* */ } };
    client.on('close', end); client.on('error', end);
    up.on('close', end); up.on('error', end);
  });
  const tick = setInterval(() => {
    const open = [...pairs];
    for (const p of open) p.flush();
    stats.maxConcurrent = Math.max(stats.maxConcurrent, open.length);
    if (open.length > 1) stats.multiSamples++;
    const newest = open.reduce((m, p) => Math.max(m, p.openedAt), 0);
    for (const p of open) {
      if (!p.zombieCounted && p.openedAt < newest && Date.now() - newest > 15000) { p.zombieCounted = true; stats.zombies++; }
    }
  }, 100);
  let chaosOn = false;
  let chaosTimer = null;
  function chaosStep() {
    const open = [...pairs];
    const p = open[open.length - 1];
    const r = rand();
    if (p) {
      if (r < 0.35) { p.stalledUntil = Date.now() + between(3000, 20000); stats.actions.stall++; }
      else if (r < 0.55) { stats.actions.halfclose++; try { p.client._socket.end(); } catch { /* */ } }
      else if (r < 0.75) { stats.actions.drop++; try { p.client._socket.destroy(); } catch { /* */ } }
    }
    chaosTimer = setTimeout(chaosStep, between(4000, 10000));
  }
  return new Promise((resolve) => wss.on('listening', () => resolve({
    port: wss.address().port, stats,
    startChaos() { chaosOn = true; chaosTimer = setTimeout(chaosStep, 2000); },
    stopChaos() { chaosOn = false; clearTimeout(chaosTimer); for (const p of pairs) { p.stalledUntil = 0; p.downStalledUntil = 0; } },
    openCount: () => pairs.size,
    close() { clearInterval(tick); clearTimeout(chaosTimer); for (const p of pairs) { try { p.client.terminate(); p.up.terminate(); } catch { /* */ } } wss.close(); },
  })));
}

// ---------------------------------------------------------------- page instrumentation
function initScript({ port, token }) {
  try {
    if (!localStorage.getItem('companion_servers')) {
      localStorage.setItem('companion_servers', JSON.stringify([{ id: 'flaky', name: 'Flaky', host: '127.0.0.1', port, token, useTls: false, enabled: true }]));
    }
  } catch { /* */ }
  const m = (window.__m = { sockets: 0, staleMsgs: 0, longTasks: [], samples: 0, sessionCounts: [], zeroAfterLoad: 0, minAfterLoad: null, disabledSamples: 0, textareaSamples: 0, loaded: false });
  const Orig = window.WebSocket;
  const all = [];
  class W extends Orig {
    constructor(u, p) {
      super(u, p);
      if (String(u).includes(':' + port)) {
        m.sockets++; all.push(this);
        this.addEventListener('message', () => { if (this !== all[all.length - 1]) m.staleMsgs++; });
      }
    }
  }
  window.WebSocket = W;
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) m.longTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true });
  } catch { /* */ }
  setInterval(() => {
    const n = document.querySelectorAll('.sidebar-session-name, .mobile-session-item').length;
    m.samples++;
    if (n > 0) m.loaded = true;
    if (m.loaded) {
      if (n === 0) m.zeroAfterLoad++;
      m.minAfterLoad = m.minAfterLoad === null ? n : Math.min(m.minAfterLoad, n);
    }
    const ta = document.querySelector('textarea.input-bar-textarea');
    if (ta) { m.textareaSamples++; if (ta.disabled) m.disabledSamples++; }
  }, 200);
}

async function openPage(browser, proxy, viewport, label) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(initScript, { port: proxy.port, token: TOKEN });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(label, 'pageerror', String(e).slice(0, 200)));
  return { ctx, page, label, proxy };
}

async function openFirstSession(p) {
  const sel = p.label === 'mobile' ? '.mobile-session-item' : '.sidebar-session-name';
  await p.page.waitForSelector(sel, { timeout: 30000 });
  await p.page.locator(sel).first().click();
  await p.page.waitForSelector('textarea.input-bar-textarea', { timeout: 15000 }).catch(() => log(p.label, 'no textarea'));
}

/** Type + send (swallowed by the proxy), then keep typing while the send is in flight. */
async function typeProbe(p, n) {
  const ta = p.page.locator('textarea.input-bar-textarea');
  if (!(await ta.count())) return { skipped: true };
  const res = { disabledDuringSend: false, typedWhileSending: false };
  try {
    if (await ta.isDisabled()) { res.disabledDuringSend = true; return res; }
    await ta.fill(`flaky harness probe ${n} (never delivered)`);
    await ta.press('Enter');
    await p.page.waitForTimeout(400);
    res.disabledDuringSend = await ta.isDisabled();
    if (!res.disabledDuringSend) {
      await ta.type('x', { timeout: 2000 });
      res.typedWhileSending = (await ta.inputValue()).includes('x');
      await ta.fill('');
    }
  } catch (e) { res.error = String(e).slice(0, 120); }
  return res;
}

(async () => {
  const stat = await startStatic();
  const BASE = `http://127.0.0.1:${stat.address().port}/web/`;
  const proxies = { desktop: await startProxy('desktop'), mobile: await startProxy('mobile') };
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const pages = [
    await openPage(browser, proxies.desktop, { width: 1366, height: 900 }, 'desktop'),
    await openPage(browser, proxies.mobile, { width: 390, height: 844 }, 'mobile'),
  ];
  for (const p of pages) await p.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  for (const p of pages) await openFirstSession(p).catch((e) => log(p.label, 'open session failed', String(e).slice(0, 160)));
  // On mobile the session view replaces the list; go back so the list is sampled too,
  // and probe typing on the desktop page (split view keeps both).
  const mobile = pages[1];
  await mobile.page.goBack().catch(() => {});
  await mobile.page.waitForTimeout(1500);
  for (const p of pages) await p.page.evaluate(() => { window.__m.longTasks = []; });

  log(`chaos on for ${DURATION_S}s`);
  for (const pr of Object.values(proxies)) pr.startChaos();
  const probes = [];
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < DURATION_S * 1000) {
    await pages[0].page.waitForTimeout(15000);
    probes.push(await typeProbe(pages[0], ++n));
  }
  for (const pr of Object.values(proxies)) pr.stopChaos();
  log('chaos off, settling 25s');
  await pages[0].page.waitForTimeout(25000);

  const result = { durationS: DURATION_S, pages: {} };
  for (const p of pages) {
    const m = await p.page.evaluate(() => window.__m);
    const lt = m.longTasks;
    result.pages[p.label] = {
      socketsCreated: m.sockets,
      staleSocketMessages: m.staleMsgs,
      proxy: { ...p.proxy.stats, multiSeconds: +(p.proxy.stats.multiSamples / 10).toFixed(1), openAtEnd: p.proxy.openCount() },
      sessionList: { samples: m.samples, zeroAfterLoad: m.zeroAfterLoad, minAfterLoad: m.minAfterLoad },
      longTasks: { count: lt.length, over200: lt.filter((d) => d > 200).length, max: lt.length ? Math.max(...lt) : 0 },
      textarea: { samples: m.textareaSamples, disabled: m.disabledSamples },
    };
  }
  result.typeProbes = {
    count: probes.length,
    disabledDuringSend: probes.filter((x) => x.disabledDuringSend).length,
    typedWhileSending: probes.filter((x) => x.typedWhileSending).length,
    skipped: probes.filter((x) => x.skipped).length,
  };
  console.log(JSON.stringify(result, null, 2));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  await browser.close();
  for (const pr of Object.values(proxies)) pr.close();
  stat.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
