import { useState, useEffect, useCallback } from 'react';
import { ToolCall } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ToolCardProps {
  tool: ToolCall;
  forceExpanded?: boolean;
}

const STATUS_LABELS: Record<ToolCall['status'], string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Done',
  error: 'Error',
};

const STATUS_CLASSES: Record<ToolCall['status'], string> = {
  pending: 'tool-status-pending',
  running: 'tool-status-running',
  completed: 'tool-status-completed',
  error: 'tool-status-error',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

function isEditTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'edit' || n.includes('edit') || n === 'write' || n === 'sedreplace';
}

function buildDiffLines(oldStr: string, newStr: string): Array<{ type: 'removed' | 'added' | 'context'; text: string }> {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: Array<{ type: 'removed' | 'added' | 'context'; text: string }> = [];

  // Simple greedy line matching
  let oi = 0;
  let ni = 0;
  while (oi < oldLines.length && ni < newLines.length) {
    if (oldLines[oi] === newLines[ni]) {
      result.push({ type: 'context', text: oldLines[oi] });
      oi++;
      ni++;
    } else {
      // Look ahead for match
      let foundOld = -1;
      let foundNew = -1;
      for (let k = 1; k <= 5; k++) {
        if (foundNew === -1 && ni + k < newLines.length && oldLines[oi] === newLines[ni + k]) {
          foundNew = ni + k;
        }
        if (foundOld === -1 && oi + k < oldLines.length && oldLines[oi + k] === newLines[ni]) {
          foundOld = oi + k;
        }
      }

      if (foundOld !== -1 && (foundNew === -1 || foundOld - oi <= foundNew - ni)) {
        // Old lines are removed until match
        while (oi < foundOld) {
          result.push({ type: 'removed', text: oldLines[oi] });
          oi++;
        }
      } else if (foundNew !== -1) {
        // New lines are added until match
        while (ni < foundNew) {
          result.push({ type: 'added', text: newLines[ni] });
          ni++;
        }
      } else {
        result.push({ type: 'removed', text: oldLines[oi] });
        result.push({ type: 'added', text: newLines[ni] });
        oi++;
        ni++;
      }
    }
  }
  while (oi < oldLines.length) {
    result.push({ type: 'removed', text: oldLines[oi] });
    oi++;
  }
  while (ni < newLines.length) {
    result.push({ type: 'added', text: newLines[ni] });
    ni++;
  }
  return result;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      className={`tool-card-copy-btn ${copied ? 'copied' : ''}`}
      onClick={handleCopy}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return <span className="tool-card-elapsed">{formatDuration(now - startedAt)}</span>;
}

export function ToolCard({ tool, forceExpanded }: ToolCardProps) {
  const [localExpanded, setLocalExpanded] = useState(false);

  const isSkill = tool.name === 'Skill';

  // Auto-expand pending tools so user can see what needs approval
  // Skill tools stay collapsed by default (like compaction)
  const expanded = forceExpanded !== undefined
    ? forceExpanded
    : isSkill
      ? localExpanded
      : (localExpanded || tool.status === 'pending');

  // Skill tool: compact card with markdown output
  if (isSkill) {
    const skillName = typeof tool.input.skill === 'string' ? tool.input.skill : 'unknown';
    return (
      <div className={`tool-card tool-card-skill ${expanded ? 'expanded' : ''}`} onClick={() => setLocalExpanded(!localExpanded)}>
        <div className="tool-card-header">
          <span className="tool-card-name">Skill: {skillName}</span>
          <span className={`tool-card-status ${STATUS_CLASSES[tool.status]}`}>
            {STATUS_LABELS[tool.status]}
          </span>
        </div>
        {expanded && tool.output && (
          <div className="tool-card-body tool-card-skill-body" onClick={(e) => e.stopPropagation()}>
            <MarkdownRenderer content={tool.output} />
          </div>
        )}
      </div>
    );
  }

  const hasEditDiff = isEditTool(tool.name) &&
    typeof tool.input.old_string === 'string' &&
    typeof tool.input.new_string === 'string';

  const inputStr = Object.keys(tool.input).length > 0
    ? JSON.stringify(tool.input, null, 2)
    : null;

  const filePath = typeof tool.input.file_path === 'string' ? tool.input.file_path : null;

  // Elapsed time
  let elapsed: React.ReactNode = null;
  if (tool.status === 'running' && tool.startedAt) {
    elapsed = <ElapsedTimer startedAt={tool.startedAt} />;
  } else if (tool.startedAt && tool.completedAt) {
    elapsed = <span className="tool-card-elapsed">{formatDuration(tool.completedAt - tool.startedAt)}</span>;
  }

  return (
    <div className={`tool-card ${expanded ? 'expanded' : ''}`} onClick={() => setLocalExpanded(!localExpanded)}>
      <div className="tool-card-header">
        <span className="tool-card-name">{tool.name}</span>
        {elapsed}
        <span className={`tool-card-status ${STATUS_CLASSES[tool.status]}`}>
          {STATUS_LABELS[tool.status]}
        </span>
      </div>
      {expanded && (
        <div className="tool-card-body" onClick={(e) => e.stopPropagation()}>
          {hasEditDiff ? (
            <div className="tool-card-section">
              <div className="tool-card-section-header">
                <span className="tool-card-section-label">Diff</span>
                <CopyButton
                  text={`--- old\n+++ new\n${(tool.input.old_string as string).split('\n').map(l => `- ${l}`).join('\n')}\n${(tool.input.new_string as string).split('\n').map(l => `+ ${l}`).join('\n')}`}
                  label="Copy"
                />
              </div>
              {filePath && <div className="tool-card-diff-file">{filePath}</div>}
              <div className="tool-card-diff">
                {buildDiffLines(tool.input.old_string as string, tool.input.new_string as string).map((line, i) => (
                  <div key={i} className={`tool-card-diff-line ${line.type}`}>
                    {line.type === 'removed' ? '- ' : line.type === 'added' ? '+ ' : '  '}{line.text}
                  </div>
                ))}
              </div>
            </div>
          ) : inputStr ? (
            <div className="tool-card-section">
              <div className="tool-card-section-header">
                <span className="tool-card-section-label">Input</span>
                <CopyButton text={inputStr} label="Copy" />
              </div>
              <pre className="tool-card-pre">{inputStr}</pre>
            </div>
          ) : null}
          {tool.output && (
            <div className="tool-card-section">
              <div className="tool-card-section-header">
                <span className="tool-card-section-label">Output</span>
                <CopyButton text={tool.output} label="Copy" />
              </div>
              <pre className="tool-card-pre">{tool.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
