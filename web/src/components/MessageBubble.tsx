import { useState, useCallback, useRef } from 'react';
import { ConversationHighlight } from '../types';
import { ToolCard } from './ToolCard';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ContextMenu, ContextMenuEntry } from './ContextMenu';
import { isTouchDevice } from '../utils/platform';
import { QuestionBlock, MultiQuestionFlow, ChoiceData } from './QuestionBlock';

export type { ChoiceData } from './QuestionBlock';

const ARTIFACT_THRESHOLD = 100; // lines

interface MessageBubbleProps {
  message: ConversationHighlight;
  onSelectOption?: (label: string) => void | Promise<boolean>;
  onSelectChoice?: (choice: ChoiceData) => Promise<boolean>;
  onCancelMessage?: (clientMessageId: string) => void;
  onViewFile?: (path: string) => void;
  onViewArtifact?: (content: string, title?: string) => void;
  searchTerm?: string | null;
  isCurrentMatch?: boolean;
  planFilePath?: string | null;
  hideTools?: boolean;
  isBookmarked?: boolean;
  onToggleBookmark?: (messageId: string, content: string) => void;
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

export function MessageBubble({ message, onSelectOption, onSelectChoice, onCancelMessage, onViewFile, onViewArtifact, searchTerm, isCurrentMatch, planFilePath, hideTools, isBookmarked, onToggleBookmark }: MessageBubbleProps) {
  const isUser = message.type === 'user';
  const isSystem = message.type === 'system';
  const [allExpanded, setAllExpanded] = useState<boolean | undefined>(undefined);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [batchApproving, setBatchApproving] = useState<{ current: number; total: number } | null>(null);

  const showContextMenu = !isSystem && !message.isPending;

  const openMenu = useCallback((x: number, y: number) => {
    setContextMenu({ x, y });
    if (navigator.vibrate) navigator.vibrate(50);
  }, []);

  const startLongPress = useCallback((e: React.TouchEvent) => {
    didLongPress.current = false;
    const touch = e.touches[0];
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      openMenu(touch.clientX, touch.clientY);
    }, 500);
  }, [openMenu]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!showContextMenu) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY);
  }, [showContextMenu, openMenu]);

  const contextMenuItems = useCallback((): ContextMenuEntry[] => {
    const items: ContextMenuEntry[] = [];
    if (isUser) {
      items.push({
        label: 'Copy message',
        onClick: () => navigator.clipboard.writeText(message.content),
      });
    } else {
      items.push({
        label: 'Copy message',
        onClick: () => {
          const text = bubbleRef.current?.innerText || message.content;
          navigator.clipboard.writeText(text);
        },
      });
      items.push({
        label: 'Copy as Markdown',
        onClick: () => navigator.clipboard.writeText(message.content),
      });
    }
    if (onToggleBookmark) {
      items.push({
        label: isBookmarked ? 'Remove bookmark' : 'Bookmark',
        onClick: () => onToggleBookmark(message.id, message.content),
      });
    }
    return items;
  }, [message.content, message.id, isUser, isBookmarked, onToggleBookmark]);

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
        <div
          ref={bubbleRef}
          className={`msg-bubble ${isUser ? 'msg-bubble-user' : 'msg-bubble-assistant'} ${isUser && message.isPending ? 'msg-bubble-pending' : ''} ${isBookmarked ? 'msg-bubble-bookmarked' : ''}`}
          onContextMenu={handleContextMenu}
          {...(showContextMenu && isTouchDevice() ? {
            onTouchStart: startLongPress,
            onTouchEnd: cancelLongPress,
            onTouchMove: cancelLongPress,
          } : {})}
        >
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
          {showContextMenu && contextMenu && (
            <ContextMenu
              items={contextMenuItems()}
              position={contextMenu}
              onClose={() => setContextMenu(null)}
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

      {toolCalls && toolCalls.length > 0 && (() => {
        // When hideTools is on, only show pending tools (need user action) and plan cards
        const visibleTools = hideTools
          ? toolCalls.filter(t => t.status === 'pending' || t.name === 'ExitPlanMode')
          : toolCalls;
        if (visibleTools.length === 0) return null;
        const pendingTools = toolCalls.filter(t => t.status === 'pending' && t.name !== 'ExitPlanMode');
        const showBatchApprove = pendingTools.length >= 2 && (onSelectChoice || onSelectOption);
        const handleBatchApprove = async () => {
          if (!onSelectChoice && !onSelectOption) return;
          setBatchApproving({ current: 0, total: pendingTools.length });
          for (let i = 0; i < pendingTools.length; i++) {
            setBatchApproving({ current: i + 1, total: pendingTools.length });
            if (onSelectChoice) {
              await onSelectChoice({ selectedIndices: [0], optionCount: 3, multiSelect: false });
            } else if (onSelectOption) {
              onSelectOption('yes');
            }
            if (i < pendingTools.length - 1) {
              await new Promise(r => setTimeout(r, 500));
            }
          }
          setBatchApproving(null);
        };
        return (
        <div className="msg-tools">
          {showBatchApprove && (
            <button
              className="msg-batch-approve-btn"
              onClick={handleBatchApprove}
              disabled={!!batchApproving}
            >
              {batchApproving
                ? `Approving ${batchApproving.current}/${batchApproving.total}...`
                : `Approve all (${pendingTools.length})`
              }
            </button>
          )}
          {!hideTools && hasMultipleTools && (
            <button
              className="msg-tools-toggle"
              onClick={() => setAllExpanded(allExpanded === true ? false : true)}
            >
              {allExpanded === true ? 'Collapse All' : 'Expand All'}
            </button>
          )}
          {visibleTools.map((tool) => {
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
                  {tool.status === 'pending' && (onSelectChoice || onSelectOption) && (
                    <div className="plan-card-actions">
                      <button
                        className="msg-option-btn approve"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onSelectChoice) {
                            onSelectChoice({ selectedIndices: [0], optionCount: 3, multiSelect: false });
                          } else if (onSelectOption) {
                            onSelectOption('yes');
                          }
                        }}
                      >
                        Approve
                      </button>
                      <button
                        className="msg-option-btn reject"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onSelectChoice) {
                            onSelectChoice({ selectedIndices: [2], optionCount: 3, multiSelect: false });
                          } else if (onSelectOption) {
                            onSelectOption('no');
                          }
                        }}
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
        );
      })()}

      {message.isWaitingForChoice && message.questions && onSelectOption && (
        message.questions.length > 1 ? (
          <MultiQuestionFlow questions={message.questions} onSelectOption={onSelectOption} onSelectChoice={onSelectChoice} />
        ) : (
          <>
            {message.questions.map((q, i) => (
              <QuestionBlock key={i} question={q} onSelectOption={onSelectOption} onSelectChoice={onSelectChoice} />
            ))}
          </>
        )
      )}

      {message.isWaitingForChoice && !message.questions && message.options && (onSelectChoice || onSelectOption) && (
        <div className="msg-approval-prompt">
          {message.options[0]?.description && (
            <div className="msg-approval-description">{message.options[0].description}</div>
          )}
          <div className="msg-options">
            {message.options.map((opt, idx) => {
              const isApprove = opt.label === 'yes';
              const isReject = opt.label === 'no';
              const isAlways = opt.label.startsWith('yes, and don');
              return (
                <button
                  key={opt.label}
                  className={`msg-option-btn ${isApprove ? 'approve' : isReject ? 'reject' : isAlways ? 'always' : ''}`}
                  onClick={() => {
                    if (onSelectChoice) {
                      onSelectChoice({
                        selectedIndices: [idx],
                        optionCount: message.options!.length,
                        multiSelect: false,
                      });
                    } else if (onSelectOption) {
                      onSelectOption(opt.label);
                    }
                  }}
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

