/** The process-wide impact registry (one per daemon). */
import { ImpactRegistry } from './registry';
import { isSandbox } from '../sandbox';

export const impact = new ImpactRegistry({ sandbox: isSandbox() });
