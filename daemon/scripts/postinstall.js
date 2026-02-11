#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

// Skip in CI or when explicitly disabled
if (process.env.CI || process.env.COMPANION_SKIP_POSTINSTALL) {
  process.exit(0);
}

function resolveUserHome() {
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && sudoUser !== 'root' && process.getuid && process.getuid() === 0) {
    try {
      if (os.platform() === 'darwin') {
        const out = execSync(`dscl . -read /Users/${sudoUser} NFSHomeDirectory`, { encoding: 'utf-8' });
        const home = out.trim().split(':').pop().trim();
        return { home, user: sudoUser };
      } else {
        const line = execSync(`getent passwd ${sudoUser}`, { encoding: 'utf-8' }).trim();
        const home = line.split(':')[5];
        return { home, user: sudoUser };
      }
    } catch {
      // fallback to os.homedir()
    }
  }
  return { home: os.homedir(), user: os.userInfo().username };
}

function setupConfig(homeDir) {
  const configDir = path.join(homeDir, '.companion');
  const configPath = path.join(configDir, 'config.json');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'certs'), { recursive: true, mode: 0o700 });

  if (fs.existsSync(configPath)) {
    console.log('  Existing config found, preserving configuration.');
    try {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return { token: existing.token || '', isNew: false, port: existing.port || 9877 };
    } catch {
      // corrupted config, regenerate
    }
  }

  const token = crypto.randomBytes(32).toString('hex');

  const config = {
    port: 9877,
    token: token,
    tls: false,
    tmux_session: 'main',
    code_home: path.join(homeDir, '.claude'),
    mdns_enabled: true,
    push_delay_ms: 60000
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('  Config created at ~/.companion/config.json');

  return { token, isNew: true, port: 9877 };
}

function fixOwnership(targetPath, user) {
  if (process.getuid && process.getuid() === 0 && user !== 'root') {
    try {
      execSync(`chown -R ${user} "${targetPath}"`, { stdio: 'ignore' });
    } catch { /* best effort */ }
  }
}

function main() {
  console.log('');
  console.log('  Setting up Companion...');

  const { home, user } = resolveUserHome();
  const { token, isNew, port } = setupConfig(home);
  fixOwnership(path.join(home, '.companion'), user);

  console.log('');
  console.log('  ========================================');
  console.log('  Companion installed successfully!');
  console.log('  ========================================');
  console.log('');
  if (isNew) {
    console.log('  Your authentication token:');
    console.log(`    ${token}`);
    console.log('');
    console.log('  Save this token -- you need it to connect from the app.');
  } else {
    console.log('  Existing configuration preserved.');
    if (token) {
      console.log(`  Token: ${token.slice(0, 8)}...${token.slice(-4)}`);
    }
  }
  console.log('');
  console.log('  Next steps:');
  console.log('    companion setup             Review configuration');
  console.log('    companion start             Start the daemon');
  console.log('    companion autostart enable  Auto-start on login');
  console.log('');
  console.log(`  Web client: http://localhost:${port}/web (after starting)`);
  console.log('  Config:     ~/.companion/config.json');
  console.log('');
}

try {
  main();
} catch (err) {
  // Never fail the npm install
  console.log('');
  console.log('  Note: Automatic setup did not complete.');
  console.log(`  Error: ${err.message || err}`);
  console.log('  You can set up manually by running: companion setup');
  console.log('');
}
