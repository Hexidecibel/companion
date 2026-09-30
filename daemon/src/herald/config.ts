/**
 * Herald configuration: parsing the raw `herald` config block and resolving the
 * effective runtime settings (provider, model, credentials from env only).
 *
 * Secrets are NEVER read from the config file. The only credential sources are:
 *   - provider=openai_compatible: optional HERALD_LLM_API_KEY
 *   - provider=anthropic:          required ANTHROPIC_API_KEY
 */

import * as os from 'os';
import * as path from 'path';

export type HeraldProviderName = 'openai_compatible' | 'anthropic';

/** Raw config block as written in config.json (snake_case). */
export interface HeraldConfigBlock {
  enabled?: boolean;
  display_name?: string;
  provider?: HeraldProviderName;
  base_url?: string;
  model?: string;
  echo_delay_ms?: number;
  timeout_ms?: number;
  max_tokens?: number;
  /**
   * Directory holding Herald's state.json. Defaults to ~/.companion/herald.
   * The COMPANION_HERALD_STATE_DIR env var takes precedence (used by the
   * isolated bin/herald-sandbox daemon so it never touches production state).
   */
  state_dir?: string;
}

export interface ResolvedHeraldConfig {
  /** False only when the operator explicitly set herald.enabled=false. */
  featureEnabled: boolean;
  displayName: string;
  provider: HeraldProviderName;
  baseUrl: string | null;
  model: string;
  echoDelayMs: number;
  /** Per-request timeout (headers + inter-chunk idle) for the brain server. */
  requestTimeoutMs: number;
  maxTokens: number;
  /** Absolute directory for Herald's persisted state. */
  stateDir: string;
  apiKey: string | null;
  /** True when the brain can be attempted (provider fully configured). */
  brainConfigured: boolean;
  /** Human-readable reason the brain is unavailable (when !brainConfigured or !featureEnabled). */
  disabledReason?: string;
}

export const DEFAULT_DISPLAY_NAME = 'Herald';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const DEFAULT_ECHO_DELAY_MS = 5000;
export const MIN_ECHO_DELAY_MS = 1500;
export const MAX_ECHO_DELAY_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOKENS = 700;

const PROVIDERS: HeraldProviderName[] = ['openai_compatible', 'anthropic'];

function clampInt(v: unknown, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Parse an untrusted raw object into a HeraldConfigBlock (drops anything malformed). */
export function parseHeraldConfigBlock(raw: unknown): HeraldConfigBlock | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: HeraldConfigBlock = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (typeof r.display_name === 'string' && r.display_name.trim()) {
    out.display_name = r.display_name.trim().slice(0, 40);
  }
  if (typeof r.provider === 'string' && (PROVIDERS as string[]).includes(r.provider)) {
    out.provider = r.provider as HeraldProviderName;
  }
  if (typeof r.base_url === 'string' && r.base_url.trim()) out.base_url = r.base_url.trim();
  if (typeof r.model === 'string' && r.model.trim()) out.model = r.model.trim();
  if (typeof r.echo_delay_ms === 'number') out.echo_delay_ms = r.echo_delay_ms;
  if (typeof r.timeout_ms === 'number') out.timeout_ms = r.timeout_ms;
  if (typeof r.max_tokens === 'number') out.max_tokens = r.max_tokens;
  if (typeof r.state_dir === 'string' && r.state_dir.trim()) out.state_dir = r.state_dir.trim();
  return out;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve Herald's state directory: env override > config block > ~/.companion/herald. */
export function resolveHeraldStateDir(
  block: HeraldConfigBlock | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = (env.COMPANION_HERALD_STATE_DIR || '').trim() || block?.state_dir || '';
  if (raw) return path.resolve(expandHome(raw));
  return path.join(os.homedir(), '.companion', 'herald');
}

function validBaseUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function resolveHeraldConfig(
  block: HeraldConfigBlock | undefined,
  env: NodeJS.ProcessEnv = process.env
): ResolvedHeraldConfig {
  const b = block || {};
  const provider: HeraldProviderName = b.provider || 'openai_compatible';
  const featureEnabled = b.enabled !== false;
  const base: Omit<
    ResolvedHeraldConfig,
    'brainConfigured' | 'disabledReason' | 'model' | 'apiKey' | 'baseUrl'
  > = {
    featureEnabled,
    displayName: b.display_name || DEFAULT_DISPLAY_NAME,
    provider,
    echoDelayMs: clampInt(
      b.echo_delay_ms,
      DEFAULT_ECHO_DELAY_MS,
      MIN_ECHO_DELAY_MS,
      MAX_ECHO_DELAY_MS
    ),
    requestTimeoutMs: clampInt(b.timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS, 5_000, 120_000),
    maxTokens: clampInt(b.max_tokens, DEFAULT_MAX_TOKENS, 128, 4096),
    stateDir: resolveHeraldStateDir(b, env),
  };

  if (!featureEnabled) {
    return {
      ...base,
      baseUrl: b.base_url || null,
      model: b.model || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : ''),
      apiKey: null,
      brainConfigured: false,
      disabledReason: 'Disabled in config (herald.enabled is false).',
    };
  }

  if (provider === 'anthropic') {
    const key = (env.ANTHROPIC_API_KEY || '').trim();
    const model = b.model || DEFAULT_ANTHROPIC_MODEL;
    if (!key) {
      return {
        ...base,
        baseUrl: null,
        model,
        apiKey: null,
        brainConfigured: false,
        disabledReason:
          'herald.provider is "anthropic" but ANTHROPIC_API_KEY is not set in the daemon environment. ' +
          'Set it for the companion service (e.g. a systemd Environment= / EnvironmentFile= entry) and restart the daemon.',
      };
    }
    return { ...base, baseUrl: null, model, apiKey: key, brainConfigured: true };
  }

  // openai_compatible (default): local server, model must be named explicitly.
  const key = (env.HERALD_LLM_API_KEY || '').trim() || null;
  const baseUrl = b.base_url ? b.base_url.replace(/\/+$/, '') : null;
  const model = b.model || '';
  const missing: string[] = [];
  if (!baseUrl) missing.push('herald.base_url (e.g. "http://spark.local:8000/v1")');
  if (!model) missing.push('herald.model (the model name your server serves)');
  if (missing.length > 0) {
    return {
      ...base,
      baseUrl,
      model,
      apiKey: key,
      brainConfigured: false,
      disabledReason: `Brain not configured: set ${missing.join(' and ')} in the daemon config.`,
    };
  }
  if (!validBaseUrl(baseUrl!)) {
    return {
      ...base,
      baseUrl,
      model,
      apiKey: key,
      brainConfigured: false,
      disabledReason: `herald.base_url "${baseUrl}" is not a valid http(s) URL.`,
    };
  }
  return { ...base, baseUrl, model, apiKey: key, brainConfigured: true };
}
