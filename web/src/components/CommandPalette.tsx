import { useState, useEffect, useCallback, useRef } from 'react';

export interface CommandAction {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  execute: () => void;
}

interface CommandPaletteProps {
  actions: CommandAction[];
  onClose: () => void;
}

export function CommandPalette({ actions, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = query
    ? actions.filter((a) => a.label.toLowerCase().includes(query.toLowerCase()))
    : actions;

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const executeAction = useCallback((action: CommandAction) => {
    onClose();
    action.execute();
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % Math.max(filtered.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + filtered.length) % Math.max(filtered.length, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIndex]) {
        executeAction(filtered[activeIndex]);
      }
    }
  }, [filtered, activeIndex, executeAction, onClose]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);

  return (
    <div className="command-palette-overlay" onClick={handleOverlayClick}>
      <div className="command-palette" onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          placeholder="Type a command..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-list">
          {filtered.length === 0 ? (
            <div className="command-palette-empty">No matching commands</div>
          ) : (
            filtered.map((action, i) => (
              <div
                key={action.id}
                className={`command-palette-item ${i === activeIndex ? 'active' : ''}`}
                onClick={() => executeAction(action)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="command-palette-item-icon">{action.icon}</span>
                <span className="command-palette-item-label">{action.label}</span>
                {action.shortcut && (
                  <span className="command-palette-item-shortcut">{action.shortcut}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
