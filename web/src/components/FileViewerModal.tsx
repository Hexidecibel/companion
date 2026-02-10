import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { MarkdownRenderer } from './MarkdownRenderer';
import { isTauriMobile } from '../utils/platform';
import hljs from 'highlight.js/lib/core';
import 'highlight.js/styles/github-dark.css';

// Register common languages
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import ruby from 'highlight.js/lib/languages/ruby';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import lua from 'highlight.js/lib/languages/lua';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import graphql from 'highlight.js/lib/languages/graphql';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('lua', lua);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('graphql', graphql);

// Map file extensions to highlight.js language names
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyw: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xhtml: 'xml',
  css: 'css',
  scss: 'scss', sass: 'scss',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  lua: 'lua',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini',
  dockerfile: 'dockerfile',
  graphql: 'graphql', gql: 'graphql',
};

function getLangFromFileName(fileName: string): string | undefined {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  // Special filenames
  const lower = fileName.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower === 'makefile' || lower === 'gnumakefile') return 'bash';
  return EXT_TO_LANG[ext];
}

const MAX_RENDER_LINES = 3000;
const MAX_HIGHLIGHT_LENGTH = 100_000; // Skip highlighting for files > 100KB
const MAX_MARKDOWN_LENGTH = 200_000;
const CHUNK_SIZE = 3000;

interface FileViewerModalProps {
  serverId: string;
  filePath: string;
  onClose: () => void;
}

type ContentType = 'markdown' | 'diff' | 'code' | 'image' | 'binary';

function classifyContent(fileName: string, content: string): ContentType {
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

const DiffRenderer = memo(function DiffRenderer({ content }: { content: string }) {
  const allLines = useMemo(() => content.split('\n'), [content]);
  const [showLines, setShowLines] = useState(MAX_RENDER_LINES);
  const lines = allLines.length > showLines ? allLines.slice(0, showLines) : allLines;
  const truncated = allLines.length > showLines;

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
      {truncated && (
        <div className="file-viewer-truncated">
          Showing {showLines.toLocaleString()} of {allLines.length.toLocaleString()} lines
          <button onClick={() => setShowLines(prev => prev + CHUNK_SIZE)}>Show more</button>
        </div>
      )}
    </div>
  );
});

const CodeRenderer = memo(function CodeRenderer({ content, fileName }: { content: string; fileName?: string }) {
  const allLines = useMemo(() => content.split('\n'), [content]);
  const [showLines, setShowLines] = useState(MAX_RENDER_LINES);
  const visibleContent = allLines.length > showLines ? allLines.slice(0, showLines).join('\n') : content;
  const truncated = allLines.length > showLines;

  const lang = fileName ? getLangFromFileName(fileName) : undefined;
  const shouldHighlight = content.length <= MAX_HIGHLIGHT_LENGTH;

  const highlighted = useMemo(() => {
    if (!shouldHighlight) return null;
    try {
      if (lang) {
        return hljs.highlight(visibleContent, { language: lang }).value;
      }
      // No known extension — try auto-detect on first 10KB
      const sample = visibleContent.slice(0, 10_000);
      const result = hljs.highlightAuto(sample);
      if (result.relevance > 5 && result.language) {
        return hljs.highlight(visibleContent, { language: result.language }).value;
      }
    } catch {
      // Fall through to plain text
    }
    return null;
  }, [visibleContent, lang, shouldHighlight]);

  if (highlighted) {
    // Render highlighted HTML with line numbers
    const htmlLines = highlighted.split('\n');
    return (
      <div className="file-viewer-lines">
        {htmlLines.map((html, i) => (
          <div key={i} className="file-viewer-line">
            <span className="file-viewer-line-num">{i + 1}</span>
            <span
              className="file-viewer-line-content"
              dangerouslySetInnerHTML={{ __html: html || '\n' }}
            />
          </div>
        ))}
        {truncated && (
          <div className="file-viewer-truncated">
            Showing {showLines.toLocaleString()} of {allLines.length.toLocaleString()} lines
            <button onClick={() => setShowLines(prev => prev + CHUNK_SIZE)}>Show more</button>
          </div>
        )}
      </div>
    );
  }

  // Fallback: plain text with line numbers
  const lines = allLines.length > showLines ? allLines.slice(0, showLines) : allLines;
  return (
    <div className="file-viewer-lines">
      {lines.map((line, i) => (
        <div key={i} className="file-viewer-line">
          <span className="file-viewer-line-num">{i + 1}</span>
          <span className="file-viewer-line-content">{line || '\n'}</span>
        </div>
      ))}
      {truncated && (
        <div className="file-viewer-truncated">
          Showing {showLines.toLocaleString()} of {allLines.length.toLocaleString()} lines
          <button onClick={() => setShowLines(prev => prev + CHUNK_SIZE)}>Show more</button>
        </div>
      )}
    </div>
  );
});

interface FileData {
  content: string;
  encoding?: 'base64';
  mimeType?: string;
  binary?: boolean;
  size?: number;
}

export function FileViewerModal({ serverId, filePath, onClose }: FileViewerModalProps) {
  const [currentPath, setCurrentPath] = useState(filePath);
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const [fileData, setFileData] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorStatus, setEditorStatus] = useState<'idle' | 'opening' | 'opened' | 'error'>('idle');

  const fileName = currentPath.split('/').pop() || currentPath;
  const content = fileData && !fileData.binary && !fileData.encoding ? fileData.content : null;

  useEffect(() => {
    setLoading(true);
    setError(null);
    setFileData(null);

    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) {
      setError('Server not connected');
      setLoading(false);
      return;
    }

    conn.sendRequest('read_file', { path: currentPath })
      .then((response) => {
        if (response.success && response.payload) {
          setFileData(response.payload as FileData);
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

  const contentType: ContentType = useMemo(() => {
    if (!fileData) return 'code';
    if (fileData.binary) return 'binary';
    if (fileData.encoding === 'base64') return 'image';
    return classifyContent(fileName, fileData.content);
  }, [fileName, fileData]);

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
            {!isTauriMobile() && (
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
            )}
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
          {content !== null && contentType === 'markdown' && content.length <= MAX_MARKDOWN_LENGTH && (
            <MarkdownRenderer content={content} onFileClick={handleFileClick} />
          )}
          {content !== null && contentType === 'markdown' && content.length > MAX_MARKDOWN_LENGTH && (
            <>
              <div className="file-viewer-truncated">Large markdown file — rendered as plain text</div>
              <CodeRenderer content={content} fileName={fileName} />
            </>
          )}
          {content !== null && contentType === 'diff' && (
            <DiffRenderer content={content} />
          )}
          {content !== null && contentType === 'code' && (
            <CodeRenderer content={content} fileName={fileName} />
          )}
          {fileData && contentType === 'image' && fileData.encoding === 'base64' && (
            <div className="file-viewer-image-container">
              <img
                src={`data:${fileData.mimeType};base64,${fileData.content}`}
                alt={fileName}
                className="file-viewer-image"
              />
            </div>
          )}
          {fileData && contentType === 'binary' && (
            <div className="file-viewer-binary">
              Binary file ({fileData.size ? `${(fileData.size / 1024).toFixed(1)} KB` : 'unknown size'})
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
