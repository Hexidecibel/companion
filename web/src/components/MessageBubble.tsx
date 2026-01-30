import { useState } from 'react';
import { ConversationHighlight } from '../types';
import { ToolCard } from './ToolCard';

interface MessageBubbleProps {
  message: ConversationHighlight;
  onSelectOption?: (label: string) => void;
  onViewFile?: (path: string) => void;
}

export function MessageBubble({ message, onSelectOption, onViewFile }: MessageBubbleProps) {
  const isUser = message.type === 'user';
  const [allExpanded, setAllExpanded] = useState<boolean | undefined>(undefined);

  const toolCalls = !isUser ? message.toolCalls : undefined;
  const hasMultipleTools = toolCalls && toolCalls.length >= 2;

  return (
    <div className={`msg-row ${isUser ? 'msg-row-user' : 'msg-row-assistant'}`}>
      <div className={`msg-bubble ${isUser ? 'msg-bubble-user' : 'msg-bubble-assistant'}`}>
        {!isUser && onViewFile ? (
          <pre className="msg-content">
            <FilePathContent content={message.content} onViewFile={onViewFile} />
          </pre>
        ) : (
          <pre className="msg-content">{message.content}</pre>
        )}
      </div>

      {toolCalls && toolCalls.length > 0 && (
        <div className="msg-tools">
          {hasMultipleTools && (
            <button
              className="msg-tools-toggle"
              onClick={() => setAllExpanded(allExpanded === true ? false : true)}
            >
              {allExpanded === true ? 'Collapse All' : 'Expand All'}
            </button>
          )}
          {toolCalls.map((tool) => (
            <ToolCard key={tool.id} tool={tool} forceExpanded={allExpanded} />
          ))}
        </div>
      )}

      {message.isWaitingForChoice && message.questions && onSelectOption && (
        <div className="msg-options">
          {message.questions.map((q) =>
            q.options.map((opt) => (
              <button
                key={opt.label}
                className="msg-option-btn"
                onClick={() => onSelectOption(opt.label)}
                title={opt.description}
              >
                {opt.label}
              </button>
            )),
          )}
        </div>
      )}

      {message.isWaitingForChoice && !message.questions && message.options && onSelectOption && (
        <div className="msg-options">
          {message.options.map((opt) => (
            <button
              key={opt.label}
              className="msg-option-btn"
              onClick={() => onSelectOption(opt.label)}
              title={opt.description}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Path detection for file links in assistant messages
const FILE_PATH_RE = /(?:^|[\s(["'])(\/?(?:~\/|\/)[^\s)>"'\]]+)/g;
const URL_RE = /^https?:\/\//;

interface FilePathContentProps {
  content: string;
  onViewFile: (path: string) => void;
}

function FilePathContent({ content, onViewFile }: FilePathContentProps) {
  const segments: Array<{ type: 'text' | 'path'; value: string }> = [];
  let lastIndex = 0;

  const regex = new RegExp(FILE_PATH_RE.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const path = (match[1] || match[0]).trim();
    if (URL_RE.test(path) || path.length < 3) continue;

    // Only match paths that look like file paths
    if (!path.startsWith('/') && !path.startsWith('~/')) continue;

    const fullMatchStart = match.index + (match[0].length - (match[1] || match[0]).trim().length);
    const fullMatchEnd = fullMatchStart + path.length;

    if (fullMatchStart > lastIndex) {
      segments.push({ type: 'text', value: content.slice(lastIndex, fullMatchStart) });
    }
    segments.push({ type: 'path', value: path });
    lastIndex = fullMatchEnd;
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', value: content.slice(lastIndex) });
  }

  if (segments.length === 0 || (segments.length === 1 && segments[0].type === 'text')) {
    return <>{content}</>;
  }

  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'path' ? (
          <span
            key={i}
            className="msg-file-link"
            onClick={(e) => { e.stopPropagation(); onViewFile(seg.value); }}
          >
            {seg.value}
          </span>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </>
  );
}
