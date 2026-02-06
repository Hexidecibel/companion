import { useState, useEffect, useRef, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';

interface FileFinderProps {
  serverId: string;
  onSelectFile: (path: string) => void;
  onClose: () => void;
}

interface FileResult {
  path: string;
  relativePath: string;
}

export function FileFinder({ serverId, onSelectFile, onClose }: FileFinderProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      conn.sendRequest('search_files', { query: query.trim(), limit: 20 })
        .then((response) => {
          if (response.success && response.payload) {
            const payload = response.payload as { files: FileResult[] };
            setResults(payload.files);
            setSelectedIndex(0);
          }
        })
        .catch(() => {
          // Silently ignore
        })
        .finally(() => {
          setLoading(false);
        });
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, serverId]);

  const handleSelect = useCallback((filePath: string) => {
    onSelectFile(filePath);
    onClose();
  }, [onSelectFile, onClose]);

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
        handleSelect(results[selectedIndex].path);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [results, selectedIndex, handleSelect, onClose]);

  // Highlight matching characters in the path
  const highlightMatch = (relativePath: string) => {
    if (!query.trim()) return relativePath;
    const q = query.trim().toLowerCase();
    const idx = relativePath.toLowerCase().indexOf(q);
    if (idx >= 0) {
      return (
        <>
          {relativePath.slice(0, idx)}
          <span className="file-finder-match">{relativePath.slice(idx, idx + q.length)}</span>
          {relativePath.slice(idx + q.length)}
        </>
      );
    }
    return relativePath;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="file-finder" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="file-finder-input"
          type="text"
          placeholder="Search files by name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="file-finder-results">
          {!query.trim() && (
            <div className="file-finder-empty">Type to search files in this project</div>
          )}
          {query.trim() && !loading && results.length === 0 && (
            <div className="file-finder-empty">No matching files</div>
          )}
          {results.map((file, i) => (
            <div
              key={file.path}
              className={`file-finder-item ${i === selectedIndex ? 'file-finder-item-selected' : ''}`}
              onClick={() => handleSelect(file.path)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="file-finder-item-name">
                {highlightMatch(file.relativePath)}
              </span>
            </div>
          ))}
          {loading && results.length === 0 && (
            <div className="file-finder-empty">Searching...</div>
          )}
        </div>
      </div>
    </div>
  );
}
