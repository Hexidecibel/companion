import { ConversationHighlight } from '../types';
import { HISTORY_KEY } from './storageKeys';

const HISTORY_STORAGE_KEY = HISTORY_KEY;
const MAX_SESSIONS = 50;
const MAX_MESSAGES_PER_SESSION = 100;

export interface HistorySession {
  id: string;
  serverId: string;
  serverName: string;
  projectPath?: string;
  startTime: number;
  endTime: number;
  messages: ConversationHighlight[];
}

class HistoryService {
  private sessions: HistorySession[] = [];
  private loaded = false;
  private currentSession: HistorySession | null = null;

  load(): void {
    if (this.loaded) return;
    try {
      const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (stored) {
        this.sessions = JSON.parse(stored);
      }
      this.loaded = true;
    } catch {
      this.sessions = [];
      this.loaded = true;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(this.sessions));
    } catch {
      // localStorage quota exceeded — trim older sessions
      if (this.sessions.length > 10) {
        this.sessions = this.sessions.slice(0, 10);
        try {
          localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(this.sessions));
        } catch { /* give up */ }
      }
    }
  }

  startSession(serverId: string, serverName: string, projectPath?: string): string {
    this.load();
    if (this.currentSession) {
      this.endSession();
    }
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.currentSession = {
      id,
      serverId,
      serverName,
      projectPath,
      startTime: Date.now(),
      endTime: Date.now(),
      messages: [],
    };
    return id;
  }

  addMessage(message: ConversationHighlight): void {
    if (!this.currentSession) return;
    if (this.currentSession.messages.some((m) => m.id === message.id)) return;
    this.currentSession.messages.push(message);
    this.currentSession.endTime = Date.now();
    if (this.currentSession.messages.length > MAX_MESSAGES_PER_SESSION) {
      this.currentSession.messages = this.currentSession.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
  }

  addMessages(messages: ConversationHighlight[]): void {
    if (!this.currentSession) return;
    for (const message of messages) {
      if (!this.currentSession.messages.some((m) => m.id === message.id)) {
        this.currentSession.messages.push(message);
      }
    }
    this.currentSession.endTime = Date.now();
    if (this.currentSession.messages.length > MAX_MESSAGES_PER_SESSION) {
      this.currentSession.messages = this.currentSession.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
  }

  endSession(): void {
    if (!this.currentSession) return;
    this.load();
    if (this.currentSession.messages.length > 0) {
      this.sessions.unshift(this.currentSession);
      if (this.sessions.length > MAX_SESSIONS) {
        this.sessions = this.sessions.slice(0, MAX_SESSIONS);
      }
      this.save();
    }
    this.currentSession = null;
  }

  getSessions(): HistorySession[] {
    this.load();
    return [...this.sessions];
  }

  getSession(sessionId: string): HistorySession | undefined {
    this.load();
    return this.sessions.find((s) => s.id === sessionId);
  }

  deleteSession(sessionId: string): void {
    this.load();
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.save();
  }

  clearAll(): void {
    this.sessions = [];
    this.currentSession = null;
    this.save();
  }

  getSessionCount(): number {
    this.load();
    return this.sessions.length;
  }

  getCurrentSession(): HistorySession | null {
    return this.currentSession;
  }
}

export const historyService = new HistoryService();
