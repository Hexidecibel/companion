/* Setup wizard E2E against the Docker image (run through bin/e2e-docker): a
 * fresh container behind Docker's port mapping, so the first device pairs with
 * the code from `docker compose logs`. Checks the container-aware steps and
 * screenshots them. Env: PORT, OUT, LOGS_CMD (prints the companion log),
 * INSTALL_CLAUDE=1 (click "Install Claude Code" and wait), PLAYWRIGHT_CORE, CHROME. */
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 9744);
const BASE = `http://localhost:${PORT}/web/`;
const OUT = process.env.OUT;
fs.mkdirSync(OUT, { recursive: true });
const DESKTOP = { width: 1366, height: 900 };
const MOBILE = { width: 390, height: 844 };
let n = 0;
const log = (...a) => console.log('[e2e-docker]', ...a);

async function shot(page, name, mobile = true) {
  n++;
  const base = `${String(n).padStart(2, '0')}-${name}`;
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `${base}-desktop.png`) });
  if (mobile) {
    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `${base}-mobile.png`) });
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(250);
  }
  log('shot', base);
}
const text = (page) => page.evaluate(() => document.body.innerText);
async function expectText(page, s) {
  const t = await text(page);
  if (!t.includes(s)) throw new Error(`expected page to show: ${s}`);
}
async function expectNoText(page, s) {
  if ((await text(page)).includes(s)) throw new Error(`page should not show: ${s}`);
}
async function waitTitle(page, t, timeout = 15000) {
  await page.waitForFunction((x) => document.querySelector('.sw-head__title')?.textContent?.trim() === x, t, { timeout });
}
async function next(page) {
  await page.locator('.sw-foot .sw-btn--primary').click();
  await page.waitForTimeout(700);
}
async function skip(page) {
  await page.locator('.sw-foot button', { hasText: 'Skip' }).click();
  await page.waitForTimeout(700);
}
const checksSettled = (page) =>
  page.waitForFunction(() => document.querySelector('.sw-check') && !document.querySelector('.sw-checks .sw-status--pending'), null, {
    timeout: 30000,
  });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sw-root', { timeout: 15000 });
  await waitTitle(page, 'Welcome');
  await next(page);

  // Pair: no one-click pairing through the port mapping; the code comes from the log.
  await waitTitle(page, 'Pair this device');
  await page.waitForSelector('text=Pair with a code', { timeout: 10000 });
  if (await page.locator('text=Pair this browser').count()) throw new Error('auto-pair offered through Docker port mapping');
  await expectText(page, 'docker compose logs companion');
  await expectText(page, 'Companion runs in Docker here');
  await page.fill('.sw-input', 'Test laptop');
  await shot(page, 'pair-docker');
  await page.locator('text=Pair with a code').click();
  await page.waitForSelector('.pairing-code-input', { timeout: 10000 });
  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    await page.waitForTimeout(500);
    const logs = execSync(process.env.LOGS_CMD, { encoding: 'utf8' });
    const m = [...logs.matchAll(/"Test laptop" \(web, [^)]*\) wants to pair - code (\d{6})/g)];
    if (m.length) code = m[m.length - 1][1];
    if (code && !/PAIRING CODE: {2}\d{3} \d{3}/.test(logs)) throw new Error('no pairing banner in the container log');
  }
  if (!code) throw new Error('no pairing code in docker compose logs');
  log('pairing code from logs:', code);
  await shot(page, 'pair-code-entry', false);
  await page.fill('.pairing-code-input', code);
  await page.locator('.pairing-code button.btn-primary').click();

  await waitTitle(page, 'Name your server', 20000);
  await page.waitForFunction(() => (document.querySelector('.sw-input--lg')?.value || '').length > 0, null, { timeout: 10000 });
  await next(page);

  // Machine: compose replaces the service step; claude points at setup-claude.
  await waitTitle(page, 'Check your machine');
  await checksSettled(page);
  await expectText(page, 'Docker restarts it (restart: unless-stopped)');
  await expectText(page, 'Running in Docker: tmux, git and Node are part of the image');
  await expectNoText(page, 'Start Companion on boot');
  await expectText(page, 'docker compose --profile tailscale up -d');
  await expectText(page, 'docker compose --profile voice up -d');
  await shot(page, 'machine-docker');
  await next(page);

  await waitTitle(page, 'Claude Code');
  await checksSettled(page);
  const installed = (await text(page)).includes('Signed in') || !(await page.locator('text=Install Claude Code').count());
  if (!installed) {
    await expectText(page, 'docker compose run --rm companion setup-claude');
    await shot(page, 'claude-install-docker');
    if (process.env.INSTALL_CLAUDE === '1') {
      const t0 = Date.now();
      await page.locator('.sw-panel button', { hasText: 'Install Claude Code' }).click();
      // Success re-runs the checks, which swaps the install panel for the sign-in one.
      await page.waitForSelector('text=/Sign in to Claude Code|did not finish/', { timeout: 330000 });
      log(`wizard install took ${Math.round((Date.now() - t0) / 1000)} s`);
      await expectText(page, 'Sign in to Claude Code');
      await expectText(page, 'docker compose exec companion claude');
    }
  }
  await shot(page, 'claude-login-docker');
  await next(page);

  // Projects: the picker is rooted at the projects mount.
  await waitTitle(page, 'Projects');
  await page.waitForSelector('.sw-browser__item', { timeout: 10000 });
  await expectText(page, 'Running in Docker: your code is the folder mounted at');
  const pathShown = await page.locator('.sw-browser__path').textContent();
  if (!/projects$/.test(pathShown.trim())) throw new Error(`picker should start at the projects mount, got ${pathShown}`);
  if (await page.locator('.sw-browser__bar button', { hasText: 'Up' }).isEnabled()) throw new Error('picker must not go above the projects mount');
  await page.locator('text=Add this folder').click();
  await page.waitForSelector('.sw-chip', { timeout: 5000 });
  await shot(page, 'projects-docker');
  await next(page);

  await waitTitle(page, 'First session');
  await page.waitForSelector('.sw-browser__item', { timeout: 10000 });
  await page.locator('.sw-browser__item', { hasText: 'demo-app' }).click();
  await page.waitForFunction(() => document.querySelector('.sw-browser__path')?.textContent?.endsWith('demo-app'), null, { timeout: 10000 });
  await page.locator('text=Use this folder').click();
  await page.locator('text=Start session').click();
  await page.waitForSelector('.sw-timeline', { timeout: 30000 });
  await page.waitForTimeout(6000);
  await expectText(page, 'docker compose exec companion tmux attach -t');
  await shot(page, 'session-docker');
  await skip(page);

  await waitTitle(page, 'Your devices');
  await page.waitForFunction(() => !document.body.innerText.includes('Reading the update feed'), null, { timeout: 15000 });
  await expectText(page, 'Nearby discovery does not cross Docker');
  await shot(page, 'devices-docker');
  await skip(page);

  await waitTitle(page, 'Notifications');
  await skip(page);

  await waitTitle(page, 'Herald');
  await page.waitForTimeout(1500);
  await expectText(page, 'docker compose --profile voice up -d');
  await expectNoText(page, 'Run the voice service on boot');
  await shot(page, 'herald-docker');
  await skip(page);

  await waitTitle(page, 'Remote access');
  await page.waitForFunction(() => !document.body.innerText.includes('Asking the Tailscale sidecar'), null, { timeout: 15000 });
  await expectText(page, 'TS_AUTHKEY');
  await shot(page, 'remote-docker');
  await skip(page);

  await waitTitle(page, 'Done');
  await shot(page, 'done-docker');
  await page.locator('text=Finish setup').click();
  await page.waitForSelector('.sw-root', { state: 'detached', timeout: 15000 });
  await page.waitForTimeout(2000);
  await shot(page, 'dashboard-after', false);

  const real = errors.filter((e) => !/favicon|WebSocket|ERR_CONNECTION/.test(e));
  log('page errors:', JSON.stringify(real.slice(0, 10)));
  await browser.close();
  log('OK');
})().catch((e) => {
  console.error('[e2e-docker] FAILED', e);
  process.exit(1);
});
