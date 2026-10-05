#!/usr/bin/env node
/*
 * Writes dist/version.json: the app version every part of the daemon reports
 * (/health, mDNS TXT, pair_hello, get_capabilities, `companion --version`).
 *
 *   version = <major>.<minor>.<git commit count>
 *
 * The same scheme as the desktop / Android builds (desktop/scripts/
 * desktop-version.cjs): major.minor from package.json, patch = commit count.
 * Sources, in order:
 *   1. COMPANION_VERSION (x.y.z) - the Docker build passes it as a build arg,
 *      since the image's build context has no .git
 *   2. git rev-list --count HEAD
 *   3. package.json version (not a git checkout, e.g. an npm tarball)
 *
 * Run by `npm run build` after tsc. Usage: node scripts/write-version.js [--print]
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function resolveVersion(env, pkgVersion, countFn) {
  const fromEnv = String(env.COMPANION_VERSION || '').trim();
  if (VERSION_RE.test(fromEnv)) return { version: fromEnv, source: 'COMPANION_VERSION' };
  const [major = '1', minor = '0'] = String(pkgVersion || '1.0.0').split('.');
  let count = 0;
  try {
    count = countFn();
  } catch {
    count = 0;
  }
  if (Number.isInteger(count) && count > 0) return { version: `${major}.${minor}.${count}`, source: 'git' };
  return { version: String(pkgVersion || '0.0.0'), source: 'package.json' };
}

function gitCommitCount() {
  const out = execSync('git rev-list --count HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  return Number.parseInt(out, 10);
}

module.exports = { resolveVersion };

if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { version, source } = resolveVersion(process.env, pkg.version, gitCommitCount);
  if (process.argv.includes('--print')) {
    console.log(version);
    process.exit(0);
  }
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'dist', 'version.json'),
    JSON.stringify({ version, source, builtAt: new Date().toISOString() }, null, 2) + '\n'
  );
  console.log(`daemon version ${version} (${source})`);
}
