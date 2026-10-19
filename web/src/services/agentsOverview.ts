/**
 * All-sessions "Agents" page model (pure): which sessions get a card, in what
 * order, which rows show, what folds away. "Where's it at?" in ~2 seconds:
 * only sessions with a running agent or one that finished in the last 2 h,
 * attention (stuck / failed) pinned on top, at most MAX_ROWS agent rows per
 * card, finished agents folded into "N done", finished-only sessions folded
 * into one bottom line. No transcript text: names, states, counters and a
 * short deterministic activity phrase.
 */
import type { SessionSummary } from '../types';
import type { SubagentSessionLabel, SubagentStatus, SubagentSummary } from '../types/subagents';
import { isActiveStatus } from './subagents';

export const RECENT_MS = 2 * 60 * 60 * 1000;
/** Active agent rows visible per card before "+N more". */
export const MAX_ROWS = 5;
export const MAX_ACTIVITY_WORDS = 6;
const MAX_INDENT = 3;
const QUIET_MS = 3 * 60 * 1000;

export type AgentTone = 'running' | 'waiting' | 'stuck' | 'done' | 'unconfirmed' | 'failed' | 'stopped' | 'lost';

export interface AgentRow {
  agentId: string;
  serverId: string;
  name: string;
  indent: number;
  tone: AgentTone;
  /** Upper-case chip for the exceptional states ("STUCK 6m", "FAILED"); none for plain running/done. */
  chip?: string;
  /** "12m" (active: since start; finished: how long it took). */
  elapsed: string;
  /** At most ~6 words. */
  activity: string;
  active: boolean;
  summary: SubagentSummary;
}

export interface SessionCard {
  key: string;
  serverId: string;
  conversationId: string;
  title: string;
  /** One line under the title (the main thread's current activity, else the project). */
  subtitle?: string;
  /** App session to open (SessionSummary.id); absent = not a Companion session. */
  openSessionId?: string;
  done: number;
  total: number;
  running: number;
  attention: boolean;
  /** Newest activity of any agent in the card. */
  lastActivity: number;
  /** Visible active rows (tree order, at most MAX_ROWS). */
  rows: AgentRow[];
  /** Active rows behind "+N more". */
  moreRows: AgentRow[];
  /** Finished rows behind "N done" (newest first). */
  finished: AgentRow[];
}

export interface AttentionItem {
  key: string;
  serverId: string;
  agentId: string;
  sessionTitle: string;
  openSessionId?: string;
  name: string;
  kind: 'stuck' | 'failed';
  chip: string;
  /** Short why ("same test failing 4x"). */
  detail: string;
  at: number;
}

export interface ServerGroup {
  serverId: string;
  serverName: string;
  cards: SessionCard[];
  /** Sessions whose agents all finished (no failure) in the window. */
  finishedOnly: SessionCard[];
}

export interface AgentsOverview {
  running: number;
  stuck: number;
  failed: number;
  attention: AttentionItem[];
  groups: ServerGroup[];
  /** Show server headings (more than one server has something to show). */
  multiServer: boolean;
  /** Nothing running anywhere. */
  idle: boolean;
  /** Text for the idle state ("Nothing running. Last batch finished 14 min ago in companion."). */
  emptyLine?: string;
}

export interface OverviewServerInput {
  serverId: string;
  serverName: string;
  agents: SubagentSummary[];
  labels?: Record<string, SubagentSessionLabel>;
  /** The server's session list (get_server_summary), to link cards to sessions. */
  sessions?: SessionSummary[];
}

/** Compact elapsed: "45s", "12m", "2h 5m". */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** "14 min ago" style for the idle line. */
export function agoText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`;
}

/** First N words, ellipsis when cut. */
export function clipWords(text: string, max = MAX_ACTIVITY_WORDS): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= max) return words.join(' ');
  return `${words.slice(0, max).join(' ')}…`;
}

const TEST_RE = /\b(jest|vitest|pytest|mocha|playwright|cargo test|go test|npm (?:run )?test|bin\/test|rspec|phpunit)\b/i;
const BUILD_RE = /\b(tsc|typecheck|npm run build|cargo build|vite build|eslint|lint)\b/i;

function baseName(p: string): string {
  const first = p.trim().split(/\s+/)[0] || '';
  const b = first.split('/').filter(Boolean).pop() || first;
  return b.length > 32 ? `${b.slice(0, 31)}…` : b;
}

function testsBit(s: SubagentSummary): string | null {
  const t = s.tests;
  if (!t || !t.runs) return null;
  return t.lastFailed ? `${t.failed} failing` : 'passing';
}

/** What an agent is doing, in at most ~6 words. Never raw transcript prose. */
export function shortActivity(s: SubagentSummary, now: number): string {
  const active = isActiveStatus(s.status);
  if (!active) {
    switch (s.status) {
      case 'done':
        return 'done';
      case 'done_unconfirmed':
        return 'seems done';
      case 'failed':
        return 'failed';
      case 'stopped':
        return 'stopped';
      case 'lost':
        return `silent ${shortDuration(now - s.lastEntryAt)}`;
      default:
        return '';
    }
  }
  if (s.stuck) return clipWords(s.stuck.headline);
  if (s.status === 'starting') return 'starting';
  if (s.status === 'waiting_child') return 'waiting on subagents';
  const tool = s.pendingTool;
  const act = s.activity || '';
  if (tool) {
    const since = s.pendingSince ? now - s.pendingSince : 0;
    if (tool === 'Bash') {
      if (TEST_RE.test(act)) {
        const m = TEST_RE.exec(act)![1].toLowerCase();
        const bit = testsBit(s);
        return clipWords(bit ? `${m} (${bit})` : `running ${m}`);
      }
      if (BUILD_RE.test(act)) return /\b(tsc|typecheck)\b/i.test(act) ? 'typecheck' : /lint/i.test(act) ? 'linting' : 'building';
      if (since >= QUIET_MS) return `command, ${shortDuration(since)}`;
      return 'running a command';
    }
    if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit')
      return act ? `editing ${baseName(act)}` : 'editing files';
    if (tool === 'Read') return act ? `reading ${baseName(act)}` : 'reading code';
    if (tool === 'Grep' || tool === 'Glob' || tool === 'LS') return 'searching code';
    if (tool === 'WebFetch' || tool === 'WebSearch') return 'researching online';
    if (tool === 'Agent' || tool === 'Task') return 'dispatching a subagent';
    if (tool === 'TodoWrite') return 'updating its plan';
    return clipWords(`using ${tool}`);
  }
  const idle = now - Math.max(s.lastEntryAt, s.pendingSince ?? 0);
  if (idle >= QUIET_MS) return `quiet ${shortDuration(idle)}`;
  if (s.checklist && s.checklist.total > 0)
    return `step ${Math.min(s.checklist.done + 1, s.checklist.total)}/${s.checklist.total}`;
  const bit = testsBit(s);
  if (bit) return `tests ${bit}`;
  return 'thinking';
}

function toneOf(s: SubagentSummary): AgentTone {
  if (isActiveStatus(s.status)) {
    if (s.stuck) return 'stuck';
    return s.status === 'waiting_child' ? 'waiting' : 'running';
  }
  switch (s.status as SubagentStatus) {
    case 'done':
      return 'done';
    case 'done_unconfirmed':
      return 'unconfirmed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'lost';
  }
}

function endOf(s: SubagentSummary): number {
  return s.endedAt ?? s.lastEntryAt;
}

function activityAt(s: SubagentSummary): number {
  return Math.max(s.lastEntryAt, s.pendingSince ?? 0, s.endedAt ?? 0, s.startedAt);
}

export function inWindow(s: SubagentSummary, now: number, windowMs = RECENT_MS): boolean {
  return isActiveStatus(s.status) || now - endOf(s) <= windowMs;
}

function rowOf(s: SubagentSummary, serverId: string, indent: number, now: number): AgentRow {
  const active = isActiveStatus(s.status);
  const tone = toneOf(s);
  const row: AgentRow = {
    agentId: s.agentId,
    serverId,
    name: (s.name || s.agentId.slice(0, 8)).replace(/\s+/g, ' ').trim(),
    indent,
    tone,
    elapsed: shortDuration((active ? now : endOf(s)) - s.startedAt),
    activity: shortActivity(s, now),
    active,
    summary: s,
  };
  if (tone === 'stuck') row.chip = `STUCK ${shortDuration(now - (s.stuck?.since ?? s.startedAt))}`;
  else if (tone === 'failed') row.chip = 'FAILED';
  return row;
}

/** Active agents in tree order (parents before children, newest activity first), with indents. */
function activeTree(active: SubagentSummary[]): Array<{ s: SubagentSummary; indent: number }> {
  const ids = new Set(active.map((a) => a.agentId));
  const kids = new Map<string, SubagentSummary[]>();
  const roots: SubagentSummary[] = [];
  for (const a of active) {
    const p = a.parentAgentId;
    if (p && p !== a.agentId && ids.has(p)) {
      const l = kids.get(p) || [];
      l.push(a);
      kids.set(p, l);
    } else roots.push(a);
  }
  const cmp = (a: SubagentSummary, b: SubagentSummary) =>
    Number(!!b.stuck) - Number(!!a.stuck) || activityAt(b) - activityAt(a);
  const out: Array<{ s: SubagentSummary; indent: number }> = [];
  const seen = new Set<string>();
  const walk = (list: SubagentSummary[], indent: number) => {
    for (const a of [...list].sort(cmp)) {
      if (seen.has(a.agentId)) continue;
      seen.add(a.agentId);
      out.push({ s: a, indent: Math.min(indent, MAX_INDENT) });
      const c = kids.get(a.agentId);
      if (c) walk(c, indent + 1);
    }
  };
  walk(roots, 0);
  for (const a of active) if (!seen.has(a.agentId)) out.push({ s: a, indent: 0 });
  return out;
}

function findSession(
  sessions: SessionSummary[] | undefined,
  conv: string,
  label: SubagentSessionLabel | undefined,
): SessionSummary | undefined {
  if (!sessions) return undefined;
  const sid = label?.sessionId;
  return sessions.find(
    (s) => (sid && (s.id === sid || s.tmuxSessionName === sid)) || s.id === conv,
  );
}

function titleOf(conv: string, label: SubagentSessionLabel | undefined, session: SessionSummary | undefined): string {
  if (session) return session.friendlyName || session.name || session.id;
  if (label) {
    if (label.sessionId) return label.session;
    if (label.project) return tidyProject(label.project)!;
    return label.session.replace(/^a session in /, '');
  }
  return `session ${conv.slice(0, 8)}`;
}

/** "home-hexi-local-src-out4" (a daemon whose HOME differs from the transcripts') -> "out4". */
export function tidyProject(project: string | undefined): string | undefined {
  if (!project) return undefined;
  const t = project.replace(/^(?:home|Users)-[^-]+-(?:local-src-|src-|code-|projects-)?/, '');
  return t || project;
}

function subtitleOf(title: string, label: SubagentSessionLabel | undefined, session: SessionSummary | undefined): string | undefined {
  if (session?.status === 'working' && session.currentActivity) return clipWords(session.currentActivity, 8);
  const project = tidyProject(label?.project);
  if (project && project.toLowerCase() !== title.toLowerCase()) return project;
  return undefined;
}

export function buildAgentsOverview(servers: OverviewServerInput[], now: number): AgentsOverview {
  const attention: AttentionItem[] = [];
  const groups: ServerGroup[] = [];
  let running = 0;
  let stuck = 0;
  let failed = 0;
  let lastFinished: { at: number; title: string } | null = null;

  for (const srv of servers) {
    const byConv = new Map<string, SubagentSummary[]>();
    for (const a of srv.agents) {
      if (!inWindow(a, now)) continue;
      const l = byConv.get(a.sessionId);
      if (l) l.push(a);
      else byConv.set(a.sessionId, [a]);
    }
    const cards: SessionCard[] = [];
    for (const [conv, list] of byConv) {
      const label = srv.labels?.[conv];
      const session = findSession(srv.sessions, conv, label);
      const title = titleOf(conv, label, session);
      const openSessionId = session?.id ?? label?.sessionId;
      const active = list.filter((a) => isActiveStatus(a.status));
      const fin = list
        .filter((a) => !isActiveStatus(a.status))
        .sort((a, b) => endOf(b) - endOf(a));
      const tree = activeTree(active).map(({ s, indent }) => rowOf(s, srv.serverId, indent, now));
      const finished = fin.map((s) => rowOf(s, srv.serverId, 0, now));
      const cardStuck = active.filter((a) => a.stuck);
      const cardFailed = fin.filter((a) => a.status === 'failed');
      running += active.length;
      stuck += cardStuck.length;
      failed += cardFailed.length;
      for (const a of cardStuck)
        attention.push({
          key: `${srv.serverId}:${a.agentId}`,
          serverId: srv.serverId,
          agentId: a.agentId,
          sessionTitle: title,
          openSessionId,
          name: a.name || a.agentId.slice(0, 8),
          kind: 'stuck',
          chip: `STUCK ${shortDuration(now - (a.stuck!.since || a.startedAt))}`,
          detail: clipWords(a.stuck!.headline, 8),
          at: a.stuck!.since || a.startedAt,
        });
      for (const a of cardFailed)
        attention.push({
          key: `${srv.serverId}:${a.agentId}`,
          serverId: srv.serverId,
          agentId: a.agentId,
          sessionTitle: title,
          openSessionId,
          name: a.name || a.agentId.slice(0, 8),
          kind: 'failed',
          chip: 'FAILED',
          detail: a.notifySummary ? clipWords(a.notifySummary, 8) : `after ${shortDuration(endOf(a) - a.startedAt)}`,
          at: endOf(a),
        });
      if (!active.length && fin[0] && (!lastFinished || endOf(fin[0]) > lastFinished.at))
        lastFinished = { at: endOf(fin[0]), title };
      const done = list.filter((a) => a.status === 'done' || a.status === 'done_unconfirmed').length;
      cards.push({
        key: `${srv.serverId}:${conv}`,
        serverId: srv.serverId,
        conversationId: conv,
        title,
        subtitle: subtitleOf(title, label, session),
        openSessionId,
        done,
        total: list.length,
        running: active.length,
        attention: cardStuck.length + cardFailed.length > 0,
        lastActivity: Math.max(...list.map(activityAt)),
        rows: tree.slice(0, MAX_ROWS),
        moreRows: tree.slice(MAX_ROWS),
        finished,
      });
    }
    const rank = (c: SessionCard) => (c.attention ? 0 : c.running > 0 ? 1 : 2);
    cards.sort((a, b) => rank(a) - rank(b) || b.lastActivity - a.lastActivity);
    const shown = cards.filter((c) => rank(c) < 2);
    const finishedOnly = cards.filter((c) => rank(c) === 2);
    if (shown.length || finishedOnly.length)
      groups.push({ serverId: srv.serverId, serverName: srv.serverName, cards: shown, finishedOnly });
  }

  // Stuck before failed, then newest first.
  attention.sort((a, b) => Number(a.kind === 'failed') - Number(b.kind === 'failed') || b.at - a.at);

  const out: AgentsOverview = {
    running,
    stuck,
    failed,
    attention,
    groups,
    multiServer: groups.length > 1,
    idle: running === 0,
  };
  if (running === 0) {
    out.emptyLine = lastFinished
      ? `Nothing running. Last batch finished ${agoText(now - lastFinished.at)} in ${lastFinished.title}.`
      : groups.length
        ? 'Nothing running.'
        : 'No agents in the last 2 hours.';
  }
  return out;
}

/** Nav badge: running count, red when anything is stuck or failed; null = hide. */
export function agentsBadge(o: Pick<AgentsOverview, 'running' | 'stuck' | 'failed'>): { count: number; alert: boolean } | null {
  const alert = o.stuck + o.failed > 0;
  if (!o.running && !alert) return null;
  return { count: o.running, alert };
}
