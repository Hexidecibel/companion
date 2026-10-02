/**
 * Live view: edits as they land, newest first. A started edit shows as
 * "writing", then flips to its final +/- (or failed) in place.
 */
import { useState } from 'react';
import type { LiveEntry } from '../../hooks/useReviewLive';
import { baseName, dirName } from '../../utils/diff/patchText';
import { FileDiff } from './FileDiff';
import { useReviewContext } from './ReviewContext';
import { formatAgo, formatStat, maxLevel } from './format';
import { RiskDot } from './RiskBadge';

export function LiveFeed({ entries, error, now }: { entries: LiveEntry[]; error: string | null; now: number }) {
  const ctx = useReviewContext();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="rv-live" aria-live="polite" data-testid="rv-live">
      <div className="rv-live__head">
        <span className="rv-live-dot" /> Live
        <span className="rv-live__sub">{error ? `Not watching: ${error}` : entries.length ? `${entries.length} edit${entries.length === 1 ? '' : 's'}` : 'Waiting for the next edit…'}</span>
      </div>
      {entries.length > 0 && (
        <ul className="rv-live__list">
          {entries.map(({ edit, phase, at }) => {
            const st = formatStat(edit.additions, edit.deletions);
            const isOpen = open === edit.id;
            return (
              <li key={edit.id} className={`rv-live__row rv-live__row--${phase}`}>
                <button type="button" className="rv-live__btn" onClick={() => setOpen(isOpen ? null : edit.id)} aria-expanded={isOpen}>
                  <span className={`rv-live__phase rv-live__phase--${phase}`} aria-label={phase} />
                  <span className="rv-live__path"><span className="rv-file__dir">{dirName(edit.path) && `${dirName(edit.path)}/`}</span><span className="rv-file__base">{baseName(edit.path)}</span></span>
                  <RiskDot level={maxLevel(edit.risks)} />
                  <span className="rv-live__stat rv-num">
                    {phase === 'started' ? 'writing…' : phase === 'failed' ? 'failed' : <><span className="rv-add">{st.add}</span> <span className="rv-del">{st.del}</span></>}
                  </span>
                  <span className="rv-live__ago">{formatAgo(at, now)}</span>
                </button>
                {isOpen && phase === 'completed' && (
                  <FileDiff
                    fileKey={`live:${edit.id}`}
                    path={edit.path}
                    absPath={edit.absPath}
                    status={edit.kind}
                    additions={edit.additions}
                    deletions={edit.deletions}
                    risks={edit.risks}
                    hunks={edit.hunks}
                    editId={edit.id}
                    expanded
                    onToggle={() => setOpen(null)}
                    onAsk={ctx?.actions?.ask}
                    onRevertHunk={ctx?.actions?.revertHunk}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
