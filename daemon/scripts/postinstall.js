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
      return { configDir, configPath, token: existing.token || '', isNew: false, port: existing.port || 9877 };
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

  return { configDir, configPath, token, isNew: true, port: 9877 };
}

function fixOwnership(targetPath, user) {
  if (process.getuid && process.getuid() === 0 && user !== 'root') {
    try {
      execSync(`chown -R ${user} "${targetPath}"`, { stdio: 'ignore' });
    } catch { /* best effort */ }
  }
}

function setupLaunchd(nodeExecPath, daemonScript, homeDir) {
  const plistDir = path.join(homeDir, 'Library', 'LaunchAgents');
  const plistPath = path.join(plistDir, 'com.companion.daemon.plist');

  fs.mkdirSync(plistDir, { recursive: true });

  const workDir = path.dirname(daemonScript);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.companion.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeExecPath}</string>
        <string>${daemonScript}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${homeDir}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${workDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${homeDir}/Library/Logs/companion.log</string>
    <key>StandardErrorPath</key>
    <string>${homeDir}/Library/Logs/companion.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);

  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' });
  } catch { /* may not be loaded */ }

  try {
    if (process.getuid && process.getuid() === 0 && process.env.SUDO_USER) {
      const uid = execSync(`id -u ${process.env.SUDO_USER}`, { encoding: 'utf-8' }).trim();
      execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`, { stdio: 'ignore' });
    } else {
      execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function setupSystemd(nodeExecPath, daemonScript, homeDir, user) {
  const isRoot = process.getuid && process.getuid() === 0;
  const realUser = process.env.SUDO_USER || user;

  const unitContent = `[Unit]
Description=Companion Daemon - Claude Code session monitor
After=network.target

[Service]
Type=simple
ExecStart=${nodeExecPath} ${daemonScript}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;

  const userServiceDir = path.join(homeDir, '.config', 'systemd', 'user');
  const servicePath = path.join(userServiceDir, 'companion.service');
  fs.mkdirSync(userServiceDir, { recursive: true });
  fs.writeFileSync(servicePath, unitContent);

  if (isRoot && realUser !== 'root') {
    try {
      execSync(`chown -R ${realUser} "${path.join(homeDir, '.config', 'systemd')}"`, { stdio: 'ignore' });
      const uid = execSync(`id -u ${realUser}`, { encoding: 'utf-8' }).trim();
      const runtimeDir = `/run/user/${uid}`;
      const env = `XDG_RUNTIME_DIR=${runtimeDir}`;
      execSync(`sudo -u ${realUser} ${env} systemctl --user daemon-reload`, { stdio: 'ignore' });
      execSync(`sudo -u ${realUser} ${env} systemctl --user enable companion`, { stdio: 'ignore' });
      execSync(`sudo -u ${realUser} ${env} systemctl --user start companion`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  } else {
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
      execSync('systemctl --user enable companion', { stdio: 'ignore' });
      execSync('systemctl --user start companion', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

function printSuccess(token, isNew, port, serviceStarted) {
  console.log('');
  console.log('  ========================================');
  console.log('  Companion daemon installed successfully!');
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
  console.log(`  WebSocket:  ws://localhost:${port}`);
  console.log(`  Web client: http://localhost:${port}/web`);
  console.log(`  Config:     ~/.companion/config.json`);
  console.log('');
  if (serviceStarted) {
    console.log('  The daemon is running and will auto-start on login.');
  } else {
    console.log('  To start the daemon:');
    console.log('    companion start');
  }
  console.log('');
  console.log('  Commands:');
  console.log('    companion status    Check daemon status');
  console.log('    companion config    View configuration');
  console.log('    companion logs      View daemon logs');
  console.log('    companion stop      Stop the daemon');
  console.log('');
}

function main() {
  console.log('');
  console.log('  Setting up Companion daemon...');

  const { home, user } = resolveUserHome();
  const { configDir, token, isNew, port } = setupConfig(home);
  fixOwnership(configDir, user);

  const nodeExecPath = process.execPath;
  const daemonScript = path.resolve(__dirname, '..', 'dist', 'index.js');

  let serviceStarted = false;
  const platform = os.platform();

  if (platform === 'darwin') {
    serviceStarted = setupLaunchd(nodeExecPath, daemonScript, home);
    if (serviceStarted) {
      fixOwnership(path.join(home, 'Library', 'LaunchAgents', 'com.companion.daemon.plist'), user);
    }
  } else if (platform === 'linux') {
    serviceStarted = setupSystemd(nodeExecPath, daemonScript, home, user);
  }

  printSuccess(token, isNew, port, serviceStarted);
}

try {
  main();
} catch (err) {
  // Never fail the npm install
  console.log('');
  console.log('  Note: Automatic setup did not complete.');
  console.log(`  Error: ${err.message || err}`);
  console.log('  You can set up manually by running: companion start');
  console.log('');
}
