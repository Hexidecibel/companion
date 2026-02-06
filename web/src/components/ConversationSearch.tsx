import { useState, useEffect, useRef, useCallback } from 'react';
import { ConversationHighlight } from '../types';
import { connectionManager } from '../services/ConnectionManager';
import { MessageBubble } from './MessageBubble';

interface ConversationSearchProps {
  serverId: string;
  onClose: () => void;
}

interface SearchResult {
  filePath: string;
  fileName: string;
  lastModified: number;
  snippet: string;
  matchCount: number;
}

function relativeDate(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ConversationSearch({ serverId, onClose }: ConversationSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Viewer mode
  const [viewingFile, setViewingFile] = useState<{ filePath: string; lastModified: number } | null>(null);
  const [viewerHighlights, setViewerHighlights] = useState<ConversationHighlight[]>([]);
  const [viewerLoading, setViewerLoading] = useState(false);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Search on query change (debounced)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    debounceRef.current = setTimeout(() => {
      const conn = connectionManager.getConnection(serverId);
      if (!conn || !conn.isConnected()) return;

      setLoading(true);
      conn.sendRequest('search_conversations', { query: query.trim(), limit: 20 })
        .then((response) => {
          if (response.success && response.payload) {
            const payload = response.payload as { results: SearchResult[] };
            setResults(payload.results);
            setSelectedIndex(0);
          }
        })
        .catch(() => {})
        .finally(() => {
          setLoading(false);
        });
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, serverId]);

  const handleSelectResult = useCallback((result: SearchResult) => {
    setViewingFile({ filePath: result.filePath, lastModified: result.lastModified });
    setViewerLoading(true);
    setViewerHighlights([]);

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    conn.sendRequest('get_conversation_file', { filePath: result.filePath, limit: 200 })
      .then((response) => {
        if (response.success && response.payload) {
          const payload = response.payload as { highlights: ConversationHighlight[] };
          setViewerHighlights(payload.highlights);
        }
      })
      .catch(() => {})
      .finally(() => {
        setViewerLoading(false);
      });
  }, [serverId]);

  const handleBack = useCallback(() => {
    setViewingFile(null);
    setViewerHighlights([]);
    // Re-focus input after returning
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[selectedIndex]) {
        handleSelectResult(results[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (viewingFile) {
        handleBack();
      } else {
        onClose();
      }
    }
  }, [results, selectedIndex, handleSelectResult, viewingFile, handleBack, onClose]);

  // Highlight matching text in snippet
  const highlightSnippet = (snippet: string) => {
    if (!query.trim()) return snippet;
    const q = query.trim();
    const idx = snippet.toLowerCase().indexOf(q.toLowerCase());
    if (idx >= 0) {
      return (
        <>
          {snippet.slice(0, idx)}
          <span className="conversation-search-match">{snippet.slice(idx, idx + q.length)}</span>
          {snippet.slice(idx + q.length)}
        </>
      );
    }
    return snippet;
  };

  // Viewer mode
  if (viewingFile) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="conversation-search conversation-search-viewer-mode" onClick={(e) => e.stopPropagation()}>
          <div className="conversation-search-header">
            <button className="conversation-search-back" onClick={handleBack}>
              {'\u2039'} Back
            </button>
            <span className="conversation-search-date">{relativeDate(viewingFile.lastModified)}</span>
            <button className="modal-close" onClick={onClose}>{'\u2715'}</button>
          </div>
          <div className="conversation-search-viewer">
            {viewerLoading && (
              <div className="conversation-search-empty">Loading conversation...</div>
            )}
            {!viewerLoading && viewerHighlights.length === 0 && (
              <div className="conversation-search-empty">No messages found</div>
            )}
            {viewerHighlights.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Search mode
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="conversation-search" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="conversation-search-input"
          type="text"
          placeholder="Search past conversations..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="conversation-search-results">
          {!query.trim() && (
            <div className="conversation-search-empty">Search across past conversations in this project</div>
          )}
          {query.trim() && !loading && results.length === 0 && (
            <div className="conversation-search-empty">No matches</div>
          )}
          {results.map((result, i) => (
            <div
              key={result.filePath}
              className={`conversation-search-item ${i === selectedIndex ? 'conversation-search-item-selected' : ''}`}
              onClick={() => handleSelectResult(result)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <div className="conversation-search-item-info">
                <span className="conversation-search-date">{relativeDate(result.lastModified)}</span>
                <span className="conversation-search-snippet">{highlightSnippet(result.snippet)}</span>
              </div>
              <span className="conversation-search-count">{result.matchCount}</span>
            </div>
          ))}
          {loading && results.length === 0 && (
            <div className="conversation-search-empty">Searching...</div>
          )}
        </div>
      </div>
    </div>
  );
}
