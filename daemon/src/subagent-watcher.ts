/**
 * SubAgentWatcher: the daemon's subagent facade. By default it runs the
 * SubagentTracker (daemon/src/subagents/: fs.watch discovery, byte-offset tails,
 * notification-driven completion); `subagents.discovery: 'legacy'` (or env
 * COMPANION_SUBAGENTS=legacy) runs the old chokidar watcher for one release.
 * `get_agent_tree` / `get_agent_detail` keep their response shapes (fields only added).
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { SubAgent, AgentTree, ConversationHighlight } from './types';
import { parseConversationFile, extractHighlights } from './parser';
import { LegacySubAgentWatcher } from './subagent-watcher-legacy';
import { SubagentTracker } from './subagents/tracker';
import { SubagentDiscovery } from './subagents/discover';
import { SubagentHub } from './subagents/hub';
import { isActive, legacyStatus } from './subagents/completion';
import { rollupText } from './subagents/rollup';
import type { AgentRecord } from './subagents/state';
import type { StuckSettings } from './stuck/protocol';
import type { SubagentSummary, SubagentUpdateEvent } from './subagents/protocol';

export type SubagentMode = 'watch' | 'legacy' | 'off';

export interface SubAgentWatcherOptions {
  mode?: SubagentMode;
  stuckSettings?: () => StuckSettings;
  /** Backstop tick (ms). */
  tickMs?: number;
}

/** Recently finished agents stay in get_agent_tree this long (legacy panel semantics). */
const TREE_FINISHED_MS = 5 * 60 * 1000;
/** get_agent_detail reads at most the newest this-many bytes of a transcript. */
const DETAIL_TAIL_BYTES = 2 * 1024 * 1024;
const DETAIL_CACHE = 20;

export function resolveSubagentMode(configured?: unknown, env = process.env): SubagentMode {
  const e = (env.COMPANION_SUBAGENTS || '').trim().toLowerCase();
  if (e === 'legacy' || e === 'off' || e === 'watch') return e;
  if (configured === 'legacy' || configured === 'off' || configured === 'watch') return configured;
  return 'watch';
}

export class SubAgentWatcher extends EventEmitter {
  readonly mode: SubagentMode;
  private legacy: LegacySubAgentWatcher | null = null;
  readonly tracker: SubagentTracker | null = null;
  private discovery: SubagentDiscovery | null = null;
  private hubRef: SubagentHub | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private detailCache = new Map<
    string,
    { size: number; mtimeMs: number; highlights: ConversationHighlight[]; messageCount: number }
  >();

  constructor(
    private codeHome: string,
    private opts: SubAgentWatcherOptions = {}
  ) {
    super();
    this.mode = opts.mode ?? resolveSubagentMode();
    if (this.mode === 'legacy') this.legacy = new LegacySubAgentWatcher(codeHome);
    else if (this.mode === 'watch')
      this.tracker = new SubagentTracker({ stuckSettings: opts.stuckSettings });
  }

  start(): void {
    if (this.legacy) {
      console.log('SubAgentWatcher: legacy (chokidar polling) mode');
      this.legacy.start();
      return;
    }
    if (!this.tracker) {
      console.log('SubAgentWatcher: disabled');
      return;
    }
    const projectsDir = path.join(this.codeHome, 'projects');
    console.log(`SubAgentWatcher: tracking subagents in ${projectsDir} (fs.watch, incremental)`);
    this.discovery = new SubagentDiscovery(projectsDir, this.tracker);
    void this.discovery
      .start()
      .catch((err) => console.error('SubAgentWatcher: discovery failed:', err));
    const tickMs = this.opts.tickMs ?? 5000;
    this.tickTimer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      void this.tracker!.tick()
        .catch(() => undefined)
        .finally(() => {
          this.ticking = false;
        });
    }, tickMs);
    this.tickTimer.unref?.();
    this.pruneTimer = setInterval(() => this.discovery?.prune(), 60_000);
    this.pruneTimer.unref?.();
  }

  stop(): void {
    this.legacy?.stop();
    this.discovery?.stop();
    this.tracker?.stop();
    this.hubRef?.shutdown();
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.tickTimer = null;
    this.pruneTimer = null;
  }

  /** Live delta hub (created on first use; only when the tracker runs). */
  hub(
    send: (clientId: string, payload: SubagentUpdateEvent) => boolean,
    resolve: (sessionKey: string | null) => string[] | null
  ): SubagentHub | null {
    if (!this.tracker) return null;
    if (this.hubRef) return this.hubRef;
    const tracker = this.tracker;
    const hub = new SubagentHub({
      summary: (id) => {
        const rec = tracker.get(id);
        return rec ? tracker.summary(rec) : undefined;
      },
      resolve,
      send,
    });
    tracker.on('changed', (ids: string[], removed: string[]) => hub.onChanged(ids, removed));
    this.hubRef = hub;
    return hub;
  }

  get hubInstance(): SubagentHub | null {
    return this.hubRef;
  }

  private toLegacy(rec: AgentRecord): SubAgent {
    const t = this.tracker!;
    const s = t.summary(rec);
    const status = legacyStatus(rec.status);
    const out: SubAgent = {
      agentId: rec.agentId,
      slug: s.name,
      sessionId: rec.sessionId,
      status,
      startedAt: s.startedAt,
      description: s.name,
      subagentType: s.type || '',
      messageCount: rec.entries,
      lastActivity: s.lastEntryAt,
      state: rec.status,
      depth: s.depth,
      summary: s,
    };
    if (s.endedAt !== undefined && status !== 'running') out.completedAt = s.endedAt;
    if (s.activity) out.currentActivity = s.activity;
    if (s.parentAgentId) out.parentAgentId = s.parentAgentId;
    return out;
  }

  getAgentTree(sessionIds?: string[]): AgentTree {
    if (this.legacy) return this.legacy.getAgentTree(sessionIds);
    const empty: AgentTree = {
      sessionId: sessionIds?.[0] || 'all',
      agents: [],
      totalAgents: 0,
      runningCount: 0,
      completedCount: 0,
    };
    if (!this.tracker) return empty;
    const now = Date.now();
    const agents: SubAgent[] = [];
    let running = 0;
    let completed = 0;
    for (const rec of this.tracker.list(sessionIds)) {
      const active = isActive(rec.status);
      if (!active && (rec.endedAt ?? 0) < now - TREE_FINISHED_MS) continue;
      if (active) running++;
      else completed++;
      agents.push(this.toLegacy(rec));
    }
    agents.sort((a, b) => b.lastActivity - a.lastActivity);
    return {
      ...empty,
      agents,
      totalAgents: agents.length,
      runningCount: running,
      completedCount: completed,
    };
  }

  getAgentsForSession(sessionIds: string[]): SubAgent[] {
    return this.getAgentTree(sessionIds).agents;
  }

  /** Summaries for subagent_list (every retained agent of these conversations). */
  listSummaries(convIds?: string[] | null): {
    agents: SubagentSummary[];
    running: number;
    rollup: string;
  } {
    if (!this.tracker) return { agents: [], running: 0, rollup: 'No subagents.' };
    const t = this.tracker;
    const agents = t.list(convIds).map((r) => t.summary(r));
    return {
      agents,
      running: agents.filter((a) => isActive(a.status)).length,
      rollup: rollupText(agents, Date.now()),
    };
  }

  /**
   * Agent detail with conversation highlights. Served from the newest
   * DETAIL_TAIL_BYTES of the transcript (async read), cached until the file grows.
   */
  async getAgentDetail(agentId: string): Promise<{
    agent: SubAgent;
    highlights: ConversationHighlight[];
  } | null> {
    if (this.legacy) return this.legacy.getAgentDetail(agentId);
    if (!this.tracker) return null;
    const rec = await this.tracker.hydrate(agentId);
    if (!rec) return null;
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(rec.filePath);
    } catch {
      return null;
    }
    let cached = this.detailCache.get(agentId);
    if (!cached || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
      const start = Math.max(0, st.size - DETAIL_TAIL_BYTES);
      const len = st.size - start;
      let content = '';
      if (len > 0) {
        const fh = await fs.promises.open(rec.filePath, 'r');
        try {
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, start);
          content = buf.subarray(0, bytesRead).toString('utf8');
        } finally {
          await fh.close().catch(() => undefined);
        }
        if (start > 0) {
          const nl = content.indexOf('\n');
          content = nl >= 0 ? content.slice(nl + 1) : '';
        }
      }
      const messages = content ? parseConversationFile(rec.filePath, 200, content) : [];
      cached = {
        size: st.size,
        mtimeMs: st.mtimeMs,
        highlights: extractHighlights(messages),
        messageCount: messages.length,
      };
      this.detailCache.delete(agentId);
      this.detailCache.set(agentId, cached);
      while (this.detailCache.size > DETAIL_CACHE) {
        const first = this.detailCache.keys().next().value;
        if (first === undefined) break;
        this.detailCache.delete(first);
      }
    }
    return { agent: this.toLegacy(rec), highlights: cached.highlights };
  }
}
