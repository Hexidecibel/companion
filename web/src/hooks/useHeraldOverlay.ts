import { useEffect, useMemo, useRef, useState } from 'react';
import { OverlayPresenter, type OverlayInput } from '../services/heraldSetup/overlay';
import { pushOverlayView } from '../services/overlayBridge';
import type { HeraldInboxItem, HeraldMessage } from '../types/herald';

export interface OverlayHost {
  /** Floating orb wanted (desktop app, setting on for this profile). */
  enabled: boolean;
  listening: boolean;
  transcribing: boolean;
  thinking: boolean;
  speaking: boolean;
  /** Follow-up window open, or null. */
  followUp?: { until: number; ms: number } | null;
  messages: HeraldMessage[];
  inbox: HeraldInboxItem[];
  /** This device plays the news tones. */
  tonesHere: boolean;
}

function windowFocused(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Feeds the floating orb (desktop app): Herald's activity in, overlay views
 * out to the native window. It stays hidden while Companion is in front.
 */
export function useHeraldOverlay(host: OverlayHost): void {
  const presenter = useMemo(() => new OverlayPresenter((v) => void pushOverlayView(v)), []);
  useEffect(() => () => {
    presenter.dispose();
    if (presenter.current.phase !== 'hidden') void pushOverlayView({ ...presenter.current, phase: 'hidden' });
  }, [presenter]);

  const [focused, setFocused] = useState(windowFocused);
  useEffect(() => {
    const on = () => setFocused(windowFocused());
    window.addEventListener('focus', on);
    window.addEventListener('blur', on);
    document.addEventListener('visibilitychange', on);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', on);
      document.removeEventListener('visibilitychange', on);
    };
  }, []);

  // A tone for news: the newest unheard item that just arrived.
  const [tone, setTone] = useState<OverlayInput['tone']>(null);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(host.inbox.map((i) => i.id));
    const prev = seen.current;
    seen.current = ids;
    if (!prev || !host.tonesHere) return;
    const fresh = host.inbox.filter((i) => !i.heard && !prev.has(i.id));
    if (fresh.length > 0) {
      const top = fresh[fresh.length - 1];
      setTone({ at: Date.now(), text: `${top.sessionName}: ${top.headline}` });
    }
  }, [host.inbox, host.tonesHere]);

  const last = host.messages[host.messages.length - 1];
  const lastUser = [...host.messages].reverse().find((m) => m.role === 'user' && !m.intent);
  const replyText = last?.role === 'herald' ? last.text : null;

  const input: OverlayInput = {
    enabled: host.enabled,
    mainFocused: focused,
    listening: host.listening,
    transcribing: host.transcribing,
    thinking: host.thinking,
    speaking: host.speaking,
    followUp: host.followUp ?? null,
    tone,
    lastUserText: lastUser?.text ?? null,
    replyText,
  };
  const key = JSON.stringify(input);
  useEffect(() => {
    presenter.update(JSON.parse(key) as OverlayInput);
  }, [presenter, key]);
}
