import { OPEN_FILES_KEY } from './storageKeys';

const STORAGE_KEY = OPEN_FILES_KEY;
const MAX_TABS = 10;

export interface OpenFile {
  path: string;
}

class OpenFilesService {
  private files: Map<string, OpenFile[]> = new Map();

  constructor() {
    this.load();
  }

  private key(serverId: string, sessionId: string): string {
    return `${serverId}:${sessionId}`;
  }

  private load(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, OpenFile[]>;
        this.files = new Map(Object.entries(parsed));
      }
    } catch {
      this.files = new Map();
    }
  }

  private save(): void {
    try {
      const obj: Record<string, OpenFile[]> = {};
      this.files.forEach((files, key) => {
        obj[key] = files;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // Silently ignore
    }
  }

  openFile(serverId: string, sessionId: string, path: string): void {
    const k = this.key(serverId, sessionId);
    let files = [...(this.files.get(k) || [])];
    const existing = files.findIndex((f) => f.path === path);
    if (existing !== -1) {
      files.splice(existing, 1);
    }
    files.push({ path });
    if (files.length > MAX_TABS) {
      files = files.slice(files.length - MAX_TABS);
    }
    this.files.set(k, files);
    this.save();
  }

  closeFile(serverId: string, sessionId: string, path: string): void {
    const k = this.key(serverId, sessionId);
    const files = this.files.get(k) || [];
    const filtered = files.filter((f) => f.path !== path);
    if (filtered.length === 0) {
      this.files.delete(k);
    } else {
      this.files.set(k, filtered);
    }
    this.save();
  }

  closeAllFiles(serverId: string, sessionId: string): void {
    const k = this.key(serverId, sessionId);
    this.files.delete(k);
    this.save();
  }

  getFiles(serverId: string, sessionId: string): OpenFile[] {
    const files = this.files.get(this.key(serverId, sessionId));
    return files ? [...files] : [];
  }
}

export const openFilesService = new OpenFilesService();
