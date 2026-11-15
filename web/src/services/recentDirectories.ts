import { RECENT_DIRS_KEY } from './storageKeys';

const STORAGE_KEY = RECENT_DIRS_KEY;
const MAX_ENTRIES = 10;

export interface RecentDirectory {
  path: string;
  name: string;
  lastUsed: number;
}

type RecentStore = Record<string, RecentDirectory[]>;

function load(): RecentStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function save(store: RecentStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function getRecentDirectories(serverId: string): RecentDirectory[] {
  const store = load();
  const entries = store[serverId] ?? [];
  return entries.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_ENTRIES);
}

export function addRecentDirectory(serverId: string, dirPath: string): void {
  const store = load();
  const entries = store[serverId] ?? [];

  const existing = entries.findIndex((e) => e.path === dirPath);
  const name = dirPath.split('/').filter(Boolean).pop() || dirPath;

  if (existing >= 0) {
    entries[existing].lastUsed = Date.now();
  } else {
    entries.push({ path: dirPath, name, lastUsed: Date.now() });
  }

  store[serverId] = entries.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_ENTRIES);
  save(store);
}

/**
 * Merge recent-folder lists (daemon, local legacy store, live tmux dirs):
 * dedupe by path (trailing slash ignored), keep the newest lastUsed, newest first.
 */
export function mergeRecents(lists: RecentDirectory[][], limit: number): RecentDirectory[] {
  const byPath = new Map<string, RecentDirectory>();
  for (const list of lists) {
    for (const d of list) {
      if (!d || typeof d.path !== 'string' || !d.path) continue;
      const path = d.path.length > 1 ? d.path.replace(/\/+$/, '') : d.path;
      const prev = byPath.get(path);
      if (!prev || d.lastUsed > prev.lastUsed) {
        byPath.set(path, { path, name: d.name || path.split('/').filter(Boolean).pop() || path, lastUsed: d.lastUsed });
      }
    }
  }
  return [...byPath.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, limit);
}

/**
 * The panel's recents: explicit ones (daemon + local legacy store, merged by
 * lastUsed) first, then working dirs of live sessions not already listed.
 */
export function combineRecents(
  daemon: RecentDirectory[],
  local: RecentDirectory[],
  sessionDirs: RecentDirectory[],
  limit: number,
): RecentDirectory[] {
  const explicit = mergeRecents([daemon, local], limit);
  const seen = new Set(explicit.map((d) => d.path));
  const extra = mergeRecents([sessionDirs], limit).filter((d) => !seen.has(d.path));
  return [...explicit, ...extra].slice(0, limit);
}
