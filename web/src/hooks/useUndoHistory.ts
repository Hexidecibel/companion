import { useState, useRef, useCallback } from 'react';

interface UndoHistoryOptions {
  groupingInterval?: number;
  maxHistory?: number;
}

interface UndoHistoryResult {
  value: string;
  onChange: (newValue: string) => void;
  undo: () => string | null;
  redo: () => string | null;
  reset: () => void;
  canUndo: boolean;
  canRedo: boolean;
  lastDelta: { prevLength: number; newLength: number };
}

interface HistoryEntry {
  value: string;
  timestamp: number;
}

export function useUndoHistory(options?: UndoHistoryOptions): UndoHistoryResult {
  const groupingInterval = options?.groupingInterval ?? 500;
  const maxHistory = options?.maxHistory ?? 100;

  const [value, setValue] = useState('');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const historyRef = useRef<HistoryEntry[]>([{ value: '', timestamp: 0 }]);
  const indexRef = useRef(0);
  const lastDeltaRef = useRef({ prevLength: 0, newLength: 0 });
  // Track whether last action was undo/redo so next change truncates forward history
  const justUndoRedoRef = useRef(false);

  const updateFlags = useCallback(() => {
    setCanUndo(indexRef.current > 0);
    setCanRedo(indexRef.current < historyRef.current.length - 1);
  }, []);

  const onChange = useCallback((newValue: string) => {
    const history = historyRef.current;
    const currentIndex = indexRef.current;
    const currentEntry = history[currentIndex];

    lastDeltaRef.current = { prevLength: currentEntry.value.length, newLength: newValue.length };

    const now = Date.now();

    // If we just did undo/redo, always start a new entry and truncate forward
    if (justUndoRedoRef.current) {
      justUndoRedoRef.current = false;
      // Truncate forward history
      history.length = currentIndex + 1;
      history.push({ value: newValue, timestamp: now });
      indexRef.current = history.length - 1;
    } else {
      // Truncate forward history if we're not at the end
      if (currentIndex < history.length - 1) {
        history.length = currentIndex + 1;
      }

      // Group with previous entry if within interval
      if (now - currentEntry.timestamp < groupingInterval) {
        history[currentIndex] = { value: newValue, timestamp: now };
      } else {
        history.push({ value: newValue, timestamp: now });
        indexRef.current = history.length - 1;
      }
    }

    // Cap history size
    if (history.length > maxHistory) {
      const excess = history.length - maxHistory;
      history.splice(0, excess);
      indexRef.current = Math.max(0, indexRef.current - excess);
    }

    setValue(newValue);
    updateFlags();
  }, [groupingInterval, maxHistory, updateFlags]);

  const undo = useCallback((): string | null => {
    if (indexRef.current <= 0) return null;
    indexRef.current--;
    const newValue = historyRef.current[indexRef.current].value;
    justUndoRedoRef.current = true;
    setValue(newValue);
    updateFlags();
    return newValue;
  }, [updateFlags]);

  const redo = useCallback((): string | null => {
    if (indexRef.current >= historyRef.current.length - 1) return null;
    indexRef.current++;
    const newValue = historyRef.current[indexRef.current].value;
    justUndoRedoRef.current = true;
    setValue(newValue);
    updateFlags();
    return newValue;
  }, [updateFlags]);

  const reset = useCallback(() => {
    historyRef.current = [{ value: '', timestamp: 0 }];
    indexRef.current = 0;
    justUndoRedoRef.current = false;
    lastDeltaRef.current = { prevLength: 0, newLength: 0 };
    setValue('');
    updateFlags();
  }, [updateFlags]);

  return {
    value,
    onChange,
    undo,
    redo,
    reset,
    canUndo,
    canRedo,
    lastDelta: lastDeltaRef.current,
  };
}
