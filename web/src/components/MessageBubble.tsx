import { useState, useCallback } from 'react';
import { ConversationHighlight, Question } from '../types';
import { ToolCard } from './ToolCard';
import { MarkdownRenderer } from './MarkdownRenderer';

const ARTIFACT_THRESHOLD = 100; // lines

interface MessageBubbleProps {
  message: ConversationHighlight;
  onSelectOption?: (label: string) => void;
  onViewFile?: (path: string) => void;
  onViewArtifact?: (content: string, title?: string) => void;
  searchTerm?: string | null;
  isCurrentMatch?: boolean;
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

// Highlight search matches in text
function HighlightedText({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const parts: Array<{ text: string; match: boolean }> = [];
  const lower = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  let lastIdx = 0;
  let idx = lower.indexOf(lowerTerm, lastIdx);
  while (idx !== -1) {
    if (idx > lastIdx) parts.push({ text: text.slice(lastIdx, idx), match: false });
    parts.push({ text: text.slice(idx, idx + term.length), match: true });
    lastIdx = idx + term.length;
    idx = lower.indexOf(lowerTerm, lastIdx);
  }
  if (lastIdx < text.length) parts.push({ text: text.slice(lastIdx), match: false });
  if (parts.length === 0) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.match ? <mark key={i} className="search-highlight">{p.text}</mark> : <span key={i}>{p.text}</span>
      )}
    </>
  );
}

// Detect plan file paths in content text
const PLAN_PATH_RE = /(?:\/[^\s)>"'\]]*\.claude\/plans\/[^\s)>"'\]]+\.md|\/[^\s)>"'\]]*plan\.md)/g;

export function extractPlanFilePath(message: ConversationHighlight): string | null {
  // Check tool call inputs for plan references
  if (message.toolCalls) {
    for (const tool of message.toolCalls) {
      if (tool.name === 'ExitPlanMode' || tool.name === 'EnterPlanMode') {
        // Check output for plan file path
        if (tool.output) {
          const match = tool.output.match(PLAN_PATH_RE);
          if (match) return match[0];
        }
      }
    }
  }
  // Check message content
  if (message.content) {
    const match = message.content.match(PLAN_PATH_RE);
    if (match) return match[0];
  }
  return null;
}

export function MessageBubble({ message, onSelectOption, onViewFile, onViewArtifact, searchTerm, isCurrentMatch }: MessageBubbleProps) {
  const isUser = message.type === 'user';
  const [allExpanded, setAllExpanded] = useState<boolean | undefined>(undefined);

  const toolCalls = !isUser ? message.toolCalls : undefined;
  const hasMultipleTools = toolCalls && toolCalls.length >= 2;
  const trimmedContent = message.content?.trim();
  const hasContent = trimmedContent && trimmedContent.length > 0 && trimmedContent !== '(no content)';
  const isLargeContent = !isUser && hasContent && (message.content.split('\n').length > ARTIFACT_THRESHOLD);

  // Hide completely empty assistant messages that have no text, no tools, and no options
  if (!isUser && !hasContent && (!toolCalls || toolCalls.length === 0) && !message.isWaitingForChoice) {
    return null;
  }

  return (
    <div
      className={`msg-row ${isUser ? 'msg-row-user' : 'msg-row-assistant'} ${isCurrentMatch ? 'msg-row-current-match' : ''}`}
      data-highlight-id={message.id}
    >
      {hasContent && (
        <div className={`msg-bubble ${isUser ? 'msg-bubble-user' : 'msg-bubble-assistant'}`}>
          {searchTerm ? (
            <pre className="msg-content">
              <HighlightedText text={message.content} term={searchTerm} />
            </pre>
          ) : isUser ? (
            <pre className="msg-content">{message.content}</pre>
          ) : (
            <MarkdownRenderer
              content={message.content}
              onFileClick={onViewFile}
              className="msg-markdown"
            />
          )}
        </div>
      )}

      {isLargeContent && onViewArtifact && (
        <button
          className="msg-artifact-btn"
          onClick={() => onViewArtifact(message.content, 'Full Output')}
        >
          View full output in viewer
        </button>
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
          {toolCalls.map((tool) => {
            if (tool.name === 'ExitPlanMode' && onViewFile) {
              const planPath = extractPlanFilePath(message);
              return (
                <div key={tool.id} className="plan-card">
                  <div className="plan-card-header">
                    <span className="plan-card-icon">Plan Ready</span>
                    <span className={`tool-card-status ${tool.status === 'completed' ? 'tool-status-completed' : 'tool-status-pending'}`}>
                      {tool.status === 'completed' ? 'Approved' : 'Pending'}
                    </span>
                  </div>
                  {planPath && (
                    <button
                      className="plan-card-view-btn"
                      onClick={(e) => { e.stopPropagation(); onViewFile(planPath); }}
                    >
                      View Plan
                    </button>
                  )}
                </div>
              );
            }
            return <ToolCard key={tool.id} tool={tool} forceExpanded={allExpanded} />;
          })}
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
        <div className="msg-approval-prompt">
          {message.options[0]?.description && (
            <div className="msg-approval-description">{message.options[0].description}</div>
          )}
          <div className="msg-options">
            {message.options.map((opt) => (
              <button
                key={opt.label}
                className={`msg-option-btn ${opt.label === 'yes' ? 'approve' : opt.label === 'no' ? 'reject' : ''}`}
                onClick={() => onSelectOption(opt.label)}
                title={opt.description}
              >
                {opt.label === 'yes' ? 'Approve' : opt.label === 'no' ? 'Reject' : opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

