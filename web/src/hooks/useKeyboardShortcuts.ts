import { useEffect, useRef } from 'react';

export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
  handler: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || (el as HTMLElement).isContentEditable;
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const current = shortcutsRef.current;
      for (const shortcut of current) {
        // On Mac: use metaKey (Cmd). On Windows/Linux: use ctrlKey.
        const wantsModifier = shortcut.ctrl || shortcut.meta;
        const modifierPressed = isMac ? e.metaKey : e.ctrlKey;

        const k = shortcut.key.toLowerCase();
        const code = e.code.toLowerCase();
        const keyMatch = e.key.toLowerCase() === k
          || code === k
          || code === `key${k}`
          || code === `digit${k}`
          || (k === '[' && code === 'bracketleft')
          || (k === ']' && code === 'bracketright');

        if (!keyMatch) continue;

        if (wantsModifier && !modifierPressed) continue;
        if (!wantsModifier && modifierPressed) continue;

        if (shortcut.shift && !e.shiftKey) continue;
        if (shortcut.alt && !e.altKey) continue;
        if (!shortcut.alt && e.altKey) continue;

        // For plain-letter shortcuts (no ctrl/meta), skip when input is focused
        if (!wantsModifier && isInputFocused()) continue;

        e.preventDefault();
        shortcut.handler();
        return;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);
}
