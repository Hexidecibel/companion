import AsyncStorage from '@react-native-async-storage/async-storage';
import { ConversationHighlight } from '../types';

const HISTORY_STORAGE_KEY = 'claude_companion_history';
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
  private loaded: boolean = false;
  private currentSession: HistorySession | null = null;

  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      const stored = await AsyncStorage.getItem(HISTORY_STORAGE_KEY);
      if (stored) {
        this.sessions = JSON.parse(stored);
      }
      this.loaded = true;
      console.log(`History: Loaded ${this.sessions.length} sessions`);
    } catch (err) {
      console.error('History: Failed to load:', err);
      this.sessions = [];
      this.loaded = true;
    }
  }

  private async save(): Promise<void> {
    try {
      await AsyncStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(this.sessions));
    } catch (err) {
      console.error('History: Failed to save:', err);
    }
  }

  async startSession(serverId: string, serverName: string, projectPath?: string): Promise<string> {
    await this.load();

    // Close any existing session
    if (this.currentSession) {
      await this.endSession();
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

    console.log(`History: Started session ${id}`);
    return id;
  }

  async addMessage(message: ConversationHighlight): Promise<void> {
    if (!this.currentSession) return;

    // Avoid duplicates
    if (this.currentSession.messages.some((m) => m.id === message.id)) {
      return;
    }

    this.currentSession.messages.push(message);
    this.currentSession.endTime = Date.now();

    // Trim if too many messages
    if (this.currentSession.messages.length > MAX_MESSAGES_PER_SESSION) {
      this.currentSession.messages = this.currentSession.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
  }

  async addMessages(messages: ConversationHighlight[]): Promise<void> {
    if (!this.currentSession) return;

    for (const message of messages) {
      if (!this.currentSession.messages.some((m) => m.id === message.id)) {
        this.currentSession.messages.push(message);
      }
    }

    this.currentSession.endTime = Date.now();

    // Trim if too many messages
    if (this.currentSession.messages.length > MAX_MESSAGES_PER_SESSION) {
      this.currentSession.messages = this.currentSession.messages.slice(-MAX_MESSAGES_PER_SESSION);
    }
  }

  async endSession(): Promise<void> {
    if (!this.currentSession) return;

    await this.load();

    // Only save if there are messages
    if (this.currentSession.messages.length > 0) {
      this.sessions.unshift(this.currentSession);

      // Trim old sessions
      if (this.sessions.length > MAX_SESSIONS) {
        this.sessions = this.sessions.slice(0, MAX_SESSIONS);
      }

      await this.save();
      console.log(`History: Saved session with ${this.currentSession.messages.length} messages`);
    }

    this.currentSession = null;
  }

  async getSessions(): Promise<HistorySession[]> {
    await this.load();
    return [...this.sessions];
  }

  async getSession(sessionId: string): Promise<HistorySession | undefined> {
    await this.load();
    return this.sessions.find((s) => s.id === sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.load();
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    await this.save();
  }

  async clearAll(): Promise<void> {
    this.sessions = [];
    this.currentSession = null;
    await this.save();
    console.log('History: Cleared all sessions');
  }

  async getSessionCount(): Promise<number> {
    await this.load();
    return this.sessions.length;
  }

  getCurrentSession(): HistorySession | null {
    return this.currentSession;
  }
}

export const historyService = new HistoryService();
