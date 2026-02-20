interface ShortcutHelpOverlayProps {
  onClose: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const MOD = isMac ? '\u2318' : 'Ctrl';

const SHORTCUT_GROUPS = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: `${MOD}+Alt+1-9`, description: 'Switch to session by position' },
      { keys: `${MOD}+Alt (hold)`, description: 'Show jump number badges' },
      { keys: `${MOD}+Alt+[`, description: 'Previous session' },
      { keys: `${MOD}+Alt+]`, description: 'Next session' },
      { keys: 'j / \u2193', description: 'Next session' },
      { keys: 'k / \u2191', description: 'Previous session' },
      { keys: '/', description: 'Focus input bar' },
    ],
  },
  {
    title: 'Session',
    shortcuts: [
      { keys: `${MOD}+Alt+T`, description: 'Toggle terminal' },
      { keys: `${MOD}+Alt+F`, description: 'Search messages' },
      { keys: `${MOD}+Alt+P`, description: 'Open file finder' },
      { keys: `${MOD}+Alt+Shift+A`, description: 'Toggle auto-approve' },
      { keys: `${MOD}+Alt+Shift+M`, description: 'Toggle mute' },
    ],
  },
  {
    title: 'General',
    shortcuts: [
      { keys: 'Escape', description: 'Close panel / modal / search' },
      { keys: '?', description: 'Show this help' },
    ],
  },
];

export function ShortcutHelpOverlay({ onClose }: ShortcutHelpOverlayProps) {
  return (
    <div className="shortcut-overlay-backdrop" onClick={onClose}>
      <div className="shortcut-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="shortcut-overlay-header">
          <span>Keyboard Shortcuts</span>
          <button className="shortcut-overlay-close" onClick={onClose}>{'\u2715'}</button>
        </div>
        <div className="shortcut-overlay-body">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="shortcut-group">
              <div className="shortcut-group-title">{group.title}</div>
              {group.shortcuts.map((s) => (
                <div key={s.keys} className="shortcut-row">
                  <kbd className="shortcut-keys">{s.keys}</kbd>
                  <span className="shortcut-desc">{s.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
