import { useState, useEffect, useRef, useCallback } from 'react';
import { PendingImage } from '../types';
import { useConversation } from '../hooks/useConversation';
import { useTasks } from '../hooks/useTasks';
import { useSubAgents } from '../hooks/useSubAgents';
import { useSubAgentDetail } from '../hooks/useSubAgentDetail';
import { useAutoApprove } from '../hooks/useAutoApprove';
import { useMessageQueue } from '../hooks/useMessageQueue';
import { addArchive } from '../services/archiveService';
import { messageQueue } from '../services/messageQueue';
import { connectionManager } from '../services/ConnectionManager';
import { useSessionMute } from '../hooks/useSessionMute';
import { WaitingIndicator } from './WaitingIndicator';
import { TaskList } from './TaskList';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { SubAgentBar } from './SubAgentBar';
import { SubAgentModal } from './SubAgentModal';
import { SubAgentDetail } from './SubAgentDetail';
import { FileViewerModal } from './FileViewerModal';
import { QueuedMessageBar } from './QueuedMessageBar';
import { ArchiveModal } from './ArchiveModal';
import { TerminalPanel } from './TerminalPanel';

interface SessionViewProps {
  serverId: string | null;
  sessionId: string | null;
  tmuxSessionName?: string;
}

export function SessionView({ serverId, sessionId, tmuxSessionName }: SessionViewProps) {
  const {
    highlights,
    status,
    loading,
    loadingMore,
    hasMore,
    error,
    sendInput,
    loadMore,
  } = useConversation(serverId, sessionId);

  const { tasks, loading: tasksLoading } = useTasks(serverId, sessionId);
  const { agents, runningCount, completedCount, totalAgents } = useSubAgents(serverId, sessionId);
  const autoApprove = useAutoApprove(serverId, sessionId);
  const sessionMute = useSessionMute(serverId);
  const { queuedMessages, enqueue, cancel: cancelQueued, clearAll: clearAllQueued } = useMessageQueue(serverId);

  // Sub-agent state
  const [showAgentsModal, setShowAgentsModal] = useState(false);
  const [viewingAgentId, setViewingAgentId] = useState<string | null>(null);
  const agentDetail = useSubAgentDetail(serverId, viewingAgentId);

  // File viewer state
  const [viewingFile, setViewingFile] = useState<string | null>(null);

  // Archive state
  const [showArchiveModal, setShowArchiveModal] = useState(false);

  // Terminal view state
  const [showTerminal, setShowTerminal] = useState(false);

  // Auto-focus input and reset terminal view when session changes
  useEffect(() => {
    setShowTerminal(false);
    if (serverId && sessionId) {
      requestAnimationFrame(() => {
        const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
        textarea?.focus();
      });
    }
  }, [serverId, sessionId]);

  // Track waiting state for auto-dequeue
  const prevWaitingRef = useRef(false);

  useEffect(() => {
    const wasWaiting = prevWaitingRef.current;
    const isWaiting = status?.isWaitingForInput ?? false;
    prevWaitingRef.current = isWaiting;

    // Auto-send first queued message when session transitions to waiting
    if (!wasWaiting && isWaiting && serverId) {
      const next = messageQueue.dequeue(serverId);
      if (next) {
        sendInput(next.text);
      }
    }
  }, [status?.isWaitingForInput, serverId, sendInput]);

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      // If session is not waiting for input, queue the message
      if (status && !status.isWaitingForInput && serverId) {
        enqueue(text);
        return true;
      }
      return sendInput(text);
    },
    [status, serverId, enqueue, sendInput],
  );

  const handleSendWithImages = useCallback(
    async (text: string, images: PendingImage[]): Promise<boolean> => {
      if (!serverId) return false;
      const conn = connectionManager.getConnection(serverId);
      if (!conn) return false;

      try {
        // Upload each image via send_image
        const imagePaths: string[] = [];
        for (const img of images) {
          const reader = new FileReader();
          const base64 = await new Promise<string>((resolve, reject) => {
            reader.onload = () => {
              const result = reader.result as string;
              // Strip data:image/...;base64, prefix
              const b64 = result.includes(',') ? result.split(',')[1] : result;
              resolve(b64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(img.file);
          });

          const response = await conn.sendRequest('upload_image', {
            base64,
            mimeType: img.file.type,
          });

          if (!response.success) {
            console.log('Image upload failed:', response.error);
            return false;
          }

          const payload = response.payload as { filepath?: string };
          if (payload?.filepath) {
            imagePaths.push(payload.filepath);
          }
        }

        // Send message with image paths
        const response = await conn.sendRequest('send_with_images', {
          message: text,
          imagePaths,
        });

        return response.success;
      } catch (err) {
        console.log('Failed to send images:', err);
        return false;
      }
    },
    [serverId],
  );

  const handleArchive = useCallback(() => {
    if (!serverId || !sessionId || highlights.length === 0) return;
    const name = `Session ${new Date().toLocaleString()}`;
    addArchive(serverId, sessionId, name, highlights);
  }, [serverId, sessionId, highlights]);

  if (!serverId || !sessionId) {
    return (
      <div className="session-view-empty">
        <p>Select a session from the sidebar</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="session-view-empty">
        <p className="session-view-error">{error}</p>
      </div>
    );
  }

  const handleSelectOption = (label: string) => {
    sendInput(label);
  };

  return (
    <div className="session-view">
      {/* Session header with actions */}
      <div className="session-header">
        <div className="session-header-actions">
          {sessionId && (
            <button
              className={`session-mute-btn ${sessionMute.isMuted(sessionId) ? 'muted' : ''}`}
              onClick={() => sessionMute.toggleMute(sessionId)}
              title={sessionMute.isMuted(sessionId) ? 'Unmute notifications' : 'Mute notifications'}
            >
              {sessionMute.isMuted(sessionId) ? '\u{1F515} Muted' : '\u{1F514} Notify'}
            </button>
          )}
          <button
            className={`auto-approve-btn ${autoApprove.enabled ? 'auto-approve-btn-active' : ''}`}
            onClick={autoApprove.toggle}
            disabled={autoApprove.loading}
            title={autoApprove.enabled ? 'Auto-approve enabled' : 'Auto-approve disabled'}
          >
            {autoApprove.enabled ? 'Auto: ON' : 'Auto: OFF'}
          </button>
          {tmuxSessionName && (
            <button
              className={`session-header-btn ${showTerminal ? 'terminal-active' : ''}`}
              onClick={() => setShowTerminal(!showTerminal)}
              title={showTerminal ? 'Show conversation' : 'Show terminal output'}
            >
              Terminal
            </button>
          )}
          <button
            className="session-header-btn"
            onClick={handleArchive}
            disabled={highlights.length === 0}
            title="Save conversation archive"
          >
            Archive
          </button>
          <button
            className="session-header-btn"
            onClick={() => setShowArchiveModal(true)}
            title="View saved archives"
          >
            History
          </button>
        </div>
      </div>

      {showTerminal && tmuxSessionName && serverId ? (
        <TerminalPanel
          serverId={serverId}
          tmuxSessionName={tmuxSessionName}
        />
      ) : (
        <>
          <WaitingIndicator status={status} />

          <SubAgentBar
            agents={agents}
            runningCount={runningCount}
            totalAgents={totalAgents}
            onClick={() => setShowAgentsModal(true)}
          />

          <TaskList tasks={tasks} loading={tasksLoading} />

          <MessageList
            highlights={highlights}
            loading={loading}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onSelectOption={handleSelectOption}
            onViewFile={setViewingFile}
          />

          <QueuedMessageBar
            messages={queuedMessages}
            onCancel={cancelQueued}
            onClearAll={clearAllQueued}
          />

          <InputBar
            onSend={handleSend}
            onSendWithImages={handleSendWithImages}
            disabled={!status?.isWaitingForInput && !status?.isRunning}
          />
        </>
      )}

      {/* Modals */}
      {showAgentsModal && (
        <SubAgentModal
          agents={agents}
          runningCount={runningCount}
          completedCount={completedCount}
          onClose={() => setShowAgentsModal(false)}
          onViewAgent={(agentId) => {
            setViewingAgentId(agentId);
            setShowAgentsModal(false);
          }}
        />
      )}

      {viewingAgentId && (
        <SubAgentDetail
          agent={agentDetail.agent}
          highlights={agentDetail.highlights}
          loading={agentDetail.loading}
          onClose={() => setViewingAgentId(null)}
        />
      )}

      {viewingFile && serverId && (
        <FileViewerModal
          serverId={serverId}
          filePath={viewingFile}
          onClose={() => setViewingFile(null)}
        />
      )}

      {showArchiveModal && (
        <ArchiveModal onClose={() => setShowArchiveModal(false)} />
      )}
    </div>
  );
}
