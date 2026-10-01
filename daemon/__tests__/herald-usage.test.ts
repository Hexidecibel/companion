import {
  cacheHitRate,
  costOf,
  DEFAULT_PRICING,
  formatUsd,
  ratesFor,
  sanitizeUsage,
  spokenUsd,
  usageAnswer,
  UsageMeter,
} from '../src/herald/usage';
import { parseHeraldConfigBlock, resolveHeraldConfig, resolvePricing } from '../src/herald/config';
import {
  classifyFallback,
  fallbackReply,
  isUsageQuestion,
  outageReason,
  recoveryDelayMs,
} from '../src/herald/fallback';
import { LlmError, LlmErrorCode } from '../src/herald/llm/provider';
import { sanitizeState } from '../src/herald/store';
import { snap } from './herald-helpers';

const HAIKU = DEFAULT_PRICING['claude-haiku-4-5'];

describe('pricing', () => {
  it('Haiku 4.5 default rates: $1 in, $5 out, 1.25x / 2x writes, 0.1x reads', () => {
    expect(HAIKU).toEqual({ input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 });
    expect(ratesFor('claude-haiku-4-5-20251001')).toBe(HAIKU);
    expect(ratesFor('qwen3-8b')).toBeNull();
  });

  it('cost of a cached vs uncached turn', () => {
    const uncached = costOf({ inputTokens: 5800, outputTokens: 40 }, HAIKU);
    const cold = costOf({ inputTokens: 400, outputTokens: 40, cacheCreationInputTokens: 5400 }, HAIKU);
    const warm = costOf({ inputTokens: 400, outputTokens: 40, cacheReadInputTokens: 5400 }, HAIKU);
    expect(uncached).toBeCloseTo(0.006, 6);
    expect(cold).toBeCloseTo(0.00735, 6);
    expect(warm).toBeCloseTo(0.00114, 6);
    expect(costOf({ cacheCreationInputTokens: 1_000_000 }, HAIKU, '1h')).toBeCloseTo(2, 6);
  });

  it('herald.pricing overrides the configured model (rates from config, not logic)', () => {
    const block = parseHeraldConfigBlock({
      provider: 'anthropic',
      pricing: { input_per_mtok: 2, cache_read_per_mtok: 0.2, bogus: 1, output_per_mtok: -1 },
    });
    expect(block?.pricing).toEqual({ input_per_mtok: 2, cache_read_per_mtok: 0.2 });
    const t = resolvePricing('claude-haiku-4-5', block!.pricing);
    expect(t['claude-haiku-4-5']).toEqual({ input: 2, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.2 });
    // An unknown model needs input + output; cache rates then follow the multipliers.
    const local = resolvePricing('my-model', { input_per_mtok: 0.5, output_per_mtok: 1 });
    expect(local['my-model']).toEqual({ input: 0.5, output: 1, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 });
  });

  it('config: budget, cache ttl, prompt_cache off', () => {
    const env = { ANTHROPIC_API_KEY: 'x' };
    const on = resolveHeraldConfig(parseHeraldConfigBlock({ provider: 'anthropic', monthly_budget_usd: 5, cache_ttl: '1h' }), env);
    expect(on.monthlyBudgetUsd).toBe(5);
    expect(on.promptCache).toEqual({ ttl: '1h' });
    const def = resolveHeraldConfig(parseHeraldConfigBlock({ provider: 'anthropic' }), env);
    expect(def.promptCache).toEqual({ ttl: '5m' });
    expect(def.monthlyBudgetUsd).toBeUndefined();
    const off = resolveHeraldConfig(parseHeraldConfigBlock({ provider: 'anthropic', prompt_cache: false, monthly_budget_usd: -3 }), env);
    expect(off.promptCache).toBeUndefined();
    expect(off.monthlyBudgetUsd).toBeUndefined();
  });

  it('money formatting', () => {
    expect(formatUsd(0.04)).toBe('$0.04');
    expect(formatUsd(0.0031)).toBe('$0.003');
    expect(formatUsd(1.1)).toBe('$1.10');
    expect(spokenUsd(0)).toBe('nothing');
    expect(spokenUsd(0.003)).toBe('less than a cent');
    expect(spokenUsd(0.04)).toBe('about 4 cents');
    expect(spokenUsd(1.1)).toBe('1 dollar 10');
    expect(spokenUsd(5)).toBe('5 dollars');
  });
});

describe('UsageMeter', () => {
  // Local-time clock: Sep 30 23:59, then Oct 1.
  const t0 = new Date(2026, 8, 30, 23, 50).getTime();

  it('accumulates day + month, counts turns, computes the cache hit rate', () => {
    let now = t0;
    const m = new UsageMeter(undefined, { model: 'claude-haiku-4-5', now: () => now });
    m.recordRequest({ inputTokens: 400, outputTokens: 40, cacheCreationInputTokens: 5400 });
    m.recordTurn();
    m.recordRequest({ inputTokens: 400, outputTokens: 40, cacheReadInputTokens: 5400 });
    m.recordTurn();
    const s = m.summary();
    expect(s.today.turns).toBe(2);
    expect(s.today.requests).toBe(2);
    expect(s.month.costUsd).toBeCloseTo(0.00735 + 0.00114, 6);
    expect(cacheHitRate(s.month)).toBeCloseTo(5400 / 11600, 6);
    expect(s.budgetUsd).toBeNull();
    expect(s.priced).toBe(true);
    now += 1;
  });

  it('day and month roll over at local midnight / month start', () => {
    let now = t0;
    const m = new UsageMeter(undefined, { model: 'claude-haiku-4-5', now: () => now, configBudgetUsd: 1 });
    m.recordRequest({ inputTokens: 1_000_000 }); // $1: at the cap
    expect(m.overBudget()).toBe(true);
    expect(m.summary().monthKey).toBe('2026-09');
    now = new Date(2026, 9, 1, 0, 1).getTime();
    expect(m.overBudget()).toBe(false);
    const s = m.summary();
    expect(s.monthKey).toBe('2026-10');
    expect(s.month.costUsd).toBe(0);
    expect(s.today.costUsd).toBe(0);
    expect(s.resetsAt).toBe(new Date(2026, 10, 1).getTime());
    // Same month, next day: month keeps, day resets.
    m.recordRequest({ inputTokens: 100_000 });
    now = new Date(2026, 9, 2, 9).getTime();
    expect(m.summary().today.costUsd).toBe(0);
    expect(m.summary().month.costUsd).toBeCloseTo(0.1, 6);
  });

  it('80% warns once, 100% once, per month; raising the cap re-arms', () => {
    let now = t0 - 86_400_000; // Sep 29
    const m = new UsageMeter(undefined, { model: 'claude-haiku-4-5', now: () => now, configBudgetUsd: 1 });
    m.recordRequest({ inputTokens: 700_000 });
    expect(m.takeNotice()).toBeNull();
    m.recordRequest({ inputTokens: 100_000 }); // 80%
    expect(m.takeNotice()).toBe('budget_warning');
    expect(m.takeNotice()).toBeNull();
    m.recordRequest({ inputTokens: 250_000 }); // 105%
    expect(m.takeNotice()).toBe('budget_exceeded');
    expect(m.takeNotice()).toBeNull();
    expect(m.overBudget()).toBe(true);
    // Raise the cap from the app: back under, notices re-arm.
    m.setBudget(2);
    expect(m.overBudget()).toBe(false);
    expect(m.summary().budgetSource).toBe('app');
    m.recordRequest({ inputTokens: 600_000 }); // 1.65 of 2 = 82%
    expect(m.takeNotice()).toBe('budget_warning');
    // No cap at all.
    m.setBudget(null);
    expect(m.budgetUsd()).toBeNull();
    expect(m.overBudget()).toBe(false);
    // Back to config.
    m.setBudget(undefined);
    expect(m.budgetUsd()).toBe(1);
    // Next month: everything re-arms.
    now = new Date(2026, 9, 3).getTime();
    m.recordRequest({ inputTokens: 900_000 });
    expect(m.takeNotice()).toBe('budget_warning');
  });

  it('persists and restores (tolerant of junk)', () => {
    const now = t0;
    const m = new UsageMeter(undefined, { model: 'claude-haiku-4-5', now: () => now });
    m.recordRequest({ inputTokens: 10, outputTokens: 2 });
    m.setBudget(3);
    const p = m.toPersisted();
    const restored = sanitizeUsage(JSON.parse(JSON.stringify(p)));
    expect(restored).toEqual(p);
    expect(sanitizeUsage({ day: 'nope', monthKey: '2026-09' })).toBeUndefined();
    expect(sanitizeUsage({ day: '2026-09-30', monthKey: '2026-09', today: { costUsd: -5, turns: 'x' }, budgetOverrideUsd: -1 })).toEqual({
      day: '2026-09-30',
      monthKey: '2026-09',
      today: expect.objectContaining({ costUsd: 0, turns: 0 }),
      month: expect.objectContaining({ costUsd: 0 }),
    });
    const st = sanitizeState({ messages: [], heard: [], actions: [], usage: p }, now);
    expect(st.usage).toEqual(p);
  });

  it('unpriced model (local server): turns count, cost stays 0, honest answer', () => {
    const m = new UsageMeter(undefined, { model: 'qwen3', now: () => t0 });
    m.recordRequest({ inputTokens: 5000 });
    m.recordTurn();
    expect(m.summary().month.costUsd).toBe(0);
    expect(usageAnswer(m.summary())).toMatch(/no price list/);
  });

  it('usage answer mentions the budget share', () => {
    const m = new UsageMeter(undefined, { model: 'claude-haiku-4-5', now: () => t0, configBudgetUsd: 5 });
    m.recordRequest({ inputTokens: 40_000 });
    m.recordTurn();
    expect(usageAnswer(m.summary())).toBe(
      "Today I've cost about 4 cents, and about 4 cents this month over 1 turn. That's 1% of your 5 dollars monthly budget."
    );
  });
});

describe('fallback brain', () => {
  it('every error class maps to an outage reason (abort is not an outage)', () => {
    const cases: [LlmErrorCode, string | null][] = [
      ['unreachable', 'unreachable'],
      ['timeout', 'timeout'],
      ['auth', 'auth'],
      ['credit', 'credit'],
      ['rate_limited', 'rate_limited'],
      ['overloaded', 'server'],
      ['server', 'server'],
      ['bad_request', 'bad_request'],
      ['protocol', 'other'],
      ['aborted', null],
    ];
    for (const [code, reason] of cases) expect(outageReason(new LlmError(code, 'x'))).toBe(reason);
    expect(outageReason(new Error('?'))).toBe('other');
  });

  it('recovery backs off, and faster for transient trouble', () => {
    expect(recoveryDelayMs('unreachable', 1)).toBe(10_000);
    expect(recoveryDelayMs('unreachable', 2)).toBe(20_000);
    expect(recoveryDelayMs('credit', 1)).toBe(60_000);
    expect(recoveryDelayMs('credit', 50)).toBe(600_000);
  });

  it('classifies what the user asked', () => {
    expect(classifyFallback('Anything for me?')).toBe('brief');
    expect(classifyFallback('what did I miss')).toBe('brief');
    expect(classifyFallback('x', 'brief')).toBe('brief');
    expect(classifyFallback("what's the status")).toBe('status');
    expect(classifyFallback("what's everyone doing?")).toBe('status');
    expect(classifyFallback('how much have you cost me')).toBe('usage');
    expect(classifyFallback('tell companion to run the tests')).toBe('other');
    expect(isUsageQuestion('How much have you cost me this month?')).toBe(true);
    expect(isUsageQuestion("what's my API bill")).toBe(true);
    expect(isUsageQuestion('how much is left on the deploy')).toBe(false);
  });

  const sessions = [
    snap({ sessionId: 'companion', status: 'waiting', pendingApproval: { tool: 'Bash', detail: 'npm run deploy', toolUseId: 't' } as never, lastActivity: 3 }),
    snap({ sessionId: 'docs', status: 'working', currentActivity: 'Running the build', lastActivity: 2 }),
    snap({ sessionId: 'api', status: 'idle', lastActivity: 1 }),
  ];
  const items = [
    { id: '1', serverId: 'local', sessionId: 'docs', sessionName: 'docs', priority: 'finished' as const, headline: 'docs finished: Published the site.', createdAt: 2, heard: false },
    { id: '2', serverId: 'local', sessionId: 'companion', sessionName: 'companion', priority: 'blocked' as const, headline: 'companion is asking: Which approach?', createdAt: 1, heard: false },
  ];

  it('first answer of an outage says why; later ones stay short', () => {
    const first = fallbackReply({ kind: 'other', reason: 'credit', announce: true, snapshots: sessions, briefing: [] });
    expect(first).toBe("My brain's offline right now (out of API credit) — here's what's waiting: companion wants your OK to run a shell command.");
    const later = fallbackReply({ kind: 'other', reason: 'credit', announce: false, snapshots: sessions, briefing: [] });
    expect(later).toBe("Still offline — here's what's waiting: companion wants your OK to run a shell command.");
  });

  it('brief: headlines, most urgent first; status: one line per session', () => {
    const sorted = [items[1], items[0]];
    expect(fallbackReply({ kind: 'brief', reason: 'unreachable', announce: false, snapshots: sessions, briefing: sorted })).toBe(
      'companion is asking: Which approach? docs finished: Published the site.'
    );
    expect(fallbackReply({ kind: 'brief', reason: 'budget', announce: true, snapshots: sessions, briefing: [] })).toBe(
      "My brain's offline right now (this month's API budget is used up), so here's the short version. Nothing new."
    );
    expect(fallbackReply({ kind: 'status', reason: 'timeout', announce: false, snapshots: sessions, briefing: [] })).toBe(
      '3 sessions. companion wants your OK to run a shell command. docs is working: Running the build. api is idle.'
    );
  });
});
