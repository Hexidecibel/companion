/**
 * Sandbox / shared-state switches for running a second daemon (e.g.
 * bin/herald-sandbox) next to production on the same machine.
 *
 *   COMPANION_SANDBOX=1                  -> sandbox mode: implies read-only shared
 *                                           state, and disables push notifications
 *                                           (no device registration, no sends) and
 *                                           tool auto-approval, so the user never
 *                                           gets duplicate pushes and a pending tool
 *                                           is never approved twice.
 *   COMPANION_READONLY_SHARED_STATE=1    -> never write state files that live in the
 *                                           shared code_home (~/.claude/companion-
 *                                           session-mappings.json and companion-
 *                                           sessions-snapshot.json), which the
 *                                           production daemon owns. Reads still work.
 *
 * Read at call time (not cached) so tests can toggle them.
 */

export function isSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPANION_SANDBOX === '1';
}

export function isReadonlySharedState(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPANION_READONLY_SHARED_STATE === '1' || isSandbox(env);
}
