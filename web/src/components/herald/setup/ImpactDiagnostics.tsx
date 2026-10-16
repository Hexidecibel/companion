import { useEffect, useState } from 'react';
import type { ImpactBucket, ImpactFlagId, ImpactReport } from '../../../types/impact';
import type { DiagLevel, DiagSection } from './HeraldDiagnostics';

const REFRESH_MS = 10_000;

interface ImpactTransport {
  isConnected(): boolean;
  request(type: string, payload?: unknown, timeoutMs?: number): Promise<{ success: boolean; payload?: unknown; error?: string }>;
}

const fmt = (n: number | null | undefined, unit: string, digits = 0) =>
  typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(digits)} ${unit}` : 'n/a';

/**
 * The daemon's impact on the machine (Help > Diagnostics > Impact), as rows
 * with a level. Pure, unit tested.
 */
export function impactSections(r: ImpactReport): DiagSection[] {
  const lvl = (id: ImpactFlagId, ok = true): DiagLevel => {
    const f = r.flags.find((x) => x.id === id);
    return f ? f.level : ok ? 'ok' : 'info';
  };
  const daemon = r.current.procs.find((p) => p.name === 'daemon');
  const procRows = r.current.procs
    .filter((p) => p.name !== 'daemon')
    .map((p) => ({ label: p.name, value: `${p.cpuPct.toFixed(1)} % CPU, ${p.rssMb} MB${p.swapMb ? ` (+${p.swapMb} MB swap)` : ''}`, level: 'info' as DiagLevel }));
  const c = r.recent.counters;
  const subs = r.recent.subprocesses.slice(0, 8).map((s) => ({
    label: s.kind,
    value: `${s.perMin}/min, avg ${s.avgMs} ms, p95 ${s.p95Ms} ms${s.timeouts ? `, ${s.timeouts} timeout${s.timeouts === 1 ? '' : 's'}` : ''}`,
    level: (s.timeouts ? 'bad' : s.p95Ms > 500 ? 'warn' : 'info') as DiagLevel,
  }));
  return [
    {
      title: 'Impact',
      rows: [
        ...(r.flags.length
          ? r.flags.map((f) => ({ label: 'Attention', value: f.message, level: f.level as DiagLevel }))
          : [{ label: 'Status', value: 'within all thresholds', level: 'ok' as DiagLevel }]),
        { label: 'Daemon CPU', value: `${fmt(daemon?.cpuPct, '%', 1)} now, ${fmt(r.recent.cpuAvgPct, '%', 1)} over ${Math.round(r.recent.minutes)} min`, level: lvl('daemon_cpu') },
        { label: 'Daemon memory', value: daemon ? `${daemon.rssMb} MB${daemon.swapMb ? ` (+${daemon.swapMb} MB swap)` : ''}` : 'n/a', level: 'info' },
        { label: 'Event-loop lag', value: `p99 ${fmt(r.current.loop.p99Ms, 'ms', 1)} now, ${fmt(r.recent.loopP99Ms, 'ms', 1)} worst 10 min (max ${fmt(r.recent.loopMaxMs, 'ms')})`, level: lvl('loop_lag') },
        { label: 'tmux answers in', value: `${fmt(r.current.tmuxProbe.lastMs, 'ms', 1)} (avg ${fmt(r.current.tmuxProbe.avgMs, 'ms', 1)}, max ${fmt(r.current.tmuxProbe.maxMs, 'ms')})`, level: lvl('tmux_slow') },
        { label: 'Subprocesses', value: `${r.recent.subCallsPerMin}/min (${r.current.inFlight} running)`, level: lvl('sub_timeout') },
        { label: 'Swap', value: r.current.swap ? `${r.current.swap.usedPct} % of ${r.current.swap.totalMb} MB used` : 'none', level: lvl('swap', false) },
        { label: 'Transcript reads', value: `${c.transcriptParses} in 10 min (${c.transcriptFullParses} full), ${Math.round(c.transcriptParseBytes / 1024)} KB, ${c.transcriptParseMs} ms`, level: 'info' },
        { label: 'Log lines', value: `${Math.round(c.logLines / Math.max(1, r.recent.minutes))}/min`, level: 'info' },
        { label: 'Typing collisions (24 h)', value: String(r.day.counters.inputCollisions), level: lvl('typing_collision') },
        ...(r.day.counters.gitIndexLockErrors ? [{ label: 'git index.lock errors (24 h)', value: String(r.day.counters.gitIndexLockErrors), level: 'warn' as DiagLevel }] : []),
        ...procRows,
      ],
    },
    { title: 'Subprocesses (last 10 min)', rows: subs.length ? subs : [{ label: 'none', value: 'no subprocesses', level: 'info' }] },
  ];
}

/** Points for a tiny sparkline: [0..1] per bucket, null gaps preserved. */
export function sparkPoints(history: ImpactBucket[], pick: (b: ImpactBucket) => number | null): Array<number | null> {
  const vals = history.map(pick);
  const max = Math.max(1e-9, ...vals.filter((v): v is number => typeof v === 'number'));
  return vals.map((v) => (typeof v === 'number' ? v / max : null));
}

function Sparkline({ label, history, pick, unit }: { label: string; history: ImpactBucket[]; pick: (b: ImpactBucket) => number | null; unit: string }) {
  const pts = sparkPoints(history, pick);
  const vals = history.map(pick).filter((v): v is number => typeof v === 'number');
  const w = 240;
  const h = 28;
  const step = pts.length > 1 ? w / (pts.length - 1) : w;
  let d = '';
  pts.forEach((p, i) => {
    if (p === null) return;
    d += `${d && pts[i - 1] !== null ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - 2 - p * (h - 4)).toFixed(1)}`;
  });
  const peak = vals.length ? Math.max(...vals) : null;
  return (
    <div className="hh-defs__row hd-row hd-row--info">
      <dt>{label}</dt>
      <dd>
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}, 24 h`} style={{ display: 'block', maxWidth: '100%' }}>
          <path d={d} fill="none" stroke="#3b82f6" strokeWidth={1.5} />
        </svg>
        <span className="hd-val">peak {peak === null ? 'n/a' : `${peak.toFixed(1)} ${unit}`}</span>
      </dd>
    </div>
  );
}

/** Help > Diagnostics > Impact: fetched on open, refreshed every 10 s while open. */
export function ImpactDiagnostics({ getTransport }: { getTransport: () => ImpactTransport | null | undefined }) {
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const t = getTransport();
      if (!t || !t.isConnected()) {
        setError('not connected');
        return;
      }
      try {
        const res = await t.request('get_impact', {}, 8000);
        if (stopped) return;
        if (res.success && res.payload) {
          setReport(res.payload as ImpactReport);
          setError(null);
        } else setError(res.error || 'this daemon does not report impact yet');
      } catch (err) {
        if (!stopped) setError((err as Error)?.message || 'no answer');
      }
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [getTransport]);

  if (!report) {
    return (
      <section className="hh-sec">
        <h3 className="hh-sec__title">Impact</h3>
        <p className="hh-p">{error ? `Impact: ${error}` : 'Loading…'}</p>
      </section>
    );
  }
  return (
    <>
      {impactSections(report).map((sec) => (
        <section key={sec.title} className="hh-sec">
          <h3 className="hh-sec__title">{sec.title}</h3>
          <dl className="hh-defs hd-rows">
            {sec.rows.map((r, i) => (
              <div key={`${r.label}-${i}`} className={`hh-defs__row hd-row hd-row--${r.level}`}>
                <dt>{r.label}</dt>
                <dd><span className="hd-val">{r.value}</span></dd>
              </div>
            ))}
            {sec.title === 'Impact' && report.history.length > 1 && (
              <>
                <Sparkline label="CPU, 24 h" history={report.history} pick={(b) => b.cpuPct} unit="%" />
                <Sparkline label="Loop lag p99, 24 h" history={report.history} pick={(b) => b.loopP99Ms} unit="ms" />
                <Sparkline label="Subprocesses, 24 h" history={report.history} pick={(b) => b.subCalls / b.spanMin} unit="/min" />
              </>
            )}
          </dl>
        </section>
      ))}
    </>
  );
}
