import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Skill } from '../types';

export interface SlashMenuItem {
  id: string;
  name: string;
  description: string;
  section: 'skills' | 'quick' | 'builtin';
  action: 'insert' | 'send';
  sendText?: string;
}

const QUICK_ACTIONS: SlashMenuItem[] = [
  { id: 'q-yes', name: 'yes', description: 'Send "yes"', section: 'quick', action: 'send', sendText: 'yes' },
  { id: 'q-no', name: 'no', description: 'Send "no"', section: 'quick', action: 'send', sendText: 'no' },
  { id: 'q-continue', name: 'continue', description: 'Send "continue"', section: 'quick', action: 'send', sendText: 'continue' },
  { id: 'q-approve', name: 'approve', description: 'Send "approve"', section: 'quick', action: 'send', sendText: 'approve' },
  { id: 'q-reject', name: 'reject', description: 'Send "reject"', section: 'quick', action: 'send', sendText: 'reject' },
  { id: 'q-skip', name: 'skip', description: 'Send "skip"', section: 'quick', action: 'send', sendText: 'skip' },
  { id: 'q-cancel', name: 'cancel', description: 'Send interrupt (Ctrl+C)', section: 'quick', action: 'send', sendText: '\x03' },
];

const CLI_BUILTINS: SlashMenuItem[] = [
  { id: 'b-help', name: 'help', description: 'Show Claude help', section: 'builtin', action: 'insert' },
  { id: 'b-clear', name: 'clear', description: 'Clear conversation', section: 'builtin', action: 'insert' },
  { id: 'b-compact', name: 'compact', description: 'Compact conversation history', section: 'builtin', action: 'insert' },
  { id: 'b-status', name: 'status', description: 'Show session status', section: 'builtin', action: 'insert' },
  { id: 'b-review', name: 'review', description: 'Review recent changes', section: 'builtin', action: 'insert' },
];

interface SlashMenuProps {
  query: string;
  skills: Skill[];
  onSelect: (item: SlashMenuItem) => void;
  onClose: () => void;
}

export function SlashMenu({ query, skills, onSelect, onClose }: SlashMenuProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // Build skill items from installed skills
  const skillItems: SlashMenuItem[] = useMemo(
    () =>
      skills
        .filter((s) => s.installed)
        .map((s) => ({
          id: `s-${s.id}`,
          name: s.id,
          description: s.name,
          section: 'skills' as const,
          action: 'insert' as const,
        })),
    [skills]
  );

  // Filter all items by query
  const allItems = useMemo(() => {
    const lower = query.toLowerCase();
    const filter = (items: SlashMenuItem[]) =>
      items.filter(
        (item) =>
          item.name.toLowerCase().includes(lower) ||
          item.description.toLowerCase().includes(lower)
      );

    const filteredSkills = filter(skillItems);
    const filteredQuick = filter(QUICK_ACTIONS);
    const filteredBuiltin = filter(CLI_BUILTINS);

    return { skills: filteredSkills, quick: filteredQuick, builtin: filteredBuiltin };
  }, [query, skillItems]);

  const flatItems = useMemo(
    () => [...allItems.skills, ...allItems.quick, ...allItems.builtin],
    [allItems]
  );

  // Reset index when items change
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // Keyboard handler — exposed via ref-based approach
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (flatItems.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % flatItems.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + flatItems.length) % flatItems.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (flatItems[activeIndex]) {
          onSelect(flatItems[activeIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [flatItems, activeIndex, onSelect, onClose]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  if (flatItems.length === 0) return null;

  const renderSection = (title: string, items: SlashMenuItem[], startIndex: number) => {
    if (items.length === 0) return null;
    return (
      <div className="slash-menu-section">
        <div className="slash-menu-section-title">{title}</div>
        {items.map((item, i) => {
          const globalIndex = startIndex + i;
          return (
            <div
              key={item.id}
              ref={globalIndex === activeIndex ? activeRef : undefined}
              className={`slash-menu-item ${globalIndex === activeIndex ? 'active' : ''}`}
              onClick={() => onSelect(item)}
              onMouseEnter={() => setActiveIndex(globalIndex)}
            >
              <span className="slash-menu-item-name">/{item.name}</span>
              <span className="slash-menu-item-desc">{item.description}</span>
            </div>
          );
        })}
      </div>
    );
  };

  let offset = 0;
  const skillsOffset = offset;
  offset += allItems.skills.length;
  const quickOffset = offset;
  offset += allItems.quick.length;
  const builtinOffset = offset;

  return (
    <div className="slash-menu" ref={menuRef}>
      {renderSection('Skills', allItems.skills, skillsOffset)}
      {renderSection('Quick Actions', allItems.quick, quickOffset)}
      {renderSection('CLI Built-ins', allItems.builtin, builtinOffset)}
    </div>
  );
}
