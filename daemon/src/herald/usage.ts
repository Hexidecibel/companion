/**
 * Herald's API usage meter: tokens and dollars per day and per month, the
 * optional monthly budget, and its one-shot 80% / 100% notices.
 *
 * Prices come from a per-model rate table (config default below, overridable
 * with herald.pricing), never from logic. Day and month are the daemon's local
 * calendar. Everything here is pure over an injected clock; the service owns
 * persistence (it rides in Herald's state.json) and the side effects.
 */

import type { HeraldUsageBucket, HeraldUsageSummary } from './protocol';
import type { LlmUsage } from './llm/provider';

/** USD per million tokens. */
export interface PricingRates {
  input: number;
  output: number;
  /** Cache writes with the default 5-minute TTL (1.25x input). */
  cacheWrite5m: number;
  /** Cache writes with the 1-hour TTL (2x input). */
  cacheWrite1h: number;
  /** Cache reads (0.1x input on Haiku 4.5). */
  cacheRead: number;
}

/**
 * Default rates (Anthropic first-party list prices, USD / MTok). Keys match a
 * model id exactly or as a prefix (dated snapshot ids).
 */
export const DEFAULT_PRICING: Record<string, PricingRates> = {
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
};

export function ratesFor(
  model: string,
  table: Record<string, PricingRates> = DEFAULT_PRICING
): PricingRates | null {
  if (table[model]) return table[model];
  const key = Object.keys(table)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

export type CacheTtl = '5m' | '1h';

/** Dollar cost of one request's usage. */
export function costOf(usage: LlmUsage, rates: PricingRates, ttl: CacheTtl = '5m'): number {
  const write = ttl === '1h' ? rates.cacheWrite1h : rates.cacheWrite5m;
  return (
    ((usage.inputTokens || 0) * rates.input +
      (usage.outputTokens || 0) * rates.output +
      (usage.cacheReadInputTokens || 0) * rates.cacheRead +
      (usage.cacheCreationInputTokens || 0) * write) /
    1_000_000
  );
}

export function emptyBucket(): HeraldUsageBucket {
  return {
    turns: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

/** What Herald state.json keeps (see store.ts). */
export interface PersistedUsage {
  /** Local calendar day of `today` (YYYY-MM-DD). */
  day: string;
  /** Local calendar month of `month` (YYYY-MM). */
  monthKey: string;
  today: HeraldUsageBucket;
  month: HeraldUsageBucket;
  /** Monthly cap set from the app; overrides herald.monthly_budget_usd. null = explicitly none. */
  budgetOverrideUsd?: number | null;
  /** Month (YYYY-MM) in which the 80% warning was given. */
  warnedMonth?: string;
  /** Month (YYYY-MM) in which the 100% notice was given. */
  exceededMonth?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
/** Start of the next local month (ms). */
export function nextMonthStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function sanitizeBucket(raw: unknown): HeraldUsageBucket {
  const b = emptyBucket();
  if (!raw || typeof raw !== 'object') return b;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(b) as (keyof HeraldUsageBucket)[]) {
    if (isNum(r[k])) b[k] = r[k] as number;
  }
  return b;
}

export const MAX_BUDGET_USD = 10_000;

export function validBudget(v: unknown): v is number {
  return isNum(v) && v > 0 && v <= MAX_BUDGET_USD;
}

/** Validate a persisted usage block (tolerant: junk becomes empty). */
export function sanitizeUsage(raw: unknown): PersistedUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.day !== 'string' || typeof r.monthKey !== 'string') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !/^\d{4}-\d{2}$/.test(r.monthKey)) return undefined;
  const out: PersistedUsage = {
    day: r.day,
    monthKey: r.monthKey,
    today: sanitizeBucket(r.today),
    month: sanitizeBucket(r.month),
  };
  if (r.budgetOverrideUsd === null) out.budgetOverrideUsd = null;
  else if (validBudget(r.budgetOverrideUsd)) out.budgetOverrideUsd = r.budgetOverrideUsd;
  if (typeof r.warnedMonth === 'string' && /^\d{4}-\d{2}$/.test(r.warnedMonth))
    out.warnedMonth = r.warnedMonth;
  if (typeof r.exceededMonth === 'string' && /^\d{4}-\d{2}$/.test(r.exceededMonth))
    out.exceededMonth = r.exceededMonth;
  return out;
}

export interface UsageMeterOptions {
  model: string;
  now?: () => number;
  pricing?: Record<string, PricingRates>;
  cacheTtl?: CacheTtl;
  /** herald.monthly_budget_usd (undefined = no cap). */
  configBudgetUsd?: number;
  /** Fraction of the budget that triggers the one-shot warning. */
  warnFraction?: number;
}

export type BudgetNotice = 'budget_warning' | 'budget_exceeded';

export class UsageMeter {
  private state: PersistedUsage;
  private readonly now: () => number;
  private readonly rates: PricingRates | null;
  private readonly ttl: CacheTtl;
  private readonly configBudget: number | undefined;
  private readonly warnFraction: number;
  readonly model: string;

  constructor(persisted: PersistedUsage | undefined, opts: UsageMeterOptions) {
    this.now = opts.now || Date.now;
    this.model = opts.model;
    this.rates = ratesFor(opts.model, opts.pricing || DEFAULT_PRICING);
    this.ttl = opts.cacheTtl || '5m';
    this.configBudget = validBudget(opts.configBudgetUsd) ? opts.configBudgetUsd : undefined;
    this.warnFraction = opts.warnFraction ?? 0.8;
    const t = this.now();
    this.state = persisted
      ? { ...persisted, today: { ...persisted.today }, month: { ...persisted.month } }
      : { day: dayKey(t), monthKey: monthKey(t), today: emptyBucket(), month: emptyBucket() };
    this.roll();
  }

  /** Start a new day / month when the calendar moved on. True when anything reset. */
  roll(): boolean {
    const t = this.now();
    let changed = false;
    const d = dayKey(t);
    if (this.state.day !== d) {
      this.state.day = d;
      this.state.today = emptyBucket();
      changed = true;
    }
    const m = monthKey(t);
    if (this.state.monthKey !== m) {
      this.state.monthKey = m;
      this.state.month = emptyBucket();
      changed = true;
    }
    return changed;
  }

  get priced(): boolean {
    return this.rates !== null;
  }

  /** Account one brain request. Returns its cost in USD. */
  recordRequest(usage: LlmUsage): number {
    this.roll();
    const cost = this.rates ? costOf(usage, this.rates, this.ttl) : 0;
    for (const b of [this.state.today, this.state.month]) {
      b.requests += 1;
      b.inputTokens += usage.inputTokens || 0;
      b.outputTokens += usage.outputTokens || 0;
      b.cacheReadTokens += usage.cacheReadInputTokens || 0;
      b.cacheWriteTokens += usage.cacheCreationInputTokens || 0;
      b.costUsd += cost;
    }
    return cost;
  }

  /** Account one conversational turn that reached the brain. */
  recordTurn(): void {
    this.roll();
    this.state.today.turns += 1;
    this.state.month.turns += 1;
  }

  /** Effective monthly cap in USD, or null when there is none. */
  budgetUsd(): number | null {
    if (this.state.budgetOverrideUsd === null) return null;
    if (this.state.budgetOverrideUsd !== undefined) return this.state.budgetOverrideUsd;
    return this.configBudget ?? null;
  }

  /** Set the cap from the app (null = no cap, undefined = back to the config value). */
  setBudget(v: number | null | undefined): void {
    if (v === undefined) delete this.state.budgetOverrideUsd;
    else this.state.budgetOverrideUsd = v;
    // A raised cap may re-arm the notices for this month.
    const cap = this.budgetUsd();
    const spent = this.state.month.costUsd;
    if (cap === null || spent < cap) delete this.state.exceededMonth;
    if (cap === null || spent < cap * this.warnFraction) delete this.state.warnedMonth;
  }

  overBudget(): boolean {
    this.roll();
    const cap = this.budgetUsd();
    return cap !== null && this.state.month.costUsd + 1e-9 >= cap;
  }

  /**
   * The budget notice that is due now, at most once per month each. Marks it
   * given; the caller announces it.
   */
  takeNotice(): BudgetNotice | null {
    this.roll();
    const cap = this.budgetUsd();
    if (cap === null) return null;
    // A hair of slack: float sums (0.7 + 0.1) must still reach 80%.
    const spent = this.state.month.costUsd + 1e-9;
    const m = this.state.monthKey;
    if (spent >= cap) {
      if (this.state.exceededMonth === m) return null;
      this.state.exceededMonth = m;
      this.state.warnedMonth = m;
      return 'budget_exceeded';
    }
    if (spent >= cap * this.warnFraction && this.state.warnedMonth !== m) {
      this.state.warnedMonth = m;
      return 'budget_warning';
    }
    return null;
  }

  summary(): HeraldUsageSummary {
    this.roll();
    const cap = this.budgetUsd();
    return {
      model: this.model,
      priced: this.priced,
      today: { ...this.state.today },
      month: { ...this.state.month },
      monthKey: this.state.monthKey,
      budgetUsd: cap,
      budgetSource:
        this.state.budgetOverrideUsd !== undefined ? 'app' : cap !== null ? 'config' : undefined,
      overBudget: cap !== null && this.state.month.costUsd >= cap,
      resetsAt: nextMonthStart(this.now()),
    };
  }

  toPersisted(): PersistedUsage {
    return {
      ...this.state,
      today: { ...this.state.today },
      month: { ...this.state.month },
    };
  }
}

/** "$0.04", "$1.10", "$0.003": readable money for tiny API bills. */
export function formatUsd(v: number): string {
  if (v > 0 && v < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** Spoken money: "4 cents", "about a tenth of a cent", "1 dollar 10". */
export function spokenUsd(v: number): string {
  if (v <= 0) return 'nothing';
  if (v < 0.005) return 'less than a cent';
  if (v < 1) {
    const c = Math.round(v * 100);
    return c === 1 ? 'about a cent' : `about ${c} cents`;
  }
  const d = Math.floor(v);
  const c = Math.round((v - d) * 100);
  if (c === 0) return `${d} dollar${d === 1 ? '' : 's'}`;
  if (c === 100) return `${d + 1} dollars`;
  return `${d} dollar${d === 1 ? '' : 's'} ${pad(c)}`;
}

/** The deterministic answer to "how much have you cost me?". */
export function usageAnswer(s: HeraldUsageSummary): string {
  if (!s.priced)
    return `I run on ${s.model}, which has no price list here, so I can't put a dollar figure on it. This month: ${s.month.turns} turns.`;
  const parts = [
    `Today I've cost ${spokenUsd(s.today.costUsd)}, and ${spokenUsd(s.month.costUsd)} this month over ${s.month.turns} turn${s.month.turns === 1 ? '' : 's'}.`,
  ];
  if (s.budgetUsd !== null) {
    const pct = Math.round((s.month.costUsd / s.budgetUsd) * 100);
    parts.push(`That's ${pct}% of your ${spokenUsd(s.budgetUsd)} monthly budget.`);
  }
  return parts.join(' ');
}

/** Cache hit rate over input tokens (0..1), or null with no input yet. */
export function cacheHitRate(b: HeraldUsageBucket): number | null {
  const total = b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens;
  return total > 0 ? b.cacheReadTokens / total : null;
}
