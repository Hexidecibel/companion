// --- setup protocol v1 ---
// Mirrored byte-for-byte: daemon/src/setup/protocol.ts <-> web/src/types/setup.ts. No imports.

/** Wizard steps, in order. `pair` and `welcome` are device-side; the rest configure the server. */
export type SetupStepId =
  | 'welcome'
  | 'pair'
  | 'name'
  | 'machine'
  | 'claude'
  | 'projects'
  | 'session'
  | 'devices'
  | 'notifications'
  | 'herald'
  | 'remote'
  | 'done';

export const SETUP_STEPS: SetupStepId[] = [
  'welcome',
  'pair',
  'name',
  'machine',
  'claude',
  'projects',
  'session',
  'devices',
  'notifications',
  'herald',
  'remote',
  'done',
];

export type SetupStepState = 'done' | 'skipped';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export type PrereqId =
  | 'node'
  | 'tmux'
  | 'git'
  | 'claude_installed'
  | 'claude_login'
  | 'tailscale'
  | 'herald_voice'
  | 'disk'
  | 'service'
  | 'port';

export interface PrereqCheck {
  id: PrereqId;
  label: string;
  status: CheckStatus;
  /** One line: what was found ("tmux 3.4", "not installed"). */
  detail: string;
  /** One line: what to do about it (absent when ok). */
  fix?: string;
  /** A command the user can copy and run in a terminal. */
  command?: string;
  /** Optional checks never block the wizard. */
  optional: boolean;
}

export type HeraldProviderChoice = 'anthropic' | 'openai_compatible' | 'off';
export type PairingPolicy = 'lan' | 'anywhere' | 'off';
export type NotificationsChoice = 'browser' | 'off';

export interface SetupSettings {
  /** Server display name (mDNS, pairing, app list). */
  name: string;
  /** Folders sessions may be started in (absolute, inside $HOME). */
  projectRoots: string[];
  /** Default tmux session name. */
  tmuxSession: string;
  mdnsEnabled: boolean;
  /** lan: code pairing on local network / tailnet only. anywhere: also public. off: no pairing. */
  pairing: PairingPolicy;
  herald: {
    provider: HeraldProviderChoice;
    /** openai_compatible: base URL of the local server ("http://host:8000/v1"). */
    baseUrl: string;
    /** openai_compatible: model name (anthropic: optional override). */
    model: string;
  };
  notifications: NotificationsChoice;
}

/** Fields to change; everything else is kept (including config keys the wizard does not know). */
export interface SetupSettingsPatch {
  name?: string;
  projectRoots?: string[];
  tmuxSession?: string;
  mdnsEnabled?: boolean;
  pairing?: PairingPolicy;
  herald?: { provider?: HeraldProviderChoice; baseUrl?: string; model?: string };
  notifications?: NotificationsChoice;
}

export type SecretName = 'anthropic_api_key';

/** Never the value: only whether it is set, and where from. */
export interface SecretStatus {
  name: SecretName;
  set: boolean;
  source: 'env' | 'secrets_file' | 'none';
}

export interface SetupStatus {
  /** The daemon is in first-run setup mode (setup_complete is false). */
  setupMode: boolean;
  setupComplete: boolean;
  daemonId: string;
  serverName: string;
  hostname: string;
  platform: 'linux' | 'darwin' | 'other';
  version: string;
  home: string;
  steps: Partial<Record<SetupStepId, SetupStepState>>;
  settings: SetupSettings;
  secrets: SecretStatus[];
  deviceCount: number;
  /** Some saved settings only apply after a daemon restart. */
  restartNeeded: boolean;
  /** The secrets file path shown to the user (never its contents). */
  secretsFile: string;
  /** Running in the Docker image (compose replaces services, apt and npm -g); null on a host install. */
  container: ContainerSetupInfo | null;
}

export interface ContainerSetupInfo {
  runtime: 'docker';
  /** The projects bind mount: the folder picker starts here and stays inside it. */
  projectsDir: string | null;
  /** network_mode: host (Nearby discovery works); false on the default bridge network. */
  hostNetwork: boolean;
  /** The Tailscale sidecar's socket is mounted (the tailscale compose profile). */
  tailscaleSidecar: boolean;
}

export interface ClaudeInstallResult {
  ok: boolean;
  /** Last lines of the installer output. */
  output: string;
  /** `claude --version` after the install (null when it still does not run). */
  version: string | null;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  /** null at $HOME (nothing above it is listed). */
  parent: string | null;
  entries: DirEntry[];
  truncated: boolean;
}

export type SessionHint =
  | 'starting'
  | 'trust_dialog'
  | 'login'
  | 'claude_missing'
  | 'ready'
  | 'gone';

export interface SessionProgress {
  sessionName: string;
  exists: boolean;
  /** The session has a parsed Claude Code conversation. */
  conversationDetected: boolean;
  hint: SessionHint;
  /** One line of guidance for the hint. */
  guidance: string;
  /** Command to attach to the session from a terminal. */
  attachCommand: string;
}

export type ServiceTarget = 'daemon' | 'voice';

export interface ServiceInfo {
  target: ServiceTarget;
  supported: boolean;
  installed: boolean;
  /** systemd unit / launchd plist path. */
  path: string;
  /** What the install button runs (shown before running). */
  command: string;
  /** Why it cannot be installed from here (e.g. voice not downloaded yet). */
  blocker?: string;
}

export interface ServiceStatus {
  platform: 'linux' | 'darwin' | 'other';
  services: ServiceInfo[];
}

export interface ServiceInstallResult {
  target: ServiceTarget;
  ok: boolean;
  /** Last lines of the command output (no secrets are involved). */
  output: string;
  /** The running daemon was not restarted; the service takes over on the next start. */
  note: string;
}

export interface RemoteAccessInfo {
  tailscale: {
    installed: boolean;
    up: boolean;
    dnsName: string | null;
    url: string | null;
  };
  lanUrls: string[];
  port: number;
  tls: boolean;
}

export interface AppDownload {
  platform: 'android' | 'linux' | 'macos' | 'windows';
  label: string;
  version: string;
  /** Absolute URL from the feed manifest. */
  url: string;
  /** Same file through this server ("/updates/stable/..."), when it is in the local feed. */
  localPath: string | null;
}

export interface AppDownloads {
  channel: string;
  downloads: AppDownload[];
  /** local: this server's own feed. remote: the public feed (COMPANION_APP_FEED_URL). none: neither has builds. */
  source: 'local' | 'remote' | 'none';
  /** The public feed the apps update from (null when turned off). */
  feedUrl: string | null;
}

export type SetupErrorCode =
  | 'bad_request'
  | 'forbidden'
  | 'untrusted_network'
  | 'not_found'
  | 'busy'
  | 'unavailable';

export const SETUP_LIMITS = {
  nameMaxLength: 60,
  maxProjectRoots: 20,
  maxDirEntries: 200,
  secretMaxLength: 400,
  tmuxSessionMaxLength: 40,
  urlMaxLength: 300,
  modelMaxLength: 120,
} as const;
// --- end setup protocol ---
