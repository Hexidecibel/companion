import { MarkdownRenderer } from './MarkdownRenderer';

interface ArtifactViewerModalProps {
  content: string;
  title?: string;
  onClose: () => void;
  onFileClick?: (path: string) => void;
}

export function ArtifactViewerModal({ content, title, onClose, onFileClick }: ArtifactViewerModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content file-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="file-viewer-title">
            <div className="file-viewer-title-text">
              <h3>{title || 'Output'}</h3>
            </div>
          </div>
          <div className="file-viewer-actions">
            <button
              className="file-viewer-editor-btn"
              onClick={() => {
                navigator.clipboard.writeText(content);
              }}
              title="Copy to clipboard"
            >
              Copy
            </button>
            <button className="modal-close" onClick={onClose}>{'\u2715'}</button>
          </div>
        </div>
        <div className="file-viewer-body">
          <MarkdownRenderer content={content} onFileClick={onFileClick} />
        </div>
      </div>
    </div>
  );
}
