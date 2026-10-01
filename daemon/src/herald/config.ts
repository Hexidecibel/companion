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
import { DEFAULT_PRICING, PricingRates, ratesFor, validBudget } from './usage';

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
  /**
   * Local voice service (bin/herald-voice). Default http://127.0.0.1:9889;
   * env HERALD_VOICE_URL takes precedence. The browser never talks to it.
   */
  voice_url?: string;
  /** Set false to disable neural voice / voice input entirely. */
  voice_enabled?: boolean;
  /** Optional monthly API budget in USD: 80% warns once, 100% switches to the fallback brain. */
  monthly_budget_usd?: number;
  /** Prompt caching of the stable prefix (tools + system). Default true. */
  prompt_cache?: boolean;
  /** Cache lifetime: "5m" (default, writes 1.25x) or "1h" (writes 2x; pays off with 5-60 min gaps). */
  cache_ttl?: '5m' | '1h';
  /** Price override for the configured model, USD per million tokens. */
  pricing?: {
    input_per_mtok?: number;
    output_per_mtok?: number;
    cache_write_5m_per_mtok?: number;
    cache_write_1h_per_mtok?: number;
    cache_read_per_mtok?: number;
  };
  /**
   * Remote triggers that open the mic (listen, toggle) from outside the home
   * network / tailnet are refused unless this is true.
   */
  trigger_public_listen?: boolean;
  /**
   * Hostnames that resolve to this home's own public IP (e.g. "dev.cush.rocks").
   * A request whose client IP equals that address came from inside the home via
   * the router's hairpin NAT, so it counts as LAN.
   */
  trigger_home_hosts?: string[];
  /**
   * Reverse proxies whose X-Forwarded-For is believed (IPs). Default: loopback
   * only (HAProxy on this host). A forwarded request from anyone else is
   * treated as coming from the internet.
   */
  trigger_trusted_proxies?: string[];
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
  /** Voice service base URL, or null when voice is disabled (always set by resolveHeraldConfig). */
  voiceUrl?: string | null;
  /** Monthly API budget in USD (undefined = none). */
  monthlyBudgetUsd?: number;
  /** Prompt caching settings (undefined = caching off). */
  promptCache?: { ttl: '5m' | '1h' };
  /** Price table used by the usage meter (defaults + herald.pricing for the model). */
  pricing?: Record<string, PricingRates>;
  /** Remote-trigger trust settings. */
  trigger?: ResolvedTriggerConfig;
}

export interface ResolvedTriggerConfig {
  publicListen: boolean;
  homeHosts: string[];
  trustedProxies: string[];
}

export const DEFAULT_DISPLAY_NAME = 'Herald';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const DEFAULT_ECHO_DELAY_MS = 5000;
export const MIN_ECHO_DELAY_MS = 1500;
export const MAX_ECHO_DELAY_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOKENS = 700;
export const DEFAULT_VOICE_URL = 'http://127.0.0.1:9889';

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
  if (typeof r.voice_url === 'string' && r.voice_url.trim()) out.voice_url = r.voice_url.trim();
  if (typeof r.voice_enabled === 'boolean') out.voice_enabled = r.voice_enabled;
  if (validBudget(r.monthly_budget_usd)) out.monthly_budget_usd = r.monthly_budget_usd;
  if (typeof r.prompt_cache === 'boolean') out.prompt_cache = r.prompt_cache;
  if (r.cache_ttl === '5m' || r.cache_ttl === '1h') out.cache_ttl = r.cache_ttl;
  if (r.pricing && typeof r.pricing === 'object') {
    const p = r.pricing as Record<string, unknown>;
    const pricing: NonNullable<HeraldConfigBlock['pricing']> = {};
    for (const k of [
      'input_per_mtok',
      'output_per_mtok',
      'cache_write_5m_per_mtok',
      'cache_write_1h_per_mtok',
      'cache_read_per_mtok',
    ] as const) {
      const v = p[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 10_000) pricing[k] = v;
    }
    if (Object.keys(pricing).length) out.pricing = pricing;
  }
  if (typeof r.trigger_public_listen === 'boolean')
    out.trigger_public_listen = r.trigger_public_listen;
  const strList = (v: unknown, max: number) =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length < 256)
          .map((x) => x.trim())
          .slice(0, max)
      : undefined;
  const hosts = strList(r.trigger_home_hosts, 8);
  if (hosts) out.trigger_home_hosts = hosts;
  const proxies = strList(r.trigger_trusted_proxies, 16);
  if (proxies) out.trigger_trusted_proxies = proxies;
  return out;
}

/** The price table for a model: the defaults, with herald.pricing applied to that model. */
export function resolvePricing(
  model: string,
  override: HeraldConfigBlock['pricing']
): Record<string, PricingRates> {
  const table = { ...DEFAULT_PRICING };
  if (!override) return table;
  const base = ratesFor(model, table);
  const pick = (v: number | undefined, d: number | undefined) => v ?? d;
  const rates = {
    input: pick(override.input_per_mtok, base?.input),
    output: pick(override.output_per_mtok, base?.output),
    cacheWrite5m: pick(override.cache_write_5m_per_mtok, base?.cacheWrite5m),
    cacheWrite1h: pick(override.cache_write_1h_per_mtok, base?.cacheWrite1h),
    cacheRead: pick(override.cache_read_per_mtok, base?.cacheRead),
  };
  // Without a base entry, an override must name input and output; the cache
  // rates then follow the standard multipliers.
  if (rates.input === undefined || rates.output === undefined) return table;
  table[model] = {
    input: rates.input,
    output: rates.output,
    cacheWrite5m: rates.cacheWrite5m ?? rates.input * 1.25,
    cacheWrite1h: rates.cacheWrite1h ?? rates.input * 2,
    cacheRead: rates.cacheRead ?? rates.input * 0.1,
  };
  return table;
}

export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1'];

export function resolveTriggerConfig(block: HeraldConfigBlock | undefined): ResolvedTriggerConfig {
  return {
    publicListen: block?.trigger_public_listen === true,
    homeHosts: block?.trigger_home_hosts ?? [],
    trustedProxies: block?.trigger_trusted_proxies ?? DEFAULT_TRUSTED_PROXIES,
  };
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

/** Voice service URL: env HERALD_VOICE_URL > herald.voice_url > default; null when disabled or invalid. */
export function resolveVoiceUrl(
  block: HeraldConfigBlock | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (block?.voice_enabled === false) return null;
  const raw = (env.HERALD_VOICE_URL || '').trim() || block?.voice_url || DEFAULT_VOICE_URL;
  const url = raw.replace(/\/+$/, '');
  return validBaseUrl(url) ? url : null;
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
    voiceUrl: resolveVoiceUrl(b, env),
    ...(b.monthly_budget_usd !== undefined ? { monthlyBudgetUsd: b.monthly_budget_usd } : {}),
    ...(b.prompt_cache === false ? {} : { promptCache: { ttl: b.cache_ttl || '5m' } }),
    pricing: resolvePricing(b.model || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : ''), b.pricing),
    trigger: resolveTriggerConfig(b),
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
