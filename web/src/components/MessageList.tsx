import { useRef, useState, useEffect, useCallback, memo } from 'react';
import { ConversationHighlight } from '../types';
import { MessageBubble } from './MessageBubble';
import { SkeletonMessageBubble } from './Skeleton';

interface MessageListProps {
  highlights: ConversationHighlight[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onSelectOption?: (label: string) => void | Promise<boolean>;
  onSelectChoice?: (choice: { selectedIndices: number[]; optionCount: number; multiSelect: boolean; otherText?: string }) => Promise<boolean>;
  onCancelMessage?: (clientMessageId: string) => void;
  onViewFile?: (path: string) => void;
  onViewArtifact?: (content: string, title?: string) => void;
  searchTerm?: string | null;
  currentMatchId?: string | null;
  scrollToBottom?: boolean;
  planFilePath?: string | null;
  hideTools?: boolean;
  isBookmarked?: (messageId: string) => boolean;
  onToggleBookmark?: (messageId: string, content: string) => void;
  serverId?: string | null;
  sessionId?: string | null;
}

export const MessageList = memo(function MessageList({
  highlights,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onSelectOption,
  onSelectChoice,
  onCancelMessage,
  onViewFile,
  onViewArtifact,
  searchTerm,
  currentMatchId,
  scrollToBottom: scrollToBottomProp,
  planFilePath,
  hideTools,
  isBookmarked,
  onToggleBookmark,
  serverId,
  sessionId,
}: MessageListProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const prevHighlightsLenRef = useRef(0);
  const needsScrollRef = useRef(true); // true initially for first load scroll
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);

  // Scroll handler - update refs, only setState when value changes
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    isNearBottomRef.current = nearBottom;
    setShowScrollButton(prev => {
      const next = !nearBottom;
      return prev === next ? prev : next;
    });
  }, []);

  // Scroll to bottom helper
  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Mark scroll needed on session switch
  useEffect(() => {
    needsScrollRef.current = true;
    prevHighlightsLenRef.current = 0;
  }, [sessionId]);

  // Session-switch scroll: waits for loading to finish and scroll container to exist
  useEffect(() => {
    if (!needsScrollRef.current) return;
    if (loading) return; // still showing skeleton, container doesn't exist
    const el = scrollContainerRef.current;
    if (!el || highlights.length === 0) return;

    needsScrollRef.current = false;
    isNearBottomRef.current = true;
    setShowScrollButton(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToBottom(false));
    });
  }, [highlights.length, sessionId, loading, scrollToBottom]);

  // Auto-follow: smooth scroll when new messages arrive and user is near bottom
  useEffect(() => {
    if (needsScrollRef.current) {
      // Session switch in progress — handled by the effect above
      prevHighlightsLenRef.current = highlights.length;
      return;
    }

    const prevLen = prevHighlightsLenRef.current;
    prevHighlightsLenRef.current = highlights.length;

    // New messages appended while following
    if (highlights.length > prevLen && prevLen > 0 && isNearBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom(true));
    }
  }, [highlights.length, scrollToBottom]);

  // Scroll to bottom when switching back from terminal to chat
  useEffect(() => {
    if (scrollToBottomProp) {
      requestAnimationFrame(() => {
        scrollToBottom(false);
        isNearBottomRef.current = true;
        setShowScrollButton(false);
      });
    }
  }, [scrollToBottomProp, scrollToBottom]);

  // Scroll to bottom on viewport resize (keyboard open/close) if near bottom
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let lastHeight = vv.height;
    const onResize = () => {
      const diff = Math.abs(vv.height - lastHeight);
      if (diff < 100) return;
      lastHeight = vv.height;
      if (isNearBottomRef.current) {
        setTimeout(() => {
          scrollToBottom(false);
          isNearBottomRef.current = true;
          setShowScrollButton(false);
        }, 150);
      }
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [scrollToBottom]);

  // Scroll to current search match
  useEffect(() => {
    if (!currentMatchId) return;
    const el = document.getElementById(`msg-${currentMatchId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentMatchId]);

  // IntersectionObserver for load-more at top
  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore && !loadingMore) {
          onLoadMore();
        }
      },
      { root: scrollContainerRef.current, rootMargin: '200px 0px 0px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, code, pre, .option-btn, .tool-card')) return;
    if (window.getSelection()?.toString()) return;
    if ('ontouchstart' in window && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
      return;
    }
    const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
    textarea?.focus();
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px' }}>
        <SkeletonMessageBubble side="left" lines={2} />
        <SkeletonMessageBubble side="right" lines={3} />
        <SkeletonMessageBubble side="left" lines={4} />
        <SkeletonMessageBubble side="right" lines={2} />
        <SkeletonMessageBubble side="left" lines={3} />
      </div>
    );
  }

  if (highlights.length === 0) {
    return (
      <div className="msg-list-empty">
        <span>No messages yet</span>
      </div>
    );
  }

  return (
    <div className="msg-list" onClick={handleClick} style={{ position: 'relative' }}>
      <div
        ref={scrollContainerRef}
        className="msg-list-scroll"
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', overflowAnchor: 'auto' } as React.CSSProperties}
      >
        {/* Load-more sentinel */}
        <div ref={loadMoreSentinelRef} style={{ height: 1 }} />
        {loadingMore && (
          <div className="msg-list-loading-more">
            <div className="spinner small" />
          </div>
        )}
        {highlights.map((msg) => {
          const filteredMsg = hideTools && msg.toolCalls
            ? {
                ...msg,
                toolCalls: msg.toolCalls.filter(t => t.status === 'pending' || t.name === 'ExitPlanMode'),
              }
            : msg;

          return (
            <div key={msg.id} id={`msg-${msg.id}`}>
              <MessageBubble
                message={filteredMsg}
                onSelectOption={onSelectOption}
                onSelectChoice={onSelectChoice}
                onCancelMessage={onCancelMessage}
                onViewFile={onViewFile}
                onViewArtifact={onViewArtifact}
                searchTerm={searchTerm}
                isCurrentMatch={msg.id === currentMatchId}
                planFilePath={planFilePath}
                isBookmarked={isBookmarked?.(msg.id)}
                onToggleBookmark={onToggleBookmark}
                serverId={serverId}
              />
            </div>
          );
        })}
      </div>
      {showScrollButton && (
        <button
          className="scroll-to-bottom-btn"
          onClick={() => scrollToBottom()}
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
    </div>
  );
});
