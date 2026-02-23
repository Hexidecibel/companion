import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { PendingImage, WorkGroup } from '../types';
import { useConversation } from '../hooks/useConversation';
import { useTasks } from '../hooks/useTasks';
import { useCodeReview } from '../hooks/useCodeReview';
import { useSubAgents } from '../hooks/useSubAgents';
import { useBypassPermissions } from '../hooks/useBypassPermissions';
import { useOpenFiles } from '../hooks/useOpenFiles';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { connectionManager } from '../services/ConnectionManager';
import { isMobileViewport } from '../utils/platform';
import { useSessionMute } from '../hooks/useSessionMute';
import { useSkills } from '../hooks/useSkills';
import { WaitingIndicator } from './WaitingIndicator';
import { TaskList } from './TaskList';
import { CodeReviewCard } from './CodeReviewCard';
import { CodeReviewModal } from './CodeReviewModal';
import { MessageList } from './MessageList';
import { InputBar, InputBarHandle } from './InputBar';
import { DispatchPanel } from './DispatchPanel';
import { FileViewerModal } from './FileViewerModal';
import { ArtifactViewerModal } from './ArtifactViewerModal';
import { FileTabBar } from './FileTabBar';
import { extractPlanFilePath, extractInlinePlan } from './MessageBubble';
import { SearchBar } from './SearchBar';
import { ConversationSearch } from './ConversationSearch';
import { TerminalPanel } from './TerminalPanel';
import { WorkGroupBar } from './WorkGroupBar';
import { WorkGroupPanel } from './WorkGroupPanel';
import { FileFinder } from './FileFinder';
import { useBookmarks } from '../hooks/useBookmarks';
import { BookmarkList } from './BookmarkList';
import { FetchErrorBanner } from './FetchErrorBanner';
import { hideToolsKey } from '../services/storageKeys';

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
    cancelMessage,
    addOptimisticMessage,
    loadMore,
  } = useConversation(serverId, sessionId, tmuxSessionName);

  const { tasks, loading: tasksLoading, error: tasksError, refresh: refreshTasks } = useTasks(serverId, sessionId);
  const { fileChanges, loading: reviewLoading, error: reviewError, refresh: refreshReview } = useCodeReview(serverId, sessionId);
  const { agents, runningCount, totalAgents, error: agentsError } = useSubAgents(serverId, sessionId);
  const bypass = useBypassPermissions(serverId, sessionId);
  const sessionMute = useSessionMute(serverId);
  const { skills } = useSkills(serverId);
  // Dispatch panel state
  const DISPATCH_HEIGHT_KEY = 'dispatch-panel-height';
  const [dispatchCollapsed, setDispatchCollapsed] = useState(true);
  const [dispatchHeight, setDispatchHeight] = useState(() => {
    const stored = localStorage.getItem(DISPATCH_HEIGHT_KEY);
    return stored ? parseInt(stored, 10) : 280;
  });
  const dispatchDraggingRef = useRef(false);
  const prevRunningRef = useRef(0);

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

  // Code review modal state
  const [showCodeReviewModal, setShowCodeReviewModal] = useState(false);

  // Bookmarks
  const { addBookmark, removeBookmark, isBookmarked, sessionBookmarks } = useBookmarks(serverId);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const currentBookmarks = sessionId ? sessionBookmarks(sessionId) : [];

  // Tool card visibility (persisted per session in localStorage)
  const toolsKey = sessionId ? hideToolsKey(sessionId) : null;
  const [hideTools, setHideToolsRaw] = useState(() => {
    if (!toolsKey) return false;
    return localStorage.getItem(toolsKey) === '1';
  });
  const setHideTools = useCallback((hide: boolean) => {
    setHideToolsRaw(hide);
    if (toolsKey) localStorage.setItem(toolsKey, hide ? '1' : '0');
  }, [toolsKey]);

  // Sync hideTools when session changes
  useEffect(() => {
    setHideToolsRaw(toolsKey ? localStorage.getItem(toolsKey) === '1' : false);
  }, [toolsKey]);

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

  // Detect inline plan content (ExitPlanMode with input.plan)
  const latestInlinePlan = useMemo(() => {
    if (latestPlanFile) return null; // file path takes priority
    for (let i = highlights.length - 1; i >= 0; i--) {
      const plan = extractInlinePlan(highlights[i]);
      if (plan) return plan;
    }
    return null;
  }, [highlights, latestPlanFile]);

  // Auto-show dispatch panel when agents START running (desktop only, not on initial load)
  // Auto-collapse ~3s after all agents finish (desktop only)
  const hasMountedRef = useRef(false);
  const autoCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Clear any pending auto-collapse timer
    if (autoCollapseTimerRef.current) {
      clearTimeout(autoCollapseTimerRef.current);
      autoCollapseTimerRef.current = null;
    }

    if (hasMountedRef.current && !isMobileViewport()) {
      // Auto-open when agents start running
      if (runningCount > 0 && prevRunningRef.current === 0) {
        setDispatchCollapsed(false);
      }
      // Auto-collapse after all agents complete (brief delay so user sees "done" state)
      if (runningCount === 0 && prevRunningRef.current > 0) {
        autoCollapseTimerRef.current = setTimeout(() => {
          setDispatchCollapsed(true);
        }, 3000);
      }
    }
    prevRunningRef.current = runningCount;
    hasMountedRef.current = true;

    return () => {
      if (autoCollapseTimerRef.current) {
        clearTimeout(autoCollapseTimerRef.current);
      }
    };
  }, [runningCount]);

  const showDispatchPanel = !dispatchCollapsed && totalAgents > 0;

  const handleDispatchDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dispatchDraggingRef.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const container = (e.target as HTMLElement).closest('.session-view');
    if (!container) return;
    const containerRect = container.getBoundingClientRect();

    const onMouseMove = (ev: MouseEvent) => {
      if (!dispatchDraggingRef.current) return;
      const newHeight = Math.min(
        Math.max(containerRect.bottom - ev.clientY, 100),
        containerRect.height - 100
      );
      setDispatchHeight(newHeight);
    };

    const onMouseUp = () => {
      dispatchDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      setDispatchHeight((h) => {
        localStorage.setItem(DISPATCH_HEIGHT_KEY, String(h));
        return h;
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // Track whether dispatch overlay is open on mobile (for back gesture)
  const dispatchOverlayOpen = isMobileViewport() && !dispatchCollapsed && totalAgents > 0;

  // Signal to Dashboard that an overlay is open (for back gesture coordination)
  useEffect(() => {
    const isOverlay = showTerminal || showWorkGroupPanel || showConversationSearch || showFileFinder || showCodeReviewModal || dispatchOverlayOpen || !!viewingFile || !!artifactContent || showBookmarks;
    document.body.dataset.overlay = isOverlay ? 'true' : '';
    return () => { document.body.dataset.overlay = ''; };
  }, [showTerminal, showWorkGroupPanel, showConversationSearch, showFileFinder, showCodeReviewModal, dispatchOverlayOpen, viewingFile, artifactContent, showBookmarks]);

  // Listen for close-overlay event from Dashboard's back gesture handler
  useEffect(() => {
    const handler = () => {
      // Close innermost/topmost overlay first
      if (artifactContent) setArtifactContent(null);
      else if (viewingFile) setViewingFile(null);
      else if (dispatchOverlayOpen) setDispatchCollapsed(true);
      else if (showCodeReviewModal) setShowCodeReviewModal(false);
      else if (showConversationSearch) setShowConversationSearch(false);
      else if (showFileFinder) setShowFileFinder(false);
      else if (showBookmarks) setShowBookmarks(false);
      else if (showTerminal) setShowTerminal(false);
      else if (showWorkGroupPanel) setShowWorkGroupPanel(false);
    };
    window.addEventListener('close-overlay', handler);
    return () => window.removeEventListener('close-overlay', handler);
  }, [showTerminal, showWorkGroupPanel, showConversationSearch, showFileFinder, showCodeReviewModal, dispatchOverlayOpen, viewingFile, artifactContent, showBookmarks]);

  // Reset views when session changes, auto-focus on desktop only
  useEffect(() => {
    setShowTerminal(false);
    setShowWorkGroupPanel(false);
    setViewingFile(null);
    if (serverId && sessionId && !isMobileViewport()) {
      requestAnimationFrame(() => {
        const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
        textarea?.focus();
      });
    }
  }, [serverId, sessionId]);

  // Always keep textarea focused on desktop — re-focus whenever focus leaves
  useEffect(() => {
    if (isMobileViewport() || !serverId || !sessionId) return;
    // Track mouse-down state to avoid stealing focus during click-drag selection
    let mouseDown = false;
    const onMouseDown = () => { mouseDown = true; };
    const onMouseUp = () => {
      mouseDown = false;
      // After mouseup, refocus if no text was selected and focus isn't on an interactive element
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active.closest('input, textarea:not(.input-bar-textarea), [contenteditable], select')) return;
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;
        const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
        textarea?.focus();
      });
    };

    const refocus = () => {
      requestAnimationFrame(() => {
        if (mouseDown) return;
        const active = document.activeElement;
        // Don't steal focus from other interactive elements
        if (active && active.closest('input, textarea:not(.input-bar-textarea), [contenteditable], select')) return;
        // Don't steal focus if user is selecting text
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;
        const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
        textarea?.focus();
      });
    };
    // Focus on any view change (terminal toggle, etc.)
    refocus();
    // Re-focus when clicks happen outside interactive elements
    document.addEventListener('focusout', refocus);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('focusout', refocus);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [showTerminal, serverId, sessionId]);

  // Click on conversation area focuses textarea (desktop only)
  const handleConversationClick = useCallback((e: React.MouseEvent) => {
    if (isMobileViewport()) return;
    const target = e.target as HTMLElement;
    // Don't steal focus from interactive elements
    if (target.closest('button, a, input, textarea, [role="button"], .msg-option-btn, .tool-card, .question-block, .dispatch-panel, .dispatch-mobile-overlay')) return;
    // Don't steal focus if user is selecting text
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
    textarea?.focus();
  }, []);

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
    { key: 'f', meta: true, alt: true, handler: () => setShowSearch(true) },
    { key: 'p', meta: true, alt: true, handler: () => setShowFileFinder(true) },
    { key: 't', meta: true, alt: true, handler: () => { if (tmuxSessionName) setShowTerminal(prev => !prev); } },
    { key: 'a', meta: true, alt: true, shift: true, handler: () => bypass.toggle() },
    { key: 'm', meta: true, alt: true, shift: true, handler: () => { if (sessionId) sessionMute.toggleMute(sessionId); } },
    { key: 'Escape', handler: () => {
      if (showCodeReviewModal) setShowCodeReviewModal(false);
      else if (showFileFinder) setShowFileFinder(false);
      else if (showSearch) handleCloseSearch();
      else if (artifactContent) setArtifactContent(null);
      else if (viewingFile) setViewingFile(null);
      else if (showConversationSearch) setShowConversationSearch(false);
    }},
  ], [tmuxSessionName, showSearch, showFileFinder, showCodeReviewModal, viewingFile, showConversationSearch, artifactContent, sessionId, bypass, sessionMute, handleCloseSearch]));

  const sendTerminalText = useCallback(async (text: string): Promise<boolean> => {
    if (!serverId || !tmuxSessionName) return false;
    const conn = connectionManager.getConnection(serverId);
    if (!conn?.isConnected()) return false;
    try {
      const response = await conn.sendRequest('send_terminal_text', {
        sessionName: tmuxSessionName,
        text,
      });
      if (response.success) {
        addOptimisticMessage(text);
      }
      return response.success;
    } catch {
      return false;
    }
  }, [serverId, tmuxSessionName, addOptimisticMessage]);

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

  // Reference to InputBar for pre-filling text on cancel
  const inputBarRef = useRef<InputBarHandle>(null);

  const handleCancelMessage = useCallback(async (clientMessageId: string) => {
    const originalText = await cancelMessage(clientMessageId);
    if (originalText && inputBarRef.current) {
      inputBarRef.current.prefill(originalText);
    }
  }, [cancelMessage]);

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
    return sendInput(label, { skipOptimistic: true });
  };

  const handleSelectChoice = async (choice: {
    selectedIndices: number[];
    optionCount: number;
    multiSelect: boolean;
    otherText?: string;
  }): Promise<boolean> => {
    if (!serverId || !sessionId) return false;
    const conn = connectionManager.getConnection(serverId);
    if (!conn?.isConnected()) return false;
    try {
      const response = await conn.sendRequest('send_choice', {
        ...choice,
        sessionId,
        tmuxSessionName: tmuxSessionName || sessionId,
      });
      return response.success;
    } catch {
      return false;
    }
  };

  const mobile = isMobileViewport();

  // View/action buttons — shown in header on mobile, in header bar on desktop
  const viewButtons = (
    <>
      <button
        className="session-header-btn"
        onClick={() => setShowFileFinder(true)}
        title="Search files (Cmd+P)"
      >
        Files
      </button>
      {latestPlanFile ? (
        <button
          className="session-header-btn plan-btn"
          onClick={() => handleViewFile(latestPlanFile)}
          title={`View plan: ${latestPlanFile}`}
        >
          Plan
        </button>
      ) : latestInlinePlan ? (
        <button
          className="session-header-btn plan-btn"
          onClick={() => setArtifactContent({ content: latestInlinePlan, title: 'Plan' })}
          title="View plan"
        >
          Plan
        </button>
      ) : null}
      <button
        className="session-header-btn"
        onClick={() => setShowConversationSearch(true)}
        title="Search past conversations"
      >
        Search
      </button>
      {currentBookmarks.length > 0 && (
        <button
          className="session-header-btn"
          onClick={() => setShowBookmarks(!showBookmarks)}
          title="View bookmarks"
        >
          Bookmarks ({currentBookmarks.length})
        </button>
      )}
      {fileChanges.length > 0 && (
        <button
          className="session-header-btn"
          onClick={() => setShowCodeReviewModal(true)}
          title="Review file changes"
        >
          Review ({fileChanges.length})
        </button>
      )}
    </>
  );

  // Operational buttons — shown in bottom bar on mobile, in header bar on desktop
  const operationalButtons = (
    <>
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
        className={`auto-approve-btn ${bypass.enabled ? 'auto-approve-btn-active' : ''}`}
        onClick={bypass.toggle}
        disabled={bypass.loading}
        title={bypass.enabled ? 'Permission bypass enabled — tools run without prompts' : 'Permission bypass disabled'}
      >
        {bypass.enabled ? 'Bypass: ON' : 'Bypass: OFF'}
      </button>
      <button
        className={`auto-approve-btn ${!hideTools ? 'auto-approve-btn-active' : ''}`}
        onClick={() => setHideTools(!hideTools)}
        title={hideTools ? 'Show tool cards' : 'Hide tool cards'}
      >
        {hideTools ? 'Tools: OFF' : 'Tools: ON'}
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
    </>
  );

  // Combined for desktop header
  const actionButtons = (
    <div className="session-header-actions">
      {operationalButtons}
      {viewButtons}
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
        {mobile ? (
          <div className="session-header-actions">
            {viewButtons}
          </div>
        ) : actionButtons}
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
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
            <WaitingIndicator status={status} />

            {workGroup && (workGroup.status === 'active' || workGroup.status === 'merging' || workGroup.status === 'completed' || workGroup.status === 'failed') && (
              <WorkGroupBar
                group={workGroup}
                onClick={() => setShowWorkGroupPanel(true)}
              />
            )}

            <TaskList tasks={tasks} loading={tasksLoading} />

            <CodeReviewCard
              fileChanges={fileChanges}
              loading={reviewLoading}
              onOpenModal={() => setShowCodeReviewModal(true)}
              onRefresh={refreshReview}
            />

            {tasksError && (
              <FetchErrorBanner message={`Tasks: ${tasksError}`} onRetry={refreshTasks} />
            )}
            {reviewError && (
              <FetchErrorBanner message={`Code review: ${reviewError}`} onRetry={refreshReview} />
            )}
            {agentsError && (
              <FetchErrorBanner message={`Agents: ${agentsError}`} />
            )}

            {!mobile && dispatchCollapsed && totalAgents > 0 && serverId && (
              <div className="dispatch-collapsed-bar" onClick={() => setDispatchCollapsed(false)}>
                <span className={`dispatch-mobile-dot ${runningCount > 0 ? 'dispatch-dot-running' : 'dispatch-dot-done'}`} />
                <span className="dispatch-collapsed-label">
                  {runningCount > 0
                    ? `${runningCount} agent${runningCount !== 1 ? 's' : ''} running`
                    : `${totalAgents} agent${totalAgents !== 1 ? 's' : ''} done`}
                  {(totalAgents - runningCount) > 0 && runningCount > 0 &&
                    ` / ${totalAgents - runningCount} done`}
                </span>
                <span className="dispatch-collapsed-expand">{'\u25B2'}</span>
              </div>
            )}

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

            {showBookmarks && (
              <BookmarkList
                bookmarks={currentBookmarks}
                onNavigate={(messageId) => {
                  const el = document.querySelector(`[data-highlight-id="${messageId}"]`);
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
                onRemove={removeBookmark}
                onClose={() => setShowBookmarks(false)}
              />
            )}

            <MessageList
              highlights={highlights}
              loading={loading}
              loadingMore={loadingMore}
              hasMore={hasMore}
              onLoadMore={loadMore}
              onSelectOption={handleSelectOption}
              onSelectChoice={handleSelectChoice}
              onCancelMessage={handleCancelMessage}
              onViewFile={handleViewFile}
              onViewArtifact={(content, title) => setArtifactContent({ content, title })}
              searchTerm={searchTerm}
              currentMatchId={searchMatches.length > 0 ? searchMatches[currentMatchIndex]?.id : null}
              scrollToBottom={!showTerminal}
              planFilePath={latestPlanFile}
              hideTools={hideTools}
              isBookmarked={isBookmarked}
              onToggleBookmark={(messageId, content) => {
                if (!sessionId) return;
                if (isBookmarked(messageId)) {
                  removeBookmark(messageId);
                } else {
                  addBookmark(messageId, sessionId, content);
                }
              }}
            />

            <FileTabBar
              files={openFiles.map(f => f.path)}
              activeFile={viewingFile}
              onSelectFile={setViewingFile}
              onCloseFile={handleCloseFileTab}
              onCloseAll={handleCloseAllFileTabs}
            />
          </div>

          {mobile && (
            <div className="session-bottom-bar">
              <div className="session-header-actions">
                {operationalButtons}
              </div>
            </div>
          )}
      </div>

      {showDispatchPanel && !mobile && (
        <div className="dispatch-divider" onMouseDown={handleDispatchDragStart} />
      )}

      {serverId && totalAgents > 0 && (
        <DispatchPanel
          serverId={serverId}
          agents={agents}
          runningCount={runningCount}
          totalAgents={totalAgents}
          height={dispatchHeight}
          collapsed={dispatchCollapsed}
          onCollapse={() => setDispatchCollapsed(prev => !prev)}
        />
      )}

      <InputBar
        ref={inputBarRef}
        onSend={handleSend}
        onSendWithImages={handleSendWithImages}
        disabled={false}
        skills={skills}
        terminalMode={showTerminal}
        onTerminalSend={sendTerminalText}
        onTerminalKey={sendTerminalKey}
      />

      {/* Modals */}
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

      {showCodeReviewModal && fileChanges.length > 0 && (
        <CodeReviewModal
          fileChanges={fileChanges}
          onViewFile={handleViewFile}
          onRefresh={refreshReview}
          onClose={() => setShowCodeReviewModal(false)}
          onComment={handleSend}
          sessionId={sessionId}
        />
      )}

      {showConversationSearch && serverId && (
        <ConversationSearch serverId={serverId} onClose={() => setShowConversationSearch(false)} />
      )}

      {showFileFinder && serverId && (
        <FileFinder
          serverId={serverId}
          sessionId={sessionId || undefined}
          onSelectFile={handleViewFile}
          onClose={() => setShowFileFinder(false)}
        />
      )}
    </div>
  );
}
