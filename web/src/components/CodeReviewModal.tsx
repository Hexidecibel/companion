import { useState, useCallback, useEffect, useRef } from 'react';
import { FileChange } from '../types';
import { isMobileViewport } from '../utils/platform';
import { ContextMenu, ContextMenuEntry } from './ContextMenu';

interface CommentingLine {
  filePath: string;
  lineNumber: number;
  lineText: string;
  /** Position for the inline input overlay */
  anchorY: number;
}

interface CodeReviewModalProps {
  fileChanges: FileChange[];
  onViewFile: (path: string) => void;
  onRefresh: () => void;
  onClose: () => void;
  onComment?: (text: string) => void;
}

function classifyLine(line: string): string {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'meta';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

export function CodeReviewModal({ fileChanges, onViewFile, onRefresh, onClose, onComment }: CodeReviewModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const fileListRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [contextLine, setContextLine] = useState<CommentingLine | null>(null);
  const [commentingLine, setCommentingLine] = useState<CommentingLine | null>(null);
  const [commentText, setCommentText] = useState('');
  const commentInputRef = useRef<HTMLInputElement>(null);

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

  const handleLineContextMenu = useCallback((
    e: React.MouseEvent,
    filePath: string,
    lineNumber: number,
    lineText: string,
  ) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
    setContextLine({ filePath, lineNumber, lineText, anchorY: e.clientY });
  }, []);

  const handleSubmitComment = useCallback(() => {
    if (!commentingLine || !commentText.trim() || !onComment) return;
    const formatted = `Re: ${commentingLine.filePath}:${commentingLine.lineNumber}\n> ${commentingLine.lineText}\n\n${commentText.trim()}`;
    onComment(formatted);
    setCommentingLine(null);
    setCommentText('');
    onClose();
  }, [commentingLine, commentText, onComment, onClose]);

  // Focus inline comment input when it appears
  useEffect(() => {
    if (commentingLine && commentInputRef.current) {
      commentInputRef.current.focus();
    }
  }, [commentingLine]);

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
      // Don't intercept keys when typing in comment input
      if ((e.target as HTMLElement)?.closest('.crm-comment-input')) return;
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          if (commentingLine) {
            setCommentingLine(null);
            setCommentText('');
          } else {
            onClose();
          }
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
  }, [fileChanges, selectedIndex, onClose, onViewFile, onRefresh, toggleExpanded, commentingLine]);

  const mobile = isMobileViewport();
  const writes = fileChanges.filter(f => f.action === 'write').length;
  const edits = fileChanges.filter(f => f.action === 'edit').length;

  return (
    <>
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

          {!mobile && (
            <div className="crm-hints">
              <span><kbd>{'\u2191'}</kbd><kbd>{'\u2193'}</kbd> navigate</span>
              <span><kbd>Enter</kbd> toggle diff</span>
              <span><kbd>o</kbd> open file</span>
              <span><kbd>r</kbd> refresh</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
          )}

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
                  onClick={() => { setSelectedIndex(i); if (mobile) toggleExpanded(fc.path); }}
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
                      {hasDiff ? (() => {
                        let newLine = 0;
                        let oldLine = 0;
                        return fc.diff!.split('\n').map((line, li) => {
                          const cls = classifyLine(line);
                          let displayLineNum = 0;

                          if (cls === 'hunk') {
                            const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                            if (match) {
                              oldLine = parseInt(match[1], 10);
                              newLine = parseInt(match[2], 10);
                            }
                          } else if (cls === 'added') {
                            displayLineNum = newLine;
                            newLine++;
                          } else if (cls === 'removed') {
                            displayLineNum = oldLine;
                            oldLine++;
                          } else if (cls === 'context') {
                            displayLineNum = newLine;
                            newLine++;
                            oldLine++;
                          }

                          const isCommentable = cls === 'added' || cls === 'removed' || cls === 'context';
                          const lineContent = cls === 'added' || cls === 'removed' ? line.slice(1) : line;

                          return (
                            <div
                              key={li}
                              className={`code-review-diff-line ${cls}`}
                              onContextMenu={isCommentable ? (e) => handleLineContextMenu(e, fc.path, displayLineNum, lineContent.trim()) : undefined}
                            >
                              {line || '\n'}
                            </div>
                          );
                        });
                      })() : (
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

      {contextMenu && contextLine && (
        <ContextMenu
          position={contextMenu}
          onClose={() => { setContextMenu(null); setContextLine(null); }}
          items={[
            ...(onComment ? [{
              label: 'Comment on this line',
              onClick: () => {
                setCommentingLine(contextLine);
                setCommentText('');
              },
            }] : []),
            {
              label: 'Copy line',
              onClick: () => {
                navigator.clipboard.writeText(contextLine.lineText);
              },
            },
          ] as ContextMenuEntry[]}
        />
      )}

      {commentingLine && onComment && (
        <div className="crm-comment-overlay" onClick={() => { setCommentingLine(null); setCommentText(''); }}>
          <div
            className="crm-comment-input"
            onClick={e => e.stopPropagation()}
            style={{ top: Math.min(commentingLine.anchorY, window.innerHeight - 80) }}
          >
            <div className="crm-comment-context">
              {commentingLine.filePath}:{commentingLine.lineNumber}
            </div>
            <div className="crm-comment-line">{commentingLine.lineText}</div>
            <form onSubmit={e => { e.preventDefault(); handleSubmitComment(); }} style={{ display: 'flex', gap: 6 }}>
              <input
                ref={commentInputRef}
                type="text"
                value={commentText}
                onChange={e => setCommentText(e.target.value)}
                placeholder="Add your comment..."
                className="crm-comment-text-input"
              />
              <button type="submit" className="crm-comment-send" disabled={!commentText.trim()}>
                Send
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
