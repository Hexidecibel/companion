import { useCallback } from 'react';
import { useConversation } from '../hooks/useConversation';
import { connectionManager } from '../services/ConnectionManager';
import { WaitingIndicator } from './WaitingIndicator';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { ComponentErrorBoundary } from './ComponentErrorBoundary';

interface ConciergeViewProps {
  serverId: string;
  sessionId: string;
  onBack: () => void;
}

/**
 * Renders the concierge session's conversation. It is a NORMAL session — no
 * special transport — so it reuses the same `useConversation` hook (get_highlights /
 * get_status / send_input) and the same MessageList / InputBar / WaitingIndicator
 * primitives that SessionView uses. Session-bound hooks (useTasks / useCodeReview)
 * are intentionally omitted.
 */
export function ConciergeView({ serverId, sessionId, onBack }: ConciergeViewProps) {
  const {
    highlights,
    status,
    loading,
    loadingMore,
    hasMore,
    error,
    sendInput,
    cancelMessage,
    loadMore,
  } = useConversation(serverId, sessionId);

  const handleSend = useCallback(
    (text: string) => sendInput(text),
    [sendInput],
  );

  const handleSelectOption = useCallback(
    (label: string) => sendInput(label, { skipOptimistic: true }),
    [sendInput],
  );

  const handleSelectChoice = useCallback(
    async (choice: {
      selectedIndices: number[];
      optionCount: number;
      multiSelect: boolean;
      otherText?: string;
    }): Promise<boolean> => {
      // Mirror SessionView: choices go through the dedicated send_choice request.
      const conn = connectionManager.getConnection(serverId);
      if (!conn?.isConnected()) return false;
      try {
        const response = await conn.sendRequest('send_choice', {
          ...choice,
          sessionId,
          tmuxSessionName: sessionId,
        });
        return response.success;
      } catch {
        return false;
      }
    },
    [serverId, sessionId],
  );

  const handleCancelMessage = useCallback(
    (clientMessageId: string) => {
      void cancelMessage(clientMessageId);
    },
    [cancelMessage],
  );

  return (
    <div className="session-view" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        className="session-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid #374151',
          background: '#1f2937',
        }}
      >
        <button
          className="session-header-btn"
          onClick={onBack}
          title="Back to dashboard"
          style={{
            background: 'transparent',
            border: 'none',
            color: '#f3f4f6',
            cursor: 'pointer',
            fontSize: 18,
            padding: '2px 8px',
          }}
        >
          &#x2190;
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ color: '#f3f4f6', fontWeight: 600 }}>Concierge</span>
          <span style={{ color: '#9ca3af', fontSize: 12 }}>
            Fans out across your servers
          </span>
        </div>
      </div>

      {error && (
        <div style={{ color: '#ef4444', padding: '8px 12px', fontSize: 13 }}>
          {error}
        </div>
      )}

      <div
        className="session-conversation"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <WaitingIndicator status={status} serverId={serverId} sessionId={sessionId} />

        <ComponentErrorBoundary name="MessageList">
          <MessageList
            key={sessionId}
            highlights={highlights}
            loading={loading}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onSelectOption={handleSelectOption}
            onSelectChoice={handleSelectChoice}
            onCancelMessage={handleCancelMessage}
            scrollToBottom
            serverId={serverId}
            sessionId={sessionId}
          />
        </ComponentErrorBoundary>
      </div>

      <InputBar onSend={handleSend} disabled={false} />
    </div>
  );
}
