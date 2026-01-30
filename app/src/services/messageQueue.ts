import AsyncStorage from '@react-native-async-storage/async-storage';

const QUEUE_STORAGE_KEY = 'companion_message_queue';

export interface QueuedMessage {
  id: string;
  type: 'text' | 'image' | 'combined';
  content: string;
  imagePaths?: string[];
  timestamp: number;
  serverId: string;
}

class MessageQueueService {
  private queue: QueuedMessage[] = [];
  private loaded: boolean = false;
  private listeners: Set<(queue: QueuedMessage[]) => void> = new Set();

  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      const stored = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
      if (stored) {
        this.queue = JSON.parse(stored);
      }
      this.loaded = true;
      console.log(`MessageQueue: Loaded ${this.queue.length} queued messages`);
    } catch (err) {
      console.error('MessageQueue: Failed to load queue:', err);
      this.queue = [];
      this.loaded = true;
    }
  }

  private async save(): Promise<void> {
    try {
      await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(this.queue));
    } catch (err) {
      console.error('MessageQueue: Failed to save queue:', err);
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener([...this.queue]);
      } catch (err) {
        console.error('MessageQueue: Listener error:', err);
      }
    });
  }

  async enqueue(message: Omit<QueuedMessage, 'id' | 'timestamp'>): Promise<string> {
    await this.load();

    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const queuedMessage: QueuedMessage = {
      ...message,
      id,
      timestamp: Date.now(),
    };

    this.queue.push(queuedMessage);
    await this.save();
    this.notify();

    console.log(`MessageQueue: Enqueued message ${id}`);
    return id;
  }

  async dequeue(id: string): Promise<void> {
    await this.load();

    const index = this.queue.findIndex((m) => m.id === id);
    if (index !== -1) {
      this.queue.splice(index, 1);
      await this.save();
      this.notify();
      console.log(`MessageQueue: Dequeued message ${id}`);
    }
  }

  async getMessagesForServer(serverId: string): Promise<QueuedMessage[]> {
    await this.load();
    return this.queue.filter((m) => m.serverId === serverId);
  }

  async getPendingCount(): Promise<number> {
    await this.load();
    return this.queue.length;
  }

  async getPendingCountForServer(serverId: string): Promise<number> {
    await this.load();
    return this.queue.filter((m) => m.serverId === serverId).length;
  }

  async clearForServer(serverId: string): Promise<void> {
    await this.load();
    this.queue = this.queue.filter((m) => m.serverId !== serverId);
    await this.save();
    this.notify();
  }

  async clearAll(): Promise<void> {
    this.queue = [];
    await this.save();
    this.notify();
  }

  subscribe(listener: (queue: QueuedMessage[]) => void): () => void {
    this.listeners.add(listener);
    // Immediately notify with current queue
    this.load().then(() => listener([...this.queue]));
    return () => this.listeners.delete(listener);
  }

  getQueue(): QueuedMessage[] {
    return [...this.queue];
  }
}

export const messageQueue = new MessageQueueService();
