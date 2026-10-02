/**
 * One file's (or one edit's) diff: a header that folds, then rows for every
 * hunk with collapsed "unchanged lines" gaps between them. Long files (> 200
 * rows) are virtualized against the drawer's scroller. Syntax highlighting and
 * word marks are only computed once a file is expanded.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ReviewFileStatus, ReviewHunk, ReviewRiskFlag, ReviewTrivialKind } from '../../types/review';
import { baseName, dirName, hunkGaps, hunkHeader, hunkPatch, numberHunk, type NumberedLine } from '../../utils/diff/patchText';
import { copyToClipboard } from '../../utils/clipboard';
import { ContextMenu, type ContextMenuEntry } from '../ContextMenu';
import { DiffLine } from './DiffLine';
import { RiskBadges } from './RiskBadge';
import { useHunkSegments } from './useHunkSegments';
import { useReviewContext, type SavedComment } from './ReviewContext';
import { IconAsk, IconChevronDown, IconChevronRight, IconComment, IconCopy, IconOpen, IconRevert } from './reviewIcons';
import { HOT_HEAT, formatStat, TRIVIAL_LABEL } from './format';

export const VIRTUALIZE_ROWS = 200;

type Row =
  | { t: 'gap'; key: string; count: number }
  | { t: 'hunk'; key: string; hunk: ReviewHunk }
  | { t: 'line'; key: string; hunk: ReviewHunk; line: NumberedLine; commented: boolean }
  | { t: 'comment'; key: string; comment: SavedComment }
  | { t: 'composer'; key: string; hunk: ReviewHunk; line: NumberedLine };

const STATUS_LETTER: Record<ReviewFileStatus | 'create' | 'update', { l: string; label: string }> = {
  added: { l: 'A', label: 'Added' },
  create: { l: 'A', label: 'Created' },
  modified: { l: 'M', label: 'Modified' },
  update: { l: 'M', label: 'Edited' },
  deleted: { l: 'D', label: 'Deleted' },
  renamed: { l: 'R', label: 'Renamed' },
  mode_changed: { l: 'P', label: 'Mode changed' },
};

export interface FileDiffProps {
  fileKey: string;
  path: string;
  absPath: string;
  oldPath?: string;
  status: ReviewFileStatus | 'create' | 'update';
  additions: number;
  deletions: number;
  risks: ReviewRiskFlag[];
  heat?: number;
  trivial?: ReviewTrivialKind;
  hunks: ReviewHunk[] | null;
  hunksOmitted?: 'lazy' | 'too_large' | 'binary' | 'unavailable';
  editId?: string;
  unreviewed?: boolean;
  pending?: boolean;
  failed?: boolean;
  /** Extra header meta, e.g. "T11, T12" or "also changed by Out4". */
  meta?: ReactNode;
  expanded: boolean;
  onToggle: (fileKey: string) => void;
  focused?: boolean;
  focusedHunkId?: string | null;
  onFocusHunk?: (fileKey: string, hunkId: string) => void;
  loadHunks?: () => Promise<ReviewHunk[] | null>;
  onAsk?: (hunk: ReviewHunk, ctx: { absPath: string; path: string; editId?: string }) => void;
  onRevertHunk?: (hunk: ReviewHunk, ctx: { absPath: string; path: string; editId?: string }) => void;
  /** Header-right slot (undo link etc.). */
  headerExtra?: ReactNode;
  scrollParent?: HTMLElement | null;
}

export const FileDiff = memo(function FileDiff(props: FileDiffProps) {
  const {
    fileKey, path, absPath, oldPath, status, additions, deletions, risks, heat, trivial, hunks: givenHunks, hunksOmitted,
    editId, unreviewed, pending, failed, meta, expanded, onToggle, focused, focusedHunkId, onFocusHunk, loadHunks,
    onAsk, onRevertHunk, headerExtra, scrollParent,
  } = props;
  const ctx = useReviewContext();

  // Lazy hunks (files view: lockfiles, big files).
  const [loaded, setLoaded] = useState<ReviewHunk[] | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRef = useRef(loadHunks);
  loadRef.current = loadHunks;
  useEffect(() => { setLoaded(null); setLoadState('idle'); }, [fileKey, givenHunks]);
  const hunks = givenHunks ?? loaded;
  const canLoad = !givenHunks && !!loadHunks && hunksOmitted !== 'binary';
  useEffect(() => {
    if (!expanded || !canLoad || loaded || loadState !== 'idle') return;
    setLoadState('loading');
    loadRef.current!()
      .then((h) => { setLoaded(h ?? []); setLoadState('idle'); })
      .catch((err) => { setLoadState('error'); setLoadError(err instanceof Error ? err.message : String(err)); });
  }, [expanded, canLoad, loaded, loadState]);

  const segments = useHunkSegments(hunks, path, expanded);

  // Line comments + composer.
  const [composeAt, setComposeAt] = useState<{ hunkId: string; index: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; hunk: ReviewHunk; line: NumberedLine } | null>(null);
  const fileComments = useMemo(() => (ctx?.comments ?? []).filter((c) => c.filePath === path), [ctx?.comments, path]);

  const rows = useMemo<Row[]>(() => {
    if (!expanded || !hunks) return [];
    const out: Row[] = [];
    const gaps = hunkGaps(hunks);
    hunks.forEach((h, hi) => {
      if (gaps[hi] > 0 && !(hi === 0 && status === 'added')) out.push({ t: 'gap', key: `gap-${h.id}`, count: gaps[hi] });
      out.push({ t: 'hunk', key: `h-${h.id}`, hunk: h });
      for (const line of numberHunk(h)) {
        const lineNo = line.kind === 'del' ? line.oldNo : line.newNo;
        const cs = line.kind === 'meta' ? [] : fileComments.filter((c) => c.lineNumber === lineNo && c.lineText === line.text.trim());
        out.push({ t: 'line', key: `l-${h.id}-${line.index}`, hunk: h, line, commented: cs.length > 0 });
        cs.forEach((c, ci) => out.push({ t: 'comment', key: `c-${h.id}-${line.index}-${ci}`, comment: c }));
        if (composeAt && composeAt.hunkId === h.id && composeAt.index === line.index) {
          out.push({ t: 'composer', key: `k-${h.id}-${line.index}`, hunk: h, line });
        }
      }
    });
    return out;
  }, [expanded, hunks, status, fileComments, composeAt]);

  const hunkCtx = useMemo(() => ({ absPath, path, editId }), [absPath, path, editId]);

  const openMenu = useCallback((e: React.MouseEvent | React.KeyboardEvent, hunk: ReviewHunk, line: NumberedLine) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = 'clientX' in e && e.clientX ? e.clientX : r.left + 24;
    const y = 'clientY' in e && e.clientY ? e.clientY : r.bottom;
    setMenu({ x, y, hunk, line });
  }, []);

  // Keyboard focus: bring the focused hunk into view.
  const virtuoso = useRef<VirtuosoHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALIZE_ROWS && !!scrollParent;
  useEffect(() => {
    if (!focusedHunkId || !expanded) return;
    const idx = rows.findIndex((r) => r.t === 'hunk' && r.hunk.id === focusedHunkId);
    if (idx < 0) return;
    if (virtual) {
      virtuoso.current?.scrollToIndex({ index: idx, align: 'start', behavior: 'auto' });
    } else {
      const el = rootRef.current?.querySelector(`[data-hunk-id="${CSS.escape(focusedHunkId)}"]`);
      (el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [focusedHunkId, expanded, rows, virtual]);
  useEffect(() => {
    if (focused && !focusedHunkId) rootRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused, focusedHunkId]);

  const renderRow = (row: Row) => {
    switch (row.t) {
      case 'gap':
        return <div className="rv-gap">{'⋯'} {row.count} unchanged line{row.count === 1 ? '' : 's'}</div>;
      case 'hunk': {
        const isFocused = focusedHunkId === row.hunk.id;
        return (
          <div
            className={`rv-hunk-head${isFocused ? ' rv-hunk-head--focus' : ''}${row.hunk.trivial ? ' rv-hunk-head--trivial' : ''}`}
            data-hunk-id={row.hunk.id}
            onClick={() => onFocusHunk?.(fileKey, row.hunk.id)}
          >
            <span className="rv-hunk-head__range">{hunkHeader(row.hunk).replace(/ @@.*$/, ' @@')}</span>
            {row.hunk.section && <span className="rv-hunk-head__section">{row.hunk.section}</span>}
            {row.hunk.trivial && <span className="rv-tag">{TRIVIAL_LABEL[row.hunk.trivial]}</span>}
            {row.hunk.clipped && <span className="rv-tag" title="Some long lines were clipped">clipped</span>}
            <span className="rv-hunk-head__actions">
              {onAsk && (
                <button type="button" className="rv-icon-btn" title="Ask why (w)" aria-label="Ask why" onClick={(e) => { e.stopPropagation(); onAsk(row.hunk, hunkCtx); }}>
                  <IconAsk width={14} height={14} />
                </button>
              )}
              {onRevertHunk && (
                <button type="button" className="rv-icon-btn rv-icon-btn--danger" title="Revert hunk (x)" aria-label="Revert hunk" onClick={(e) => { e.stopPropagation(); onRevertHunk(row.hunk, hunkCtx); }}>
                  <IconRevert width={14} height={14} />
                </button>
              )}
              <button type="button" className="rv-icon-btn" title="Copy hunk" aria-label="Copy hunk" onClick={(e) => { e.stopPropagation(); void copyToClipboard(hunkPatch(path, [row.hunk])); ctx?.toast({ text: 'Hunk copied' }); }}>
                <IconCopy width={14} height={14} />
              </button>
            </span>
          </div>
        );
      }
      case 'line':
        return (
          <DiffLine
            line={row.line}
            segments={segments.get(row.hunk.id)?.[row.line.index]}
            hasComments={row.commented}
            onMenu={row.line.kind === 'meta' ? undefined : (e, line) => openMenu(e, row.hunk, line)}
          />
        );
      case 'comment':
        return (
          <div className="rv-comment">
            <IconComment width={13} height={13} />
            <span>{row.comment.comment}</span>
          </div>
        );
      case 'composer':
        return (
          <CommentComposer
            path={path}
            line={row.line}
            onCancel={() => setComposeAt(null)}
            onSubmit={(text) => {
              const lineNo = (row.line.kind === 'del' ? row.line.oldNo : row.line.newNo) ?? 0;
              const lineText = row.line.text.trim();
              ctx?.sendToSession?.(`Re: ${path}:${lineNo}\n> ${lineText}\n\n${text}`);
              ctx?.addComment({ filePath: path, lineNumber: lineNo, lineText, comment: text });
              ctx?.toast({ text: 'Comment sent to the session', tone: 'success' });
              setComposeAt(null);
            }}
          />
        );
    }
  };

  const st = STATUS_LETTER[status];
  const stat = formatStat(additions, deletions);
  const dir = dirName(path);
  const hot = (heat ?? 0) >= HOT_HEAT;

  return (
    <div
      ref={rootRef}
      className={`rv-file${expanded ? ' rv-file--open' : ''}${focused ? ' rv-file--focus' : ''}${failed ? ' rv-file--failed' : ''}`}
      data-file-key={fileKey}
    >
      <div className="rv-file__head" onClick={() => onToggle(fileKey)} role="button" tabIndex={-1} aria-expanded={expanded}>
        <span className="rv-file__chev" aria-hidden="true">{expanded ? <IconChevronDown width={13} height={13} /> : <IconChevronRight width={13} height={13} />}</span>
        <span className={`rv-status rv-status--${st.l}`} title={st.label}>{st.l}</span>
        <span className="rv-file__path" title={oldPath ? `${oldPath} → ${path}` : path}>
          {dir && <span className="rv-file__dir">{dir}/</span>}
          <span className="rv-file__base">{baseName(path)}</span>
        </span>
        {unreviewed && <span className="rv-dot rv-dot--unreviewed" title="Not reviewed yet" />}
        {hot && <span className="rv-hot" title={`Review first (heat ${heat})`}>Hot</span>}
        {trivial && <span className="rv-tag">{TRIVIAL_LABEL[trivial]}</span>}
        {pending && <span className="rv-tag rv-tag--live">writing</span>}
        {failed && <span className="rv-tag">failed, no change</span>}
        <span className="rv-file__spacer" />
        <RiskBadges risks={risks} max={2} compact />
        <span className="rv-file__stat rv-num">
          <span className="rv-add">{stat.add}</span> <span className="rv-del">{stat.del}</span>
        </span>
        {headerExtra}
        {ctx?.onViewFile && status !== 'deleted' && (
          <button type="button" className="rv-icon-btn" title="Open file (o)" aria-label="Open file" onClick={(e) => { e.stopPropagation(); ctx.onViewFile?.(absPath); }}>
            <IconOpen width={14} height={14} />
          </button>
        )}
      </div>
      {meta && <div className="rv-file__meta">{meta}</div>}
      {oldPath && expanded && <div className="rv-file__meta">Renamed from {oldPath}</div>}
      {expanded && (
        <div className="rv-file__body">
          {hunksOmitted === 'binary' ? (
            <div className="rv-file__note">Binary file, not shown.</div>
          ) : !hunks && loadState === 'loading' ? (
            <div className="rv-file__note rv-shimmer">Loading diff…</div>
          ) : !hunks && loadState === 'error' ? (
            <div className="rv-file__note rv-file__note--error">Could not load this diff: {loadError}</div>
          ) : !hunks ? (
            <div className="rv-file__note">
              {hunksOmitted === 'too_large' ? 'Too large to show inline.' : hunksOmitted === 'unavailable' ? 'Diff not available.' : 'No diff.'}
            </div>
          ) : hunks.length === 0 ? (
            <div className="rv-file__note">{status === 'mode_changed' ? 'File mode changed, no content change.' : 'No textual changes.'}</div>
          ) : virtual ? (
            <Virtuoso
              ref={virtuoso}
              customScrollParent={scrollParent!}
              data={rows}
              computeItemKey={(_, r) => r.key}
              itemContent={(_, r) => renderRow(r)}
              increaseViewportBy={400}
            />
          ) : (
            rows.map((r) => <div key={r.key}>{renderRow(r)}</div>)
          )}
        </div>
      )}
      {menu && (
        <ContextMenu
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={[
            ...(ctx?.sendToSession ? [{ label: 'Comment on this line', onClick: () => setComposeAt({ hunkId: menu.hunk.id, index: menu.line.index }) }] : []),
            ...(onAsk ? [{ label: 'Ask why', onClick: () => onAsk(menu.hunk, hunkCtx) }] : []),
            ...(onRevertHunk ? [{ label: 'Revert hunk', danger: true, onClick: () => onRevertHunk(menu.hunk, hunkCtx) }] : []),
            null,
            { label: 'Copy line', onClick: () => { void copyToClipboard(menu.line.text); } },
          ] as ContextMenuEntry[]}
        />
      )}
    </div>
  );
});

function CommentComposer({ path, line, onSubmit, onCancel }: { path: string; line: NumberedLine; onSubmit: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const lineNo = line.kind === 'del' ? line.oldNo : line.newNo;
  return (
    <form
      className="rv-composer"
      onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSubmit(text.trim()); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onCancel(); }}
    >
      <span className="rv-composer__where">{baseName(path)}:{lineNo}</span>
      <input
        ref={ref}
        className="rv-composer__input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Comment for Claude…"
        aria-label="Comment"
      />
      <button type="submit" className="rv-btn rv-btn--primary rv-btn--sm" disabled={!text.trim()}>Send</button>
      <button type="button" className="rv-btn rv-btn--ghost rv-btn--sm" onClick={onCancel}>Cancel</button>
    </form>
  );
}
