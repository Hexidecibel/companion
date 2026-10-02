/**
 * Locating a session's transcript files: the conversation chain (oldest first,
 * via the watcher) and each conversation's subagent sidechain files
 * (`<conv-dir>/<conv-id>/subagents/agent-*.jsonl` + `.meta.json`).
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SubagentFile {
  path: string;
  agentId: string;
  /** The parent's Agent/Task tool_use id (from the .meta.json). */
  parentToolUseId?: string;
}

const metaCache = new Map<string, string | null>();
const MAX_META_CACHE = 2000;
const MAX_SUBAGENTS_PER_CONV = 200;

async function readParentToolUseId(metaPath: string): Promise<string | undefined> {
  if (metaCache.has(metaPath)) return metaCache.get(metaPath) ?? undefined;
  let id: string | null = null;
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf-8');
    const j = JSON.parse(raw) as { toolUseId?: unknown };
    if (typeof j.toolUseId === 'string') id = j.toolUseId;
  } catch {
    id = null;
  }
  if (metaCache.size > MAX_META_CACHE) metaCache.clear();
  metaCache.set(metaPath, id);
  return id ?? undefined;
}

export async function listSubagentFiles(conversationPaths: string[]): Promise<SubagentFile[]> {
  const out: SubagentFile[] = [];
  for (const conv of conversationPaths) {
    const dir = path.join(path.dirname(conv), path.basename(conv, '.jsonl'), 'subagents');
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    const files = names.filter((n) => /^agent-[\w-]+\.jsonl$/.test(n)).sort();
    for (const n of files.slice(0, MAX_SUBAGENTS_PER_CONV)) {
      const agentId = n.slice('agent-'.length, -'.jsonl'.length);
      const parentToolUseId = await readParentToolUseId(
        path.join(dir, `agent-${agentId}.meta.json`)
      );
      out.push({ path: path.join(dir, n), agentId, parentToolUseId });
    }
  }
  return out;
}
