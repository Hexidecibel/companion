const STORAGE_KEY = 'companion_message_queue';

export interface QueuedMessage {
  id: string;
  serverId: string;
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

  enqueue(serverId: string, text: string): void {
    const msg: QueuedMessage = {
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      serverId,
      text,
      queuedAt: Date.now(),
    };
    this.messages.push(msg);
    this.save();
    this.notify();
  }

  dequeue(serverId: string): QueuedMessage | undefined {
    const idx = this.messages.findIndex((m) => m.serverId === serverId);
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

  clearAll(serverId: string): void {
    this.messages = this.messages.filter((m) => m.serverId !== serverId);
    this.save();
    this.notify();
  }

  getMessagesForServer(serverId: string): QueuedMessage[] {
    return this.messages.filter((m) => m.serverId === serverId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const messageQueue = new MessageQueue();
