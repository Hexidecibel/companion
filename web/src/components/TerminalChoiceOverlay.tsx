import type { TerminalChoicePrompt } from '../types';

interface TerminalChoiceOverlayProps {
  prompt: TerminalChoicePrompt;
  onPick: (index: number) => void;
  onDismiss: () => void;
}

/**
 * Compact tappable overlay pinned to the bottom of the terminal pane. Renders one
 * numbered button per detected choice option. Tapping option N sends the digit (N)
 * + Enter to the live selector (handled by the parent). Small and dismissable so it
 * never obscures typing.
 */
export function TerminalChoiceOverlay({ prompt, onPick, onDismiss }: TerminalChoiceOverlayProps) {
  const options = prompt.options.slice(0, 9); // single-digit selectors only

  return (
    <div
      style={{
        position: 'absolute',
        left: 8,
        right: 8,
        bottom: 8,
        background: '#1f2937',
        border: '1px solid #374151',
        borderRadius: 8,
        padding: '8px 10px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        zIndex: 10,
        maxHeight: '45%',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
          gap: 8,
        }}
      >
        <span
          style={{
            color: '#9ca3af',
            fontSize: 12,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {prompt.question || 'Select an option'}
        </span>
        <button
          onClick={onDismiss}
          title="Hide"
          style={{
            flexShrink: 0,
            background: 'transparent',
            border: 'none',
            color: '#9ca3af',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            padding: '0 2px',
          }}
        >
          x
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => onPick(i)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              textAlign: 'left',
              background: '#111827',
              border: '1px solid #374151',
              borderRadius: 6,
              color: '#f3f4f6',
              padding: '7px 9px',
              cursor: 'pointer',
              fontSize: 13,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = '#3b82f6';
              e.currentTarget.style.background = '#172033';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = '#374151';
              e.currentTarget.style.background = '#111827';
            }}
          >
            <span
              style={{
                flexShrink: 0,
                width: 18,
                height: 18,
                borderRadius: 4,
                background: '#3b82f6',
                color: '#f3f4f6',
                fontSize: 11,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {i + 1}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
