/**
 * One-time contextual tips. Each tip is shown the first time its moment
 * happens on this device, stays until dismissed, and never comes back (it is
 * marked seen as soon as it is queued, so a reload does not repeat it).
 */
import { useSyncExternalStore } from 'react';
import { syncToStore } from '../persistentStorage';

export type TipId = 'handsfree' | 'first_tone' | 'red_card' | 'remote_trigger';

export interface TipContent {
  title: string;
  body: string;
}

export const TIPS: Record<TipId, TipContent> = {
  handsfree: {
    title: 'Hands-free is listening',
    body: 'Say "Hey Jarvis", then your question. Audio leaves this device only after the wake word. Dictation apps such as Wispr Flow may think you are in a meeting: turn off their meeting detection, or pause them while hands-free is on.',
  },
  first_tone: {
    title: 'That tone means news',
    body: 'Herald never speaks up on its own. A tone says a session finished or needs you; say "what\'s up" or press Brief me to hear it.',
  },
  red_card: {
    title: 'Red cards wait for you',
    body: 'Anything risky (a deploy, a delete) is held until you confirm it on screen. Nothing is sent before that.',
  },
  remote_trigger: {
    title: 'Remote trigger received',
    body: 'A hotkey, mouse button or script just drove Herald on this device. Triggers go to the active device; Take control moves them here.',
  },
};

export const TIPS_KEY = 'herald_tips_seen';
const ALL: readonly TipId[] = ['handsfree', 'first_tone', 'red_card', 'remote_trigger'];

function loadSeen(): TipId[] {
  try {
    const raw = localStorage.getItem(TIPS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((t): t is TipId => ALL.includes(t as TipId)) : [];
  } catch {
    return [];
  }
}

interface TipsState {
  seen: TipId[];
  /** Tips waiting to be shown, first = on screen. */
  queue: TipId[];
}

let state: TipsState = { seen: loadSeen(), queue: [] };
const listeners = new Set<() => void>();

function emit(next: TipsState): void {
  state = next;
  listeners.forEach((l) => l());
}

export const tipsStore = {
  get: (): TipsState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  /** The moment for a tip happened. Shows it once per device, ever. */
  trigger(id: TipId): boolean {
    if (state.seen.includes(id) || state.queue.includes(id)) return false;
    const seen = [...state.seen, id];
    const json = JSON.stringify(seen);
    try {
      localStorage.setItem(TIPS_KEY, json);
    } catch {
      // storage unavailable: once per session instead
    }
    syncToStore(TIPS_KEY, json);
    emit({ seen, queue: [...state.queue, id] });
    return true;
  },
  dismiss(id?: TipId): void {
    const target = id ?? state.queue[0];
    if (!target) return;
    emit({ ...state, queue: state.queue.filter((t) => t !== target) });
  },
  /** Tests only. */
  reset(): void {
    state = { seen: loadSeen(), queue: [] };
    listeners.forEach((l) => l());
  },
};

export function useTips(): TipsState {
  return useSyncExternalStore(tipsStore.subscribe, tipsStore.get, tipsStore.get);
}
