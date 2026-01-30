import { useState, useEffect, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';

interface FileViewerModalProps {
  serverId: string;
  filePath: string;
  onClose: () => void;
}

export function FileViewerModal({ serverId, filePath, onClose }: FileViewerModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<'idle' | 'opening' | 'opened' | 'error'>('idle');

  const fileName = filePath.split('/').pop() || filePath;

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent(null);

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) {
      setError('Server not connected');
      setLoading(false);
      return;
    }

    conn.sendRequest('read_file', { path: filePath })
      .then((response) => {
        if (response.success && response.payload) {
          const payload = response.payload as { content: string };
          setContent(payload.content);
        } else {
          setError(response.error || 'Failed to read file');
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to read file');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [serverId, filePath]);

  const handleOpenInEditor = useCallback(async () => {
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    setEditorStatus('opening');
    try {
      const response = await conn.sendRequest('open_in_editor', { path: filePath });
      if (response.success) {
        setEditorStatus('opened');
        setTimeout(() => setEditorStatus('idle'), 2000);
      } else {
        setEditorStatus('error');
        setTimeout(() => setEditorStatus('idle'), 3000);
      }
    } catch {
      setEditorStatus('error');
      setTimeout(() => setEditorStatus('idle'), 3000);
    }
  }, [serverId, filePath]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content file-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="file-viewer-title">
            <h3>{fileName}</h3>
            <span className="file-viewer-path">{filePath}</span>
          </div>
          <div className="file-viewer-actions">
            <button
              className={`file-viewer-editor-btn ${editorStatus}`}
              onClick={handleOpenInEditor}
              disabled={editorStatus === 'opening'}
              title="Open in your default editor on the server"
            >
              {editorStatus === 'opening' ? 'Opening...'
                : editorStatus === 'opened' ? 'Opened'
                : editorStatus === 'error' ? 'Failed'
                : 'Open in Editor'}
            </button>
            <button className="modal-close" onClick={onClose}>{'\u2715'}</button>
          </div>
        </div>

        <div className="file-viewer-body">
          {loading && (
            <div className="msg-list-empty">
              <div className="spinner" />
              <span>Loading file...</span>
            </div>
          )}
          {error && (
            <div className="file-viewer-error">{error}</div>
          )}
          {content !== null && (
            <pre className="file-viewer-code">{content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
