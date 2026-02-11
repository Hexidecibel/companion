import { useState, useCallback } from 'react';
import { FileChange } from '../types';

interface CodeReviewCardProps {
  fileChanges: FileChange[];
  loading: boolean;
  onViewFile: (path: string) => void;
  onRefresh: () => void;
}

export function CodeReviewCard({ fileChanges, loading, onViewFile, onRefresh }: CodeReviewCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);

  const toggleDiff = useCallback((path: string) => {
    setExpandedDiff(prev => prev === path ? null : path);
  }, []);

  if (loading && fileChanges.length === 0) return null;
  if (fileChanges.length === 0) return null;

  const writes = fileChanges.filter(f => f.action === 'write').length;
  const edits = fileChanges.filter(f => f.action === 'edit').length;

  return (
    <div className="code-review-panel">
      <div
        className="code-review-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="code-review-icon">{'\u0394'}</span>
        <span className="code-review-summary">
          {fileChanges.length} file{fileChanges.length !== 1 ? 's' : ''} changed
          {writes > 0 && ` (${writes} new)`}
          {edits > 0 && ` (${edits} edited)`}
        </span>
        <button
          className="code-review-refresh"
          onClick={(e) => { e.stopPropagation(); onRefresh(); }}
          title="Refresh diff"
        >
          {'\u21BB'}
        </button>
        <span className="code-review-toggle">{expanded ? '\u25B4' : '\u25BE'}</span>
      </div>

      {expanded && (
        <div className="code-review-files">
          {fileChanges.map((fc) => {
            const fileName = fc.path.split('/').pop() || fc.path;
            const hasDiff = !!fc.diff;
            const isDiffExpanded = expandedDiff === fc.path;

            return (
              <div key={fc.path} className="code-review-file">
                <div className="code-review-file-row">
                  <span className={`code-review-action ${fc.action}`}>
                    {fc.action === 'write' ? '+' : '~'}
                  </span>
                  <span
                    className="code-review-file-name"
                    onClick={() => onViewFile(fc.path)}
                    title={fc.path}
                  >
                    {fileName}
                  </span>
                  <span className="code-review-file-path">
                    {fc.path.substring(0, fc.path.lastIndexOf('/'))}
                  </span>
                  {hasDiff && (
                    <button
                      className="code-review-diff-toggle"
                      onClick={() => toggleDiff(fc.path)}
                    >
                      {isDiffExpanded ? 'Hide diff' : 'Diff'}
                    </button>
                  )}
                </div>
                {isDiffExpanded && fc.diff && (
                  <div className="code-review-diff">
                    {fc.diff.split('\n').map((line, i) => (
                      <div key={i} className={`code-review-diff-line ${classifyLine(line)}`}>
                        {line || '\n'}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function classifyLine(line: string): string {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'meta';
  if (line.startsWith('diff --git') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}
