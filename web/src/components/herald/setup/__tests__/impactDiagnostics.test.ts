import { describe, expect, it } from 'vitest';
import { impactSections, sparkPoints } from '../ImpactDiagnostics';
import type { ImpactReport, ImpactWindow } from '../../../../types/impact';

const win = (over: Partial<ImpactWindow> = {}): ImpactWindow => ({
  minutes: 10,
  subprocesses: [{ kind: 'tmux:list-panes@snapshot', count: 120, perMin: 12, avgMs: 4, p95Ms: 10, maxMs: 30, timeouts: 0, failures: 0, inFlightPeak: 1 }],
  subCallsPerMin: 12,
  counters: { transcriptParses: 30, transcriptParseBytes: 40960, transcriptParseMs: 12, transcriptFullParses: 2, gitIndexLockErrors: 0, inputCollisions: 0, logLines: 300 },
  loopP99Ms: 12,
  loopMaxMs: 40,
  cpuAvgPct: 1.5,
  ...over,
});

const report = (over: Partial<ImpactReport> = {}): ImpactReport => ({
  version: 1,
  generatedAt: 0,
  startedAt: 0,
  sandbox: false,
  current: {
    loop: { p50Ms: 1, p99Ms: 10, maxMs: 20 },
    procs: [
      { name: 'daemon', pids: [1], cpuPct: 1.2, rssMb: 120, swapMb: 0 },
      { name: 'tmux', pids: [2], cpuPct: 0.3, rssMb: 9, swapMb: 0 },
    ],
    swap: { totalMb: 4096, freeMb: 2048, usedPct: 50 },
    tmuxProbe: { lastMs: 4, avgMs: 5, maxMs: 9, failures: 0 },
    inFlight: 0,
  },
  recent: win(),
  day: win(),
  history: [],
  flags: [],
  ...over,
});

const row = (r: ImpactReport, label: string) => impactSections(r)[0].rows.find((x) => x.label === label)!;

describe('impactSections', () => {
  it('healthy: says so, all ok', () => {
    const r = report();
    expect(row(r, 'Status').value).toBe('within all thresholds');
    expect(row(r, 'Daemon CPU').level).toBe('ok');
    expect(row(r, 'Log lines').value).toBe('30/min');
    expect(impactSections(r)[1].rows[0].label).toBe('tmux:list-panes@snapshot');
    expect(impactSections(r)[0].rows.some((x) => x.label === 'tmux')).toBe(true);
  });

  it('flags drive the row levels and the attention lines', () => {
    const r = report({
      flags: [
        { id: 'daemon_cpu', level: 'warn', message: 'Daemon CPU 14 %' },
        { id: 'sub_timeout', level: 'bad', message: '2 subprocess timeouts' },
      ],
    });
    expect(row(r, 'Daemon CPU').level).toBe('warn');
    expect(row(r, 'Subprocesses').level).toBe('bad');
    expect(impactSections(r)[0].rows.filter((x) => x.label === 'Attention')).toHaveLength(2);
  });

  it('sparkPoints normalises and keeps gaps', () => {
    const h = [
      { t: 0, spanMin: 10, cpuPct: 2, rssMb: 1, loopP99Ms: null, loopMaxMs: null, subCalls: 0, subTimeouts: 0, tmuxProbeMs: null, logLines: 0, parses: 0 },
      { t: 1, spanMin: 10, cpuPct: null, rssMb: 1, loopP99Ms: null, loopMaxMs: null, subCalls: 0, subTimeouts: 0, tmuxProbeMs: null, logLines: 0, parses: 0 },
      { t: 2, spanMin: 10, cpuPct: 4, rssMb: 1, loopP99Ms: null, loopMaxMs: null, subCalls: 0, subTimeouts: 0, tmuxProbeMs: null, logLines: 0, parses: 0 },
    ];
    expect(sparkPoints(h, (b) => b.cpuPct)).toEqual([0.5, null, 1]);
  });
});
