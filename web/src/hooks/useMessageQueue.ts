import { useState, useEffect, useCallback } from 'react';
import { messageQueue, QueuedMessage } from '../services/messageQueue';

interface UseMessageQueueReturn {
  queuedMessages: QueuedMessage[];
  enqueue: (text: string) => void;
  cancel: (id: string) => void;
  clearAll: () => void;
}

export function useMessageQueue(serverId: string | null): UseMessageQueueReturn {
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);

  useEffect(() => {
    if (!serverId) {
      setQueuedMessages([]);
      return;
    }

    setQueuedMessages(messageQueue.getMessagesForServer(serverId));
    const unsub = messageQueue.subscribe(() => {
      setQueuedMessages(messageQueue.getMessagesForServer(serverId));
    });
    return unsub;
  }, [serverId]);

  const enqueue = useCallback(
    (text: string) => {
      if (serverId) messageQueue.enqueue(serverId, text);
    },
    [serverId],
  );

  const cancel = useCallback((id: string) => {
    messageQueue.cancel(id);
  }, []);

  const clearAll = useCallback(() => {
    if (serverId) messageQueue.clearAll(serverId);
  }, [serverId]);

  return { queuedMessages, enqueue, cancel, clearAll };
}
