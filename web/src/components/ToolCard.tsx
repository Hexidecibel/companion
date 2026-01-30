import { useState } from 'react';
import { ToolCall } from '../types';

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

export function ToolCard({ tool, forceExpanded }: ToolCardProps) {
  const [localExpanded, setLocalExpanded] = useState(false);

  const expanded = forceExpanded !== undefined ? forceExpanded : localExpanded;

  const inputStr = Object.keys(tool.input).length > 0
    ? JSON.stringify(tool.input, null, 2)
    : null;

  return (
    <div className={`tool-card ${expanded ? 'expanded' : ''}`} onClick={() => setLocalExpanded(!localExpanded)}>
      <div className="tool-card-header">
        <span className="tool-card-name">{tool.name}</span>
        <span className={`tool-card-status ${STATUS_CLASSES[tool.status]}`}>
          {STATUS_LABELS[tool.status]}
        </span>
      </div>
      {expanded && (
        <div className="tool-card-body">
          {inputStr && (
            <div className="tool-card-section">
              <div className="tool-card-section-label">Input</div>
              <pre className="tool-card-pre">{inputStr}</pre>
            </div>
          )}
          {tool.output && (
            <div className="tool-card-section">
              <div className="tool-card-section-label">Output</div>
              <pre className="tool-card-pre">{tool.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
