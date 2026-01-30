import { ConversationHighlight } from '../types';

const STORAGE_KEY = 'companion_archives';
const MAX_ARCHIVES = 20;

export interface ArchivedConversation {
  id: string;
  serverId: string;
  sessionId: string;
  name: string;
  savedAt: number;
  messageCount: number;
  highlights: ConversationHighlight[];
}

function loadArchives(): ArchivedConversation[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveArchives(archives: ArchivedConversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(archives));
  } catch {
    // Silently ignore
  }
}

export function getArchives(): ArchivedConversation[] {
  return loadArchives().sort((a, b) => b.savedAt - a.savedAt);
}

export function addArchive(
  serverId: string,
  sessionId: string,
  name: string,
  highlights: ConversationHighlight[],
): ArchivedConversation {
  const archives = loadArchives();
  const entry: ArchivedConversation = {
    id: `arc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    serverId,
    sessionId,
    name,
    savedAt: Date.now(),
    messageCount: highlights.length,
    highlights,
  };

  archives.unshift(entry);

  // Enforce max limit
  while (archives.length > MAX_ARCHIVES) {
    archives.pop();
  }

  saveArchives(archives);
  return entry;
}

export function deleteArchive(id: string): void {
  const archives = loadArchives().filter((a) => a.id !== id);
  saveArchives(archives);
}

export function getArchive(id: string): ArchivedConversation | undefined {
  return loadArchives().find((a) => a.id === id);
}
