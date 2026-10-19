/**
 * Glue between the subagent tracker and the app's sessions: app session (tmux)
 * <-> conversation ids, display names, and the "where's it at" facts used by the
 * subagent_rollup handler (MCP), Herald's subagent_status tool and the inbox
 * alerts. In-memory lookups only (watcher maps, the session name store, tracker
 * records): no fs, no subprocess.
 */

import * as os from 'os';
import * as path from 'path';
import type { SubagentTracker } from './tracker';
import { convOfAgentFile } from './tracker';
import type { SubagentFacts, SubagentSessionLabel } from './protocol';
import { buildFacts, FACTS_DEFAULTS, projectLabelOf, type FactsLabel } from './facts';

export interface SubagentLinkDeps {
  watcher: {
    getConversationInfo(sessionId: string): { path: string } | null;
    getConversationIdsForSession(tmuxSessionName: string): string[];
    getTmuxSessionForConversation(conversationId: string): string | null;
  };
  /** Friendly name of an app session (undefined = use the tmux name). */
  sessionName: (sessionId: string) => string | undefined;
  tracker: () => SubagentTracker | null;
  home?: string;
  now?: () => number;
}

/** An app session id (tmux name) -> its conversation ids (plus the key itself: it may be one). */
export function convsForSession(deps: SubagentLinkDeps, key: string): string[] {
  const out = new Set<string>([key]);
  const info = deps.watcher.getConversationInfo(key);
  const base = info?.path.split('/').pop()?.replace('.jsonl', '');
  if (base) out.add(base);
  for (const id of deps.watcher.getConversationIdsForSession(key)) out.add(id);
  return [...out];
}

/** The app session a conversation runs in, or null (not a Companion session). */
export function sessionOf(
  deps: SubagentLinkDeps,
  conversationId: string
): { sessionId: string; sessionName: string } | null {
  const tmux = deps.watcher.getTmuxSessionForConversation(conversationId);
  if (!tmux) return null;
  return { sessionId: tmux, sessionName: deps.sessionName(tmux) || tmux };
}

function projectOf(deps: SubagentLinkDeps, conversationId: string): string {
  const t = deps.tracker();
  const rec = t?.list([conversationId])[0];
  if (!rec) return 'a project';
  const { convPath } = convOfAgentFile(rec.filePath);
  return projectLabelOf(path.basename(path.dirname(convPath)), deps.home ?? os.homedir());
}

export function factsLabel(deps: SubagentLinkDeps, conversationId: string): FactsLabel {
  const s = sessionOf(deps, conversationId);
  if (s) return { session: s.sessionName, sessionId: s.sessionId };
  return { session: `a session in ${projectOf(deps, conversationId)}` };
}

/** Labels for the conversations of a subagent_list (all-sessions views). In-memory only. */
export function sessionLabels(
  deps: SubagentLinkDeps,
  conversationIds: Iterable<string>
): Record<string, SubagentSessionLabel> {
  const out: Record<string, SubagentSessionLabel> = {};
  for (const conv of conversationIds) {
    if (out[conv]) continue;
    const project = projectOf(deps, conv);
    const s = sessionOf(deps, conv);
    const label: SubagentSessionLabel = s
      ? { session: s.sessionName, sessionId: s.sessionId }
      : { session: `a session in ${project}` };
    if (project !== 'a project') label.project = project;
    out[conv] = label;
  }
  return out;
}

/** Facts for one app session (every retained agent) or for every session (recent ones). */
export function factsFor(deps: SubagentLinkDeps, sessionKey?: string): SubagentFacts | null {
  const t = deps.tracker();
  if (!t) return null;
  const convs = sessionKey ? convsForSession(deps, sessionKey) : null;
  const agents = t.list(convs).map((r) => t.summary(r));
  return buildFacts(agents, (deps.now ?? Date.now)(), {
    label: (c) => factsLabel(deps, c),
    finishedWithinMs: sessionKey ? 0 : FACTS_DEFAULTS.finishedWithinMs,
  });
}
