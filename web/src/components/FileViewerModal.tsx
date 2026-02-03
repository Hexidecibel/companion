import { useState, useEffect, useCallback, useMemo } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { MarkdownRenderer } from './MarkdownRenderer';

interface FileViewerModalProps {
  serverId: string;
  filePath: string;
  onClose: () => void;
}

function classifyContent(fileName: string, content: string): 'markdown' | 'diff' | 'code' {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'mdx') return 'markdown';
  if (ext === 'diff' || ext === 'patch') return 'diff';
  if (content.startsWith('diff --git ') || content.startsWith('--- a/') || content.startsWith('Index: ')) return 'diff';
  return 'code';
}

function classifyDiffLine(line: string): 'added' | 'removed' | 'hunk' | 'meta' | 'context' {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'meta';
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('Index: ')) return 'meta';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

/** Resolve a relative path against the directory of the current file */
function resolvePath(currentFile: string, relativePath: string): string {
  if (relativePath.startsWith('/') || relativePath.startsWith('~/')) {
    return relativePath;
  }
  // Get the directory of the current file
  const dir = currentFile.substring(0, currentFile.lastIndexOf('/'));
  // Simple path resolution: split, handle . and ..
  const parts = (dir + '/' + relativePath).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  const prefix = currentFile.startsWith('/') ? '/' : '';
  return prefix + resolved.join('/');
}

function DiffRenderer({ content }: { content: string }) {
  const lines = useMemo(() => content.split('\n'), [content]);

  return (
    <div className="file-viewer-diff">
      {lines.map((line, i) => {
        const cls = classifyDiffLine(line);
        return (
          <div key={i} className={`file-viewer-diff-line ${cls}`}>
            {line || '\n'}
          </div>
        );
      })}
    </div>
  );
}

function CodeRenderer({ content }: { content: string }) {
  const lines = useMemo(() => content.split('\n'), [content]);

  return (
    <div className="file-viewer-lines">
      {lines.map((line, i) => (
        <div key={i} className="file-viewer-line">
          <span className="file-viewer-line-num">{i + 1}</span>
          <span className="file-viewer-line-content">{line || '\n'}</span>
        </div>
      ))}
    </div>
  );
}

export function FileViewerModal({ serverId, filePath, onClose }: FileViewerModalProps) {
  const [currentPath, setCurrentPath] = useState(filePath);
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<'idle' | 'opening' | 'opened' | 'error'>('idle');

  const fileName = currentPath.split('/').pop() || currentPath;

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

    conn.sendRequest('read_file', { path: currentPath })
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
  }, [serverId, currentPath]);

  const handleOpenInEditor = useCallback(async () => {
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    setEditorStatus('opening');
    try {
      const response = await conn.sendRequest('open_in_editor', { path: currentPath });
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
  }, [serverId, currentPath]);

  const handleFileClick = useCallback((relativePath: string) => {
    const resolved = resolvePath(currentPath, relativePath);
    setPathHistory((prev) => [...prev, currentPath]);
    setCurrentPath(resolved);
  }, [currentPath]);

  const handleBack = useCallback(() => {
    setPathHistory((prev) => {
      const next = [...prev];
      const previous = next.pop();
      if (previous) {
        setCurrentPath(previous);
      }
      return next;
    });
  }, []);

  const contentType = useMemo(() => {
    if (content === null) return 'code';
    return classifyContent(fileName, content);
  }, [fileName, content]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content file-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="file-viewer-title">
            {pathHistory.length > 0 && (
              <button className="file-viewer-back-btn" onClick={handleBack} title="Go back">
                {'\u2190'}
              </button>
            )}
            <div className="file-viewer-title-text">
              <h3>{fileName}</h3>
              <span className="file-viewer-path">{currentPath}</span>
            </div>
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
          {content !== null && contentType === 'markdown' && (
            <MarkdownRenderer content={content} onFileClick={handleFileClick} />
          )}
          {content !== null && contentType === 'diff' && (
            <DiffRenderer content={content} />
          )}
          {content !== null && contentType === 'code' && (
            <CodeRenderer content={content} />
          )}
        </div>
      </div>
    </div>
  );
}
