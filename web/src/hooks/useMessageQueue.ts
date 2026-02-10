import { useState, useEffect, useCallback } from 'react';
import { messageQueue, QueuedMessage } from '../services/messageQueue';

interface UseMessageQueueReturn {
  queuedMessages: QueuedMessage[];
  enqueue: (text: string) => void;
  cancel: (id: string) => void;
  edit: (id: string, newText: string) => void;
  clearAll: () => void;
}

export function useMessageQueue(serverId: string | null, sessionId: string | null): UseMessageQueueReturn {
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);

  useEffect(() => {
    if (!serverId || !sessionId) {
      setQueuedMessages([]);
      return;
    }

    setQueuedMessages(messageQueue.getMessagesForSession(serverId, sessionId));
    const unsub = messageQueue.subscribe(() => {
      setQueuedMessages(messageQueue.getMessagesForSession(serverId, sessionId));
    });
    return unsub;
  }, [serverId, sessionId]);

  const enqueue = useCallback(
    (text: string) => {
      if (serverId && sessionId) messageQueue.enqueue(serverId, sessionId, text);
    },
    [serverId, sessionId],
  );

  const cancel = useCallback((id: string) => {
    messageQueue.cancel(id);
  }, []);

  const edit = useCallback((id: string, newText: string) => {
    messageQueue.edit(id, newText);
  }, []);

  const clearAll = useCallback(() => {
    if (serverId && sessionId) messageQueue.clearAll(serverId, sessionId);
  }, [serverId, sessionId]);

  return { queuedMessages, enqueue, cancel, edit, clearAll };
}
