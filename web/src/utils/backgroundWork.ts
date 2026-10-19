import type { BackgroundWork } from '../types';

/**
 * Label for a session whose main thread ended its turn while background agents
 * / shells keep running ("Agents working · 2 running"). null = no background work.
 */
export function backgroundWorkLabel(bg: BackgroundWork | undefined | null): string | null {
  if (!bg) return null;
  const agents = Math.max(0, bg.agents | 0);
  const shells = Math.max(0, bg.shells | 0);
  if (agents > 0) {
    return `Agents working · ${agents} running${shells > 0 ? ` · ${shells} shell${shells === 1 ? '' : 's'}` : ''}`;
  }
  if (shells > 0) return `Shells working · ${shells} running`;
  return null;
}
