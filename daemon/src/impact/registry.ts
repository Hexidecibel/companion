/**
 * In-memory impact metrics: one bucket per minute, 24 h kept (a ring), plus the
 * latest process / swap / tmux-probe samples. Pure bookkeeping, no I/O except
 * the explicit save()/load() (persistence lives in ~/.companion/impact.json).
 *
 * Everything recorded here is cheap: a few additions per event. The hot path
 * (recordSub) is called once per subprocess.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  IMPACT_THRESHOLDS,
  ImpactBucket,
  ImpactCounters,
  ImpactFlag,
  ImpactProcSample,
  ImpactReport,
  ImpactSubStats,
  ImpactWindow,
} from './protocol';

/** Upper edges (ms) of the duration histogram; the last slot is "> 5000". */
export const HIST_EDGES_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const MINUTE = 60_000;
export const KEEP_MINUTES = 24 * 60;
const HISTORY_SPAN_MIN = 10;

export type CounterName = keyof ImpactCounters;

interface SubAcc {
  n: number;
  ms: number;
  max: number;
  to: number;
  fail: number;
  peak: number;
  h: number[];
}

export interface MinuteBucket {
  t: number;
  sub: Record<string, SubAcc>;
  cpuSum: number;
  cpuN: number;
  rssMb: number | null;
  loopP50: number | null;
  loopP99: number | null;
  loopMax: number | null;
  probeSum: number;
  probeN: number;
  probeMax: number | null;
  probeFail: number;
  c: Partial<Record<CounterName, number>>;
}

function emptyMinute(t: number): MinuteBucket {
  return {
    t,
    sub: {},
    cpuSum: 0,
    cpuN: 0,
    rssMb: null,
    loopP50: null,
    loopP99: null,
    loopMax: null,
    probeSum: 0,
    probeN: 0,
    probeMax: null,
    probeFail: 0,
    c: {},
  };
}

function emptyCounters(): ImpactCounters {
  return {
    transcriptParses: 0,
    transcriptParseBytes: 0,
    transcriptParseMs: 0,
    transcriptFullParses: 0,
    gitIndexLockErrors: 0,
    inputCollisions: 0,
    logLines: 0,
  };
}

function histSlot(ms: number): number {
  for (let i = 0; i < HIST_EDGES_MS.length; i++) if (ms <= HIST_EDGES_MS[i]) return i;
  return HIST_EDGES_MS.length;
}

/** Upper edge of the slot holding the q-quantile (the slot past 5 s reports the max). */
export function histQuantile(h: number[], q: number, max: number): number {
  const total = h.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const want = Math.ceil(total * q);
  let seen = 0;
  for (let i = 0; i < h.length; i++) {
    seen += h[i];
    if (seen >= want) return i < HIST_EDGES_MS.length ? Math.min(HIST_EDGES_MS[i], max) : max;
  }
  return max;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const maxOrNull = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

export interface RegistryOptions {
  now?: () => number;
  sandbox?: boolean;
}

export class ImpactRegistry {
  private now: () => number;
  private sandbox: boolean;
  readonly startedAt: number;
  private ring: MinuteBucket[] = [];
  private cur: MinuteBucket;
  private inFlight = new Map<string, number>();
  private totalInFlight = 0;
  private procs: ImpactProcSample[] = [];
  private swap: ImpactReport['current']['swap'] = null;
  private loopNow: ImpactReport['current']['loop'] = { p50Ms: null, p99Ms: null, maxMs: null };
  private probeLast: number | null = null;

  constructor(opts: RegistryOptions = {}) {
    this.now = opts.now || Date.now;
    this.sandbox = !!opts.sandbox;
    this.startedAt = this.now();
    this.cur = emptyMinute(this.minuteOf(this.startedAt));
  }

  private minuteOf(ms: number): number {
    return Math.floor(ms / MINUTE) * MINUTE;
  }

  /** Close the current minute when the clock moved past it. */
  private roll(): MinuteBucket {
    const m = this.minuteOf(this.now());
    if (m !== this.cur.t) {
      this.ring.push(this.cur);
      const cutoff = m - KEEP_MINUTES * MINUTE;
      while (this.ring.length && this.ring[0].t < cutoff) this.ring.shift();
      this.cur = emptyMinute(m);
    }
    return this.cur;
  }

  // ---- recording -------------------------------------------------------

  subStart(kind: string): void {
    const n = (this.inFlight.get(kind) || 0) + 1;
    this.inFlight.set(kind, n);
    this.totalInFlight++;
    const acc = this.acc(kind);
    if (n > acc.peak) acc.peak = n;
  }

  subEnd(kind: string, ms: number, o: { timedOut?: boolean; failed?: boolean } = {}): void {
    const n = Math.max(0, (this.inFlight.get(kind) || 0) - 1);
    if (n === 0) this.inFlight.delete(kind);
    else this.inFlight.set(kind, n);
    this.totalInFlight = Math.max(0, this.totalInFlight - 1);
    this.recordSub(kind, ms, o);
  }

  /** One finished subprocess (use subStart/subEnd to also track concurrency). */
  recordSub(kind: string, ms: number, o: { timedOut?: boolean; failed?: boolean } = {}): void {
    const acc = this.acc(kind);
    acc.n++;
    acc.ms += ms;
    if (ms > acc.max) acc.max = ms;
    if (o.timedOut) acc.to++;
    else if (o.failed) acc.fail++;
    acc.h[histSlot(ms)]++;
    if (acc.peak === 0) acc.peak = 1;
  }

  private acc(kind: string): SubAcc {
    const b = this.roll();
    let a = b.sub[kind];
    if (!a) {
      a = {
        n: 0,
        ms: 0,
        max: 0,
        to: 0,
        fail: 0,
        peak: 0,
        h: new Array(HIST_EDGES_MS.length + 1).fill(0),
      };
      b.sub[kind] = a;
    }
    return a;
  }

  count(name: CounterName, by = 1): void {
    const b = this.roll();
    b.c[name] = (b.c[name] || 0) + by;
  }

  recordTranscriptParse(bytes: number, ms: number, full: boolean): void {
    const b = this.roll();
    b.c.transcriptParses = (b.c.transcriptParses || 0) + 1;
    b.c.transcriptParseBytes = (b.c.transcriptParseBytes || 0) + bytes;
    b.c.transcriptParseMs = (b.c.transcriptParseMs || 0) + ms;
    if (full) b.c.transcriptFullParses = (b.c.transcriptFullParses || 0) + 1;
  }

  /** A sampler tick: daemon CPU (% of one core) and RSS. */
  recordSelf(cpuPct: number, rssMb: number): void {
    const b = this.roll();
    b.cpuSum += cpuPct;
    b.cpuN++;
    b.rssMb = rssMb;
  }

  recordLoop(p50: number, p99: number, max: number): void {
    const b = this.roll();
    this.loopNow = { p50Ms: round1(p50), p99Ms: round1(p99), maxMs: round1(max) };
    b.loopP50 = p50;
    b.loopP99 = maxOrNull(b.loopP99, p99);
    b.loopMax = maxOrNull(b.loopMax, max);
  }

  recordProbe(ms: number | null): void {
    const b = this.roll();
    this.probeLast = ms;
    if (ms === null) {
      b.probeFail++;
      return;
    }
    b.probeSum += ms;
    b.probeN++;
    b.probeMax = maxOrNull(b.probeMax, ms);
  }

  setProcs(procs: ImpactProcSample[]): void {
    this.procs = procs;
  }

  setSwap(totalMb: number, freeMb: number): void {
    this.swap =
      totalMb > 0
        ? {
            totalMb: Math.round(totalMb),
            freeMb: Math.round(freeMb),
            usedPct: round1(((totalMb - freeMb) / totalMb) * 100),
          }
        : null;
  }

  // ---- reading ---------------------------------------------------------

  private buckets(sinceMs: number): MinuteBucket[] {
    this.roll();
    return [...this.ring, this.cur].filter((b) => b.t >= sinceMs);
  }

  private window(minutes: number): ImpactWindow {
    const now = this.now();
    const since = this.minuteOf(now) - (minutes - 1) * MINUTE;
    const list = this.buckets(since);
    // Minutes actually covered (the daemon may have been down part of the window).
    const covered = Math.max(1, list.length - 1 + (now - this.cur.t) / MINUTE);
    const kinds = new Map<string, SubAcc>();
    const counters = emptyCounters();
    let loopP99: number | null = null;
    let loopMax: number | null = null;
    let cpuSum = 0;
    let cpuN = 0;
    for (const b of list) {
      for (const [k, a] of Object.entries(b.sub)) {
        let m = kinds.get(k);
        if (!m) {
          m = {
            n: 0,
            ms: 0,
            max: 0,
            to: 0,
            fail: 0,
            peak: 0,
            h: new Array(HIST_EDGES_MS.length + 1).fill(0),
          };
          kinds.set(k, m);
        }
        m.n += a.n;
        m.ms += a.ms;
        m.max = Math.max(m.max, a.max);
        m.to += a.to;
        m.fail += a.fail;
        m.peak = Math.max(m.peak, a.peak);
        for (let i = 0; i < m.h.length; i++) m.h[i] += a.h[i] || 0;
      }
      for (const [k, v] of Object.entries(b.c)) counters[k as CounterName] += v || 0;
      loopP99 = maxOrNull(loopP99, b.loopP99);
      loopMax = maxOrNull(loopMax, b.loopMax);
      cpuSum += b.cpuSum;
      cpuN += b.cpuN;
    }
    const subprocesses: ImpactSubStats[] = [...kinds.entries()]
      .map(([kind, a]) => ({
        kind,
        count: a.n,
        perMin: round1(a.n / covered),
        avgMs: a.n ? round1(a.ms / a.n) : 0,
        p95Ms: round1(histQuantile(a.h, 0.95, a.max)),
        maxMs: round1(a.max),
        timeouts: a.to,
        failures: a.fail,
        inFlightPeak: a.peak,
      }))
      .sort((x, y) => y.count - x.count);
    const total = subprocesses.reduce((s, x) => s + x.count, 0);
    counters.transcriptParseMs = Math.round(counters.transcriptParseMs);
    return {
      minutes: round1(covered),
      subprocesses,
      subCallsPerMin: round1(total / covered),
      counters,
      loopP99Ms: loopP99 === null ? null : round1(loopP99),
      loopMaxMs: loopMax === null ? null : round1(loopMax),
      cpuAvgPct: cpuN ? round1(cpuSum / cpuN) : null,
    };
  }

  private history(): ImpactBucket[] {
    const now = this.now();
    const span = HISTORY_SPAN_MIN * MINUTE;
    const out = new Map<
      number,
      ImpactBucket & { _cpuN: number; _cpuSum: number; _pN: number; _pSum: number }
    >();
    for (const b of this.buckets(now - KEEP_MINUTES * MINUTE)) {
      const t = Math.floor(b.t / span) * span;
      let h = out.get(t);
      if (!h) {
        h = {
          t,
          spanMin: HISTORY_SPAN_MIN,
          cpuPct: null,
          rssMb: null,
          loopP99Ms: null,
          loopMaxMs: null,
          subCalls: 0,
          subTimeouts: 0,
          tmuxProbeMs: null,
          logLines: 0,
          parses: 0,
          _cpuN: 0,
          _cpuSum: 0,
          _pN: 0,
          _pSum: 0,
        };
        out.set(t, h);
      }
      h._cpuN += b.cpuN;
      h._cpuSum += b.cpuSum;
      h._pN += b.probeN;
      h._pSum += b.probeSum;
      if (b.rssMb !== null) h.rssMb = b.rssMb;
      h.loopP99Ms = maxOrNull(h.loopP99Ms, b.loopP99);
      h.loopMaxMs = maxOrNull(h.loopMaxMs, b.loopMax);
      for (const a of Object.values(b.sub)) {
        h.subCalls += a.n;
        h.subTimeouts += a.to;
      }
      h.logLines += b.c.logLines || 0;
      h.parses += b.c.transcriptParses || 0;
    }
    return [...out.values()]
      .sort((a, b) => a.t - b.t)
      .map(({ _cpuN, _cpuSum, _pN, _pSum, ...h }) => ({
        ...h,
        cpuPct: _cpuN ? round1(_cpuSum / _cpuN) : null,
        tmuxProbeMs: _pN ? round1(_pSum / _pN) : null,
        loopP99Ms: h.loopP99Ms === null ? null : round1(h.loopP99Ms),
        loopMaxMs: h.loopMaxMs === null ? null : round1(h.loopMaxMs),
      }));
  }

  report(): ImpactReport {
    const recent = this.window(10);
    const day = this.window(KEEP_MINUTES);
    const recentBuckets = this.buckets(this.minuteOf(this.now()) - 9 * MINUTE);
    let pN = 0;
    let pSum = 0;
    let pMax: number | null = null;
    let pFail = 0;
    for (const b of recentBuckets) {
      pN += b.probeN;
      pSum += b.probeSum;
      pMax = maxOrNull(pMax, b.probeMax);
      pFail += b.probeFail;
    }
    const current: ImpactReport['current'] = {
      loop: this.loopNow,
      procs: this.procs,
      swap: this.swap,
      tmuxProbe: {
        lastMs: this.probeLast === null ? null : round1(this.probeLast),
        avgMs: pN ? round1(pSum / pN) : null,
        maxMs: pMax === null ? null : round1(pMax),
        failures: pFail,
      },
      inFlight: this.totalInFlight,
    };
    return {
      version: 1,
      generatedAt: this.now(),
      startedAt: this.startedAt,
      sandbox: this.sandbox,
      current,
      recent,
      day,
      history: this.history(),
      flags: computeFlags(current, recent, day),
    };
  }

  // ---- persistence -----------------------------------------------------

  serialize(): string {
    this.roll();
    return JSON.stringify({ version: 1, savedAt: this.now(), minutes: [...this.ring, this.cur] });
  }

  save(file: string): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, this.serialize(), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      console.log(`Impact: could not save ${file}: ${err}`);
    }
  }

  /** Merge buckets saved by an earlier run (only minutes before ours, within 24 h). */
  load(file: string): number {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return 0;
    }
    const minutes = (raw as { minutes?: unknown })?.minutes;
    if (!Array.isArray(minutes)) return 0;
    const cutoff = this.minuteOf(this.now()) - KEEP_MINUTES * MINUTE;
    const known = new Set(this.ring.map((b) => b.t));
    const valid: MinuteBucket[] = [];
    for (const m of minutes as MinuteBucket[]) {
      if (!m || typeof m.t !== 'number' || m.t < cutoff || m.t >= this.cur.t || known.has(m.t))
        continue;
      if (typeof m.sub !== 'object' || m.sub === null) continue;
      valid.push({ ...emptyMinute(m.t), ...m, c: { ...(m.c || {}) } });
    }
    this.ring = [...valid, ...this.ring].sort((a, b) => a.t - b.t);
    return valid.length;
  }
}

export function computeFlags(
  current: ImpactReport['current'],
  recent: ImpactWindow,
  day: ImpactWindow
): ImpactFlag[] {
  const T = IMPACT_THRESHOLDS;
  const flags: ImpactFlag[] = [];
  const loop = recent.loopP99Ms;
  if (loop !== null && loop > T.loopP99Ms)
    flags.push({
      id: 'loop_lag',
      level: loop > T.loopP99Ms * 5 ? 'bad' : 'warn',
      message: `Event-loop lag p99 ${Math.round(loop)} ms in the last 10 min (over ${T.loopP99Ms} ms)`,
    });
  const daemon = current.procs.find((p) => p.name === 'daemon');
  const cpu = recent.cpuAvgPct ?? daemon?.cpuPct ?? null;
  if (cpu !== null && cpu > T.daemonCpuPct)
    flags.push({
      id: 'daemon_cpu',
      level: cpu > T.daemonCpuPct * 2.5 ? 'bad' : 'warn',
      message: `Daemon CPU ${cpu.toFixed(1)} % of a core over the last 10 min (over ${T.daemonCpuPct} %)`,
    });
  const probe = current.tmuxProbe;
  const probeMs = probe.avgMs ?? probe.lastMs;
  if (probe.failures > 0)
    flags.push({
      id: 'tmux_slow',
      level: 'bad',
      message: `tmux did not answer ${probe.failures} probe(s) in the last 10 min`,
    });
  else if (probeMs !== null && probeMs > T.tmuxProbeMs)
    flags.push({
      id: 'tmux_slow',
      level: 'warn',
      message: `tmux answers in ${Math.round(probeMs)} ms on average (over ${T.tmuxProbeMs} ms)`,
    });
  const toRecent = recent.subprocesses.reduce((s, x) => s + x.timeouts, 0);
  const toDay = day.subprocesses.reduce((s, x) => s + x.timeouts, 0);
  if (toDay > 0) {
    const worst = day.subprocesses
      .filter((x) => x.timeouts > 0)
      .map((x) => `${x.kind} ${x.timeouts}`);
    flags.push({
      id: 'sub_timeout',
      level: toRecent > 0 ? 'bad' : 'warn',
      message: `${toDay} subprocess timeout(s) in 24 h (${toRecent} in the last 10 min): ${worst.slice(0, 3).join(', ')}`,
    });
  }
  if (current.swap && current.swap.usedPct > T.swapUsedPct)
    flags.push({
      id: 'swap',
      level: 'warn',
      message: `Swap ${current.swap.usedPct} % used (over ${T.swapUsedPct} %)`,
    });
  if (day.counters.inputCollisions > 0)
    flags.push({
      id: 'typing_collision',
      level: 'warn',
      message: `${day.counters.inputCollisions} input injection(s) collided with typing in 24 h`,
    });
  return flags;
}
