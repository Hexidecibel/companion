import { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo, memo } from 'react';
import { ConversationHighlight } from '../types';
import { MessageBubble } from './MessageBubble';
import { SkeletonMessageBubble } from './Skeleton';
import scrollDebugger from '../utils/scrollDebugger';

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
    const prevNearBottom = isNearBottomRef.current;
    isNearBottomRef.current = nearBottom;
    if (scrollDebugger.enabled && prevNearBottom !== nearBottom) {
      scrollDebugger.record({
        timestamp: performance.now(),
        type: 'user-scroll',
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        messageCount: prevHighlightsLenRef.current,
        nearBottom,
        source: 'handleScroll-nearBottom-toggle',
      });
    }
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

    if (scrollDebugger.enabled) {
      scrollDebugger.record({
        timestamp: performance.now(),
        type: 'effect-fired',
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        messageCount: highlights.length,
        nearBottom: isNearBottomRef.current,
        source: 'session-switch-effect-entry',
      });
    }

    needsScrollRef.current = false;
    isNearBottomRef.current = true;
    setShowScrollButton(false);

    let rAFCount = 0;
    const doScroll = (source: string) => {
      const container = scrollContainerRef.current;
      if (container) {
        if (scrollDebugger.enabled) {
          rAFCount += 1;
          const before = container.scrollTop;
          scrollDebugger.record({
            timestamp: performance.now(),
            type: 'effect-fired',
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
            messageCount: highlights.length,
            nearBottom: isNearBottomRef.current,
            source,
            rAFCount,
            layoutShiftDelta: container.scrollHeight - before - container.clientHeight,
          });
        }
        container.scrollTop = container.scrollHeight;
      }
    };

    // Double-rAF for immediate scroll (works on desktop)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => doScroll('session-switch-raf'));
    });

    // On mobile, content layout can settle after rAFs when loading from cache.
    // ResizeObserver catches when the scroll container actually gets its dimensions.
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.height > 0) {
          if (scrollDebugger.enabled) {
            const container = scrollContainerRef.current;
            scrollDebugger.record({
              timestamp: performance.now(),
              type: 'resize-observer',
              scrollTop: container?.scrollTop ?? 0,
              scrollHeight: container?.scrollHeight ?? 0,
              clientHeight: container?.clientHeight ?? 0,
              messageCount: highlights.length,
              nearBottom: isNearBottomRef.current,
              source: 'session-switch-resize-observer',
              layoutShiftDelta: entry.contentRect.height,
            });
          }
          doScroll('session-switch-resize-observer-doScroll');
          ro.disconnect();
        }
      }
    });
    ro.observe(el);

    const cleanup = setTimeout(() => ro.disconnect(), 1000);
    return () => {
      ro.disconnect();
      clearTimeout(cleanup);
    };
  }, [highlights.length, sessionId, loading]);

  // Force repaint on mobile after content transition (skeleton → messages).
  // Mobile Chrome can defer painting the new DOM tree; reading offsetHeight
  // forces synchronous layout/paint.
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (el && !loading && highlights.length > 0) {
      void el.offsetHeight;
    }
  }, [loading, highlights.length, sessionId]);

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
      if (scrollDebugger.enabled) {
        const el = scrollContainerRef.current;
        scrollDebugger.record({
          timestamp: performance.now(),
          type: 'effect-fired',
          scrollTop: el?.scrollTop ?? 0,
          scrollHeight: el?.scrollHeight ?? 0,
          clientHeight: el?.clientHeight ?? 0,
          messageCount: highlights.length,
          prevMessageCount: prevLen,
          nearBottom: isNearBottomRef.current,
          source: 'auto-follow',
        });
      }
      requestAnimationFrame(() => scrollToBottom(true));
    } else if (scrollDebugger.enabled && highlights.length !== prevLen) {
      // Detect potential jump: messageCount unchanged but scroll may have moved
      const el = scrollContainerRef.current;
      if (el) {
        scrollDebugger.record({
          timestamp: performance.now(),
          type: 'jump-detected',
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          messageCount: highlights.length,
          prevMessageCount: prevLen,
          nearBottom: isNearBottomRef.current,
          source: 'auto-follow-skipped',
        });
      }
    }
  }, [highlights.length, scrollToBottom]);

  // Scroll to bottom when switching back from terminal to chat
  useEffect(() => {
    if (scrollToBottomProp) {
      if (scrollDebugger.enabled) {
        const el = scrollContainerRef.current;
        scrollDebugger.record({
          timestamp: performance.now(),
          type: 'effect-fired',
          scrollTop: el?.scrollTop ?? 0,
          scrollHeight: el?.scrollHeight ?? 0,
          clientHeight: el?.clientHeight ?? 0,
          messageCount: prevHighlightsLenRef.current,
          nearBottom: isNearBottomRef.current,
          source: 'terminal-to-chat',
        });
      }
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
        if (scrollDebugger.enabled) {
          const el = scrollContainerRef.current;
          scrollDebugger.record({
            timestamp: performance.now(),
            type: 'effect-fired',
            scrollTop: el?.scrollTop ?? 0,
            scrollHeight: el?.scrollHeight ?? 0,
            clientHeight: el?.clientHeight ?? 0,
            messageCount: prevHighlightsLenRef.current,
            nearBottom: isNearBottomRef.current,
            source: 'keyboard-resize',
            layoutShiftDelta: diff,
          });
        }
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

  // Memoize the visible message list at the slice level so a single recompute
  // happens per [highlights, hideTools] change instead of an inline filter
  // running per-message during render. Doing this inline left a window where
  // the rendered list could be computed against a stale highlights snapshot
  // (e.g. while highlights had just populated but the parent hadn't pushed a
  // fresh `hideTools` value yet) — toggling the filter forced a recompute and
  // the list "appeared". Memoizing at this level closes that timing gap.
  const visibleMessages = useMemo(() => {
    if (!hideTools) return highlights;
    return highlights.map((msg) => {
      if (!msg.toolCalls) return msg;
      return {
        ...msg,
        toolCalls: msg.toolCalls.filter(t => t.status === 'pending' || t.name === 'ExitPlanMode'),
      };
    });
  }, [highlights, hideTools]);

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
        {visibleMessages.map((msg) => (
          <div key={msg.id} id={`msg-${msg.id}`}>
            <MessageBubble
              message={msg}
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
        ))}
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
