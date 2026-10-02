import type { ReviewRiskFlag, ReviewRiskLevel, ReviewTrivialKind } from '../../types/review';

export function formatAgo(at: number | null | undefined, now = Date.now()): string {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "+142 −38" with a real minus sign. */
export function formatStat(add: number, del: number): { add: string; del: string } {
  return { add: `+${add}`, del: `−${del}` };
}

const LEVEL_RANK: Record<ReviewRiskLevel, number> = { high: 3, medium: 2, low: 1 };

export function maxLevel(risks: ReadonlyArray<{ level: ReviewRiskLevel }>): ReviewRiskLevel | null {
  let best: ReviewRiskLevel | null = null;
  for (const r of risks) if (!best || LEVEL_RANK[r.level] > LEVEL_RANK[best]) best = r.level;
  return best;
}

export function sortRisks<T extends ReviewRiskFlag>(risks: T[]): T[] {
  return [...risks].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
}

export const TRIVIAL_LABEL: Record<ReviewTrivialKind, string> = {
  whitespace: 'formatting',
  lockfile: 'lockfile',
  generated: 'generated',
};

export const HOT_HEAT = 70;
