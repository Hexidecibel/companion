import * as fs from 'fs';
import * as path from 'path';
import { DaemonConfig } from './types';

const HOME_DIR = process.env.HOME || '/root';
const CONFIG_DIR = path.join(HOME_DIR, '.companion');

// Safe tools that can be auto-approved without user confirmation
const DEFAULT_AUTO_APPROVE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

const DEFAULT_CONFIG: DaemonConfig = {
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

  let fileConfig: Partial<DaemonConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);

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
    ...Object.fromEntries(
      Object.entries(fileConfig).filter(([_, v]) => v !== undefined)
    ),
  } as DaemonConfig;

  // Validate required fields
  if (!config.token) {
    console.error('Error: No authentication token configured');
    console.error('Please set a token in the config file');
    process.exit(1);
  }

  return config;
}

export function saveConfig(config: DaemonConfig): void {
  const configPath = process.env.CONFIG_PATH || path.join(CONFIG_DIR, 'config.json');

  // Convert to snake_case for file
  const fileConfig = {
    port: config.port,
    token: config.token,
    tls: config.tls,
    cert_path: config.certPath,
    key_path: config.keyPath,
    tmux_session: config.tmuxSession,
    code_home: config.codeHome,
    mdns_enabled: config.mdnsEnabled,
    fcm_credentials_path: config.fcmCredentialsPath,
    push_delay_ms: config.pushDelayMs,
  };

  fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2));
}
