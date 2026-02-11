import { useState, useCallback, useEffect, useRef } from 'react';
import { ConversationHighlight, Question } from '../types';
import { ToolCard } from './ToolCard';
import { MarkdownRenderer } from './MarkdownRenderer';

const ARTIFACT_THRESHOLD = 100; // lines

interface MessageBubbleProps {
  message: ConversationHighlight;
  onSelectOption?: (label: string) => void;
  onCancelMessage?: (clientMessageId: string) => void;
  onViewFile?: (path: string) => void;
  onViewArtifact?: (content: string, title?: string) => void;
  searchTerm?: string | null;
  isCurrentMatch?: boolean;
  planFilePath?: string | null;
}

interface QuestionBlockProps {
  question: Question;
  onSelectOption: (label: string) => void;
}

function QuestionBlock({ question, onSelectOption }: QuestionBlockProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showOther, setShowOther] = useState(false);
  const [otherText, setOtherText] = useState('');
  const blockRef = useRef<HTMLDivElement>(null);

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

  // Keyboard shortcuts: 1-9 to select options, Enter to submit multi-select
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const num = parseInt(e.key);
      if (num >= 1 && num <= question.options.length) {
        e.preventDefault();
        handleOptionClick(question.options[num - 1].label);
      }
      if (e.key === 'Enter' && question.multiSelect && selected.size > 0) {
        e.preventDefault();
        handleSubmitMulti();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [question.options, question.multiSelect, selected, handleOptionClick, handleSubmitMulti]);

  const showDescriptions = question.options.some(o => o.description);

  return (
    <div className="question-block" ref={blockRef}>
      {question.header && (
        <div className="question-block-header">{question.header}</div>
      )}
      {question.question && (
        <div className="question-block-text">{question.question}</div>
      )}
      <div className={`question-block-options ${showDescriptions ? 'with-descriptions' : ''}`}>
        {question.options.map((opt, idx) => (
          <button
            key={opt.label}
            className={`msg-option-btn ${question.multiSelect && selected.has(opt.label) ? 'selected' : ''} ${showDescriptions ? 'with-desc' : ''}`}
            onClick={() => handleOptionClick(opt.label)}
            title={opt.description}
          >
            <span className="option-key-hint">{idx + 1}</span>
            <span className="option-label">{opt.label}</span>
            {showDescriptions && opt.description && (
              <span className="option-description">{opt.description}</span>
            )}
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

// Multi-question flow: step-by-step with review screen
interface MultiQuestionFlowProps {
  questions: Question[];
  onSelectOption: (label: string) => void;
}

function MultiQuestionFlow({ questions, onSelectOption }: MultiQuestionFlowProps) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Map<number, string>>(new Map());
  const [reviewing, setReviewing] = useState(false);
  const total = questions.length;

  const handleAnswer = useCallback((questionIdx: number, answer: string) => {
    setAnswers(prev => {
      const next = new Map(prev);
      next.set(questionIdx, answer);
      return next;
    });
  }, []);

  const handleNext = useCallback(() => {
    if (step < total - 1) {
      setStep(step + 1);
    } else {
      setReviewing(true);
    }
  }, [step, total]);

  const handleBack = useCallback(() => {
    if (reviewing) {
      setReviewing(false);
    } else if (step > 0) {
      setStep(step - 1);
    }
  }, [step, reviewing]);

  const handleEditFromReview = useCallback((idx: number) => {
    setReviewing(false);
    setStep(idx);
  }, []);

  const handleSubmitAll = useCallback(async () => {
    // Send each answer sequentially — the CLI presents one question at a time,
    // so each answer needs its own sendInput + Enter with a delay between them.
    for (let i = 0; i < total; i++) {
      const answer = answers.get(i) || '';
      onSelectOption(answer);
      if (i < total - 1) {
        // Wait for the CLI to process the answer and show the next question
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [answers, total, onSelectOption]);

  if (reviewing) {
    return (
      <div className="multi-question-flow">
        <div className="multi-question-step">Review answers</div>
        <div className="multi-question-review">
          {questions.map((q, i) => (
            <div key={i} className="multi-question-review-item">
              <span>
                <span className="review-question">{q.header || q.question}: </span>
                <span className="review-answer">{answers.get(i) || '(no answer)'}</span>
              </span>
              <button className="review-edit" onClick={() => handleEditFromReview(i)}>Edit</button>
            </div>
          ))}
        </div>
        <div className="multi-question-nav">
          <button onClick={handleBack}>Back</button>
          <button
            className="multi-question-submit"
            onClick={handleSubmitAll}
            disabled={answers.size < total}
          >
            Submit All
          </button>
        </div>
      </div>
    );
  }

  const currentQ = questions[step];
  const currentAnswer = answers.get(step);

  return (
    <div className="multi-question-flow">
      <div className="multi-question-progress">
        <span className="multi-question-step">Question {step + 1} of {total}</span>
        <div className="multi-question-dots">
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={`mq-dot ${i === step ? 'active' : ''} ${answers.has(i) ? 'answered' : ''}`}
              onClick={() => { if (answers.has(i)) { setReviewing(false); setStep(i); } }}
            />
          ))}
        </div>
      </div>
      <QuestionBlockSingle
        question={currentQ}
        selectedAnswer={currentAnswer}
        onAnswer={(answer) => handleAnswer(step, answer)}
      />
      <div className="multi-question-nav">
        <button onClick={handleBack} disabled={step === 0}>Back</button>
        <button onClick={handleNext} disabled={!currentAnswer}>
          {step === total - 1 ? 'Review' : 'Next'}
        </button>
      </div>
    </div>
  );
}

// Single-question collector for multi-question flow (doesn't submit immediately)
interface QuestionBlockSingleProps {
  question: Question;
  selectedAnswer?: string;
  onAnswer: (answer: string) => void;
}

function QuestionBlockSingle({ question, selectedAnswer, onAnswer }: QuestionBlockSingleProps) {
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (!selectedAnswer) return new Set();
    if (question.multiSelect) return new Set(selectedAnswer.split(', '));
    return new Set([selectedAnswer]);
  });
  const [showOther, setShowOther] = useState(false);
  const [otherText, setOtherText] = useState('');

  const handleOptionClick = useCallback((label: string) => {
    if (question.multiSelect) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        const answer = Array.from(next).join(', ');
        if (next.size > 0) onAnswer(answer);
        return next;
      });
    } else {
      setSelected(new Set([label]));
      onAnswer(label);
    }
  }, [question.multiSelect, onAnswer]);

  const handleSendOther = useCallback(() => {
    const trimmed = otherText.trim();
    if (!trimmed) return;
    onAnswer(trimmed);
    setSelected(new Set());
  }, [otherText, onAnswer]);

  // Keyboard: 1-9 to select options
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const num = parseInt(e.key);
      if (num >= 1 && num <= question.options.length) {
        e.preventDefault();
        handleOptionClick(question.options[num - 1].label);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [question.options, handleOptionClick]);

  const showDescriptions = question.options.some(o => o.description);

  return (
    <div className="question-block">
      {question.header && <div className="question-block-header">{question.header}</div>}
      {question.question && <div className="question-block-text">{question.question}</div>}
      <div className={`question-block-options ${showDescriptions ? 'with-descriptions' : ''}`}>
        {question.options.map((opt, idx) => (
          <button
            key={opt.label}
            className={`msg-option-btn ${selected.has(opt.label) ? 'selected' : ''} ${showDescriptions ? 'with-desc' : ''}`}
            onClick={() => handleOptionClick(opt.label)}
            title={opt.description}
          >
            <span className="option-key-hint">{idx + 1}</span>
            <span className="option-label">{opt.label}</span>
            {showDescriptions && opt.description && (
              <span className="option-description">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
      <div className="question-block-actions">
        <button className="question-block-other-toggle" onClick={() => setShowOther(!showOther)}>
          Other...
        </button>
      </div>
      {showOther && (
        <div className="question-block-other-input">
          <input
            type="text"
            value={otherText}
            onChange={e => setOtherText(e.target.value)}
            placeholder="Type your response..."
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSendOther(); } }}
            autoFocus
          />
          <button className="question-block-other-send" onClick={handleSendOther}>Send</button>
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

export function extractInlinePlan(message: ConversationHighlight): string | null {
  if (message.toolCalls) {
    for (const tool of message.toolCalls) {
      if (tool.name === 'ExitPlanMode' && typeof tool.input?.plan === 'string') {
        return tool.input.plan;
      }
    }
  }
  return null;
}

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

function CompactionMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="msg-row msg-row-compaction">
      <div style={{ width: '100%', maxWidth: 600 }}>
        <div className="compaction-divider" onClick={() => setExpanded(!expanded)}>
          <span className="compaction-label">
            {expanded ? 'Hide summary' : 'Context compacted — view summary'}
          </span>
        </div>
        {expanded && (
          <div className="compaction-summary">
            <MarkdownRenderer content={content} className="msg-markdown" />
          </div>
        )}
      </div>
    </div>
  );
}

function SkillCard({ skillName, content, onViewFile }: { skillName: string; content: string; onViewFile?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`skill-card ${expanded ? 'expanded' : ''}`} onClick={() => setExpanded(!expanded)}>
      <div className="skill-card-header">
        <span className="skill-card-name">/{skillName}</span>
        <span className="skill-card-chevron">{expanded ? '\u25B4' : '\u25BE'}</span>
      </div>
      {expanded && (
        <div className="skill-card-body" onClick={(e) => e.stopPropagation()}>
          <MarkdownRenderer content={content} onFileClick={onViewFile} />
        </div>
      )}
    </div>
  );
}

export function MessageBubble({ message, onSelectOption, onCancelMessage, onViewFile, onViewArtifact, searchTerm, isCurrentMatch, planFilePath }: MessageBubbleProps) {
  const isUser = message.type === 'user';
  const isSystem = message.type === 'system';
  const [allExpanded, setAllExpanded] = useState<boolean | undefined>(undefined);

  // Render compaction summaries as expandable dividers
  if (isSystem && message.isCompaction) {
    return <CompactionMessage content={message.content} />;
  }

  // Render system messages (task notifications) as compact cards
  if (isSystem) {
    const outputFile = message.toolCalls?.[0]?.output;
    const status = message.toolCalls?.[0]?.status || 'completed';
    return (
      <div className="msg-row msg-row-system" data-highlight-id={message.id}>
        <div className={`system-notification system-notification-${status}`}>
          <span className={`system-notification-dot system-dot-${status}`} />
          <span className="system-notification-text">{message.content}</span>
          {outputFile && onViewFile && (
            <span
              className="system-notification-link"
              role="button"
              onClick={() => onViewFile(outputFile)}
            >
              View Output
            </span>
          )}
        </div>
      </div>
    );
  }

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
      {hasContent && message.skillName ? (
        <SkillCard skillName={message.skillName} content={message.content} onViewFile={onViewFile} />
      ) : hasContent && (
        <div className={`msg-bubble ${isUser ? 'msg-bubble-user' : 'msg-bubble-assistant'} ${isUser && message.isPending ? 'msg-bubble-pending' : ''}`}>
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
          {isUser && message.isPending && onCancelMessage && (
            <button
              className="msg-cancel-btn"
              onClick={() => onCancelMessage(message.id)}
              title="Cancel and edit"
            >
              &#x2715;
            </button>
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
            if (tool.name === 'ExitPlanMode') {
              const planPath = extractPlanFilePath(message) || planFilePath;
              const inlinePlan = typeof tool.input?.plan === 'string' ? tool.input.plan : null;
              return (
                <div key={tool.id} className="plan-card">
                  <div className="plan-card-header">
                    <span className="plan-card-icon">Plan Ready</span>
                    <span className={`tool-card-status ${tool.status === 'completed' ? 'tool-status-completed' : 'tool-status-pending'}`}>
                      {tool.status === 'completed' ? 'Approved' : 'Pending'}
                    </span>
                  </div>
                  {planPath && onViewFile ? (
                    <button
                      className="plan-card-view-btn"
                      onClick={(e) => { e.stopPropagation(); onViewFile(planPath); }}
                    >
                      View Plan
                    </button>
                  ) : inlinePlan && onViewArtifact ? (
                    <button
                      className="plan-card-view-btn"
                      onClick={(e) => { e.stopPropagation(); onViewArtifact(inlinePlan, 'Plan'); }}
                    >
                      View Plan
                    </button>
                  ) : null}
                  {tool.status === 'pending' && onSelectOption && (
                    <div className="plan-card-actions">
                      <button
                        className="msg-option-btn approve"
                        onClick={(e) => { e.stopPropagation(); onSelectOption('yes'); }}
                      >
                        Approve
                      </button>
                      <button
                        className="msg-option-btn reject"
                        onClick={(e) => { e.stopPropagation(); onSelectOption('no'); }}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            return <ToolCard key={tool.id} tool={tool} forceExpanded={allExpanded} />;
          })}
        </div>
      )}

      {message.isWaitingForChoice && message.questions && onSelectOption && (
        message.questions.length > 1 ? (
          <MultiQuestionFlow questions={message.questions} onSelectOption={onSelectOption} />
        ) : (
          <>
            {message.questions.map((q, i) => (
              <QuestionBlock key={i} question={q} onSelectOption={onSelectOption} />
            ))}
          </>
        )
      )}

      {message.isWaitingForChoice && !message.questions && message.options && onSelectOption && (
        <div className="msg-approval-prompt">
          {message.options[0]?.description && (
            <div className="msg-approval-description">{message.options[0].description}</div>
          )}
          <div className="msg-options">
            {message.options.map((opt) => {
              const isApprove = opt.label === 'yes';
              const isReject = opt.label === 'no';
              const isAlways = opt.label.startsWith('yes, and don');
              return (
                <button
                  key={opt.label}
                  className={`msg-option-btn ${isApprove ? 'approve' : isReject ? 'reject' : isAlways ? 'always' : ''}`}
                  onClick={() => onSelectOption(opt.label)}
                  title={opt.description}
                >
                  {isApprove ? 'Approve' : isReject ? 'Reject' : isAlways ? 'Always Allow' : opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

