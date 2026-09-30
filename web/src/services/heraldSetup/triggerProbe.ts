/**
 * Device check, trigger step: while it waits, the next remote trigger (a
 * hotkey script, the MX Master button via AutoHotkey, Raycast) is reported
 * here instead of being run, so testing the button does not start Herald
 * listening. Also tells the tips layer a real trigger arrived.
 */
import type { HeraldTriggerAction } from '../../types/herald';

type Probe = (action: HeraldTriggerAction) => void;

let probe: Probe | null = null;

export function setTriggerProbe(p: Probe | null): void {
  probe = p;
}

/** True when the device check took this trigger (do not run it). */
export function probeTrigger(action: HeraldTriggerAction): boolean {
  if (!probe) return false;
  probe(action);
  return true;
}
