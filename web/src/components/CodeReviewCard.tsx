import { FileChange } from '../types';

interface CodeReviewCardProps {
  fileChanges: FileChange[];
  loading: boolean;
  onOpenModal: () => void;
  onRefresh: () => void;
}

export function CodeReviewCard({ fileChanges, loading, onOpenModal, onRefresh }: CodeReviewCardProps) {
  if (loading && fileChanges.length === 0) return null;
  if (fileChanges.length === 0) return null;

  const writes = fileChanges.filter(f => f.action === 'write').length;
  const edits = fileChanges.filter(f => f.action === 'edit').length;

  return (
    <div className="code-review-panel">
      <div
        className="code-review-header"
        onClick={onOpenModal}
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
        <span className="code-review-toggle">{'\u25B8'}</span>
      </div>
    </div>
  );
}
