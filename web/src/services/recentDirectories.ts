const STORAGE_KEY = 'companion_recent_dirs';
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
