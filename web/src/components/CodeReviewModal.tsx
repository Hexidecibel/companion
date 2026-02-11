import { useState, useCallback, useEffect, useRef } from 'react';
import { FileChange } from '../types';

interface CodeReviewModalProps {
  fileChanges: FileChange[];
  onViewFile: (path: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}

function classifyLine(line: string): string {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'meta';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

export function CodeReviewModal({ fileChanges, onViewFile, onRefresh, onClose }: CodeReviewModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const fileListRef = useRef<HTMLDivElement>(null);

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Scroll selected file into view
  useEffect(() => {
    const container = fileListRef.current;
    if (!container) return;
    const items = container.querySelectorAll('.crm-file-item');
    const selected = items[selectedIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(prev + 1, fileChanges.length - 1));
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(prev - 1, 0));
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (fileChanges[selectedIndex]) {
            toggleExpanded(fileChanges[selectedIndex].path);
          }
          break;
        case 'o':
          e.preventDefault();
          if (fileChanges[selectedIndex]) {
            onViewFile(fileChanges[selectedIndex].path);
          }
          break;
        case 'r':
          e.preventDefault();
          onRefresh();
          break;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [fileChanges, selectedIndex, onClose, onViewFile, onRefresh, toggleExpanded]);

  const writes = fileChanges.filter(f => f.action === 'write').length;
  const edits = fileChanges.filter(f => f.action === 'edit').length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content crm-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            Code Review — {fileChanges.length} file{fileChanges.length !== 1 ? 's' : ''}
            {writes > 0 && ` (${writes} new)`}
            {edits > 0 && ` (${edits} edited)`}
          </h3>
          <div className="crm-header-actions">
            <button className="crm-refresh-btn" onClick={onRefresh} title="Refresh (r)">
              {'\u21BB'}
            </button>
            <button className="modal-close" onClick={onClose}>{'\u2715'}</button>
          </div>
        </div>

        <div className="crm-hints">
          <span><kbd>{'\u2191'}</kbd><kbd>{'\u2193'}</kbd> navigate</span>
          <span><kbd>Enter</kbd> toggle diff</span>
          <span><kbd>o</kbd> open file</span>
          <span><kbd>r</kbd> refresh</span>
          <span><kbd>Esc</kbd> close</span>
        </div>

        <div className="crm-file-list" ref={fileListRef}>
          {fileChanges.map((fc, i) => {
            const fileName = fc.path.split('/').pop() || fc.path;
            const dirPath = fc.path.substring(0, fc.path.lastIndexOf('/'));
            const isSelected = i === selectedIndex;
            const isExpanded = expandedPaths.has(fc.path);
            const hasDiff = !!fc.diff;

            return (
              <div
                key={fc.path}
                className={`crm-file-item ${isSelected ? 'crm-file-selected' : ''}`}
                onClick={() => setSelectedIndex(i)}
              >
                <div className="crm-file-row">
                  <span className={`code-review-action ${fc.action}`}>
                    {fc.action === 'write' ? '+' : '~'}
                  </span>
                  <span
                    className="crm-file-name"
                    onClick={(e) => { e.stopPropagation(); onViewFile(fc.path); }}
                    title={`Open ${fc.path}`}
                  >
                    {fileName}
                  </span>
                  <span className="crm-file-dir">{dirPath}</span>
                  <button
                    className="code-review-diff-toggle"
                    onClick={(e) => { e.stopPropagation(); toggleExpanded(fc.path); }}
                  >
                    {isExpanded ? 'Hide diff' : 'Diff'}
                  </button>
                </div>
                {isExpanded && (
                  <div className="code-review-diff">
                    {hasDiff ? fc.diff!.split('\n').map((line, li) => (
                      <div key={li} className={`code-review-diff-line ${classifyLine(line)}`}>
                        {line || '\n'}
                      </div>
                    )) : (
                      <div className="code-review-diff-line context">No diff available</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
