/**
 * Session-scoped Code Review state shared by the strip, the drawer, the
 * inline edit chips and the header button.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ReviewApproveTurnRequest, ReviewMarkRequest, ReviewMarkResponse, ReviewScope, ReviewSummary, ReviewView,
} from '../../types/review';
import { useReviewSummary, useReviewSupported } from '../../hooks/useReviewSummary';
import { reviewErrorMessage, reviewRequester, type ReviewRequestFn } from '../../services/reviewApi';
import { ReviewEditCache } from '../../services/reviewEditCache';
import { reviewStore } from '../../services/reviewStore';
import { deviceLabel } from '../../services/heraldDevice';
import { crmCommentsKey } from '../../services/storageKeys';
import { takeReviewOpen } from '../../services/reviewNav';
import { eventBus } from '../../utils/eventBus';

export const MARK_UNDO_MS = 5000;

export interface ReviewToast {
  id: number;
  text: string;
  tone?: 'info' | 'success' | 'warn' | 'error';
  action?: { label: string; run: () => void };
  ttl: number;
}

export interface SavedComment {
  filePath: string;
  lineNumber: number;
  lineText: string;
  comment: string;
  timestamp: number;
}

export interface DrawerState {
  open: boolean;
  scope: ReviewScope;
  view: ReviewView;
  /** Scroll to / expand this turn or edit on open. */
  focusTurnId?: string;
  focusEditId?: string;
}

export interface ReviewContextValue {
  serverId: string;
  sessionId: string;
  sessionName: string | null;
  summary: ReviewSummary | null;
  /** false: the daemon has no Code Review. */
  supported: boolean | null;
  request: ReviewRequestFn;
  device: string;

  drawer: DrawerState;
  openDrawer: (opts?: Partial<Omit<DrawerState, 'open'>>) => void;
  closeDrawer: () => void;
  setScope: (scope: ReviewScope) => void;
  setView: (view: ReviewView) => void;

  /** Mark through `through`; sent after a 5 s undo window. */
  markReviewed: (through: number) => void;
  /** Through-time of a mark waiting out its undo window (UI hides as reviewed). */
  pendingMark: number | null;
  approveTurn: (turnId: string, approved: boolean) => Promise<boolean>;

  editCache: ReviewEditCache;

  comments: SavedComment[];
  addComment: (c: Omit<SavedComment, 'timestamp'>) => void;
  clearComments: () => void;
  /** Send text into the session (comments). */
  sendToSession?: (text: string) => void;
  onViewFile?: (path: string) => void;

  toasts: ReviewToast[];
  toast: (t: Omit<ReviewToast, 'id' | 'ttl'> & { ttl?: number }) => number;
  dismissToast: (id: number) => void;
}

const Ctx = createContext<ReviewContextValue | null>(null);

export function useReviewContext(): ReviewContextValue | null {
  return useContext(Ctx);
}

function loadComments(sessionId: string): SavedComment[] {
  try {
    const raw = localStorage.getItem(crmCommentsKey(sessionId));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveComments(sessionId: string, comments: SavedComment[]): void {
  try {
    if (comments.length === 0) localStorage.removeItem(crmCommentsKey(sessionId));
    else localStorage.setItem(crmCommentsKey(sessionId), JSON.stringify(comments));
  } catch {
    // storage full / unavailable: comments still went to the session
  }
}

interface ProviderProps {
  serverId: string;
  sessionId: string;
  sessionName?: string | null;
  sendToSession?: (text: string) => void;
  onViewFile?: (path: string) => void;
  /** Tests / preview harness. */
  request?: ReviewRequestFn;
  /** Imperative handle for callers outside the provider (header menus). */
  apiRef?: React.MutableRefObject<ReviewApi | null>;
  onDrawerChange?: (open: boolean) => void;
  children: ReactNode;
}

export interface ReviewApi {
  openDrawer: (opts?: Partial<Omit<DrawerState, 'open'>>) => void;
  closeDrawer: () => void;
  isOpen: () => boolean;
}

export function ReviewProvider({ serverId, sessionId, sessionName, sendToSession, onViewFile, request: injected, apiRef, onDrawerChange, children }: ProviderProps) {
  const summary = useReviewSummary(serverId, sessionId);
  const supported = useReviewSupported(serverId);
  const request = useMemo(() => injected ?? reviewRequester(serverId), [injected, serverId]);
  const device = useMemo(() => {
    try { return deviceLabel(); } catch { return 'Companion'; }
  }, []);

  const [drawer, setDrawer] = useState<DrawerState>({ open: false, scope: 'since_checkpoint', view: 'turns' });
  const openDrawer = useCallback((opts?: Partial<Omit<DrawerState, 'open'>>) => {
    setDrawer((d) => ({ ...d, ...opts, open: true }));
  }, []);
  const closeDrawer = useCallback(() => setDrawer((d) => ({ ...d, open: false, focusTurnId: undefined, focusEditId: undefined })), []);
  const setScope = useCallback((scope: ReviewScope) => setDrawer((d) => ({ ...d, scope })), []);
  const setView = useCallback((view: ReviewView) => setDrawer((d) => ({ ...d, view })), []);

  // Session switch: close the drawer, then honour a parked "open review" request.
  const sessionKeyRef = useRef(`${serverId}|${sessionId}`);
  useEffect(() => {
    const key = `${serverId}|${sessionId}`;
    const switched = sessionKeyRef.current !== key;
    sessionKeyRef.current = key;
    const parked = takeReviewOpen(serverId, sessionId);
    setDrawer((d) => (parked ? { ...d, ...parked, open: true } : switched && d.open ? { ...d, open: false } : d));
    return eventBus.on('review-open', (ev) => {
      if (ev.serverId !== serverId || ev.sessionId !== sessionId) return;
      const opts = takeReviewOpen(serverId, sessionId);
      if (opts) setDrawer((d) => ({ ...d, ...opts, open: true }));
    });
  }, [serverId, sessionId]);

  const drawerOpenRef = useRef(drawer.open);
  drawerOpenRef.current = drawer.open;
  useEffect(() => { onDrawerChange?.(drawer.open); }, [drawer.open, onDrawerChange]);
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { openDrawer, closeDrawer, isOpen: () => drawerOpenRef.current };
    return () => { apiRef.current = null; };
  }, [apiRef, openDrawer, closeDrawer]);

  // --- toasts ---
  const [toasts, setToasts] = useState<ReviewToast[]>([]);
  const toastSeq = useRef(0);
  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = useCallback((t: Omit<ReviewToast, 'id' | 'ttl'> & { ttl?: number }) => {
    const id = ++toastSeq.current;
    setToasts((ts) => [...ts.slice(-2), { ttl: 4000, ...t, id }]);
    return id;
  }, []);

  // --- edit cache (inline chips) ---
  const editCache = useMemo(() => new ReviewEditCache(sessionId, request), [sessionId, request]);
  useEffect(() => () => editCache.dispose(), [editCache]);
  const version = summary?.version ?? null;
  useEffect(() => {
    if (version != null) editCache.invalidatePending();
  }, [version, editCache]);

  // --- mark reviewed, optimistic with a 5 s undo window ---
  const [pendingMark, setPendingMark] = useState<number | null>(null);
  const markTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markThrough = useRef<number | null>(null);
  const sendMark = useCallback(async (through: number) => {
    const req: ReviewMarkRequest = { sessionId, through, device };
    try {
      const res = await request<ReviewMarkResponse>('review_mark_reviewed', req);
      if (res?.summary) reviewStore.apply(serverId, res.summary);
    } catch (err) {
      toast({ text: `Could not mark reviewed: ${reviewErrorMessage(err)}`, tone: 'error' });
    } finally {
      setPendingMark((p) => (p === through ? null : p));
    }
  }, [sessionId, device, request, serverId, toast]);
  const flushMark = useCallback(() => {
    if (markTimer.current) clearTimeout(markTimer.current);
    markTimer.current = null;
    const t = markThrough.current;
    markThrough.current = null;
    if (t != null) void sendMark(t);
  }, [sendMark]);
  const flushRef = useRef(flushMark);
  flushRef.current = flushMark;
  // Leaving the session (or unmount) commits a mark still in its undo window.
  useEffect(() => () => flushRef.current(), [serverId, sessionId]);

  const markReviewed = useCallback((through: number) => {
    if (markTimer.current) flushRef.current();
    markThrough.current = through;
    setPendingMark(through);
    let toastId = 0;
    const undo = () => {
      if (markTimer.current) clearTimeout(markTimer.current);
      markTimer.current = null;
      markThrough.current = null;
      setPendingMark(null);
      dismissToast(toastId);
    };
    markTimer.current = setTimeout(() => flushRef.current(), MARK_UNDO_MS);
    toastId = toast({ text: 'Marked reviewed', tone: 'success', action: { label: 'Undo', run: undo }, ttl: MARK_UNDO_MS });
  }, [toast, dismissToast]);

  const approveTurn = useCallback(async (turnId: string, approved: boolean) => {
    const req: ReviewApproveTurnRequest = { sessionId, turnId, approved, device };
    try {
      const res = await request<ReviewMarkResponse>('review_approve_turn', req);
      if (res?.summary) reviewStore.apply(serverId, res.summary);
      return true;
    } catch (err) {
      toast({ text: `Could not ${approved ? 'approve' : 'unapprove'} turn: ${reviewErrorMessage(err)}`, tone: 'error' });
      return false;
    }
  }, [sessionId, device, request, serverId, toast]);

  // --- line comments (carried over from the old review modal) ---
  const [comments, setComments] = useState<SavedComment[]>(() => loadComments(sessionId));
  useEffect(() => { setComments(loadComments(sessionId)); }, [sessionId]);
  const addComment = useCallback((c: Omit<SavedComment, 'timestamp'>) => {
    setComments((prev) => {
      const next = [...prev, { ...c, timestamp: Date.now() }];
      saveComments(sessionId, next);
      return next;
    });
  }, [sessionId]);
  const clearComments = useCallback(() => {
    setComments([]);
    saveComments(sessionId, []);
  }, [sessionId]);

  const value = useMemo<ReviewContextValue>(() => ({
    serverId, sessionId, sessionName: sessionName ?? null, summary, supported, request, device,
    drawer, openDrawer, closeDrawer, setScope, setView,
    markReviewed, pendingMark, approveTurn, editCache,
    comments, addComment, clearComments, sendToSession, onViewFile,
    toasts, toast, dismissToast,
  }), [serverId, sessionId, sessionName, summary, supported, request, device, drawer, openDrawer, closeDrawer, setScope, setView,
    markReviewed, pendingMark, approveTurn, editCache, comments, addComment, clearComments, sendToSession, onViewFile,
    toasts, toast, dismissToast]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Summary as the UI should show it: a mark in its undo window counts as reviewed. */
export function effectiveUnreviewed(summary: ReviewSummary | null, pendingMark: number | null): boolean {
  if (!summary) return false;
  if (pendingMark != null && summary.lastChangeAt != null && pendingMark >= summary.lastChangeAt) return false;
  return summary.unreviewedFiles > 0 || summary.unreviewedTurns > 0;
}
