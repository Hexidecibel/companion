import { useState } from 'react';
import type { HeraldBrainStatus, HeraldUsageBucket, HeraldUsageSummary } from '../../types/herald';

/** "$0.04", "$1.10", "$0.003": readable money for tiny API bills. */
export function formatUsd(v: number): string {
  if (v > 0 && v < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** Share of input tokens served from the prompt cache (0..1), or null with no input yet. */
export function cacheHitRate(b: HeraldUsageBucket): number | null {
  const total = b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens;
  return total > 0 ? b.cacheReadTokens / total : null;
}

/** "Today $0.04 · Month $1.10" (the menu line). */
export function usageLine(u: HeraldUsageSummary): string {
  if (!u.priced) return `This month: ${u.month.turns} turn${u.month.turns === 1 ? '' : 's'}`;
  return `Today ${formatUsd(u.today.costUsd)} · Month ${formatUsd(u.month.costUsd)}`;
}

function monthDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * API spend in the Herald menu: a one-line meter that opens a small details
 * view (turns, average per turn, cache hit rate) and the monthly budget.
 */
export function HeraldUsageMeter({
  usage,
  onBudget,
}: {
  usage: HeraldUsageSummary | undefined;
  /** USD cap, null = no cap, undefined = back to the server config. Resolves to an error text or null. */
  onBudget: (monthlyUsd: number | null | undefined) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!usage) return null;
  const m = usage.month;
  const avg = m.turns > 0 ? m.costUsd / m.turns : null;
  const hit = cacheHitRate(m);
  const cap = usage.budgetUsd;
  const pct = cap ? Math.min(999, Math.round((m.costUsd / cap) * 100)) : null;
  const level = usage.overBudget ? 'over' : pct !== null && pct >= 80 ? 'warn' : 'ok';

  const save = async (value: number | null | undefined) => {
    setSaving(true);
    setErr(null);
    const e = await onBudget(value);
    setSaving(false);
    if (e) setErr(e);
    else setDraft('');
  };
  const submit = () => {
    const v = Number(draft.replace(/[$\s]/g, ''));
    if (!Number.isFinite(v) || v <= 0 || v > 10000) {
      setErr('Enter a dollar amount, e.g. 5');
      return;
    }
    void save(Math.round(v * 100) / 100);
  };

  return (
    <div className={`herald-usage herald-usage--${level}`}>
      <button
        type="button"
        className="herald-usage__line"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="API usage (Anthropic). Click for details and the monthly budget."
      >
        <span>{usageLine(usage)}</span>
        {pct !== null && <span className="herald-usage__pct">{pct}% of {formatUsd(cap!)}</span>}
      </button>
      {open && (
        <div className="herald-usage__details">
          <dl className="herald-usage__grid">
            <dt>Turns this month</dt>
            <dd>{m.turns}{m.requests > m.turns ? ` (${m.requests} calls)` : ''}</dd>
            {usage.priced && (
              <>
                <dt>Average per turn</dt>
                <dd>{avg === null ? '–' : formatUsd(avg)}</dd>
              </>
            )}
            <dt>Cache hit rate</dt>
            <dd>{hit === null ? '–' : `${Math.round(hit * 100)}%`}</dd>
            <dt>Today</dt>
            <dd>
              {usage.today.turns} turn{usage.today.turns === 1 ? '' : 's'}
              {usage.priced ? `, ${formatUsd(usage.today.costUsd)}` : ''}
            </dd>
          </dl>
          {usage.priced && (
            <div className="herald-usage__budget">
              <div className="herald-usage__budget-text">
                {cap === null
                  ? 'No monthly budget.'
                  : usage.overBudget
                    ? `Budget of ${formatUsd(cap)} reached: answering without the AI until ${monthDay(usage.resetsAt)}.`
                    : `Budget ${formatUsd(cap)} a month (${pct}% used). Warns at 80%.`}
              </div>
              <div className="herald-usage__budget-row">
                <label className="sr-only" htmlFor="herald-budget-input">Monthly budget in dollars</label>
                <input
                  id="herald-budget-input"
                  className="herald-usage__input"
                  inputMode="decimal"
                  placeholder={cap === null ? 'e.g. 5' : String(cap)}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') submit();
                  }}
                  disabled={saving}
                />
                <button type="button" className="herald-btn herald-btn--ghost herald-btn--sm" onClick={submit} disabled={saving || !draft.trim()}>
                  {cap === null ? 'Set' : 'Change'}
                </button>
                {cap !== null && (
                  <button type="button" className="herald-btn herald-btn--ghost herald-btn--sm" onClick={() => void save(null)} disabled={saving}>
                    Remove
                  </button>
                )}
              </div>
              {usage.budgetSource === 'app' && (
                <button type="button" className="herald-usage__link" onClick={() => void save(undefined)} disabled={saving}>
                  Use the server's setting
                </button>
              )}
              {err && <div className="herald-usage__err" role="alert">{err}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const REASON_SHORT: Record<string, string> = {
  budget: 'budget reached',
  credit: 'out of credit',
  auth: 'key rejected',
  rate_limited: 'rate limited',
  unreachable: 'API unreachable',
  timeout: 'API not answering',
  server: 'API trouble',
  bad_request: 'request refused',
  other: 'API trouble',
};

/** Header badge while the brain is down: Herald answers from session data only. */
export function HeraldBrainBadge({ brain }: { brain: HeraldBrainStatus | undefined }) {
  if (!brain || brain.state !== 'degraded') return null;
  const short = REASON_SHORT[brain.reason ?? 'other'] ?? 'offline';
  const retry =
    brain.retryAt && brain.reason !== 'budget'
      ? ` Retrying automatically.`
      : brain.reason === 'budget'
        ? ' Raise the cap in the menu to resume.'
        : '';
  return (
    <span
      className="herald-brain-badge"
      role="status"
      title={`Brain offline (${brain.detail ?? short}). Answers come from session data without the AI.${retry}`}
    >
      Offline: {short}
    </span>
  );
}
