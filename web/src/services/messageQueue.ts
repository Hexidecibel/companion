const STORAGE_KEY = 'companion_message_queue';

export interface QueuedMessage {
  id: string;
  serverId: string;
  sessionId: string;
  text: string;
  queuedAt: number;
}

type Listener = () => void;

class MessageQueue {
  private messages: QueuedMessage[] = [];
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      this.messages = stored ? JSON.parse(stored) : [];
    } catch {
      this.messages = [];
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.messages));
    } catch {
      // Silently ignore
    }
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  enqueue(serverId: string, sessionId: string, text: string): void {
    const msg: QueuedMessage = {
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      serverId,
      sessionId,
      text,
      queuedAt: Date.now(),
    };
    this.messages.push(msg);
    this.save();
    this.notify();
  }

  dequeue(serverId: string, sessionId: string): QueuedMessage | undefined {
    const idx = this.messages.findIndex((m) => m.serverId === serverId && m.sessionId === sessionId);
    if (idx === -1) return undefined;
    const [msg] = this.messages.splice(idx, 1);
    this.save();
    this.notify();
    return msg;
  }

  cancel(id: string): void {
    this.messages = this.messages.filter((m) => m.id !== id);
    this.save();
    this.notify();
  }

  edit(id: string, newText: string): void {
    const msg = this.messages.find((m) => m.id === id);
    if (msg) {
      msg.text = newText;
      this.save();
      this.notify();
    }
  }

  clearAll(serverId: string, sessionId: string): void {
    this.messages = this.messages.filter((m) => !(m.serverId === serverId && m.sessionId === sessionId));
    this.save();
    this.notify();
  }

  getMessagesForSession(serverId: string, sessionId: string): QueuedMessage[] {
    return this.messages.filter((m) => m.serverId === serverId && m.sessionId === sessionId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const messageQueue = new MessageQueue();
