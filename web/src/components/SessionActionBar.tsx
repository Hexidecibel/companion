import { ReactNode } from 'react';
import { HeaderOverflowMenu, OverflowMenuItem } from './HeaderOverflowMenu';

interface SessionActionBarProps {
  /**
   * Status content for the left side of the bar (spinner + "Processing…",
   * "Waiting for input", work-group bar, etc.). May be null/empty when the
   * session is idle — the bar still renders so the action buttons stay
   * visible as the primary mobile toolbar.
   */
  status?: ReactNode;
  /**
   * Inline action buttons, right-aligned. Shown in priority order; the ones
   * that don't fit are expected to be passed in `overflowItems` instead.
   */
  inlineActions: ReactNode;
  /** Remaining actions collapsed behind the "⋮" kebab. */
  overflowItems: OverflowMenuItem[];
}

/**
 * Mobile session toolbar. Replaces the cramped top-header action row by
 * relocating the action cluster into the (otherwise mostly-empty) activity
 * row: status indicator pinned left, action buttons + overflow kebab pinned
 * right. Always rendered on mobile so the toolbar is persistent even when the
 * session is idle (no active status).
 */
export function SessionActionBar({ status, inlineActions, overflowItems }: SessionActionBarProps) {
  return (
    <div
      className="session-action-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px',
        background: 'var(--bg-secondary, #1f2937)',
        borderBottom: '1px solid var(--border-color, #374151)',
        flexShrink: 0,
        minHeight: 40,
      }}
    >
      {/* Status: spinner + "Processing…"/"Waiting"/work-group + agent pill.
          Empty when idle; flexes to fill the left, truncating gracefully. */}
      <div
        className="session-action-bar-status"
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          overflow: 'hidden',
        }}
      >
        {status}
      </div>
      {/* Actions: inline buttons + overflow kebab, pinned right. */}
      <div
        className="session-action-bar-actions session-header-actions"
        style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {inlineActions}
        <HeaderOverflowMenu items={overflowItems} />
      </div>
    </div>
  );
}
