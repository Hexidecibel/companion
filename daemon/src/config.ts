import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { DaemonConfig, ListenerConfig, RemoteCapabilitiesConfig } from './types';
import { atomicWriteFileSync } from './utils';
import { parseHeraldConfigBlock } from './herald/config';

const HOME_DIR = process.env.HOME || '/root';
const CONFIG_DIR = path.join(HOME_DIR, '.companion');

/**
 * Resolve the daemon config file path.
 *
 * Precedence:
 *   1. COMPANION_CONFIG (preferred)
 *   2. CONFIG_PATH (legacy alias, kept for backward compatibility)
 *   3. ~/.companion/config.json (default)
 */
export function resolveConfigPath(): string {
  return (
    process.env.COMPANION_CONFIG ||
    process.env.CONFIG_PATH ||
    path.join(CONFIG_DIR, 'config.json')
  );
}

/**
 * Generate a random authentication token
 */
function generateToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

function parseRemoteCapabilities(raw: any): RemoteCapabilitiesConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const result: RemoteCapabilitiesConfig = {
    enabled: Boolean(raw.enabled),
  };
  if (raw.exec && typeof raw.exec === 'object') {
    result.exec = {
      enabled: Boolean(raw.exec.enabled),
      commandAllowlist: raw.exec.command_allowlist ?? raw.exec.commandAllowlist ?? null,
    };
  }
  if (raw.dispatch && typeof raw.dispatch === 'object') {
    result.dispatch = { enabled: Boolean(raw.dispatch.enabled) };
  }
  if (raw.write && typeof raw.write === 'object') {
    result.write = {
      enabled: Boolean(raw.write.enabled),
      roots: Array.isArray(raw.write.roots) ? raw.write.roots : [],
    };
  }
  if (raw.require_loopback_or_tls !== undefined || raw.requireLoopbackOrTls !== undefined) {
    result.requireLoopbackOrTls = Boolean(raw.require_loopback_or_tls ?? raw.requireLoopbackOrTls);
  }
  if (Array.isArray(raw.allowed_origins)) {
    result.allowedOrigins = raw.allowed_origins;
  } else if (Array.isArray(raw.allowedOrigins)) {
    result.allowedOrigins = raw.allowedOrigins;
  }
  if (Array.isArray(raw.origins)) {
    result.origins = raw.origins
      .filter((o: any) => o && typeof o === 'object' && typeof o.origin === 'string' && typeof o.token === 'string')
      .map((o: any) => {
        const cred: any = { origin: o.origin, token: o.token };
        if (typeof o.label === 'string') cred.label = o.label;
        if (o.capabilities && typeof o.capabilities === 'object') {
          cred.capabilities = {
            ...(typeof o.capabilities.exec === 'boolean' ? { exec: o.capabilities.exec } : {}),
            ...(typeof o.capabilities.dispatch === 'boolean' ? { dispatch: o.capabilities.dispatch } : {}),
            ...(typeof o.capabilities.write === 'boolean' ? { write: o.capabilities.write } : {}),
          };
        }
        if (typeof o.disabled === 'boolean') cred.disabled = o.disabled;
        return cred;
      });
  }
  return result;
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
 * First-run welcome: where to open the setup wizard. No token is printed: the
 * first device pairs with a code that appears in this log (or is paired
 * automatically from a browser on this machine).
 */
export async function displayFirstRunWelcome(
  config: DaemonConfig,
  configPath: string
): Promise<void> {
  const listener = config.listeners[0];
  const localIP = getLocalIP();
  const scheme = listener.tls ? 'https' : 'http';
  const local = `${scheme}://localhost:${listener.port}/web/`;
  const lan = localIP !== 'localhost' ? `${scheme}://${localIP}:${listener.port}/web/` : null;
  const link = (u: string) => `\x1b]8;;${u}\x07${u}\x1b]8;;\x07`;

  console.log('');
  console.log('='.repeat(56));
  console.log('  Welcome to Companion');
  console.log('='.repeat(56));
  console.log('');
  console.log('  Finish setting up in your browser:');
  console.log('');
  console.log(`    On this machine:   ${link(local)}`);
  if (lan) console.log(`    From your network: ${link(lan)}`);
  console.log('');
  console.log('  A browser on this machine pairs automatically. From another');
  console.log('  device, a 6-digit pairing code will appear here in the log');
  console.log('  (and in: companion pair).');
  console.log('');
  console.log(`  Config: ${configPath}`);
  console.log('='.repeat(56));
  console.log('');
}

/** Pre-pairing installs (no setup_complete key) are complete; a new config starts with false. */
export function isSetupMode(config: Pick<DaemonConfig, 'setupComplete'>): boolean {
  return config.setupComplete === false;
}

function envPort(): number | undefined {
  const n = Number(process.env.COMPANION_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

function envFlag(name: string): boolean | undefined {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return undefined;
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
  const configPath = resolveConfigPath();

  let fileConfig: Partial<DaemonConfig> & { listeners?: ListenerConfig[] } = {};
  let parsedListeners: ListenerConfig[] | undefined;
  let legacyRemoteCapabilities: RemoteCapabilitiesConfig | undefined;

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
          remoteCapabilities: parseRemoteCapabilities(l.remote_capabilities),
        }));
      }

      // Legacy flat-config root-level remote_capabilities
      legacyRemoteCapabilities = parseRemoteCapabilities(parsed.remote_capabilities);

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
        concierge_dir: parsed.concierge_dir,
        herald: parseHeraldConfigBlock(parsed.herald),
        name: typeof parsed.name === 'string' ? parsed.name : undefined,
        pairing: typeof parsed.pairing === 'boolean' ? parsed.pairing : undefined,
        pairingAllowPublic:
          typeof parsed.pairing_allow_public === 'boolean' ? parsed.pairing_allow_public : undefined,
        setupComplete:
          typeof parsed.setup_complete === 'boolean' ? parsed.setup_complete : undefined,
        projectRoots: Array.isArray(parsed.project_roots)
          ? parsed.project_roots.filter((r: unknown): r is string => typeof r === 'string')
          : undefined,
      };
    } catch (err) {
      console.error(`Error loading config from ${configPath}:`, err);
    }
  } else {
    // First run - generate config with random token
    // First run: setup mode. The legacy listener token still exists (every
    // listener needs one) but is never shown; devices pair instead.
    isFirstRun = true;
    const newToken = generateToken();
    fileConfig = {
      port: envPort() ?? DEFAULT_CONFIG.port,
      token: newToken,
      tls: DEFAULT_CONFIG.tls,
      name: (process.env.COMPANION_NAME || '').trim().slice(0, 60) || os.hostname(),
      mdnsEnabled: envFlag('COMPANION_MDNS') ?? DEFAULT_CONFIG.mdnsEnabled,
      setupComplete: false,
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
        remoteCapabilities: legacyRemoteCapabilities,
      },
    ];
  }

  // First run: save generated config (welcome message displayed separately)
  if (isFirstRun && config.listeners.length > 0) {
    // Ensure config directory exists
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
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
    if (!listener.remoteCapabilities) {
      listener.remoteCapabilities = { enabled: false };
    }
  }

  return config;
}

/** The config file as raw JSON (snake_case), or {} when missing / unreadable. */
export function readRawConfig(configPath: string = resolveConfigPath()): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Change the config file in place: every key the mutator does not touch is
 * kept (including keys this daemon version does not know). Atomic
 * (temp + rename), keeps the file's mode, new files are 0600.
 */
export function updateConfigFile(
  mutate: (raw: Record<string, unknown>) => void,
  configPath: string = resolveConfigPath()
): Record<string, unknown> {
  const exists = fs.existsSync(configPath);
  if (exists) {
    // A file we cannot parse must not be replaced by a partial one.
    JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  const raw = readRawConfig(configPath);
  mutate(raw);
  const mode = exists ? fs.statSync(configPath).mode & 0o777 : 0o600;
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', { mode });
  return raw;
}

export function saveConfig(config: DaemonConfig): void {
  const configPath = resolveConfigPath();

  // Managed keys are (re)written; every other key in the file is preserved.
  const fileConfig: Record<string, unknown> = {
    tmux_session: config.tmuxSession,
    code_home: config.codeHome,
    mdns_enabled: config.mdnsEnabled,
    fcm_credentials_path: config.fcmCredentialsPath,
    push_delay_ms: config.pushDelayMs,
  };
  if (config.concierge_dir) {
    fileConfig.concierge_dir = config.concierge_dir;
  }
  // Preserve the herald block across rewrites (e.g. token rotation).
  if (config.herald) {
    fileConfig.herald = config.herald;
  }
  if (config.name) fileConfig.name = config.name;
  if (config.pairing !== undefined) fileConfig.pairing = config.pairing;
  if (config.pairingAllowPublic !== undefined) {
    fileConfig.pairing_allow_public = config.pairingAllowPublic;
  }
  if (config.setupComplete !== undefined) fileConfig.setup_complete = config.setupComplete;
  if (config.projectRoots) fileConfig.project_roots = config.projectRoots;

  const legacyKeys = ['port', 'token', 'tls', 'cert_path', 'key_path', 'remote_capabilities'];
  if (config.listeners.length === 1) {
    // Single listener: use legacy format for backward compatibility
    const listener = config.listeners[0];
    fileConfig.port = listener.port;
    fileConfig.token = listener.token;
    fileConfig.tls = listener.tls;
    fileConfig.cert_path = listener.certPath;
    fileConfig.key_path = listener.keyPath;
    if (listener.remoteCapabilities) {
      fileConfig.remote_capabilities = listener.remoteCapabilities;
    }
  } else {
    // Multiple listeners: use new format
    fileConfig.listeners = config.listeners.map((l) => ({
      port: l.port,
      token: l.token,
      tls: l.tls,
      cert_path: l.certPath,
      key_path: l.keyPath,
      remote_capabilities: l.remoteCapabilities,
    }));
  }

  updateConfigFile((raw) => {
    // Drop the other listener shape so the file never holds both.
    if (config.listeners.length === 1) delete raw.listeners;
    else for (const k of legacyKeys) delete raw[k];
    for (const [k, v] of Object.entries(fileConfig)) {
      if (v === undefined) delete raw[k];
      else raw[k] = v;
    }
  }, configPath);
}
