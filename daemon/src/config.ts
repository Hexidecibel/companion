import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import QRCode from 'qrcode';
import { DaemonConfig, ListenerConfig } from './types';

const HOME_DIR = process.env.HOME || '/root';
const CONFIG_DIR = path.join(HOME_DIR, '.companion');

/**
 * Generate a random authentication token
 */
function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Get the server's local IP address (non-loopback)
 */
function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const netInterface = interfaces[name];
    if (!netInterface) continue;
    for (const iface of netInterface) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

/**
 * Display welcome message with QR code for first-run setup
 */
export async function displayFirstRunWelcome(
  config: DaemonConfig,
  configPath: string
): Promise<void> {
  const listener = config.listeners[0];
  const localIP = getLocalIP();

  const qrData = JSON.stringify({
    host: localIP,
    port: listener.port,
    token: listener.token,
    tls: listener.tls || false,
  });

  let qrString = '';
  try {
    qrString = await QRCode.toString(qrData, { type: 'terminal', small: true });
  } catch {
    // QR generation failed, skip it
  }

  console.log('');
  console.log('═'.repeat(50));
  console.log('  Welcome to Companion!');
  console.log('═'.repeat(50));
  console.log('');

  if (qrString) {
    console.log('  Scan this QR code with the Companion app:');
    console.log('');
    console.log(qrString);
  }

  console.log('  Your authentication token:');
  console.log('');
  console.log(`    ${listener.token}`);
  console.log('');
  const serverUrl = `http://${localIP}:${listener.port}`;
  // OSC 8 hyperlink escape sequence for clickable terminal links
  const clickableUrl = `\x1b]8;;${serverUrl}\x07${serverUrl}\x1b]8;;\x07`;
  console.log(`  Server: ${clickableUrl}`);
  console.log('');
  console.log(`  Config: ${configPath}`);
  console.log('  Edit this file to change settings.');
  console.log('');
  console.log('═'.repeat(50));
  console.log('');
}

// Safe tools that can be auto-approved without user confirmation
const DEFAULT_AUTO_APPROVE_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];

const DEFAULT_CONFIG: Omit<DaemonConfig, 'listeners'> & { listeners?: ListenerConfig[] } = {
  port: 9877,
  token: '',
  tls: false,
  certPath: path.join(CONFIG_DIR, 'certs', 'cert.pem'),
  keyPath: path.join(CONFIG_DIR, 'certs', 'key.pem'),
  tmuxSession: 'main',
  codeHome: path.join(HOME_DIR, '.claude'),
  mdnsEnabled: true,
  pushDelayMs: 60000, // 1 minute
  autoApproveTools: DEFAULT_AUTO_APPROVE_TOOLS,
  git: true,
};

export function loadConfig(): DaemonConfig {
  const configPath = process.env.CONFIG_PATH || path.join(CONFIG_DIR, 'config.json');

  let fileConfig: Partial<DaemonConfig> & { listeners?: ListenerConfig[] } = {};
  let parsedListeners: ListenerConfig[] | undefined;

  let isFirstRun = false;

  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);

      // Check for new multi-listener format
      if (parsed.listeners && Array.isArray(parsed.listeners)) {
        parsedListeners = parsed.listeners.map((l: any) => ({
          port: l.port,
          token: l.token,
          tls: l.tls,
          certPath: l.cert_path,
          keyPath: l.key_path,
        }));
      }

      // Map snake_case from config file to camelCase
      fileConfig = {
        port: parsed.port,
        token: parsed.token,
        tls: parsed.tls,
        certPath: parsed.cert_path,
        keyPath: parsed.key_path,
        tmuxSession: parsed.tmux_session,
        codeHome: parsed.code_home || parsed.claude_home,
        mdnsEnabled: parsed.mdns_enabled,
        fcmCredentialsPath: parsed.fcm_credentials_path,
        pushDelayMs: parsed.push_delay_ms,
        autoApproveTools: parsed.auto_approve_tools,
        git: parsed.git,
        anthropicAdminApiKey: parsed.anthropic_admin_api_key,
      };
    } catch (err) {
      console.error(`Error loading config from ${configPath}:`, err);
    }
  } else {
    // First run - generate config with random token
    isFirstRun = true;
    const newToken = generateToken();
    fileConfig = {
      port: DEFAULT_CONFIG.port,
      token: newToken,
      tls: DEFAULT_CONFIG.tls,
    };
  }

  // Merge with defaults
  const config: DaemonConfig = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(fileConfig).filter(([_, v]) => v !== undefined)),
    listeners: [], // Will be set below
  } as DaemonConfig;

  // Build listeners array
  if (parsedListeners && parsedListeners.length > 0) {
    // New format: use listeners array directly
    config.listeners = parsedListeners;
  } else if (config.port && config.token) {
    // Legacy format: convert single port/token to listeners array
    config.listeners = [
      {
        port: config.port,
        token: config.token,
        tls: config.tls,
        certPath: config.certPath,
        keyPath: config.keyPath,
      },
    ];
  }

  // First run: save generated config (welcome message displayed separately)
  if (isFirstRun && config.listeners.length > 0) {
    // Ensure config directory exists
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    saveConfig(config);
    // Mark for welcome display
    (config as DaemonConfig & { _isFirstRun?: boolean; _configPath?: string })._isFirstRun = true;
    (config as DaemonConfig & { _isFirstRun?: boolean; _configPath?: string })._configPath =
      configPath;
  }

  // Validate: must have at least one listener with port and token
  if (config.listeners.length === 0) {
    console.error('Error: No listeners configured');
    console.error('Please set port/token or listeners[] in the config file');
    process.exit(1);
  }

  for (let i = 0; i < config.listeners.length; i++) {
    const listener = config.listeners[i];
    if (!listener.port) {
      console.error(`Error: Listener ${i} missing port`);
      process.exit(1);
    }
    if (!listener.token) {
      console.error(`Error: Listener ${i} (port ${listener.port}) missing token`);
      process.exit(1);
    }
  }

  return config;
}

export function saveConfig(config: DaemonConfig): void {
  const configPath = process.env.CONFIG_PATH || path.join(CONFIG_DIR, 'config.json');

  // Convert to snake_case for file
  // Use new listeners format if we have multiple listeners
  const fileConfig: Record<string, unknown> = {
    tmux_session: config.tmuxSession,
    code_home: config.codeHome,
    mdns_enabled: config.mdnsEnabled,
    fcm_credentials_path: config.fcmCredentialsPath,
    push_delay_ms: config.pushDelayMs,
  };

  if (config.listeners.length === 1) {
    // Single listener: use legacy format for backward compatibility
    const listener = config.listeners[0];
    fileConfig.port = listener.port;
    fileConfig.token = listener.token;
    fileConfig.tls = listener.tls;
    fileConfig.cert_path = listener.certPath;
    fileConfig.key_path = listener.keyPath;
  } else {
    // Multiple listeners: use new format
    fileConfig.listeners = config.listeners.map((l) => ({
      port: l.port,
      token: l.token,
      tls: l.tls,
      cert_path: l.certPath,
      key_path: l.keyPath,
    }));
  }

  fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2));
}
