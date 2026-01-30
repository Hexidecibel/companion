import { useEffect, useRef } from 'react';

export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  handler: () => void;
}

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
        const wantsCtrlOrMeta = shortcut.ctrl || shortcut.meta;
        const ctrlOrMetaPressed = e.ctrlKey || e.metaKey;

        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase()
          || e.code.toLowerCase() === shortcut.key.toLowerCase();

        if (!keyMatch) continue;

        if (wantsCtrlOrMeta && !ctrlOrMetaPressed) continue;
        if (!wantsCtrlOrMeta && ctrlOrMetaPressed) continue;

        if (shortcut.shift && !e.shiftKey) continue;

        // For plain-letter shortcuts (no ctrl/meta), skip when input is focused
        if (!wantsCtrlOrMeta && isInputFocused()) continue;

        e.preventDefault();
        shortcut.handler();
        return;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);
}
