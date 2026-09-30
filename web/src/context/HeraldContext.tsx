import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnections } from '../hooks/useConnections';
import { useHerald, type UseHeraldReturn } from '../hooks/useHerald';
import { useHeraldVoice, type HeraldVoice } from '../hooks/useHeraldVoice';
import { useHeraldVoiceInput, type HeraldVoiceInput } from '../hooks/useHeraldVoiceInput';
import { HERALD_DEMO_SERVER_ID, isHeraldDemo } from '../services/heraldTransport';
import { DEFAULT_DISPLAY_NAME, derivePresence, type HeraldPresence } from '../services/heraldReducer';
import { isMobileViewport } from '../utils/platform';
import { eventBus } from '../utils/eventBus';

const PANEL_OPEN_KEY = 'herald_panel_open';
const HOST_KEY = 'herald_host_server_id';

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode etc.) — preference just won't persist
  }
}

export interface HeraldHostOption {
  serverId: string;
  name: string;
  connected: boolean;
}

interface HeraldUiValue {
  /** Desktop docked panel (persisted). */
  panelOpen: boolean;
  /** Mobile full-screen view (not persisted). */
  screenOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Increments whenever the composer should grab focus. */
  focusNonce: number;
  hostId: string | null;
  hostName: string;
  hostOptions: HeraldHostOption[];
  setHostId: (id: string) => void;
  demo: boolean;
}

export interface HeraldDataValue extends UseHeraldReturn {
  displayName: string;
  presence: HeraldPresence;
  unheardCount: number;
  unheardBlocked: number;
  available: boolean;
}

const HeraldUiContext = createContext<HeraldUiValue | null>(null);
const HeraldDataContext = createContext<HeraldDataValue | null>(null);
const HeraldVoiceContext = createContext<HeraldVoice | null>(null);
const HeraldVoiceInputContext = createContext<HeraldVoiceInput | null>(null);

/**
 * Two contexts on purpose: the UI context changes rarely (open/close, host),
 * the data context changes on every streamed token. Dashboard only consumes the
 * UI one so a streaming reply never re-renders the session view.
 */
export function HeraldProvider({ children }: { children: ReactNode }) {
  const demo = useMemo(() => isHeraldDemo(), []);
  const { snapshots } = useConnections();
  const [panelOpen, setPanelOpen] = useState(() => demo || readStorage(PANEL_OPEN_KEY) === '1');
  const [screenOpen, setScreenOpen] = useState(() => demo && isMobileViewport());
  const [focusNonce, setFocusNonce] = useState(0);
  const [preferredHost, setPreferredHost] = useState<string | null>(() => readStorage(HOST_KEY));

  const hostOptions: HeraldHostOption[] = useMemo(() => {
    if (demo) return [{ serverId: HERALD_DEMO_SERVER_ID, name: 'Demo hub', connected: true }];
    return snapshots.map((s) => ({
      serverId: s.serverId,
      name: s.serverName,
      connected: s.state.status === 'connected',
    }));
  }, [snapshots, demo]);

  const hostId = useMemo(() => {
    if (demo) return HERALD_DEMO_SERVER_ID;
    const connected = hostOptions.filter((o) => o.connected);
    const preferred = hostOptions.find((o) => o.serverId === preferredHost);
    if (preferred && (preferred.connected || connected.length === 0)) return preferred.serverId;
    if (connected.length > 0) return connected[0].serverId;
    return hostOptions[0]?.serverId ?? null;
  }, [hostOptions, preferredHost, demo]);

  const hostName = hostOptions.find((o) => o.serverId === hostId)?.name ?? '';

  const setHostId = useCallback((id: string) => {
    setPreferredHost(id);
    writeStorage(HOST_KEY, id);
  }, []);

  useEffect(() => {
    if (!demo) writeStorage(PANEL_OPEN_KEY, panelOpen ? '1' : '0');
  }, [panelOpen, demo]);

  const open = useCallback(() => {
    if (isMobileViewport()) setScreenOpen(true);
    else setPanelOpen(true);
    setFocusNonce((n) => n + 1);
  }, []);

  const close = useCallback(() => {
    setPanelOpen(false);
    setScreenOpen(false);
  }, []);

  const toggle = useCallback(() => {
    const mobile = isMobileViewport();
    const isOpen = mobile ? screenOpen : panelOpen;
    const focusInside = !!(document.activeElement as HTMLElement | null)?.closest?.('.herald');
    // Open but focus elsewhere: first press pulls focus back to Herald.
    if (isOpen && !focusInside && !mobile) {
      setFocusNonce((n) => n + 1);
      return;
    }
    if (isOpen) close();
    else open();
  }, [screenOpen, panelOpen, open, close]);

  // Global hotkey: Ctrl+J (Cmd+J on macOS). Fires even inside inputs because
  // it is an explicit modifier chord, but nothing else is intercepted.
  useEffect(() => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'j' && e.code !== 'KeyJ') return;
      e.preventDefault();
      e.stopPropagation();
      // Holding the chord must not flap the panel open/closed.
      if (e.repeat) return;
      toggle();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [toggle]);

  useEffect(() => eventBus.on('toggle-herald', toggle), [toggle]);

  const herald = useHerald(hostId);
  const voiceHost = useMemo(
    () => ({ getTransport: herald.getTransport, connected: herald.connected }),
    [herald.getTransport, herald.connected],
  );
  const voice = useHeraldVoice(herald.subscribeEvents, hostId, undefined, voiceHost);
  const openRef = useRef(open);
  openRef.current = open;
  const voiceInput = useHeraldVoiceInput({
    getTransport: herald.getTransport,
    connected: herald.connected,
    serverStatus: voice.serverStatus,
    stopSpeech: voice.stop,
    speaking: voice.supported && voice.speaking,
    openPanel: () => {
      const mobile = isMobileViewport();
      if (!(mobile ? screenOpenRef.current : panelOpenRef.current)) openRef.current();
    },
  });
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const screenOpenRef = useRef(screenOpen);
  screenOpenRef.current = screenOpen;
  const available = !!hostId && herald.connected && herald.supported !== false;
  const inbox = herald.state?.inbox;
  const { unheardCount, unheardBlocked } = useMemo(() => {
    let count = 0;
    let blocked = 0;
    for (const i of inbox ?? []) {
      if (!i.heard) {
        count++;
        if (i.priority === 'blocked') blocked++;
      }
    }
    return { unheardCount: count, unheardBlocked: blocked };
  }, [inbox]);

  const data: HeraldDataValue = useMemo(() => ({
    ...herald,
    displayName: herald.state?.displayName || DEFAULT_DISPLAY_NAME,
    presence: derivePresence({
      available,
      enabled: herald.state?.enabled ?? true,
      busy: (herald.state?.busy ?? false) || herald.sending,
      inbox: inbox ?? [],
    }),
    unheardCount,
    unheardBlocked,
    available,
  }), [herald, available, inbox, unheardCount, unheardBlocked]);

  const ui: HeraldUiValue = useMemo(() => ({
    panelOpen, screenOpen, open, close, toggle, focusNonce,
    hostId, hostName, hostOptions, setHostId, demo,
  }), [panelOpen, screenOpen, open, close, toggle, focusNonce, hostId, hostName, hostOptions, setHostId, demo]);

  return (
    <HeraldUiContext.Provider value={ui}>
      <HeraldDataContext.Provider value={data}>
        <HeraldVoiceContext.Provider value={voice}>
          <HeraldVoiceInputContext.Provider value={voiceInput}>
            {children}
          </HeraldVoiceInputContext.Provider>
        </HeraldVoiceContext.Provider>
      </HeraldDataContext.Provider>
    </HeraldUiContext.Provider>
  );
}

export function useHeraldUi(): HeraldUiValue {
  const ctx = useContext(HeraldUiContext);
  if (!ctx) throw new Error('useHeraldUi must be used within HeraldProvider');
  return ctx;
}

export function useHeraldData(): HeraldDataValue {
  const ctx = useContext(HeraldDataContext);
  if (!ctx) throw new Error('useHeraldData must be used within HeraldProvider');
  return ctx;
}

export function useHeraldVoiceCtx(): HeraldVoice {
  const ctx = useContext(HeraldVoiceContext);
  if (!ctx) throw new Error('useHeraldVoiceCtx must be used within HeraldProvider');
  return ctx;
}

export function useHeraldVoiceInputCtx(): HeraldVoiceInput {
  const ctx = useContext(HeraldVoiceInputContext);
  if (!ctx) throw new Error('useHeraldVoiceInputCtx must be used within HeraldProvider');
  return ctx;
}
