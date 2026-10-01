/**
 * Herald's session refs carry the HUB's server id for its own sessions
 * ('local'), not this app's connection id. Map such a ref to the Herald host's
 * connection so chips and "show me" open the right SessionView.
 */
export function resolveHeraldServerId(serverId: string, hostId: string | null, known: readonly string[]): string {
  if (known.includes(serverId)) return serverId;
  return hostId ?? serverId;
}
