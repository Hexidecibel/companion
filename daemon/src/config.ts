import * as fs from 'fs';
import * as path from 'path';
import { DaemonConfig, ListenerConfig } from './types';

const HOME_DIR = process.env.HOME || '/root';
const CONFIG_DIR = path.join(HOME_DIR, '.companion');

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
};

export function loadConfig(): DaemonConfig {
  const configPath = process.env.CONFIG_PATH || path.join(CONFIG_DIR, 'config.json');

  let fileConfig: Partial<DaemonConfig> & { listeners?: ListenerConfig[] } = {};
  let parsedListeners: ListenerConfig[] | undefined;

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
        anthropicAdminApiKey: parsed.anthropic_admin_api_key,
      };
    } catch (err) {
      console.error(`Error loading config from ${configPath}:`, err);
    }
  } else {
    console.warn(`Config file not found at ${configPath}, using defaults`);
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
