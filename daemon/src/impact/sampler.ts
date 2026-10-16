/**
 * Cheap periodic sampling for the impact report:
 *   - every 10 s: CPU (utime+stime deltas) and RSS/swap from /proc for the
 *     daemon, the herald-voice service, the tmux server and companion MCP node
 *     processes, plus system swap; event-loop delay p50/p99/max
 *     (perf_hooks.monitorEventLoopDelay, reset per sample)
 *   - every 30 s: one timed `tmux display-message -p '#{pid}'` (deduped, 2 s
 *     SIGKILL timeout); its answer is also the tmux server pid
 *   - every 60 s: re-discover the voice / MCP pids (one /proc scan)
 *   - hourly + on shutdown: save to ~/.companion/impact.json
 * Async fs only; every timer is unref'd and each tick is guarded against overlap.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { monitorEventLoopDelay, IntervalHistogram } from 'perf_hooks';
import { impact } from './state';
import { trySub } from './sub';
import { ImpactProcName, ImpactProcSample } from './protocol';

const SAMPLE_MS = 10_000;
const PROBE_MS = 30_000;
const DISCOVER_MS = 60_000;
const SAVE_MS = 60 * 60_000;
const CLK_TCK = 100; // USER_HZ on Linux

export function impactFilePath(): string {
  return process.env.COMPANION_IMPACT_FILE || path.join(os.homedir(), '.companion', 'impact.json');
}

interface ProcStat {
  ticks: number;
  rssKb: number;
  swapKb: number;
}

export async function readProcStat(
  pid: number | 'self',
  procRoot = '/proc'
): Promise<ProcStat | null> {
  try {
    const [stat, status] = await Promise.all([
      fs.promises.readFile(path.join(procRoot, String(pid), 'stat'), 'utf-8'),
      fs.promises.readFile(path.join(procRoot, String(pid), 'status'), 'utf-8'),
    ]);
    // comm (field 2) may hold spaces/parens: split after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(rest[11]) + Number(rest[12]); // utime + stime (fields 14, 15)
    const kb = (key: string) =>
      Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(status)?.[1] || 0);
    if (!Number.isFinite(ticks)) return null;
    return { ticks, rssKb: kb('VmRSS'), swapKb: kb('VmSwap') };
  } catch {
    return null;
  }
}

export async function readSwap(
  procRoot = '/proc'
): Promise<{ totalMb: number; freeMb: number } | null> {
  try {
    const mem = await fs.promises.readFile(path.join(procRoot, 'meminfo'), 'utf-8');
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(mem)?.[1] || 0);
    return { totalMb: kb('SwapTotal') / 1024, freeMb: kb('SwapFree') / 1024 };
  } catch {
    return null;
  }
}

/** Which watched group a command line belongs to (null = not ours). */
export function classifyCmdline(argv: string[]): ImpactProcName | null {
  const joined = argv.join(' ');
  if (/herald_voice|herald-voice/.test(joined) && /python|herald/.test(argv[0] || ''))
    return 'herald-voice';
  if (
    /companion\/mcp\/dist\/index\.js|companion-remote/.test(joined) &&
    /node/.test(path.basename(argv[0] || ''))
  )
    return 'mcp';
  return null;
}

/** One /proc scan for the voice service and MCP processes (own uid only). */
export async function discoverPids(procRoot = '/proc'): Promise<Map<ImpactProcName, number[]>> {
  const out = new Map<ImpactProcName, number[]>();
  let names: string[];
  try {
    names = await fs.promises.readdir(procRoot);
  } catch {
    return out;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  for (const n of names) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try {
      if (uid >= 0) {
        const st = await fs.promises.stat(path.join(procRoot, n));
        if (st.uid !== uid) continue;
      }
      const raw = await fs.promises.readFile(path.join(procRoot, n, 'cmdline'), 'utf-8');
      const kind = classifyCmdline(raw.split('\0').filter(Boolean));
      if (kind) out.set(kind, [...(out.get(kind) || []), Number(n)]);
    } catch {
      /* gone, or not ours */
    }
  }
  return out;
}

export class ImpactSampler {
  private timers: NodeJS.Timeout[] = [];
  private loop: IntervalHistogram | null = null;
  private lastTicks = new Map<number | 'self', { ticks: number; at: number }>();
  private pids = new Map<ImpactProcName, number[]>();
  private tmuxPid: number | null = null;
  private sampling = false;
  private probing = false;
  private discovering = false;

  start(): void {
    try {
      this.loop = monitorEventLoopDelay({ resolution: 20 });
      this.loop.enable();
    } catch {
      this.loop = null;
    }
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(SAMPLE_MS, () => void this.sample());
    every(PROBE_MS, () => void this.probe());
    every(DISCOVER_MS, () => void this.discover());
    every(SAVE_MS, () => impact.save(impactFilePath()));
    void this.discover();
    void this.probe();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.loop?.disable();
  }

  private async discover(): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    try {
      this.pids = await discoverPids();
    } finally {
      this.discovering = false;
    }
  }

  async probe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const t0 = performance.now();
      const r = await trySub('tmux:probe', 'tmux', ['display-message', '-p', '#{pid}'], {
        timeoutMs: 2000,
      });
      const ms = performance.now() - t0;
      if (r.error) {
        // No tmux server at all is not a slow tmux.
        if (!/no server running|error connecting|No such file/i.test(r.stderr))
          impact.recordProbe(null);
        this.tmuxPid = null;
      } else {
        impact.recordProbe(ms);
        const pid = Number(r.stdout.trim());
        this.tmuxPid = Number.isFinite(pid) && pid > 0 ? pid : null;
      }
    } finally {
      this.probing = false;
    }
  }

  private async cpuOf(key: number | 'self', st: ProcStat): Promise<number> {
    const now = Date.now();
    const prev = this.lastTicks.get(key);
    this.lastTicks.set(key, { ticks: st.ticks, at: now });
    if (!prev || now <= prev.at || st.ticks < prev.ticks) return 0;
    return ((st.ticks - prev.ticks) / CLK_TCK / ((now - prev.at) / 1000)) * 100;
  }

  async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      if (this.loop) {
        const ms = (ns: number) => ns / 1e6;
        if (this.loop.count > 0)
          impact.recordLoop(
            ms(this.loop.percentile(50)),
            ms(this.loop.percentile(99)),
            ms(this.loop.max)
          );
        this.loop.reset();
      }
      const groups: Array<[ImpactProcName, Array<number | 'self'>]> = [
        ['daemon', ['self']],
        ['herald-voice', this.pids.get('herald-voice') || []],
        ['tmux', this.tmuxPid ? [this.tmuxPid] : []],
        ['mcp', this.pids.get('mcp') || []],
      ];
      const procs: ImpactProcSample[] = [];
      const alive = new Set<number | 'self'>();
      for (const [name, pids] of groups) {
        let cpu = 0;
        let rss = 0;
        let swap = 0;
        const seen: number[] = [];
        for (const pid of pids) {
          const st = await readProcStat(pid);
          if (!st) continue;
          alive.add(pid);
          seen.push(pid === 'self' ? process.pid : pid);
          cpu += await this.cpuOf(pid, st);
          rss += st.rssKb / 1024;
          swap += st.swapKb / 1024;
        }
        if (name === 'daemon') impact.recordSelf(cpu, Math.round(rss));
        if (seen.length || name === 'daemon')
          procs.push({
            name,
            pids: seen,
            cpuPct: Math.round(cpu * 10) / 10,
            rssMb: Math.round(rss),
            swapMb: Math.round(swap),
          });
      }
      for (const k of [...this.lastTicks.keys()]) if (!alive.has(k)) this.lastTicks.delete(k);
      impact.setProcs(procs);
      const sw = await readSwap();
      if (sw) impact.setSwap(sw.totalMb, sw.freeMb);
    } finally {
      this.sampling = false;
    }
  }
}

let countingInstalled = false;

/** Count console lines per minute (log volume), without changing what is logged. */
export function installLogCounter(): void {
  if (countingInstalled) return;
  countingInstalled = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      impact.count('logLines');
      orig(...args);
    };
  }
}
