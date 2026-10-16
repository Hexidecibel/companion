// --- impact protocol v1 ---
// Mirrored byte-for-byte: daemon/src/impact/protocol.ts <-> web/src/types/impact.ts. No imports.

/**
 * What Companion costs the machine it runs on (CPU, memory, event-loop lag,
 * subprocesses, tmux responsiveness). Request `get_impact` (no payload) answers
 * with an `ImpactReport`.
 */

/** Subprocess statistics for one kind (e.g. "tmux:capture-pane", "git"). */
export interface ImpactSubStats {
  kind: string;
  count: number;
  /** Calls per minute over the window. */
  perMin: number;
  avgMs: number;
  /** From a fixed-bucket histogram: an upper bound, not exact. */
  p95Ms: number;
  maxMs: number;
  timeouts: number;
  failures: number;
  /** Most of this kind running at the same time. */
  inFlightPeak: number;
}

export type ImpactProcName = 'daemon' | 'herald-voice' | 'tmux' | 'mcp';

export interface ImpactProcSample {
  name: ImpactProcName;
  pids: number[];
  /** Percent of ONE core over the last sample interval (summed over pids). */
  cpuPct: number;
  rssMb: number;
  swapMb: number;
}

export interface ImpactCounters {
  transcriptParses: number;
  transcriptParseBytes: number;
  transcriptParseMs: number;
  /** Parses that re-read a whole file (first load, truncation, rewrite). */
  transcriptFullParses: number;
  gitIndexLockErrors: number;
  /** Input injection that ran into the user typing at the same time (batch B). */
  inputCollisions: number;
  logLines: number;
}

/** One time bucket of history (`spanMin` minutes). */
export interface ImpactBucket {
  t: number;
  spanMin: number;
  /** Daemon CPU, percent of one core (average over the bucket). */
  cpuPct: number | null;
  rssMb: number | null;
  loopP99Ms: number | null;
  loopMaxMs: number | null;
  subCalls: number;
  subTimeouts: number;
  tmuxProbeMs: number | null;
  logLines: number;
  parses: number;
}

export type ImpactFlagId =
  | 'loop_lag'
  | 'daemon_cpu'
  | 'tmux_slow'
  | 'sub_timeout'
  | 'swap'
  | 'typing_collision';

export interface ImpactFlag {
  id: ImpactFlagId;
  level: 'warn' | 'bad';
  message: string;
}

export interface ImpactWindow {
  minutes: number;
  subprocesses: ImpactSubStats[];
  subCallsPerMin: number;
  counters: ImpactCounters;
  loopP99Ms: number | null;
  loopMaxMs: number | null;
  cpuAvgPct: number | null;
}

export interface ImpactReport {
  version: 1;
  generatedAt: number;
  startedAt: number;
  sandbox: boolean;
  current: {
    loop: { p50Ms: number | null; p99Ms: number | null; maxMs: number | null };
    procs: ImpactProcSample[];
    swap: { totalMb: number; freeMb: number; usedPct: number } | null;
    tmuxProbe: {
      lastMs: number | null;
      avgMs: number | null;
      maxMs: number | null;
      failures: number;
    };
    inFlight: number;
  };
  /** The last 10 minutes. */
  recent: ImpactWindow;
  /** Everything kept (up to 24 h, survives restarts). */
  day: ImpactWindow;
  /** Up to 24 h of history, oldest first, in buckets of `spanMin` minutes. */
  history: ImpactBucket[];
  flags: ImpactFlag[];
}

export const IMPACT_THRESHOLDS = {
  loopP99Ms: 100,
  daemonCpuPct: 10,
  tmuxProbeMs: 50,
  swapUsedPct: 90,
} as const;
// --- end impact protocol ---
