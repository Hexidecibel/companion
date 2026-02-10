import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { PendingImage, WorkGroup } from '../types';
import { useConversation } from '../hooks/useConversation';
import { useTasks } from '../hooks/useTasks';
import { useSubAgents } from '../hooks/useSubAgents';
import { useSubAgentDetail } from '../hooks/useSubAgentDetail';
import { useAutoApprove } from '../hooks/useAutoApprove';
import { useOpenFiles } from '../hooks/useOpenFiles';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { connectionManager } from '../services/ConnectionManager';
import { isMobileViewport } from '../utils/platform';
import { useSessionMute } from '../hooks/useSessionMute';
import { useMessageQueue } from '../hooks/useMessageQueue';
import { useSkills } from '../hooks/useSkills';
import { WaitingIndicator } from './WaitingIndicator';
import { TaskList } from './TaskList';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { SubAgentBar } from './SubAgentBar';
import { SubAgentModal } from './SubAgentModal';
import { SubAgentDetail } from './SubAgentDetail';
import { FileViewerModal } from './FileViewerModal';
import { ArtifactViewerModal } from './ArtifactViewerModal';
import { FileTabBar } from './FileTabBar';
import { extractPlanFilePath } from './MessageBubble';
import { SearchBar } from './SearchBar';
import { ConversationSearch } from './ConversationSearch';
import { TerminalPanel } from './TerminalPanel';
import { WorkGroupBar } from './WorkGroupBar';
import { WorkGroupPanel } from './WorkGroupPanel';
import { FileFinder } from './FileFinder';
import { QueuedMessageBar } from './QueuedMessageBar';

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
  onDismissGroup?: () => void;
  merging?: boolean;
  onToggleSidebar?: () => void;
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
  onDismissGroup,
  merging,
  onToggleSidebar,
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
  } = useConversation(serverId, sessionId, tmuxSessionName);

  const { tasks, loading: tasksLoading } = useTasks(serverId, sessionId);
  const { agents, runningCount, completedCount, totalAgents } = useSubAgents(serverId, sessionId);
  const autoApprove = useAutoApprove(serverId, sessionId);
  const sessionMute = useSessionMute(serverId);
  const { skills } = useSkills(serverId);
  const { queuedMessages, enqueue, cancel: cancelQueued, edit: editQueued, clearAll: clearAllQueued } = useMessageQueue(serverId, sessionId);
  // Sub-agent state
  const [showAgentsModal, setShowAgentsModal] = useState(false);
  const [viewingAgentId, setViewingAgentId] = useState<string | null>(null);
  const agentDetail = useSubAgentDetail(serverId, viewingAgentId);

  // File viewer state
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const { openFiles, openFile, closeFile: closeOpenFile, closeAllFiles } = useOpenFiles(serverId, sessionId);

  // Conversation search state
  const [showConversationSearch, setShowConversationSearch] = useState(false);

  // Artifact viewer state
  const [artifactContent, setArtifactContent] = useState<{ content: string; title?: string } | null>(null);

  // Terminal view state
  const [showTerminal, setShowTerminal] = useState(false);

  // Work group panel state
  const [showWorkGroupPanel, setShowWorkGroupPanel] = useState(false);

  // Search state
  const [searchTerm, setSearchTerm] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  // File finder state
  const [showFileFinder, setShowFileFinder] = useState(false);

  const searchMatches = useMemo(() => {
    if (!searchTerm) return [];
    const lower = searchTerm.toLowerCase();
    return highlights
      .map((h, i) => ({ id: h.id, index: i }))
      .filter(({ index }) => highlights[index].content?.toLowerCase().includes(lower));
  }, [highlights, searchTerm]);

  // Detect plan file from conversation (Claude-generated plans)
  const latestPlanFile = useMemo(() => {
    for (let i = highlights.length - 1; i >= 0; i--) {
      const planPath = extractPlanFilePath(highlights[i]);
      if (planPath) return planPath;
    }
    return null;
  }, [highlights]);

  // Signal to Dashboard that an overlay is open (for back gesture coordination)
  useEffect(() => {
    const isOverlay = showTerminal || showWorkGroupPanel || showConversationSearch || showFileFinder;
    document.body.dataset.overlay = isOverlay ? 'true' : '';
    return () => { document.body.dataset.overlay = ''; };
  }, [showTerminal, showWorkGroupPanel, showConversationSearch, showFileFinder]);

  // Listen for close-overlay event from Dashboard's back gesture handler
  useEffect(() => {
    const handler = () => {
      if (showConversationSearch) setShowConversationSearch(false);
      else if (showFileFinder) setShowFileFinder(false);
      else if (showTerminal) setShowTerminal(false);
      else if (showWorkGroupPanel) setShowWorkGroupPanel(false);
    };
    window.addEventListener('close-overlay', handler);
    return () => window.removeEventListener('close-overlay', handler);
  }, [showTerminal, showWorkGroupPanel, showConversationSearch, showFileFinder]);

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

  // Always keep textarea focused on desktop — re-focus whenever focus leaves
  useEffect(() => {
    if (isMobileViewport() || !serverId || !sessionId) return;
    const refocus = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        // Don't steal focus from other interactive elements
        if (active && active.closest('input, textarea:not(.input-bar-textarea), [contenteditable], select')) return;
        const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
        textarea?.focus();
      });
    };
    // Focus on any view change (terminal toggle, etc.)
    refocus();
    // Re-focus when clicks happen outside interactive elements
    document.addEventListener('focusout', refocus);
    return () => document.removeEventListener('focusout', refocus);
  }, [showTerminal, serverId, sessionId]);

  // Click on conversation area focuses textarea (desktop only)
  const handleConversationClick = useCallback((e: React.MouseEvent) => {
    if (isMobileViewport()) return;
    const target = e.target as HTMLElement;
    // Don't steal focus from interactive elements
    if (target.closest('button, a, input, textarea, [role="button"], .msg-option-btn, .tool-card, .question-block')) return;
    const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
    textarea?.focus();
  }, []);

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      // Only queue when we positively know Claude is working (status loaded, not waiting).
      // When status is null/unknown, send directly to avoid blocking the user.
      if (status && !status.isWaitingForInput && status.isRunning) {
        enqueue(text);
        return true;
      }
      return sendInput(text);
    },
    [sendInput, status, enqueue],
  );

  // Auto-send queued messages when Claude becomes ready
  const drainingRef = useRef(false);
  useEffect(() => {
    if (status?.isWaitingForInput && queuedMessages.length > 0 && !drainingRef.current) {
      drainingRef.current = true;
      const next = queuedMessages[0];
      sendInput(next.text).then((ok) => {
        if (ok) cancelQueued(next.id);
        drainingRef.current = false;
      });
    }
  }, [status?.isWaitingForInput, queuedMessages, cancelQueued, sendInput]);

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
          tmuxSessionName,
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
    { key: 'p', meta: true, handler: () => setShowFileFinder(true) },
    { key: 't', meta: true, handler: () => { if (tmuxSessionName) setShowTerminal(prev => !prev); } },
    { key: 'a', meta: true, shift: true, handler: () => autoApprove.toggle() },
    { key: 'm', meta: true, shift: true, handler: () => { if (sessionId) sessionMute.toggleMute(sessionId); } },
    { key: 'Escape', handler: () => {
      if (showFileFinder) setShowFileFinder(false);
      else if (showSearch) handleCloseSearch();
      else if (artifactContent) setArtifactContent(null);
      else if (viewingFile) setViewingFile(null);
      else if (showConversationSearch) setShowConversationSearch(false);
      else if (showAgentsModal) setShowAgentsModal(false);
      else if (viewingAgentId) setViewingAgentId(null);
    }},
  ], [tmuxSessionName, showSearch, showFileFinder, viewingFile, showConversationSearch, showAgentsModal, viewingAgentId, artifactContent, sessionId, autoApprove, sessionMute, handleCloseSearch]));

  const sendTerminalText = useCallback(async (text: string): Promise<boolean> => {
    if (!serverId || !tmuxSessionName) return false;
    const conn = connectionManager.getConnection(serverId);
    if (!conn?.isConnected()) return false;
    try {
      const response = await conn.sendRequest('send_terminal_text', {
        sessionName: tmuxSessionName,
        text,
      });
      return response.success;
    } catch {
      return false;
    }
  }, [serverId, tmuxSessionName]);

  const sendTerminalKey = useCallback((key: string) => {
    if (!serverId || !tmuxSessionName) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn?.isConnected()) return;
    conn.sendRequest('send_terminal_keys', {
      sessionName: tmuxSessionName,
      keys: [key],
    });
  }, [serverId, tmuxSessionName]);

  const handleCancel = useCallback(() => {
    sendTerminalKey('C-c');
  }, [sendTerminalKey]);

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

  const mobile = isMobileViewport();

  const actionButtons = (
    <div className="session-header-actions">
      {status?.isRunning && !status?.isWaitingForInput && tmuxSessionName && (
        <button
          className="cancel-btn"
          onClick={handleCancel}
          title="Send Ctrl+C to cancel"
        >
          Cancel
        </button>
      )}
      {sessionId && (
        <button
          className={`auto-approve-btn ${!sessionMute.isMuted(sessionId) ? 'auto-approve-btn-active' : ''}`}
          onClick={() => sessionMute.toggleMute(sessionId)}
          title={sessionMute.isMuted(sessionId) ? 'Unmute notifications' : 'Mute notifications'}
        >
          {sessionMute.isMuted(sessionId) ? 'Notify: OFF' : 'Notify: ON'}
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
        onClick={() => setShowFileFinder(true)}
        title="Search files (Cmd+P)"
      >
        Files
      </button>
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
        onClick={() => setShowConversationSearch(true)}
        title="Search past conversations"
      >
        Search
      </button>
    </div>
  );

  return (
    <div className="session-view">
      {/* Top header: back arrow on mobile, full header on desktop */}
      <div className={`session-header ${mobile ? 'session-header-mobile' : ''}`}>
        {onToggleSidebar && (
          mobile ? (
            <button
              className="mobile-back-btn"
              onClick={onToggleSidebar}
              title="Back"
              aria-label="Back"
            >
              <span className="back-arrow">{'\u2190'}</span> Back
            </button>
          ) : (
            <button
              className="mobile-menu-btn"
              onClick={onToggleSidebar}
              title="Toggle sidebar"
              aria-label="Toggle sidebar"
            >
              {'\u2630'}
            </button>
          )
        )}
        {!mobile && actionButtons}
      </div>

      {showTerminal && tmuxSessionName && serverId && (
        <TerminalPanel
          serverId={serverId}
          tmuxSessionName={tmuxSessionName}
          fastPoll
          onClose={() => setShowTerminal(false)}
        />
      )}

      {showWorkGroupPanel && workGroup && onViewWorker && onSendWorkerInput && onMergeGroup && onCancelGroup && onRetryWorker && (
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
          onDismiss={onDismissGroup}
          merging={merging}
        />
      )}

      <div className="session-conversation" onClick={handleConversationClick} style={{ display: showTerminal || showWorkGroupPanel ? 'none' : undefined }}>
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

          {workGroup && (workGroup.status === 'active' || workGroup.status === 'merging' || workGroup.status === 'completed' || workGroup.status === 'failed') && (
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
            onViewArtifact={(content, title) => setArtifactContent({ content, title })}
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

          {mobile && (
            <div className="session-bottom-bar">
              {actionButtons}
            </div>
          )}
      </div>

      <QueuedMessageBar
        messages={queuedMessages}
        onCancel={cancelQueued}
        onEdit={editQueued}
        onClearAll={clearAllQueued}
      />

      <InputBar
        onSend={handleSend}
        onSendWithImages={handleSendWithImages}
        disabled={false}
        skills={skills}
        terminalMode={showTerminal}
        onTerminalSend={sendTerminalText}
        onTerminalKey={sendTerminalKey}
      />

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

      {artifactContent && (
        <ArtifactViewerModal
          content={artifactContent.content}
          title={artifactContent.title}
          onClose={() => setArtifactContent(null)}
          onFileClick={handleViewFile}
        />
      )}

      {showConversationSearch && serverId && (
        <ConversationSearch serverId={serverId} onClose={() => setShowConversationSearch(false)} />
      )}

      {showFileFinder && serverId && (
        <FileFinder
          serverId={serverId}
          onSelectFile={handleViewFile}
          onClose={() => setShowFileFinder(false)}
        />
      )}
    </div>
  );
}
