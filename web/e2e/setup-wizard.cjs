/* Setup wizard E2E (run through bin/e2e-setup-wizard): drives a TRUE first run on a
 * fresh sandbox daemon in headless Chrome, screenshots every step at desktop and
 * mobile widths, then a second device joins by code. Needs playwright-core
 * (PLAYWRIGHT_CORE=/path/to/playwright-core) and Chrome (CHROME=...). */
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 9573);
const BASE = `http://localhost:${PORT}/web/`;
const OUT = process.env.OUT;
const FRESH_HOME = process.env.FRESH_HOME;
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { width: 1366, height: 900 };
const MOBILE = { width: 390, height: 844 };
let n = 0;
const log = (...a) => console.log('[e2e]', ...a);

async function shot(page, name) {
  n++;
  const base = `${String(n).padStart(2, '0')}-${name}`;
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `${base}-desktop.png`) });
  await page.setViewportSize(MOBILE);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${base}-mobile.png`), fullPage: false });
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(250);
  log('shot', base);
}

async function title(page) {
  return (await page.locator('.sw-head__title').textContent()).trim();
}

async function cont(page) {
  await page.locator('.sw-foot .sw-btn--primary').click();
  await page.waitForTimeout(600);
}

async function waitTitle(page, t, timeout = 15000) {
  await page.waitForFunction((x) => document.querySelector('.sw-head__title')?.textContent?.trim() === x, t, { timeout });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });
  await ctx.grantPermissions(['notifications'], { origin: `http://localhost:${PORT}` }).catch(() => {});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sw-root', { timeout: 15000 });
  await waitTitle(page, 'Welcome');
  await shot(page, 'welcome');

  await cont(page);
  await waitTitle(page, 'Pair this device');
  await page.waitForSelector('text=Pair this browser', { timeout: 10000 });
  await shot(page, 'pair');
  await page.locator('text=Pair this browser').click();

  await waitTitle(page, 'Name your server', 20000);
  await page.waitForFunction(() => (document.querySelector('.sw-input--lg')?.value || '').length > 0, null, { timeout: 10000 });
  await page.fill('.sw-input--lg', 'Studio box');
  await shot(page, 'name');
  await cont(page);

  await waitTitle(page, 'Check your machine');
  await page.waitForSelector('.sw-check', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.sw-checks .sw-status--pending'), null, { timeout: 20000 });
  await shot(page, 'machine');
  // Re-check one item live.
  await page.locator('.sw-check').first().locator('text=Re-check').click();
  await page.waitForTimeout(800);
  await cont(page);

  await waitTitle(page, 'Claude Code');
  await page.waitForSelector('.sw-check', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.sw-checks .sw-status--pending'), null, { timeout: 20000 });
  await shot(page, 'claude');
  await cont(page);

  await waitTitle(page, 'Projects');
  await page.waitForSelector('.sw-browser__item', { timeout: 10000 });
  await page.locator('.sw-browser__item', { hasText: 'src' }).first().click();
  await page.waitForFunction(() => document.querySelector('.sw-browser__path')?.textContent?.endsWith('/src'), null, { timeout: 10000 });
  await page.locator('text=Add this folder').click();
  await page.waitForSelector('.sw-chip', { timeout: 5000 });
  await shot(page, 'projects');
  await cont(page);

  await waitTitle(page, 'First session');
  await page.waitForSelector('.sw-browser__item', { timeout: 10000 });
  await page.locator('.sw-browser__item', { hasText: 'demo-app' }).click();
  await page.waitForFunction(() => document.querySelector('.sw-browser__path')?.textContent?.endsWith('demo-app'), null, { timeout: 10000 });
  await page.locator('text=Use this folder').click();
  await shot(page, 'session-pick');
  await page.locator('text=Start session').click();
  await page.waitForSelector('.sw-timeline', { timeout: 30000 });
  // The stub prints a login prompt: wait for the login guidance.
  await page.waitForSelector('text=/login', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await shot(page, 'session-login');

  // Stub the detection: Claude would write a transcript once you send a message.
  const sessionDir = path.join(FRESH_HOME, 'src', 'demo-app');
  const enc = sessionDir.replace(/[^a-zA-Z0-9]/g, '-');
  const projDir = path.join(FRESH_HOME, '.claude', 'projects', enc);
  fs.mkdirSync(projDir, { recursive: true });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const lines = [
    { type: 'user', uuid: crypto.randomUUID(), sessionId: id, cwd: sessionDir, timestamp: now, message: { role: 'user', content: 'Hello! Say hi back in one short line.' } },
    { type: 'assistant', uuid: crypto.randomUUID(), sessionId: id, cwd: sessionDir, timestamp: now, message: { role: 'assistant', model: 'stub', content: [{ type: 'text', text: 'Hi! Ready when you are.' }], stop_reason: 'end_turn' } },
  ];
  await page.locator('text=Say hello').click().catch(() => {});
  await page.waitForTimeout(800);
  fs.writeFileSync(path.join(projDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  await page.waitForSelector('text=Your first session is live', { timeout: 40000 });
  await shot(page, 'session-live');
  await cont(page);

  await waitTitle(page, 'Your devices');
  await page.waitForTimeout(1500);
  await shot(page, 'devices');
  await cont(page);

  await waitTitle(page, 'Notifications');
  await page.locator('text=Allow notifications').click().catch(() => {});
  await page.waitForTimeout(500);
  await shot(page, 'notifications');
  await cont(page);

  await waitTitle(page, 'Herald');
  await page.locator('.sw-choice', { hasText: 'Claude (Anthropic API)' }).click();
  await page.fill('input[type=password]', 'sk-ant-api03-E2E-FAKE-KEY_0123456789abcdef');
  await shot(page, 'herald-anthropic');
  await page.locator('text=Save Herald settings').click();
  await page.waitForSelector('.sw-notice--ok, .sw-notice--error', { timeout: 10000 });
  const keyVisible = await page.evaluate(() => document.body.innerText.includes('E2E-FAKE-KEY'));
  if (keyVisible) throw new Error('API key echoed back in the page');
  await page.waitForTimeout(500);
  await shot(page, 'herald-saved');
  await cont(page);

  await waitTitle(page, 'Remote access');
  await page.waitForFunction(() => !document.body.innerText.includes('Looking for Tailscale'), null, { timeout: 15000 });
  await shot(page, 'remote');
  await cont(page);

  await waitTitle(page, 'Done');
  await shot(page, 'done');

  // Revisit a finished step from the rail, then come back.
  await page.locator('.sw-rail__item', { hasText: 'Name your server' }).click();
  await waitTitle(page, 'Name your server');
  await shot(page, 'revisit-name');
  await page.locator('.sw-rail__item', { hasText: 'Done' }).click();
  await waitTitle(page, 'Done');

  await page.locator('text=Finish setup').click();
  await page.waitForSelector('.sw-root', { state: 'detached', timeout: 15000 });
  await page.waitForTimeout(2500);
  await shot(page, 'dashboard-after');

  // Settings > Setup re-run: lands on the first unfinished step (or Done).
  const settingsBtn = page.locator('[title="Settings"], button:has-text("Settings")').first();
  if (await settingsBtn.count()) {
    await settingsBtn.click().catch(() => {});
    await page.waitForTimeout(1200);
    const run = page.locator('text=Run setup').first();
    if (await run.count()) {
      await shot(page, 'settings-setup');
      await run.click();
      await page.waitForSelector('.sw-root', { timeout: 10000 });
      await page.waitForTimeout(1500);
      await shot(page, 'rerun');
      log('re-run lands on:', await title(page));
      if ((await title(page)) !== 'Done') throw new Error('re-run should land on Done when every step is finished');
      await page.locator('.sw-rail__exit').click();
      await page.waitForSelector('.sw-root', { state: 'detached', timeout: 5000 });
    } else log('no Run setup button found');
  } else log('no settings button found');


  // ---- Part 2: a second device joins the finished server (device flow, code pairing).
  const LAN = process.env.LAN_HOST;
  const ctx2 = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });
  const p2 = await ctx2.newPage();
  await p2.goto(`http://${LAN}:${PORT}/web/`, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.sw-root', { timeout: 15000 });
  await cont(p2);
  await waitTitle(p2, 'Pair this device');
  await p2.waitForSelector('text=Pair with a code', { timeout: 10000 });
  if (await p2.locator('text=Pair this browser').count()) throw new Error('auto-pair offered to a LAN browser');
  await p2.fill('.sw-input', 'Pixel 9');
  await shot(p2, 'device2-pair');
  await p2.locator('text=Pair with a code').click();
  await p2.waitForSelector('.pairing-code-input', { timeout: 10000 });
  await p2.waitForTimeout(500);
  const logText = fs.readFileSync(process.env.DAEMON_LOG, 'utf8');
  const codes = [...logText.matchAll(/"Pixel 9" \(web, [^)]*\) wants to pair - code (\d{6})/g)];
  if (!codes.length) throw new Error('no pairing code in the daemon log');
  await shot(p2, 'device2-code');
  await p2.fill('.pairing-code-input', codes[codes.length - 1][1]);
  await p2.locator('.pairing-code button.btn-primary').click();
  await waitTitle(p2, 'Notifications', 20000);
  const rail = await p2.locator('.sw-rail__label').allTextContents();
  log('device flow rail:', rail.join(' > '));
  if (rail.includes('Name your server')) throw new Error('device flow should not show server steps');
  await shot(p2, 'device2-notifications');
  await cont(p2);
  await waitTitle(p2, 'Herald');
  await shot(p2, 'device2-herald');
  await cont(p2);
  await waitTitle(p2, 'This device is ready');
  await shot(p2, 'device2-done');
  await p2.locator('text=Start using Companion').click();
  await p2.waitForSelector('.sw-root', { state: 'detached', timeout: 10000 });
  await ctx2.close();

  log('page errors:', JSON.stringify(errors.filter((e) => !/favicon|WebSocket|ERR_CONNECTION/.test(e)).slice(0, 10)));
  await browser.close();
  log('OK');
})().catch(async (e) => {
  console.error('[e2e] FAILED', e);
  process.exit(1);
});
