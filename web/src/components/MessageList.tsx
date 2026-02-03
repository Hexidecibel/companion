import { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { ConversationHighlight } from '../types';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  highlights: ConversationHighlight[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onSelectOption?: (label: string) => void;
  onViewFile?: (path: string) => void;
  searchTerm?: string | null;
  currentMatchId?: string | null;
}

export function MessageList({
  highlights,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onSelectOption,
  onViewFile,
  searchTerm,
  currentMatchId,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const isPrependRef = useRef(false);

  // Track near-bottom state on every scroll
  const updateNearBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 120;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Auto-scroll to bottom whenever highlights change (new messages OR content updates)
  // if the user was already near the bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [highlights]);

  // Scroll to current search match
  useEffect(() => {
    if (!currentMatchId || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-highlight-id="${currentMatchId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentMatchId]);

  // Preserve scroll position when prepending (load more) only — not on normal updates
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (isPrependRef.current && prevScrollHeightRef.current > 0 && el.scrollHeight > prevScrollHeightRef.current) {
      const diff = el.scrollHeight - prevScrollHeightRef.current;
      el.scrollTop += diff;
    }
    prevScrollHeightRef.current = el.scrollHeight;
    isPrependRef.current = false;
  }, [highlights]);

  // Scroll handler for load-more trigger + near-bottom tracking
  const handleScroll = useCallback(() => {
    updateNearBottom();
    const el = containerRef.current;
    if (!el || loadingMore || !hasMore) return;
    if (el.scrollTop < 80) {
      prevScrollHeightRef.current = el.scrollHeight;
      isPrependRef.current = true;
      onLoadMore();
    }
  }, [loadingMore, hasMore, onLoadMore, updateNearBottom]);

  if (loading) {
    return (
      <div className="msg-list-empty">
        <div className="spinner" />
        <span>Loading conversation...</span>
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

  const handleClick = (e: React.MouseEvent) => {
    // Don't steal focus from interactive elements or text selection
    const target = e.target as HTMLElement;
    if (target.closest('button, a, code, pre, .option-btn, .tool-card')) return;
    if (window.getSelection()?.toString()) return;
    const textarea = document.querySelector('.input-bar-textarea') as HTMLElement | null;
    textarea?.focus();
  };

  return (
    <div className="msg-list" ref={containerRef} onScroll={handleScroll} onClick={handleClick}>
      {loadingMore && (
        <div className="msg-list-loading-more">
          <div className="spinner small" />
        </div>
      )}
      {highlights.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onSelectOption={onSelectOption}
          onViewFile={onViewFile}
          searchTerm={searchTerm}
          isCurrentMatch={msg.id === currentMatchId}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
