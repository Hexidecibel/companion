import { useRef, useState, useEffect, useCallback } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
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
}

export function MessageList({
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
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const prevHighlightsLenRef = useRef(0);
  const initialIndexRef = useRef<number | undefined>(undefined);

  // Capture initial scroll position once on first meaningful render
  if (initialIndexRef.current === undefined && highlights.length > 0) {
    initialIndexRef.current = highlights.length - 1;
  }

  // Track near-bottom state via Virtuoso's atBottomStateChange
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    isNearBottomRef.current = atBottom;
    setShowScrollButton(!atBottom);
  }, []);

  // Scroll to bottom helper
  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      behavior: 'smooth',
    });
  }, []);

  // Follow new messages (when near bottom) and handle session switches
  useEffect(() => {
    const prevLen = prevHighlightsLenRef.current;
    if (highlights.length > prevLen && prevLen > 0 && isNearBottomRef.current) {
      // New messages appended while user is near bottom — follow
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: 'LAST',
          behavior: 'smooth',
        });
      });
    }
    // Session switch: was empty, now has messages
    if (prevLen === 0 && highlights.length > 0) {
      isNearBottomRef.current = true;
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: 'LAST',
          behavior: 'auto',
        });
      });
    }
    prevHighlightsLenRef.current = highlights.length;
  }, [highlights.length]);

  // Scroll to bottom when switching back from terminal to chat
  useEffect(() => {
    if (scrollToBottomProp) {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: 'LAST',
          behavior: 'auto',
        });
        isNearBottomRef.current = true;
      });
    }
  }, [scrollToBottomProp]);

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
          virtuosoRef.current?.scrollToIndex({
            index: 'LAST',
            behavior: 'auto',
          });
          isNearBottomRef.current = true;
          setShowScrollButton(false);
        }, 150);
      }
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // Scroll to current search match
  useEffect(() => {
    if (!currentMatchId) return;
    const idx = highlights.findIndex(h => h.id === currentMatchId);
    if (idx >= 0) {
      virtuosoRef.current?.scrollToIndex({
        index: idx,
        behavior: 'smooth',
        align: 'center',
      });
    }
  }, [currentMatchId, highlights]);

  // Load more when scrolling near top
  const handleStartReached = useCallback(() => {
    if (loadingMore || !hasMore) return;
    onLoadMore();
  }, [loadingMore, hasMore, onLoadMore]);

  // Render each message item
  const itemContent = useCallback((_index: number, msg: ConversationHighlight) => {
    return (
      <MessageBubble
        key={msg.id}
        message={msg}
        onSelectOption={onSelectOption}
        onSelectChoice={onSelectChoice}
        onCancelMessage={onCancelMessage}
        onViewFile={onViewFile}
        onViewArtifact={onViewArtifact}
        searchTerm={searchTerm}
        isCurrentMatch={msg.id === currentMatchId}
        planFilePath={planFilePath}
        hideTools={hideTools}
        isBookmarked={isBookmarked?.(msg.id)}
        onToggleBookmark={onToggleBookmark}
        serverId={serverId}
      />
    );
  }, [onSelectOption, onSelectChoice, onCancelMessage, onViewFile, onViewArtifact, searchTerm, currentMatchId, planFilePath, hideTools, isBookmarked, onToggleBookmark, serverId]);

  // Header component shown when loading more
  const Header = useCallback(() => {
    if (!loadingMore) return null;
    return (
      <div className="msg-list-loading-more">
        <div className="spinner small" />
      </div>
    );
  }, [loadingMore]);

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
      <Virtuoso
        ref={virtuosoRef}
        data={highlights}
        itemContent={itemContent}
        initialTopMostItemIndex={initialIndexRef.current}
        computeItemKey={(_index, item) => item.id}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={200}
        startReached={handleStartReached}
        components={{ Header }}
        increaseViewportBy={{ top: 400, bottom: 400 }}
      />
      {showScrollButton && (
        <button
          className="scroll-to-bottom-btn"
          onClick={scrollToBottom}
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
}
