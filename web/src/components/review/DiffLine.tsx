import { memo } from 'react';
import type { Segment } from '../../utils/diff/highlight';
import type { NumberedLine } from '../../utils/diff/patchText';

interface DiffLineProps {
  line: NumberedLine;
  segments?: Segment[];
  hasComments?: boolean;
  onMenu?: (e: React.MouseEvent | React.KeyboardEvent, line: NumberedLine) => void;
}

const SIGN: Record<NumberedLine['kind'], string> = { add: '+', del: '−', ctx: ' ', meta: ' ' };

/** One diff row: old/new gutters, sign, code. Right-click or gutter tap opens the line menu. */
export const DiffLine = memo(function DiffLine({ line, segments, hasComments, onMenu }: DiffLineProps) {
  const body = segments
    ? segments.map((s, i) => {
      const cls = [s.cls, s.mark ? 'rv-word' : ''].filter(Boolean).join(' ');
      return cls ? <span key={i} className={cls}>{s.text}</span> : s.text;
    })
    : line.text;
  return (
    <div
      className={`rv-line rv-line--${line.kind}${hasComments ? ' rv-line--commented' : ''}`}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e, line); } : undefined}
    >
      <button
        type="button"
        className="rv-gutter"
        tabIndex={-1}
        onClick={onMenu ? (e) => onMenu(e, line) : undefined}
        aria-label={`Line ${line.newNo ?? line.oldNo ?? ''} actions`}
      >
        <span className="rv-gutter__old">{line.oldNo ?? ''}</span>
        <span className="rv-gutter__new">{line.newNo ?? ''}</span>
      </button>
      <span className="rv-sign" aria-hidden="true">{SIGN[line.kind]}</span>
      <span className={`rv-code${line.kind === 'meta' ? ' rv-code--meta' : ''}`}>{body}{(segments ? segments.length === 0 : line.text === '') ? '\u200b' : null}</span>
    </div>
  );
});
