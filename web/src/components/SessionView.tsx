import { useState, useEffect, useCallback, useMemo } from 'react';
import { PendingImage, WorkGroup } from '../types';
import { useConversation } from '../hooks/useConversation';
import { useTasks } from '../hooks/useTasks';
import { useSubAgents } from '../hooks/useSubAgents';
import { useSubAgentDetail } from '../hooks/useSubAgentDetail';
import { useAutoApprove } from '../hooks/useAutoApprove';
import { useOpenFiles } from '../hooks/useOpenFiles';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
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
import { FileTabBar } from './FileTabBar';
import { extractPlanFilePath } from './MessageBubble';
import { SearchBar } from './SearchBar';
import { ArchiveModal } from './ArchiveModal';
import { TerminalPanel } from './TerminalPanel';
import { WorkGroupBar } from './WorkGroupBar';
import { WorkGroupPanel } from './WorkGroupPanel';

interface SessionViewProps {
  serverId: string | null;
  sessionId: string | null;
  tmuxSessionName?: string;
  workGroup?: WorkGroup;
  onViewWorker?: (sessionId: string) => void;
  onSendWorkerInput?: (workerId: string, text: string) => void;
  onMergeGroup?: () => void;
  onCancelGroup?: () => void;
  onRetryWorker?: (workerId: string) => void;
  merging?: boolean;
}

export function SessionView({
  serverId,
  sessionId,
  tmuxSessionName,
  workGroup,
  onViewWorker,
  onSendWorkerInput,
  onMergeGroup,
  onCancelGroup,
  onRetryWorker,
  merging,
}: SessionViewProps) {
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
  // Sub-agent state
  const [showAgentsModal, setShowAgentsModal] = useState(false);
  const [viewingAgentId, setViewingAgentId] = useState<string | null>(null);
  const agentDetail = useSubAgentDetail(serverId, viewingAgentId);

  // File viewer state
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const { openFiles, openFile, closeFile: closeOpenFile, closeAllFiles } = useOpenFiles(serverId, sessionId);

  // Archive state
  const [showArchiveModal, setShowArchiveModal] = useState(false);

  // Terminal view state
  const [showTerminal, setShowTerminal] = useState(false);

  // Work group panel state
  const [showWorkGroupPanel, setShowWorkGroupPanel] = useState(false);

  // Search state
  const [searchTerm, setSearchTerm] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const searchMatches = useMemo(() => {
    if (!searchTerm) return [];
    const lower = searchTerm.toLowerCase();
    return highlights
      .map((h, i) => ({ id: h.id, index: i }))
      .filter(({ index }) => highlights[index].content?.toLowerCase().includes(lower));
  }, [highlights, searchTerm]);

  // Detect plan file from conversation
  const latestPlanFile = useMemo(() => {
    for (let i = highlights.length - 1; i >= 0; i--) {
      const planPath = extractPlanFilePath(highlights[i]);
      if (planPath) return planPath;
    }
    return null;
  }, [highlights]);

  // Auto-focus input and reset views when session changes
  useEffect(() => {
    setShowTerminal(false);
    setShowWorkGroupPanel(false);
    setViewingFile(null);
    if (serverId && sessionId) {
      requestAnimationFrame(() => {
        const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
        textarea?.focus();
      });
    }
  }, [serverId, sessionId]);

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      return sendInput(text);
    },
    [sendInput],
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

  const handleViewFile = useCallback((path: string) => {
    setViewingFile(path);
    openFile(path);
  }, [openFile]);

  const handleCloseFileTab = useCallback((path: string) => {
    closeOpenFile(path);
    setViewingFile(prev => prev === path ? null : prev);
  }, [closeOpenFile]);

  const handleCloseAllFileTabs = useCallback(() => {
    closeAllFiles();
    setViewingFile(null);
  }, [closeAllFiles]);

  const handleCloseSearch = useCallback(() => {
    setShowSearch(false);
    setSearchTerm(null);
    setCurrentMatchIndex(0);
  }, []);

  const handleSearchNext = useCallback(() => {
    if (searchMatches.length === 0) return;
    setCurrentMatchIndex(prev => (prev + 1) % searchMatches.length);
  }, [searchMatches.length]);

  const handleSearchPrev = useCallback(() => {
    if (searchMatches.length === 0) return;
    setCurrentMatchIndex(prev => (prev - 1 + searchMatches.length) % searchMatches.length);
  }, [searchMatches.length]);

  // Session-specific keyboard shortcuts
  useKeyboardShortcuts(useMemo(() => [
    { key: 'f', meta: true, handler: () => setShowSearch(true) },
    { key: 't', meta: true, handler: () => { if (tmuxSessionName) setShowTerminal(prev => !prev); } },
    { key: 'a', meta: true, shift: true, handler: () => autoApprove.toggle() },
    { key: 'm', meta: true, shift: true, handler: () => { if (sessionId) sessionMute.toggleMute(sessionId); } },
    { key: 'Escape', handler: () => {
      if (showSearch) handleCloseSearch();
      else if (viewingFile) setViewingFile(null);
      else if (showArchiveModal) setShowArchiveModal(false);
      else if (showAgentsModal) setShowAgentsModal(false);
      else if (viewingAgentId) setViewingAgentId(null);
    }},
  ], [tmuxSessionName, showSearch, viewingFile, showArchiveModal, showAgentsModal, viewingAgentId, sessionId, autoApprove, sessionMute, handleCloseSearch]));

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
          {latestPlanFile && (
            <button
              className="session-header-btn plan-btn"
              onClick={() => handleViewFile(latestPlanFile)}
              title={`View plan: ${latestPlanFile}`}
            >
              Plan
            </button>
          )}
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
      ) : showWorkGroupPanel && workGroup && onViewWorker && onSendWorkerInput && onMergeGroup && onCancelGroup && onRetryWorker ? (
        <WorkGroupPanel
          group={workGroup}
          onBack={() => setShowWorkGroupPanel(false)}
          onViewWorker={(workerSessionId) => {
            setShowWorkGroupPanel(false);
            onViewWorker(workerSessionId);
          }}
          onSendWorkerInput={onSendWorkerInput}
          onMerge={onMergeGroup}
          onCancel={onCancelGroup}
          onRetryWorker={onRetryWorker}
          merging={merging}
        />
      ) : (
        <>
          <WaitingIndicator status={status} />

          <SubAgentBar
            agents={agents}
            runningCount={runningCount}
            completedCount={completedCount}
            totalAgents={totalAgents}
            onClick={() => setShowAgentsModal(true)}
            onViewAgent={(agentId) => {
              setViewingAgentId(agentId);
            }}
          />

          {workGroup && workGroup.status === 'active' && (
            <WorkGroupBar
              group={workGroup}
              onClick={() => setShowWorkGroupPanel(true)}
            />
          )}

          <TaskList tasks={tasks} loading={tasksLoading} />

          {showSearch && (
            <SearchBar
              onSearch={(term) => { setSearchTerm(term || null); setCurrentMatchIndex(0); }}
              matchCount={searchMatches.length}
              currentMatch={currentMatchIndex}
              onNext={handleSearchNext}
              onPrev={handleSearchPrev}
              onClose={handleCloseSearch}
            />
          )}

          <MessageList
            highlights={highlights}
            loading={loading}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onSelectOption={handleSelectOption}
            onViewFile={handleViewFile}
            searchTerm={searchTerm}
            currentMatchId={searchMatches.length > 0 ? searchMatches[currentMatchIndex]?.id : null}
          />

          <FileTabBar
            files={openFiles.map(f => f.path)}
            activeFile={viewingFile}
            onSelectFile={setViewingFile}
            onCloseFile={handleCloseFileTab}
            onCloseAll={handleCloseAllFileTabs}
          />

          <InputBar
            onSend={handleSend}
            onSendWithImages={handleSendWithImages}
            disabled={false}
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
