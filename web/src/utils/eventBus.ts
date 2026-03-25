type EventMap = {
  'close-overlay': void;
  'open-add-server': void;
  'open-notification-settings': void;
  'open-new-project': void;
  'open-cost-dashboard': { serverId: string };
  'companion-in-app-notification': { title: string; body?: string; tag?: string };
};

type Handler<T> = T extends void ? () => void : (data: T) => void;

const listeners = new Map<string, Set<Function>>();

export const eventBus = {
  emit<K extends keyof EventMap>(
    event: K,
    ...args: EventMap[K] extends void ? [] : [EventMap[K]]
  ): void {
    const set = listeners.get(event);
    if (!set) return;
    const data = args[0];
    for (const fn of set) {
      (fn as Function)(data);
    }
  },

  on<K extends keyof EventMap>(
    event: K,
    handler: Handler<EventMap[K]>,
  ): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) listeners.delete(event);
    };
  },

  off<K extends keyof EventMap>(
    event: K,
    handler: Handler<EventMap[K]>,
  ): void {
    const set = listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) listeners.delete(event);
  },
};
