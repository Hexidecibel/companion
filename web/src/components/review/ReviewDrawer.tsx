/**
 * The Code Review drawer: right-side panel on desktop (560 px, resizable),
 * full-screen sheet on mobile. "Since you looked | Everything" x
 * "By turn | By file". Keyboard driven (see KEYS).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReviewEdit, ReviewFileChange, ReviewGetFileResponse, ReviewHunk, ReviewTurn,
} from '../../types/review';
import { useReview } from '../../hooks/useReview';
import { isMobileViewport } from '../../utils/platform';
import { useReviewContext } from './ReviewContext';
import { FileDiff } from './FileDiff';
import { TurnGroup } from './TurnGroup';
import { IconCheck, IconClose, IconKeyboard, IconRevert } from './reviewIcons';
import { formatAgo, formatStat, plural, TRIVIAL_LABEL } from './format';

const WIDTH_KEY = 'companion_review_drawer_width';
const MIN_W = 420;
const MAX_W = 1100;
const AUTO_EXPAND_LINES = 120;

export const KEYS: Array<[string, string]> = [
  ['j / k', 'next / previous hunk'],
  ['J / K', 'next / previous file'],
  ['n', 'next unreviewed turn'],
  ['a', 'approve turn'],
  ['A', 'mark all reviewed'],
  ['w', 'ask why'],
  ['x', 'revert hunk'],
  ['t', 'since you looked / everything'],
  ['v', 'by turn / by file'],
  ['l', 'live'],
  ['o', 'open file'],
  ['Esc', 'close'],
];

interface NavFile {
  key: string;
  absPath: string;
  path: string;
  turnId?: string;
  hunks: ReviewHunk[];
  editId?: string;
}

export interface ReviewDrawerProps {
  /** Hooks for the action layer (ask / revert / live), supplied by the shell. */
  onAsk?: (hunk: ReviewHunk, c: { absPath: string; path: string; editId?: string }, turn?: ReviewTurn) => void;
  onRevertHunk?: (hunk: ReviewHunk, c: { absPath: string; path: string; editId?: string }) => void;
  renderFileExtra?: (absPath: string) => React.ReactNode;
  onRevertFile?: (absPath: string, path: string, to: 'head' | 'checkpoint') => void;
  liveSlot?: React.ReactNode;
  onToggleLive?: () => void;
  liveOn?: boolean;
  /** Bumps whenever something (a revert) should force a refetch. */
  refreshKey?: number;
}

export function ReviewDrawer(props: ReviewDrawerProps) {
  const ctx = useReviewContext();
  if (!ctx || !ctx.drawer.open) return null;
  return <DrawerInner {...props} />;
}

function DrawerInner({ onAsk, onRevertHunk, renderFileExtra, onRevertFile, liveSlot, onToggleLive, liveOn, refreshKey }: ReviewDrawerProps) {
  const ctx = useReviewContext()!;
  const { drawer, summary, sessionId, serverId } = ctx;
  const mobile = isMobileViewport();
  const { data, loading, error, refresh } = useReview({
    serverId, sessionId, scope: drawer.scope, view: drawer.view, open: true, version: summary?.version ?? null,
    request: ctx.request,
  });
  useEffect(() => { if (refreshKey) refresh(); }, [refreshKey, refresh]);
  useEffect(() => { if (data?.edits.length) ctx.editCache.seed(data.edits); }, [data, ctx.editCache]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // --- resizable width (desktop) ---
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(v) && v >= MIN_W ? Math.min(v, MAX_W) : 560;
    } catch { return 560; }
  });
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    const move = (ev: PointerEvent) => {
      last = Math.max(MIN_W, Math.min(MAX_W, startW + (startX - ev.clientX), window.innerWidth - 80));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      try { localStorage.setItem(WIDTH_KEY, String(Math.round(last))); } catch { /* ignore */ }
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [width]);

  // --- scroller (virtualization parent) ---
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  // --- fold / expand state ---
  const [foldedTurns, setFoldedTurns] = useState<Record<string, boolean>>({});
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [optimisticApproved, setOptimisticApproved] = useState<Record<string, boolean>>({});
  const [showTrivial, setShowTrivial] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  useEffect(() => { setOptimisticApproved({}); }, [data]);

  const editsById = useMemo(() => new Map((data?.edits ?? []).map((e) => [e.id, e])), [data]);
  const turnsWithEdits = useMemo(() => (data?.turns ?? []).filter((t) => t.editIds.length > 0), [data]);
  const isApproved = useCallback((t: ReviewTurn) => optimisticApproved[t.id] ?? t.approved, [optimisticApproved]);
  const isFolded = useCallback((t: ReviewTurn) => foldedTurns[t.id] ?? isApproved(t), [foldedTurns, isApproved]);

  const editLines = (e: ReviewEdit) => e.hunks.reduce((n, h) => n + h.lines.length, 0);
  const isExpanded = useCallback((key: string, fallback: boolean) => expandedFiles[key] ?? fallback, [expandedFiles]);
  const toggleFile = useCallback((key: string) => {
    setExpandedFiles((m) => ({ ...m, [key]: !(m[key] ?? defaultOpenRef.current.get(key) ?? false) }));
  }, []);
  const toggleTurn = useCallback((id: string) => {
    setFoldedTurns((m) => {
      const t = turnsWithEdits.find((x) => x.id === id);
      const cur = m[id] ?? (t ? (optimisticApproved[t.id] ?? t.approved) : false);
      return { ...m, [id]: !cur };
    });
  }, [turnsWithEdits, optimisticApproved]);

  const nonTrivialFiles = useMemo(() => (data?.files ?? []).filter((f) => !f.trivial), [data]);
  const trivialFiles = useMemo(() => (data?.files ?? []).filter((f) => !!f.trivial), [data]);

  // Default-open map: small unreviewed edits / top files open, the rest folded.
  const defaultOpen = useMemo(() => {
    const m = new Map<string, boolean>();
    if (!data) return m;
    if (drawer.view === 'turns') {
      for (const t of turnsWithEdits) {
        for (const id of t.editIds) {
          const e = editsById.get(id);
          if (e) m.set(e.id, !e.failed && editLines(e) <= AUTO_EXPAND_LINES);
        }
      }
    } else {
      nonTrivialFiles.forEach((f, i) => m.set(f.absPath, i < 6 && !!f.hunks && f.hunks.reduce((n, h) => n + h.lines.length, 0) <= AUTO_EXPAND_LINES * 2));
    }
    return m;
  }, [data, drawer.view, turnsWithEdits, editsById, nonTrivialFiles]);
  const defaultOpenRef = useRef(defaultOpen);
  defaultOpenRef.current = defaultOpen;

  // --- navigation model ---
  const navFiles = useMemo<NavFile[]>(() => {
    if (!data) return [];
    if (drawer.view === 'turns') {
      const out: NavFile[] = [];
      for (const t of turnsWithEdits) {
        for (const id of t.editIds) {
          const e = editsById.get(id);
          if (e) out.push({ key: e.id, absPath: e.absPath, path: e.path, turnId: t.id, hunks: e.hunks, editId: e.id });
        }
      }
      return out;
    }
    const files = [...nonTrivialFiles, ...(showTrivial ? trivialFiles : []), ...data.unattributed];
    return files.map((f) => ({ key: f.absPath, absPath: f.absPath, path: f.path, hunks: f.hunks ?? [] }));
  }, [data, drawer.view, turnsWithEdits, editsById, nonTrivialFiles, trivialFiles, showTrivial]);

  const [focus, setFocus] = useState<{ fileKey: string | null; hunkId: string | null }>({ fileKey: null, hunkId: null });
  useEffect(() => { setFocus({ fileKey: null, hunkId: null }); }, [drawer.view, drawer.scope]);

  const fileOpen = useCallback((f: NavFile) => {
    if (f.turnId) {
      const t = turnsWithEdits.find((x) => x.id === f.turnId);
      if (t && isFolded(t)) return false;
    }
    return isExpanded(f.key, defaultOpen.get(f.key) ?? false);
  }, [turnsWithEdits, isFolded, isExpanded, defaultOpen]);

  const focusFile = useCallback((f: NavFile) => {
    if (f.turnId) setFoldedTurns((m) => ({ ...m, [f.turnId!]: false }));
    setExpandedFiles((m) => ({ ...m, [f.key]: true }));
    setFocus({ fileKey: f.key, hunkId: f.hunks[0]?.id ?? null });
  }, []);

  const moveHunk = useCallback((dir: 1 | -1) => {
    const flat: Array<{ fileKey: string; hunkId: string }> = [];
    for (const f of navFiles) if (fileOpen(f)) for (const h of f.hunks) flat.push({ fileKey: f.key, hunkId: h.id });
    if (!flat.length) return;
    const i = flat.findIndex((x) => x.hunkId === focus.hunkId && x.fileKey === focus.fileKey);
    const next = i < 0 ? (dir > 0 ? 0 : flat.length - 1) : Math.max(0, Math.min(flat.length - 1, i + dir));
    setFocus(flat[next]);
  }, [navFiles, fileOpen, focus]);

  const moveFile = useCallback((dir: 1 | -1) => {
    if (!navFiles.length) return;
    const i = navFiles.findIndex((f) => f.key === focus.fileKey);
    const next = i < 0 ? (dir > 0 ? 0 : navFiles.length - 1) : Math.max(0, Math.min(navFiles.length - 1, i + dir));
    focusFile(navFiles[next]);
  }, [navFiles, focus, focusFile]);

  const focusedNav = navFiles.find((f) => f.key === focus.fileKey) ?? null;
  const focusedHunk = focusedNav?.hunks.find((h) => h.id === focus.hunkId) ?? null;
  const focusedTurnId = focusedNav?.turnId ?? null;

  const approve = useCallback((turnId: string, approved: boolean) => {
    setOptimisticApproved((m) => ({ ...m, [turnId]: approved }));
    if (approved) setFoldedTurns((m) => ({ ...m, [turnId]: true }));
    void ctx.approveTurn(turnId, approved).then((ok) => {
      if (!ok) setOptimisticApproved((m) => { const n = { ...m }; delete n[turnId]; return n; });
    });
  }, [ctx]);

  const nextUnreviewedTurn = useCallback(() => {
    const list = turnsWithEdits.filter((t) => t.unreviewed && !isApproved(t));
    if (!list.length) return;
    const cur = focusedTurnId ? turnsWithEdits.findIndex((t) => t.id === focusedTurnId) : -1;
    const target = list.find((t) => turnsWithEdits.indexOf(t) > cur) ?? list[0];
    setFoldedTurns((m) => ({ ...m, [target.id]: false }));
    const first = navFiles.find((f) => f.turnId === target.id);
    if (first) setFocus({ fileKey: first.key, hunkId: first.hunks[0]?.id ?? null });
    requestAnimationFrame(() => {
      scroller?.querySelector(`[data-turn-id="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block: 'start' });
    });
  }, [turnsWithEdits, isApproved, focusedTurnId, navFiles, scroller]);

  // Newest change time this device actually displayed.
  const shownThrough = useMemo(() => {
    if (!data) return null;
    let t = 0;
    for (const e of data.edits) if (!e.pending && e.at > t) t = e.at;
    if (data.view === 'files' || t === 0) t = Math.max(t, data.summary.lastChangeAt ?? 0, 0) || data.computedAt;
    return t;
  }, [data]);

  const markAll = useCallback(() => {
    if (shownThrough != null) ctx.markReviewed(shownThrough);
  }, [ctx, shownThrough]);

  // Focus requests from outside (strip "Turn 12 finished", Herald chip, inline chip).
  useEffect(() => {
    if (!data) return;
    const target = drawer.focusEditId ?? null;
    const turnTarget = drawer.focusTurnId ?? (target ? data.edits.find((e) => e.id === target)?.turnId : undefined);
    if (turnTarget) {
      setFoldedTurns((m) => ({ ...m, [turnTarget]: false }));
      requestAnimationFrame(() => {
        scroller?.querySelector(`[data-turn-id="${CSS.escape(turnTarget)}"]`)?.scrollIntoView({ block: 'start' });
      });
    }
    if (target) {
      setExpandedFiles((m) => ({ ...m, [target]: true }));
      const e = data.edits.find((x) => x.id === target);
      if (e) setFocus({ fileKey: e.id, hunkId: e.hunks[0]?.id ?? null });
    }
    // only when the request or data identity changes
  }, [drawer.focusEditId, drawer.focusTurnId, data, scroller]);

  // --- keyboard ---
  const keyState = useRef({ moveHunk, moveFile, nextUnreviewedTurn, approve, markAll, focusedHunk, focusedNav, focusedTurnId, turnsWithEdits, isApproved, onAsk, onRevertHunk, onToggleLive, ctx, drawer });
  keyState.current = { moveHunk, moveFile, nextUnreviewedTurn, approve, markAll, focusedHunk, focusedNav, focusedTurnId, turnsWithEdits, isApproved, onAsk, onRevertHunk, onToggleLive, ctx, drawer };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.closest('.rv-dialog'))) return;
      if (document.querySelector('.rv-dialog')) return;
      const s = keyState.current;
      const hunkCtx = s.focusedNav && s.focusedHunk ? { absPath: s.focusedNav.absPath, path: s.focusedNav.path, editId: s.focusedNav.editId } : null;
      let handled = true;
      switch (e.key) {
        case 'j': s.moveHunk(1); break;
        case 'k': s.moveHunk(-1); break;
        case 'J': s.moveFile(1); break;
        case 'K': s.moveFile(-1); break;
        case 'n': s.nextUnreviewedTurn(); break;
        case 'a': {
          const turn = s.turnsWithEdits.find((x) => x.id === s.focusedTurnId) ?? s.turnsWithEdits.find((x) => x.unreviewed && !s.isApproved(x));
          if (turn) s.approve(turn.id, !s.isApproved(turn));
          break;
        }
        case 'A': s.markAll(); break;
        case 'w': if (hunkCtx && s.onAsk) s.onAsk(s.focusedHunk!, hunkCtx, s.turnsWithEdits.find((x) => x.id === s.focusedTurnId)); break;
        case 'x': if (hunkCtx && s.onRevertHunk) s.onRevertHunk(s.focusedHunk!, hunkCtx); break;
        case 't': s.ctx.setScope(s.drawer.scope === 'all' ? 'since_checkpoint' : 'all'); break;
        case 'v': s.ctx.setView(s.drawer.view === 'turns' ? 'files' : 'turns'); break;
        case 'l': s.onToggleLive?.(); break;
        case 'o': if (s.focusedNav) s.ctx.onViewFile?.(s.focusedNav.absPath); break;
        case 'Escape': s.ctx.closeDrawer(); break;
        case '?': setShowKeys((v) => !v); break;
        default: handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // --- "N new changes" pill (no scroll jump) ---
  const seenIds = useRef<Set<string> | null>(null);
  const [newCount, setNewCount] = useState(0);
  useEffect(() => {
    if (!data) return;
    const ids = new Set<string>(data.view === 'turns' ? data.edits.map((e) => e.id) : data.files.map((f) => `${f.absPath}:${f.additions}:${f.deletions}`));
    const prev = seenIds.current;
    seenIds.current = ids;
    if (!prev) return;
    let n = 0;
    for (const id of ids) if (!prev.has(id)) n++;
    if (n > 0) setNewCount((c) => c + n);
  }, [data]);
  useEffect(() => { seenIds.current = null; setNewCount(0); }, [drawer.view, drawer.scope]);
  useEffect(() => {
    if (!newCount) return;
    const t = setTimeout(() => setNewCount(0), 8000);
    return () => clearTimeout(t);
  }, [newCount]);

  const pendingMarked = ctx.pendingMark != null && shownThrough != null && ctx.pendingMark >= shownThrough;
  const unrev = summary ?? data?.summary ?? null;
  const st = formatStat(unrev?.unreviewedAdditions ?? 0, unrev?.unreviewedDeletions ?? 0);
  const caughtUp = !!data && !pendingMarked && drawer.scope === 'since_checkpoint' && (drawer.view === 'turns' ? turnsWithEdits.length === 0 : data.files.length + data.unattributed.length === 0);
  const transcriptMode = data?.summary.mode === 'transcript';
  const degraded = (data?.repos ?? []).filter((r) => r.degraded);

  const loadFile = useCallback((f: ReviewFileChange) => async () => {
    const res = await ctx.request<ReviewGetFileResponse>('review_get_file', { sessionId, absPath: f.absPath, scope: drawer.scope });
    return res.file.hunks;
  }, [ctx, sessionId, drawer.scope]);

  const renderFile = (f: ReviewFileChange, extraMeta?: React.ReactNode) => {
    const turnIdx = f.turnIds.map((id) => data?.turns.find((t) => t.id === id)?.index).filter((x): x is number => !!x);
    const meta = (
      <>
        {turnIdx.length > 0 && <span>{turnIdx.map((i) => `T${i}`).join(', ')}</span>}
        {f.alsoChangedBy?.length ? <span className="rv-foreign">also changed by {f.alsoChangedBy.join(', ')}</span> : null}
        {f.source === 'transcript' && data?.summary.mode === 'git' && <span title="Not tracked by git (ignored); shown from the transcript">from transcript</span>}
        {extraMeta}
      </>
    );
    const hasMeta = turnIdx.length > 0 || !!f.alsoChangedBy?.length || (f.source === 'transcript' && data?.summary.mode === 'git') || !!extraMeta;
    return (
      <FileDiff
        key={f.absPath}
        fileKey={f.absPath}
        path={f.path}
        absPath={f.absPath}
        oldPath={f.oldPath}
        status={f.status}
        additions={f.additions}
        deletions={f.deletions}
        risks={f.risks}
        heat={f.heat}
        trivial={f.trivial}
        hunks={f.hunks}
        hunksOmitted={f.hunksOmitted}
        unreviewed={f.unreviewed}
        meta={hasMeta ? meta : undefined}
        expanded={isExpanded(f.absPath, defaultOpen.get(f.absPath) ?? false)}
        onToggle={toggleFile}
        focused={focus.fileKey === f.absPath}
        focusedHunkId={focus.fileKey === f.absPath ? focus.hunkId : null}
        onFocusHunk={(fileKey, hunkId) => setFocus({ fileKey, hunkId })}
        loadHunks={f.hunks ? undefined : loadFile(f)}
        onAsk={onAsk}
        onRevertHunk={onRevertHunk}
        headerExtra={(
          <>
            {renderFileExtra?.(f.absPath)}
            {onRevertFile && f.source === 'git' && !f.binary && (
              <button
                type="button"
                className="rv-icon-btn rv-icon-btn--danger"
                title={drawer.scope === 'all' ? 'Revert file to the last commit' : 'Revert file to when you last looked'}
                aria-label="Revert file"
                onClick={(e) => { e.stopPropagation(); onRevertFile(f.absPath, f.path, drawer.scope === 'all' ? 'head' : 'checkpoint'); }}
              >
                <IconRevert width={14} height={14} />
              </button>
            )}
          </>
        )}
        scrollParent={scroller}
      />
    );
  };

  const body = (() => {
    if (!data && loading) return <DrawerSkeleton />;
    if (!data && error) return <div className="rv-empty rv-empty--error"><p>{error}</p><button type="button" className="rv-btn" onClick={refresh}>Try again</button></div>;
    if (!data) return <DrawerSkeleton />;
    if (pendingMarked || caughtUp) {
      return (
        <div className="rv-empty">
          <div className="rv-empty__badge"><IconCheck width={22} height={22} /></div>
          <p className="rv-empty__title">You're all caught up.</p>
          <p className="rv-empty__sub">
            {pendingMarked ? 'Marked reviewed just now.' : `Last looked ${formatAgo(data.checkpoint.reviewedThrough || null, now)}.`}
            {data.checkpoint.updatedBy && !pendingMarked ? ` (${data.checkpoint.updatedBy})` : ''}
          </p>
          {drawer.scope !== 'all' && <button type="button" className="rv-btn rv-btn--ghost" onClick={() => ctx.setScope('all')}>Show everything</button>}
        </div>
      );
    }
    if (drawer.view === 'turns') {
      if (turnsWithEdits.length === 0) return <div className="rv-empty"><p className="rv-empty__title">No code changes in this session yet.</p></div>;
      return turnsWithEdits.map((t) => {
        const edits = t.editIds.map((id) => editsById.get(id)).filter((e): e is ReviewEdit => !!e);
        return (
          <TurnGroup
            key={t.id}
            turn={t}
            edits={edits}
            approved={isApproved(t)}
            folded={isFolded(t)}
            focused={focusedTurnId === t.id}
            onToggleFold={toggleTurn}
            onApprove={approve}
            swipeEnabled={mobile}
            now={now}
          >
            {edits.map((e) => (
              <FileDiff
                key={e.id}
                fileKey={e.id}
                path={e.path}
                absPath={e.absPath}
                status={e.kind}
                additions={e.additions}
                deletions={e.deletions}
                risks={e.risks}
                hunks={e.patchUnavailable ? null : e.hunks}
                hunksOmitted={e.patchUnavailable ? 'unavailable' : undefined}
                editId={e.id}
                pending={e.pending}
                failed={e.failed}
                expanded={isExpanded(e.id, defaultOpen.get(e.id) ?? false)}
                onToggle={toggleFile}
                focused={focus.fileKey === e.id}
                focusedHunkId={focus.fileKey === e.id ? focus.hunkId : null}
                onFocusHunk={(fileKey, hunkId) => setFocus({ fileKey, hunkId })}
                onAsk={onAsk ? (h, c) => onAsk(h, c, t) : undefined}
                onRevertHunk={e.failed || e.pending ? undefined : onRevertHunk}
                headerExtra={renderFileExtra?.(e.absPath)}
                scrollParent={scroller}
              />
            ))}
          </TurnGroup>
        );
      });
    }
    // files view
    return (
      <>
        {transcriptMode && <div className="rv-notice">Not a git repository: changes are listed per edit, not merged.</div>}
        {nonTrivialFiles.map((f) => renderFile(f))}
        {trivialFiles.length > 0 && (
          <div className="rv-trivial">
            <button type="button" className="rv-trivial__toggle" onClick={() => setShowTrivial((v) => !v)} aria-expanded={showTrivial}>
              {plural(trivialFiles.length, 'trivial change')} ({[...new Set(trivialFiles.map((f) => TRIVIAL_LABEL[f.trivial!]))].join(', ')})
            </button>
            {showTrivial && trivialFiles.map((f) => renderFile(f))}
          </div>
        )}
        {data.unattributed.length > 0 && (
          <div className="rv-unattributed">
            <div className="rv-section-title">
              Not from this session's edits <span className="rv-count">{data.unattributed.length}</span>
            </div>
            <p className="rv-section-sub">Changed in the repo by a shell command, another tool or by hand since the base.</p>
            {data.unattributed.map((f) => renderFile(f))}
          </div>
        )}
        {data.omitted?.files ? <div className="rv-notice">{plural(data.omitted.files, 'more file')} not shown.</div> : null}
      </>
    );
  })();

  const sessionLabel = ctx.sessionName || sessionId;

  return (
    <>
      {mobile && <div className="rv-scrim" onClick={ctx.closeDrawer} />}
      <aside
        className={`rv-drawer${mobile ? ' rv-drawer--sheet' : ''}`}
        style={mobile ? undefined : { width }}
        role="dialog"
        aria-modal={mobile ? 'true' : 'false'}
        aria-label="Code review"
        data-testid="rv-drawer"
      >
        {!mobile && <div className="rv-drawer__resize" onPointerDown={onResizeStart} aria-hidden="true" />}
        <header className="rv-drawer__head">
          <div className="rv-drawer__titlebar">
            <div className="rv-drawer__title">
              <span>Review</span>
              <span className="rv-drawer__session" title={sessionLabel}>{sessionLabel}</span>
            </div>
            <div className="rv-drawer__head-actions">
              {onToggleLive && (
                <button type="button" className={`rv-chip-btn${liveOn ? ' rv-chip-btn--on' : ''}`} onClick={onToggleLive} aria-pressed={!!liveOn} title="Live: watch edits as they land (l)">
                  <span className={`rv-live-dot rv-live-dot--inline${liveOn ? '' : ' rv-live-dot--off'}`} /> Live
                </button>
              )}
              {!mobile && (
                <button type="button" className={`rv-icon-btn${showKeys ? ' rv-icon-btn--on' : ''}`} onClick={() => setShowKeys((v) => !v)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
                  <IconKeyboard />
                </button>
              )}
              <button type="button" className="rv-icon-btn" onClick={ctx.closeDrawer} title="Close (Esc)" aria-label="Close review">
                <IconClose />
              </button>
            </div>
          </div>
          <div className="rv-drawer__controls">
            <Segmented
              value={drawer.scope}
              options={[['since_checkpoint', 'Since you looked'], ['all', 'Everything']]}
              onChange={(v) => ctx.setScope(v as typeof drawer.scope)}
              label="Scope"
            />
            <Segmented
              value={drawer.view}
              options={[['turns', 'By turn'], ['files', 'By file']]}
              onChange={(v) => ctx.setView(v as typeof drawer.view)}
              label="Group by"
            />
            {loading && data && <span className="rv-spinner" aria-label="Refreshing" />}
          </div>
          {showKeys && !mobile && (
            <div className="rv-keys">
              {KEYS.map(([k, d]) => <span key={k}><kbd>{k}</kbd> {d}</span>)}
            </div>
          )}
          {degraded.length > 0 && (
            <div className="rv-notice rv-notice--warn">
              {degraded.map((r) => `${r.root.split('/').pop()}: ${r.degraded === 'timeout' ? 'git is slow, showing edits only' : r.degraded === 'too_many_untracked' ? 'too many untracked files, showing edited paths only' : r.degraded === 'git_disabled' ? 'git disabled' : 'not a git repo'}`).join(' · ')}
            </div>
          )}
        </header>
        {liveSlot}
        <div className="rv-drawer__body" ref={setScroller}>
          {newCount > 0 && (
            <button type="button" className="rv-newpill" onClick={() => { setNewCount(0); scroller?.scrollTo({ top: drawer.view === 'turns' ? scroller.scrollHeight : 0, behavior: 'smooth' }); }}>
              {plural(newCount, 'new change')}
            </button>
          )}
          {error && data && <div className="rv-notice rv-notice--warn">Could not refresh: {error}</div>}
          {body}
        </div>
        {data && !caughtUp && !pendingMarked && (
          <footer className="rv-drawer__foot">
            <span className="rv-drawer__foot-stat rv-num">
              {unrev && unrev.unreviewedFiles > 0 ? (
                <>
                  {plural(unrev.unreviewedFiles, 'file')} unreviewed · <span className="rv-add">{st.add}</span> <span className="rv-del">{st.del}</span>
                </>
              ) : 'Nothing new since you looked'}
            </span>
            <button type="button" className="rv-btn rv-btn--primary" onClick={markAll} disabled={!unrev || (unrev.unreviewedFiles === 0 && unrev.unreviewedTurns === 0)}>
              <IconCheck width={15} height={15} /> Mark all reviewed
            </button>
          </footer>
        )}
      </aside>
    </>
  );
}

function Segmented({ value, options, onChange, label }: { value: string; options: Array<[string, string]>; onChange: (v: string) => void; label: string }) {
  return (
    <div className="rv-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={`rv-seg__opt${value === v ? ' rv-seg__opt--on' : ''}`} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function DrawerSkeleton() {
  return (
    <div className="rv-skeleton" aria-label="Loading review">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rv-skeleton__card">
          <div className="rv-skeleton__line rv-skeleton__line--w40" />
          <div className="rv-skeleton__line rv-skeleton__line--w70" />
          <div className="rv-skeleton__block" />
        </div>
      ))}
    </div>
  );
}

