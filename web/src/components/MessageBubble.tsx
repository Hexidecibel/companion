import { useState, useCallback } from 'react';
import { ConversationHighlight, Question } from '../types';
import { ToolCard } from './ToolCard';

interface MessageBubbleProps {
  message: ConversationHighlight;
  onSelectOption?: (label: string) => void;
  onViewFile?: (path: string) => void;
}

interface QuestionBlockProps {
  question: Question;
  onSelectOption: (label: string) => void;
}

function QuestionBlock({ question, onSelectOption }: QuestionBlockProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showOther, setShowOther] = useState(false);
  const [otherText, setOtherText] = useState('');

  const handleOptionClick = useCallback((label: string) => {
    if (question.multiSelect) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(label)) {
          next.delete(label);
        } else {
          next.add(label);
        }
        return next;
      });
    } else {
      onSelectOption(label);
    }
  }, [question.multiSelect, onSelectOption]);

  const handleSubmitMulti = useCallback(() => {
    if (selected.size === 0) return;
    onSelectOption(Array.from(selected).join(', '));
  }, [selected, onSelectOption]);

  const handleSendOther = useCallback(() => {
    const trimmed = otherText.trim();
    if (!trimmed) return;
    onSelectOption(trimmed);
  }, [otherText, onSelectOption]);

  return (
    <div className="question-block">
      {question.header && (
        <div className="question-block-header">{question.header}</div>
      )}
      {question.question && (
        <div className="question-block-text">{question.question}</div>
      )}
      <div className="question-block-options">
        {question.options.map((opt) => (
          <button
            key={opt.label}
            className={`msg-option-btn ${question.multiSelect && selected.has(opt.label) ? 'selected' : ''}`}
            onClick={() => handleOptionClick(opt.label)}
            title={opt.description}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="question-block-actions">
        {question.multiSelect && (
          <button
            className="question-block-submit"
            onClick={handleSubmitMulti}
            disabled={selected.size === 0}
          >
            Submit ({selected.size})
          </button>
        )}
        <button
          className="question-block-other-toggle"
          onClick={() => setShowOther(!showOther)}
        >
          Other...
        </button>
      </div>

      {showOther && (
        <div className="question-block-other-input">
          <input
            type="text"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="Type your response..."
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSendOther();
              }
            }}
            autoFocus
          />
          <button
            className="question-block-other-send"
            onClick={handleSendOther}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}

export function MessageBubble({ message, onSelectOption, onViewFile }: MessageBubbleProps) {
  const isUser = message.type === 'user';
  const [allExpanded, setAllExpanded] = useState<boolean | undefined>(undefined);

  const toolCalls = !isUser ? message.toolCalls : undefined;
  const hasMultipleTools = toolCalls && toolCalls.length >= 2;
  const hasContent = message.content && message.content.trim().length > 0;

  // Hide completely empty assistant messages that have no text, no tools, and no options
  if (!isUser && !hasContent && (!toolCalls || toolCalls.length === 0) && !message.isWaitingForChoice) {
    return null;
  }

  return (
    <div className={`msg-row ${isUser ? 'msg-row-user' : 'msg-row-assistant'}`}>
      {hasContent && (
        <div className={`msg-bubble ${isUser ? 'msg-bubble-user' : 'msg-bubble-assistant'}`}>
          {!isUser && onViewFile ? (
            <pre className="msg-content">
              <FilePathContent content={message.content} onViewFile={onViewFile} />
            </pre>
          ) : (
            <pre className="msg-content">{message.content}</pre>
          )}
        </div>
      )}

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
        <>
          {message.questions.map((q, i) => (
            <QuestionBlock key={i} question={q} onSelectOption={onSelectOption} />
          ))}
        </>
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
