import { useState, useEffect, useRef, useCallback } from 'react';

interface SearchBarProps {
  onSearch: (term: string) => void;
  matchCount: number;
  currentMatch: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export function SearchBar({ onSearch, matchCount, currentMatch, onNext, onPrev, onClose }: SearchBarProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleChange = useCallback((text: string) => {
    setValue(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearch(text.trim());
    }, 150);
  }, [onSearch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onPrev();
      } else {
        onNext();
      }
    }
  }, [onClose, onNext, onPrev]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        className="search-bar-input"
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search messages..."
      />
      {value.trim() && (
        <span className="search-bar-count">
          {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : '0 results'}
        </span>
      )}
      <button className="search-bar-nav" onClick={onPrev} disabled={matchCount === 0} title="Previous (Shift+Enter)">
        &#x25B2;
      </button>
      <button className="search-bar-nav" onClick={onNext} disabled={matchCount === 0} title="Next (Enter)">
        &#x25BC;
      </button>
      <button className="search-bar-close" onClick={onClose} title="Close (Escape)">
        &#x2715;
      </button>
    </div>
  );
}
