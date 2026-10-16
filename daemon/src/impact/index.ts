/**
 * Impact metrics: what Companion costs the box (see protocol.ts). `impact` is
 * the registry every recorder writes to; `startImpact()` (daemon main only)
 * loads the saved history and starts the sampler.
 */
import { registerShutdownCallback } from '../utils';
import { impact } from './state';
import { ImpactSampler, impactFilePath, installLogCounter } from './sampler';
import { ImpactReport } from './protocol';

export { impact } from './state';
export { runSub, trySub, runTmux, tryTmux, dedupeSub, tmuxKind } from './sub';

let sampler: ImpactSampler | null = null;

export function startImpact(): void {
  if (sampler) return;
  const file = impactFilePath();
  const loaded = impact.load(file);
  if (loaded > 0) console.log(`Impact: loaded ${loaded} minute(s) of history from ${file}`);
  installLogCounter();
  sampler = new ImpactSampler();
  sampler.start();
  registerShutdownCallback(() => {
    sampler?.stop();
    impact.save(file);
  });
}

export function getImpactReport(): ImpactReport {
  return impact.report();
}
