import { useRef, useEffect, useLayoutEffect } from 'react';
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
}

export function MessageList({
  highlights,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  onSelectOption,
  onViewFile,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(highlights.length);
  const wasNearBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);

  // Check if user is near bottom before updates
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 120;
    wasNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  });

  // Auto-scroll to bottom on new messages (when near bottom)
  useEffect(() => {
    const added = highlights.length - prevLengthRef.current;
    prevLengthRef.current = highlights.length;

    if (added > 0 && wasNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [highlights.length]);

  // Preserve scroll position when prepending (load more)
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (prevScrollHeightRef.current > 0 && el.scrollHeight > prevScrollHeightRef.current) {
      const diff = el.scrollHeight - prevScrollHeightRef.current;
      el.scrollTop += diff;
    }
    prevScrollHeightRef.current = el.scrollHeight;
  }, [highlights]);

  // Scroll handler for load-more trigger
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el || loadingMore || !hasMore) return;
    if (el.scrollTop < 80) {
      prevScrollHeightRef.current = el.scrollHeight;
      onLoadMore();
    }
  };

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
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
