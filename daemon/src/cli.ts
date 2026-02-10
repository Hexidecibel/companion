#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { execSync } from 'child_process';
import { loadConfig, saveConfig } from './config';
import { DaemonConfig } from './types';

const HOME_DIR = process.env.HOME || os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.companion');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');

// ANSI colors
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function printHelp(): void {
  console.log(`
${bold('companion')} - Daemon for monitoring Claude Code sessions

${bold('USAGE')}
  companion [command] [options]

${bold('COMMANDS')}
  start               Start the daemon (default if no command given)
  stop                Stop a running daemon
  restart             Restart the daemon (via systemctl)
  status              Show daemon status
  setup               First-time setup (creates config, prints connection info)
  autostart enable    Install as a system service (systemd / launchd)
  autostart disable   Remove the system service
  config              View or modify configuration
  token               Generate a new authentication token
  logs                Show recent daemon logs
  help                Show this help message

${bold('OPTIONS')}
  --help, -h     Show help
  --version, -v  Show version

${bold('CONFIG SUBCOMMANDS')}
  config              Show current configuration
  config set KEY VAL  Set a config value (e.g. config set port 9877)
  config path         Show config file path

${bold('EXAMPLES')}
  companion                    Start the daemon
  companion setup              First-time setup
  companion autostart enable   Install as a system service
  companion stop               Stop the daemon
  companion restart            Restart the daemon
  companion status             Check if daemon is running
  companion config             Show configuration
  companion config set port 8080
  companion token              Generate new auth token
  companion logs               Show recent logs
`);
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version || '0.0.1';
  } catch {
    return '0.0.1';
  }
}

function getDaemonPid(): number | null {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;

    // Check if process is still running
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process not running, clean up stale PID file
      fs.unlinkSync(PID_FILE);
      return null;
    }
  } catch {
    return null;
  }
}

export function writePidFile(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

export function removePidFile(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Ignore
  }
}

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

async function cmdStatus(): Promise<void> {
  const pid = getDaemonPid();
  let config: DaemonConfig | null = null;

  try {
    config = loadConfig();
  } catch {
    // Config may not exist yet
  }

  const port = config?.port || 9877;
  const listening = await isPortListening(port);

  console.log(bold('Companion Daemon Status'));
  console.log('─'.repeat(40));

  if (pid) {
    console.log(`  Process:  ${green('running')} (PID ${pid})`);
  } else {
    console.log(`  Process:  ${red('not running')}`);
  }

  if (listening) {
    console.log(`  Port:     ${green(`${port} (listening)`)}`);
  } else {
    console.log(`  Port:     ${dim(`${port} (not listening)`)}`);
  }

  const configPath = process.env.CONFIG_PATH || path.join(CONFIG_DIR, 'config.json');
  console.log(`  Config:   ${fs.existsSync(configPath) ? configPath : dim('not found')}`);
  console.log(`  PID file: ${fs.existsSync(PID_FILE) ? PID_FILE : dim('not found')}`);

  if (config) {
    console.log(`  TLS:      ${config.tls ? green('enabled') : dim('disabled')}`);
    console.log(`  mDNS:     ${config.mdnsEnabled ? green('enabled') : dim('disabled')}`);
  }

  // Check tmux sessions
  try {
    const tmuxOutput = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
    }).trim();
    const sessions = tmuxOutput.split('\n').filter(Boolean);
    if (sessions.length > 0) {
      console.log(
        `  Tmux:     ${green(`${sessions.length} session(s)`)} ${dim(`(${sessions.join(', ')})`)}`
      );
    } else {
      console.log(`  Tmux:     ${dim('no sessions')}`);
    }
  } catch {
    console.log(`  Tmux:     ${dim('not available')}`);
  }

  console.log('');
}

function cmdStop(): void {
  const pid = getDaemonPid();

  if (!pid) {
    console.log(yellow('Daemon is not running (no PID file found)'));

    // Try to find by process name
    try {
      const result = execSync('pgrep -f "node.*dist/index" 2>/dev/null', {
        encoding: 'utf-8',
      }).trim();
      if (result) {
        const pids = result.split('\n').filter((p) => p !== String(process.pid));
        if (pids.length > 0) {
          console.log(`Found daemon process(es): ${pids.join(', ')}`);
          for (const p of pids) {
            process.kill(parseInt(p, 10), 'SIGTERM');
          }
          console.log(green('Sent SIGTERM to daemon process(es)'));
        }
      }
    } catch {
      // No process found
    }
    return;
  }

  console.log(`Stopping daemon (PID ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
    removePidFile();
    console.log(green('Daemon stopped'));
  } catch (err) {
    console.error(red(`Failed to stop daemon: ${err}`));
  }
}

function cmdConfig(args: string[]): void {
  const subcommand = args[0];

  if (subcommand === 'path') {
    const configPath = process.env.CONFIG_PATH || path.join(CONFIG_DIR, 'config.json');
    console.log(configPath);
    return;
  }

  if (subcommand === 'set') {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) {
      console.error(red('Usage: companion config set KEY VALUE'));
      console.error(
        '  Keys: port, token, tls, tmux_session, code_home, mdns_enabled, push_delay_ms'
      );
      process.exit(1);
    }

    let config: DaemonConfig;
    try {
      config = loadConfig();
    } catch {
      console.error(red('Cannot load config. Run "companion install" first.'));
      process.exit(1);
    }

    // Map CLI key names to config properties
    const keyMap: Record<string, keyof DaemonConfig> = {
      port: 'port',
      token: 'token',
      tls: 'tls',
      tmux_session: 'tmuxSession',
      code_home: 'codeHome',
      mdns_enabled: 'mdnsEnabled',
      push_delay_ms: 'pushDelayMs',
    };

    const configKey = keyMap[key];
    if (!configKey) {
      console.error(red(`Unknown config key: ${key}`));
      console.error('  Valid keys: ' + Object.keys(keyMap).join(', '));
      process.exit(1);
    }

    // Parse value based on type
    let parsedValue: string | number | boolean = value;
    if (value === 'true') parsedValue = true;
    else if (value === 'false') parsedValue = false;
    else if (/^\d+$/.test(value)) parsedValue = parseInt(value, 10);

    (config as unknown as Record<string, unknown>)[configKey] = parsedValue;
    saveConfig(config);
    console.log(green(`Set ${key} = ${value}`));
    return;
  }

  // Default: show config
  let config: DaemonConfig;
  try {
    config = loadConfig();
  } catch {
    console.error(red('Cannot load config. Run "companion install" first.'));
    process.exit(1);
  }

  console.log(bold('Companion Configuration'));
  console.log('─'.repeat(40));
  console.log(`  listeners:`);
  for (const listener of config.listeners) {
    const tokenPreview = listener.token.slice(0, 8) + '...' + listener.token.slice(-4);
    console.log(
      `    - port: ${listener.port}, token: ${dim(tokenPreview)}, tls: ${listener.tls || false}`
    );
  }
  console.log(`  tmux_session:    ${config.tmuxSession}`);
  console.log(`  code_home:       ${config.codeHome}`);
  console.log(`  mdns_enabled:    ${config.mdnsEnabled}`);
  console.log(`  push_delay_ms:   ${config.pushDelayMs}`);
  if (config.autoApproveTools?.length > 0) {
    console.log(`  auto_approve:    ${config.autoApproveTools.join(', ')}`);
  }
  console.log('');
  console.log(
    dim(`Config file: ${process.env.CONFIG_PATH || path.join(CONFIG_DIR, 'config.json')}`)
  );
}

async function cmdSetup(): Promise<void> {
  const { displayFirstRunWelcome } = await import('./config');

  // loadConfig auto-creates ~/.companion/config.json with a generated token on first run
  const config = loadConfig();
  const configPath = process.env.CONFIG_PATH || path.join(CONFIG_DIR, 'config.json');

  await displayFirstRunWelcome(config, configPath);

  // Check for tmux
  try {
    execSync('which tmux', { stdio: 'ignore' });
  } catch {
    console.log(yellow('  Warning: tmux is not installed.'));
    console.log(dim('  The daemon needs tmux to interact with coding sessions.'));
    console.log(dim('  Install it: sudo apt install tmux  (Debian/Ubuntu)'));
    console.log(dim('              brew install tmux       (macOS)'));
    console.log('');
  }

  console.log(dim('Next steps:'));
  console.log(dim('  companion start              Start the daemon'));
  console.log(dim('  companion autostart enable   Install as a system service'));
  console.log('');
}

function cmdAutostart(args: string[]): void {
  const subcommand = args[0];
  const platform = os.platform();

  if (subcommand === 'enable') {
    cmdAutostartEnable(platform);
  } else if (subcommand === 'disable') {
    cmdAutostartDisable(platform);
  } else {
    console.error(red('Usage: companion autostart <enable|disable>'));
    process.exit(1);
  }
}

function cmdAutostartEnable(platform: string): void {
  // Find the daemon entry point (resolve from __dirname which is daemon/dist/)
  const daemonEntry = path.resolve(__dirname, 'index.js');
  const nodePath = process.execPath;

  if (platform === 'darwin') {
    const plistDir = path.join(HOME_DIR, 'Library', 'LaunchAgents');
    const plistPath = path.join(plistDir, 'com.companion.daemon.plist');
    const logPath = path.join(HOME_DIR, 'Library', 'Logs', 'companion.log');

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.companion.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${daemonEntry}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>`;

    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plistPath, plist);

    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
      console.log(green('Autostart enabled (launchd)'));
      console.log(dim(`  Plist: ${plistPath}`));
      console.log(dim(`  Logs:  ${logPath}`));
    } catch {
      console.error(red('Failed to load launchd plist'));
      console.log(dim(`Plist written to: ${plistPath}`));
      console.log(dim('Try manually: launchctl load ' + plistPath));
    }
  } else {
    // Linux: systemd user service
    const serviceDir = path.join(HOME_DIR, '.config', 'systemd', 'user');
    const servicePath = path.join(serviceDir, 'companion.service');

    const unit = `[Unit]
Description=Companion Daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${daemonEntry}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(servicePath, unit);

    try {
      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
      execSync('systemctl --user enable --now companion', { stdio: 'inherit' });
      console.log(green('Autostart enabled (systemd user service)'));
      console.log(dim(`  Unit: ${servicePath}`));
      console.log(dim('  Logs: journalctl --user -u companion -f'));
    } catch {
      console.error(red('Failed to enable systemd service'));
      console.log(dim(`Unit file written to: ${servicePath}`));
      console.log(dim('Try manually:'));
      console.log(dim('  systemctl --user daemon-reload'));
      console.log(dim('  systemctl --user enable --now companion'));
    }
  }
}

function cmdAutostartDisable(platform: string): void {
  if (platform === 'darwin') {
    const plistPath = path.join(HOME_DIR, 'Library', 'LaunchAgents', 'com.companion.daemon.plist');

    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'inherit' });
    } catch {
      // May already be unloaded
    }

    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
    }

    console.log(green('Autostart disabled (launchd)'));
    console.log(dim('Service stopped and plist removed.'));
  } else {
    // Linux: systemd user service
    const servicePath = path.join(HOME_DIR, '.config', 'systemd', 'user', 'companion.service');

    try {
      execSync('systemctl --user disable --now companion 2>/dev/null', { stdio: 'inherit' });
    } catch {
      // May already be disabled
    }

    if (fs.existsSync(servicePath)) {
      fs.unlinkSync(servicePath);
    }

    try {
      execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    } catch {
      // Best effort
    }

    console.log(green('Autostart disabled (systemd)'));
    console.log(dim('Service stopped and unit file removed.'));
  }
}

function cmdInstall(): void {
  console.log(yellow('The "install" command is deprecated.'));
  console.log('');
  console.log('Use these commands instead:');
  console.log(`  ${bold('companion setup')}              Create config and show connection info`);
  console.log(`  ${bold('companion autostart enable')}   Install as a system service`);
  console.log('');
}

function cmdLogs(): void {
  const platform = os.platform();

  if (platform === 'darwin') {
    const logPath = path.join(HOME_DIR, 'Library', 'Logs', 'companion.log');
    if (fs.existsSync(logPath)) {
      try {
        execSync(`tail -50 "${logPath}"`, { stdio: 'inherit' });
      } catch {
        console.error(red('Failed to read log file'));
      }
    } else {
      // Try /tmp/daemon.log (dev mode)
      const devLog = '/tmp/daemon.log';
      if (fs.existsSync(devLog)) {
        try {
          execSync(`tail -50 "${devLog}"`, { stdio: 'inherit' });
        } catch {
          console.error(red('Failed to read log file'));
        }
      } else {
        console.log(dim('No log file found'));
        console.log(dim(`Checked: ${logPath}`));
        console.log(dim(`Checked: ${devLog}`));
      }
    }
  } else {
    // Linux: try journalctl first
    try {
      execSync(
        'journalctl --user -u companion --no-pager -n 50 2>/dev/null || journalctl -u companion --no-pager -n 50 2>/dev/null',
        {
          stdio: 'inherit',
        }
      );
    } catch {
      console.log(dim('No logs found via journalctl'));
      console.log(dim('If running manually, check your terminal output'));
    }
  }
}

function cmdRestart(): void {
  const platform = os.platform();

  console.log('Restarting companion daemon...');

  if (platform === 'darwin') {
    try {
      execSync('launchctl kickstart -k gui/$(id -u)/com.companion.daemon', { stdio: 'inherit' });
      console.log(green('Daemon restarted'));
    } catch {
      console.error(red('Failed to restart via launchctl'));
      console.log('Try: launchctl unload ~/Library/LaunchAgents/com.companion.daemon.plist');
      console.log('     launchctl load ~/Library/LaunchAgents/com.companion.daemon.plist');
    }
  } else {
    // Linux: try user systemctl first, then system
    try {
      execSync('systemctl --user restart companion', { stdio: 'inherit' });
      console.log(green('Daemon restarted'));
    } catch {
      try {
        execSync('sudo systemctl restart companion', { stdio: 'inherit' });
        console.log(green('Daemon restarted (system service)'));
      } catch {
        console.error(red('Failed to restart via systemctl'));
        console.log('Try manually: systemctl --user restart companion');
      }
    }
  }
}

function cmdToken(): void {
  const crypto = require('crypto');

  let config: DaemonConfig;
  try {
    config = loadConfig();
  } catch {
    console.error(red('Cannot load config. Run "companion install" first.'));
    process.exit(1);
  }

  const newToken = crypto.randomBytes(16).toString('hex');

  // Update all listeners with the new token
  for (const listener of config.listeners) {
    listener.token = newToken;
  }

  saveConfig(config);

  console.log(bold('New authentication token generated'));
  console.log('─'.repeat(40));
  console.log('');
  console.log(`  ${yellow(newToken)}`);
  console.log('');
  console.log(dim('Token saved to config. Restart daemon to apply:'));
  console.log(dim('  companion restart'));
  console.log('');
}

/**
 * Parse CLI arguments and dispatch to the appropriate command.
 * Returns true if a command was handled, false if the daemon should start.
 */
export async function dispatchCli(args: string[]): Promise<boolean> {
  const command = args[0];

  // No args or "start" — run the daemon
  if (!command || command === 'start') {
    return false;
  }

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return true;

    case '--version':
    case '-v':
      console.log(`companion v${getVersion()}`);
      return true;

    case 'status':
      await cmdStatus();
      return true;

    case 'stop':
      cmdStop();
      return true;

    case 'restart':
      cmdRestart();
      return true;

    case 'token':
      cmdToken();
      return true;

    case 'setup':
      await cmdSetup();
      return true;

    case 'autostart':
      cmdAutostart(args.slice(1));
      return true;

    case 'config':
      cmdConfig(args.slice(1));
      return true;

    case 'install':
      cmdInstall();
      return true;

    case 'logs':
      cmdLogs();
      return true;

    default:
      console.error(red(`Unknown command: ${command}`));
      console.error(`Run ${bold('companion help')} for usage information`);
      process.exit(1);
  }
}
