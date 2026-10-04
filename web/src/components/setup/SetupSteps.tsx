import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Server } from '../../types';
import type {
  AppDownloads,
  ClaudeInstallResult,
  DirListing,
  HeraldProviderChoice,
  PrereqCheck,
  PrereqId,
  RemoteAccessInfo,
  ServiceInstallResult,
  ServiceStatus,
  ServiceTarget,
  SessionProgress,
  SetupStatus,
} from '../../types/setup';
import { SETUP_LIMITS } from '../../types/setup';
import { serverHttpBase, setupCall, SetupApiError, type WizardMode, type Marks, STEP_TITLES } from '../../services/setupWizard';
import { DaemonHello, guessDeviceName, PairingClient, PairState, PairTarget, serverFromPairing } from '../../services/pairing';
import { useServers } from '../../hooks/useServers';
import { nativePlatform } from '../../utils/platform';
import { browserNotifications } from '../../services/BrowserNotifications';
import { useHeraldData, useHeraldSetupCtx } from '../../context/HeraldContext';
import { AddServerFlow, CodePairing, detectedTarget } from '../AddServerFlow';
import { DevicesCard } from '../DevicesSettings';
import { HeraldSetup } from '../herald/setup/HeraldSetup';
import { CopyCommand, IconCheck, IconFolder, IconSkip, Notice, Spinner, StatusIcon } from './SetupCommon';

export interface StepCtx {
  serverId: string | null;
  server: Server | null;
  status: SetupStatus | null;
  setStatus: (s: SetupStatus) => void;
  mode: WizardMode;
  paired: boolean;
  marks: Marks;
  /** Why the setup API is unavailable on this connection (e.g. public network). */
  setupError: string | null;
  /** A step can run something (save) before Continue; returning false stays. */
  registerContinue: (fn: (() => Promise<boolean>) | null) => void;
  onPaired: (serverId: string) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Compose commands shown when the server runs in the Docker image (mirrors daemon/src/container.ts). */
export const DOCKER = {
  setupClaude: 'docker compose run --rm companion setup-claude',
  claude: 'docker compose exec companion claude',
  logs: 'docker compose logs companion',
  pairCode: 'bin/docker pair-code',
  restart: 'docker compose restart companion',
  voiceUp: 'docker compose --profile voice up -d',
  tailscaleUp: 'docker compose --profile tailscale up -d',
} as const;

/** The server's container facts (null on a host install or before status loads). */
const dockerOf = (ctx: StepCtx) => ctx.status?.container ?? null;

/** A setup request on this wizard's server; stable while the server stays the same. */
function useApi(serverId: string | null) {
  return useCallback(
    <T,>(type: string, payload?: unknown, timeoutMs?: number) => {
      if (!serverId) return Promise.reject(new SetupApiError('Not paired yet'));
      return setupCall<T>(serverId, type, payload, timeoutMs);
    },
    [serverId],
  );
}

function ServerOnly({ ctx }: { ctx: StepCtx }) {
  if (ctx.setupError) return <Notice tone="warn">{ctx.setupError}</Notice>;
  if (!ctx.status) return <div className="sw-loading"><Spinner /> Loading the server's setup...</div>;
  return null;
}

// ------------------------------------------------------------------ welcome

export function WelcomeStep() {
  return (
    <div className="sw-welcome">
      <div className="sw-hero" aria-hidden="true">
        <span className="sw-hero__ring" />
        <span className="sw-hero__ring sw-hero__ring--2" />
        <span className="sw-hero__core" />
      </div>
      <ul className="sw-points">
        <li><strong>Your Claude Code sessions, everywhere.</strong> Watch every session on this server live, from any device.</li>
        <li><strong>Answer from your phone.</strong> When Claude needs you, get notified and reply in a tap.</li>
        <li><strong>Private by design.</strong> It runs on your own machine; devices pair with it directly, no account needed.</li>
      </ul>
      <p className="sw-muted">This takes about five minutes. Every optional step can be skipped and revisited later from Settings, Setup.</p>
    </div>
  );
}

// ------------------------------------------------------------------ pair

export function PairStep({ ctx }: { ctx: StepCtx }) {
  const { servers, addServer, updateServer } = useServers();
  const target = useMemo(detectedTarget, []);
  const native = nativePlatform() !== 'browser';
  const [hello, setHello] = useState<DaemonHello | null>(null);
  const [helloError, setHelloError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState(() => guessDeviceName());
  const [view, setView] = useState<'choose' | 'code'>('choose');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showOther, setShowOther] = useState(false);
  const initialIds = useRef(new Set(servers.map((s) => s.id)));

  useEffect(() => {
    if (ctx.paired || !target) return;
    const c = new PairingClient(target);
    let alive = true;
    c.hello()
      .then((h) => alive && setHello(h))
      .catch((e) => alive && setHelloError(errText(e)))
      .finally(() => c.close());
    return () => {
      alive = false;
      c.close();
    };
  }, [ctx.paired, target]);

  // Paired through the other ways (Nearby / QR / address): pick up the new server.
  useEffect(() => {
    if (ctx.paired) return;
    const added = servers.find((s) => !initialIds.current.has(s.id));
    if (added && !showOther) ctx.onPaired(added.id);
  }, [servers, showOther, ctx]);

  const save = useCallback(
    (t: PairTarget, state: PairState) => {
      if (state.phase !== 'approved' || !state.outcome) return;
      const server = serverFromPairing(t, state.outcome, servers);
      if (servers.some((s) => s.id === server.id)) updateServer(server);
      else addServer(server);
      ctx.onPaired(server.id);
    },
    [servers, addServer, updateServer, ctx],
  );

  if (ctx.paired) {
    return (
      <div className="sw-success">
        <span className="sw-success__icon"><IconCheck size={22} /></span>
        <div>
          <div className="sw-success__title">This device is paired</div>
          <div className="sw-muted">
            {ctx.server ? `Signed in to ${ctx.server.name} with its own device key.` : 'Signed in with its own device key.'} You can revoke it any time in Settings, Devices.
          </div>
        </div>
      </div>
    );
  }

  const pairLocal = async () => {
    if (!target) return;
    setBusy(true);
    setErr(null);
    const c = new PairingClient(target);
    const s = await c.pairLocal(deviceName.trim() || guessDeviceName());
    setBusy(false);
    if (s.phase === 'approved') save(target, s);
    else setErr(s.error || 'Pairing failed');
  };

  return (
    <div className="sw-stack">
      <label className="sw-field">
        <span className="sw-field__label">This device's name</span>
        <input className="sw-input" value={deviceName} maxLength={60} onChange={(e) => setDeviceName(e.target.value)} />
      </label>

      {target && view === 'choose' && (
        <div className="sw-choice-list">
          {hello?.localAutoPair && (
            <button type="button" className="sw-choice sw-choice--primary" onClick={() => void pairLocal()} disabled={busy}>
              <span className="sw-choice__title">{busy ? 'Pairing...' : 'Pair this browser'}</span>
              <span className="sw-choice__desc">You are on the server itself, so no code is needed for this first device.</span>
            </button>
          )}
          {hello && hello.codePairing && (
            <button type="button" className={`sw-choice${hello.localAutoPair ? '' : ' sw-choice--primary'}`} onClick={() => setView('code')}>
              <span className="sw-choice__title">Pair with a code</span>
              <span className="sw-choice__desc">
                {hello.container ? (
                  <>A 6-digit code appears in the server's log: run <code>{DOCKER.logs}</code> (or <code>{DOCKER.pairCode}</code>) where you started Companion.</>
                ) : (
                  <>A 6-digit code appears in the server's terminal or log (and in <code>companion pair</code>).</>
                )}
              </span>
            </button>
          )}
          {hello && !hello.codePairing && !hello.localAutoPair && (
            <Notice tone="warn">This server does not pair by code from here. Use a pairing QR made on the server: <code>companion pair --qr</code>.</Notice>
          )}
          {hello?.container && !hello.localAutoPair && (
            <Notice tone="info">
              Companion runs in Docker here. Docker's port mapping hides that this browser is on the same machine, so the first device pairs with a code too.
            </Notice>
          )}
          {!hello && !helloError && <div className="sw-loading"><Spinner /> Contacting {target.host}...</div>}
          {helloError && <Notice tone="error">Could not reach the server at {target.host}:{target.port}: {helloError}</Notice>}
        </div>
      )}

      {target && view === 'code' && (
        <div className="sw-panel">
          <CodePairing target={target} label={hello?.name || target.host} deviceName={deviceName} onDone={save} />
          <button type="button" className="sw-link" onClick={() => setView('choose')}>Choose another way</button>
        </div>
      )}

      {!target && (
        <Notice tone="info">
          {native
            ? 'Find your server on this network, scan the pairing QR it shows, or enter its address.'
            : 'Open this page from your server, or use one of the ways below.'}
        </Notice>
      )}

      <button type="button" className={native && !target ? 'sw-btn sw-btn--primary' : 'sw-link'} onClick={() => setShowOther(true)}>
        {native && !target ? 'Find your server' : 'Other ways: nearby, QR code, or address'}
      </button>
      {err && <Notice tone="error">{err}</Notice>}
      {showOther && <AddServerFlow onClose={() => setShowOther(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ name

export function NameStep({ ctx }: { ctx: StepCtx }) {
  const api = useApi(ctx.serverId);
  const { updateServer } = useServers();
  const [name, setName] = useState(ctx.status?.settings.name ?? '');
  const [err, setErr] = useState<string | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (!loaded.current && ctx.status) {
      loaded.current = true;
      setName(ctx.status.settings.name);
    }
  }, [ctx.status]);

  const nameRef = useRef(name);
  nameRef.current = name;
  useEffect(() => {
    ctx.registerContinue(async () => {
      const n = nameRef.current.trim();
      if (!n) {
        setErr('Give it a name');
        return false;
      }
      if (n === ctx.status?.settings.name) return true;
      try {
        const next = await api<SetupStatus>('setup_update', { patch: { name: n } });
        ctx.setStatus(next);
        // Keep this device's server list in step (a name-only change never reconnects).
        if (ctx.server && ctx.server.name !== next.serverName) updateServer({ ...ctx.server, name: next.serverName });
        return true;
      } catch (e) {
        setErr(errText(e));
        return false;
      }
    });
    return () => ctx.registerContinue(null);
  }, [ctx, api, updateServer]);

  const guard = <ServerOnly ctx={ctx} />;
  if (ctx.setupError || !ctx.status) return guard;
  return (
    <div className="sw-stack">
      <label className="sw-field">
        <span className="sw-field__label">Server name</span>
        <input
          className="sw-input sw-input--lg"
          value={name}
          maxLength={SETUP_LIMITS.nameMaxLength}
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setErr(null);
          }}
        />
        <span className="sw-field__hint">Shown when devices look for servers nearby, and in the app's server list. The machine is {ctx.status.hostname}.</span>
      </label>
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}

// ------------------------------------------------------------------ machine checks

function useChecks(ctx: StepCtx, only?: PrereqId[]) {
  const api = useApi(ctx.serverId);
  const [checks, setChecks] = useState<PrereqCheck[] | null>(null);
  const [pending, setPending] = useState<Set<PrereqId> | 'all'>('all');
  const [err, setErr] = useState<string | null>(null);
  const key = (only || []).join(',');
  const run = useCallback(
    async (ids?: PrereqId[]) => {
      if (!ctx.serverId || ctx.setupError) return;
      setPending(ids ? new Set(ids) : 'all');
      try {
        const r = await api<{ checks: PrereqCheck[] }>('setup_checks', { only: ids ?? only }, 30_000);
        setChecks((prev) => {
          if (!ids || !prev) return r.checks;
          const byId = new Map(r.checks.map((c) => [c.id, c]));
          return prev.map((c) => byId.get(c.id) ?? c);
        });
        setErr(null);
      } catch (e) {
        setErr(errText(e));
      } finally {
        setPending(new Set());
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.serverId, ctx.setupError, api, key],
  );
  useEffect(() => {
    void run();
  }, [run]);
  return { checks, pending, err, run };
}

function CheckRow({ c, busy, onRecheck }: { c: PrereqCheck; busy: boolean; onRecheck: () => void }) {
  return (
    <li className={`sw-check sw-check--${c.status}`}>
      <StatusIcon status={busy ? 'pending' : c.status} />
      <div className="sw-check__body">
        <div className="sw-check__head">
          <span className="sw-check__label">{c.label}</span>
          <span className="sw-check__detail">{c.detail}</span>
        </div>
        {c.fix && <div className="sw-check__fix">{c.fix}</div>}
        {c.command && <CopyCommand command={c.command} />}
      </div>
      <button type="button" className="sw-mini" onClick={onRecheck} disabled={busy} aria-label={`Re-check ${c.label}`}>
        Re-check
      </button>
    </li>
  );
}

function ServiceInstall({ ctx, target }: { ctx: StepCtx; target: ServiceTarget }) {
  const api = useApi(ctx.serverId);
  const [svc, setSvc] = useState<ServiceStatus | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ServiceInstallResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api<ServiceStatus>('setup_services').then(setSvc).catch((e) => setErr(errText(e)));
  }, [api]);
  useEffect(load, [load]);
  const info = svc?.services.find((s) => s.target === target);
  if (!info) return err ? <Notice tone="error">{err}</Notice> : null;
  const install = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await api<ServiceInstallResult>('setup_install_service', { target, confirm: true }, 130_000));
      load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const title = target === 'daemon' ? 'Start Companion on boot' : 'Run the voice service on boot';
  return (
    <div className="sw-panel">
      <div className="sw-panel__head">
        <span className="sw-panel__title">{title}</span>
        {info.installed ? <span className="sw-pill sw-pill--ok">Installed</span> : <span className="sw-pill">Not installed</span>}
      </div>
      {!info.installed && (
        <>
          <p className="sw-muted">
            {target === 'daemon'
              ? 'Installs a user service so the daemon comes back after a reboot. It does not restart the daemon that is running now.'
              : 'Installs the herald-voice user service and starts it.'}
          </p>
          <CopyCommand command={info.command} label="Runs" />
          {info.blocker && <Notice tone="warn">{info.blocker}</Notice>}
          {!info.blocker && !confirm && (
            <button type="button" className="sw-btn" onClick={() => setConfirm(true)}>Install...</button>
          )}
          {confirm && (
            <div className="sw-confirm">
              <span>Run the command above on the server now?</span>
              <div className="sw-confirm__actions">
                <button type="button" className="sw-btn" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
                <button type="button" className="sw-btn sw-btn--primary" onClick={() => void install()} disabled={busy}>
                  {busy ? 'Installing...' : 'Yes, install'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {result && (
        <Notice tone={result.ok ? 'ok' : 'error'}>
          {result.ok ? result.note : 'The install command failed.'}
          {result.output && <pre className="sw-output">{result.output}</pre>}
        </Notice>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}

export function MachineStep({ ctx }: { ctx: StepCtx }) {
  const { checks, pending, err, run } = useChecks(ctx);
  if (ctx.setupError || !ctx.status) return <ServerOnly ctx={ctx} />;
  const busy = (id: PrereqId) => pending === 'all' || pending.has(id);
  const required = checks?.filter((c) => !c.optional) ?? [];
  const optional = checks?.filter((c) => c.optional) ?? [];
  const failing = required.filter((c) => c.status === 'fail').length;
  return (
    <div className="sw-stack">
      <div className="sw-toolbar">
        <span className="sw-muted">
          {checks === null ? 'Checking...' : failing ? `${failing} thing${failing > 1 ? 's' : ''} to fix` : 'Everything Companion needs is here.'}
        </span>
        <button type="button" className="sw-mini" onClick={() => void run()} disabled={pending === 'all'}>
          Re-check all
        </button>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {checks === null && <div className="sw-loading"><Spinner /> Checking this machine...</div>}
      {required.length > 0 && (
        <ul className="sw-checks">
          {required.map((c) => <CheckRow key={c.id} c={c} busy={busy(c.id)} onRecheck={() => void run([c.id])} />)}
        </ul>
      )}
      {optional.length > 0 && (
        <>
          <div className="sw-subhead">Optional</div>
          <ul className="sw-checks">
            {optional.map((c) => <CheckRow key={c.id} c={c} busy={busy(c.id)} onRecheck={() => void run([c.id])} />)}
          </ul>
        </>
      )}
      {dockerOf(ctx) ? (
        <Notice tone="info">
          Running in Docker: tmux, git and Node are part of the image, and Docker starts Companion again after a reboot (<code>restart: unless-stopped</code>). Nothing to install here.
        </Notice>
      ) : (
        <ServiceInstall ctx={ctx} target="daemon" />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ claude

export function ClaudeStep({ ctx }: { ctx: StepCtx }) {
  const only = useMemo<PrereqId[]>(() => ['claude_installed', 'claude_login'], []);
  const { checks, pending, err, run } = useChecks(ctx, only);
  const installed = checks?.find((c) => c.id === 'claude_installed');
  const login = checks?.find((c) => c.id === 'claude_login');
  // Gentle polling while something is missing (the daemon dedups runs).
  useEffect(() => {
    if (!checks || (installed?.status === 'ok' && login?.status === 'ok')) return;
    const t = setInterval(() => void run(), 8000);
    return () => clearInterval(t);
  }, [checks, installed?.status, login?.status, run]);
  if (ctx.setupError || !ctx.status) return <ServerOnly ctx={ctx} />;
  const docker = dockerOf(ctx);
  return (
    <div className="sw-stack">
      <p className="sw-lead">Companion watches Claude Code sessions. Claude Code itself runs on this server, signed in with your Claude account (or an API key).</p>
      {err && <Notice tone="error">{err}</Notice>}
      <ul className="sw-checks">
        {[installed, login].map((c) =>
          c ? (
            <CheckRow key={c.id} c={c} busy={pending === 'all' || (pending instanceof Set && pending.has(c.id))} onRecheck={() => void run([c.id])} />
          ) : null,
        )}
        {!checks && <div className="sw-loading"><Spinner /> Looking for Claude Code...</div>}
      </ul>
      {installed?.status !== 'ok' && checks && docker && <DockerClaudeInstall ctx={ctx} onInstalled={() => void run()} />}
      {installed?.status !== 'ok' && !docker && (
        <div className="sw-panel">
          <div className="sw-panel__title">Install Claude Code</div>
          <CopyCommand command="npm install -g @anthropic-ai/claude-code" label="On the server" />
          <p className="sw-muted">Needs Node 18 or newer. This page notices the install by itself.</p>
        </div>
      )}
      {installed?.status === 'ok' && login?.status !== 'ok' && docker && (
        <div className="sw-panel">
          <div className="sw-panel__title">Sign in to Claude Code</div>
          <CopyCommand command={DOCKER.claude} label="1. In a terminal on the Docker host, in the Companion folder" />
          <p className="sw-muted">2. Type <code>/login</code>, open the link it shows, sign in, and paste the code back. Then exit with <code>/exit</code>. The login is kept in a volume, so you do this once.</p>
        </div>
      )}
      {installed?.status === 'ok' && login?.status !== 'ok' && !docker && (
        <Notice tone="info">
          You sign in once, inside a Claude Code session. The next steps start one for you: run <code>/login</code> there and finish in the browser.
        </Notice>
      )}
      {installed?.status === 'ok' && login?.status === 'ok' && <Notice tone="ok">Claude Code is installed and signed in.</Notice>}
    </div>
  );
}

/** Docker: install Claude Code into the container's volume from here, or with the compose command. */
function DockerClaudeInstall({ ctx, onInstalled }: { ctx: StepCtx; onInstalled: () => void }) {
  const api = useApi(ctx.serverId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClaudeInstallResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const install = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<ClaudeInstallResult>('setup_install_claude', { confirm: true }, 320_000);
      setResult(r);
      if (r.ok) onInstalled();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sw-panel">
      <div className="sw-panel__title">Install Claude Code</div>
      <p className="sw-muted">Claude Code is not part of the Companion image. It installs into a volume, so it survives container upgrades and keeps updating itself.</p>
      <div>
        <button type="button" className="sw-btn sw-btn--primary" onClick={() => void install()} disabled={busy}>
          {busy ? 'Installing (about a minute)...' : 'Install Claude Code'}
        </button>
      </div>
      <CopyCommand command={DOCKER.setupClaude} label="Or in a terminal on the Docker host, in the Companion folder" />
      {result && (
        <Notice tone={result.ok ? 'ok' : 'error'}>
          {result.ok ? `Installed: ${result.version}` : 'The install did not finish. Try the command above in a terminal.'}
          {!result.ok && result.output && <pre className="sw-output">{result.output}</pre>}
        </Notice>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}

// ------------------------------------------------------------------ projects

function DirBrowser({ ctx, start, onPick, pickLabel }: { ctx: StepCtx; start?: string; onPick: (p: string) => void; pickLabel: string }) {
  const api = useApi(ctx.serverId);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const open = useCallback(
    (path?: string) => {
      setErr(null);
      api<DirListing>('setup_list_dirs', { path })
        .then(setListing)
        .catch((e) => setErr(errText(e)));
    },
    [api],
  );
  useEffect(() => open(start), [open, start]);
  const home = ctx.status?.home ?? '';
  const rel = (p: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p);
  return (
    <div className="sw-browser">
      <div className="sw-browser__bar">
        <button type="button" className="sw-mini" disabled={!listing?.parent} onClick={() => listing?.parent && open(listing.parent)} aria-label="Up one folder">
          Up
        </button>
        <span className="sw-browser__path" title={listing?.path}>{listing ? rel(listing.path) : '...'}</span>
        <button type="button" className="sw-btn sw-btn--primary sw-btn--sm" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
          {pickLabel}
        </button>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      <ul className="sw-browser__list">
        {listing?.entries.map((e) => (
          <li key={e.path}>
            <button type="button" className="sw-browser__item" onClick={() => open(e.path)}>
              <IconFolder /> <span>{e.name}</span>
            </button>
          </li>
        ))}
        {listing && listing.entries.length === 0 && <li className="sw-muted sw-browser__empty">No folders here</li>}
      </ul>
      {listing?.truncated && <div className="sw-muted">Showing the first {listing.entries.length} folders.</div>}
    </div>
  );
}

export function ProjectsStep({ ctx }: { ctx: StepCtx }) {
  const api = useApi(ctx.serverId);
  const [roots, setRoots] = useState<string[]>(ctx.status?.settings.projectRoots ?? []);
  const [err, setErr] = useState<string | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (!loaded.current && ctx.status) {
      loaded.current = true;
      setRoots(ctx.status.settings.projectRoots);
    }
  }, [ctx.status]);
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  useEffect(() => {
    ctx.registerContinue(async () => {
      const cur = ctx.status?.settings.projectRoots ?? [];
      if (JSON.stringify(cur) === JSON.stringify(rootsRef.current)) return true;
      try {
        ctx.setStatus(await api<SetupStatus>('setup_update', { patch: { projectRoots: rootsRef.current } }));
        return true;
      } catch (e) {
        setErr(errText(e));
        return false;
      }
    });
    return () => ctx.registerContinue(null);
  }, [ctx, api]);
  if (ctx.setupError || !ctx.status) return <ServerOnly ctx={ctx} />;
  const home = ctx.status.home;
  const rel = (p: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);
  const docker = dockerOf(ctx);
  return (
    <div className="sw-stack">
      <p className="sw-lead">Pick the folders where your code lives. New sessions (from the app or Herald) can only start inside them.</p>
      {docker && (
        <Notice tone={docker.projectsDir ? 'info' : 'warn'}>
          {docker.projectsDir ? (
            <>Running in Docker: your code is the folder mounted at <code>{rel(docker.projectsDir)}</code> (<code>COMPANION_PROJECTS</code> in <code>.env</code>). Pick it, or folders inside it.</>
          ) : (
            <>Running in Docker without a projects folder. Set <code>COMPANION_PROJECTS=/path/to/your/code</code> in <code>.env</code>, then <code>docker compose up -d</code>.</>
          )}
        </Notice>
      )}
      <div className="sw-roots">
        {roots.length === 0 && <span className="sw-muted">No folders yet. Choose one below.</span>}
        {roots.map((r) => (
          <span key={r} className="sw-chip">
            <IconFolder size={14} /> {rel(r)}
            <button type="button" className="sw-chip__x" onClick={() => setRoots(roots.filter((x) => x !== r))} aria-label={`Remove ${rel(r)}`}>
              &times;
            </button>
          </span>
        ))}
      </div>
      <DirBrowser
        ctx={ctx}
        pickLabel="Add this folder"
        onPick={(p) => {
          setErr(null);
          if (!roots.includes(p)) setRoots([...roots, p].slice(0, SETUP_LIMITS.maxProjectRoots));
        }}
      />
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}

// ------------------------------------------------------------------ first session

export function SessionStep({ ctx }: { ctx: StepCtx }) {
  const api = useApi(ctx.serverId);
  const roots = useMemo(() => ctx.status?.settings.projectRoots ?? [], [ctx.status]);
  const [dir, setDir] = useState<string | null>(null);
  const [progress, setProgress] = useState<SessionProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [helloSent, setHelloSent] = useState(false);

  useEffect(() => {
    if (!progress || progress.conversationDetected || !progress.exists) return;
    const t = setInterval(() => {
      api<SessionProgress>('setup_session_progress', { sessionName: progress.sessionName })
        .then(setProgress)
        .catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [progress, api]);

  if (ctx.setupError || !ctx.status) return <ServerOnly ctx={ctx} />;
  const home = ctx.status.home;
  const rel = (p: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);

  const start = async () => {
    if (!dir) return;
    setBusy(true);
    setErr(null);
    try {
      setProgress(await api<SessionProgress>('setup_start_session', { dir }, 30_000));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const hello = async () => {
    if (!progress) return;
    setHelloSent(true);
    try {
      setProgress(await api<SessionProgress>('setup_session_hello', { sessionName: progress.sessionName }));
    } catch (e) {
      setErr(errText(e));
    }
  };

  if (!progress) {
    return (
      <div className="sw-stack">
        <p className="sw-lead">Start a Claude Code session in one of your projects. It runs in tmux on the server, so it keeps going when you close the app.</p>
        {roots.length === 0 ? (
          <Notice tone="warn">
            Choose a projects folder first (previous step), or browse {dockerOf(ctx) ? 'the projects folder' : 'your home folder'} below.
          </Notice>
        ) : null}
        <DirBrowser ctx={ctx} start={roots[0]} pickLabel="Use this folder" onPick={setDir} />
        {dir && (
          <div className="sw-panel sw-panel--row">
            <span>Start in <strong>{rel(dir)}</strong></span>
            <button type="button" className="sw-btn sw-btn--primary" onClick={() => void start()} disabled={busy}>
              {busy ? 'Starting...' : 'Start session'}
            </button>
          </div>
        )}
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    );
  }

  const stages: Array<{ key: string; label: string; done: boolean; active: boolean }> = [
    { key: 'started', label: 'Session started in tmux', done: progress.exists, active: false },
    {
      key: 'claude',
      label: 'Claude Code signed in and ready',
      done: progress.conversationDetected || helloSent,
      active: progress.hint === 'login' || progress.hint === 'trust_dialog' || progress.hint === 'starting',
    },
    { key: 'conv', label: 'Companion sees the conversation', done: progress.conversationDetected, active: helloSent && !progress.conversationDetected },
  ];
  return (
    <div className="sw-stack">
      <ol className="sw-timeline">
        {stages.map((s) => (
          <li key={s.key} className={`sw-timeline__item${s.done ? ' is-done' : s.active ? ' is-active' : ''}`}>
            <span className="sw-timeline__dot">{s.done ? <IconCheck size={12} /> : s.active ? <Spinner /> : null}</span>
            {s.label}
          </li>
        ))}
      </ol>
      {progress.conversationDetected ? (
        <Notice tone="ok">Your first session is live. It now shows up in the app's session list.</Notice>
      ) : (
        <>
          <Notice tone={progress.hint === 'claude_missing' || progress.hint === 'gone' ? 'error' : progress.hint === 'trust_dialog' ? 'warn' : 'info'}>
            {progress.guidance}
          </Notice>
          <CopyCommand command={progress.attachCommand} label="Open the session in a terminal on the server" />
          {(progress.hint === 'login' || progress.hint === 'trust_dialog') && (
            <div className="sw-panel">
              <div className="sw-panel__title">In the session</div>
              <ol className="sw-steps">
                {progress.hint === 'trust_dialog' && <li>Accept the folder trust prompt (usually option 2, "Yes, I accept").</li>}
                <li>Type <code>/login</code> and press Enter.</li>
                <li>Open the link it shows, sign in with your Claude account, and paste the code back if asked.</li>
              </ol>
            </div>
          )}
          <div className="sw-panel sw-panel--row">
            <span className="sw-muted">Once Claude shows its prompt, send a first message so the conversation appears.</span>
            <button type="button" className="sw-btn" onClick={() => void hello()} disabled={helloSent && !progress.conversationDetected}>
              {helloSent ? 'Sent' : 'Say hello'}
            </button>
          </div>
        </>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}

// ------------------------------------------------------------------ devices

const PLATFORM_ORDER = ['android', 'macos', 'windows', 'linux'];

export function DevicesStep({ ctx }: { ctx: StepCtx }) {
  const api = useApi(ctx.serverId);
  const [downloads, setDownloads] = useState<AppDownloads | null>(null);
  useEffect(() => {
    if (!ctx.serverId || ctx.setupError) return;
    api<AppDownloads>('setup_downloads').then(setDownloads).catch(() => setDownloads({ channel: 'stable', downloads: [], source: 'none', feedUrl: null }));
  }, [ctx.serverId, ctx.setupError, api]);
  if (!ctx.serverId || !ctx.server) return <ServerOnly ctx={ctx} />;
  const base = serverHttpBase(ctx.server);
  const docker = dockerOf(ctx);
  const list = (downloads?.downloads ?? []).slice().sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));
  return (
    <div className="sw-stack">
      <p className="sw-lead">
        {docker && !docker.hostNetwork
          ? 'Pair your phone and other computers with a pairing QR, or by address and code. (Nearby discovery does not cross Docker\'s network; see docs/docker.md for host networking.)'
          : 'Pair your phone and other computers. On the same Wi-Fi, the app finds this server under Nearby; anywhere else, scan a pairing QR.'}
      </p>
      <div className="sw-devices">
        <DevicesCard serverId={ctx.serverId} serverName={ctx.server.name} />
      </div>
      <div className="sw-panel">
        <div className="sw-panel__title">Get the apps</div>
        <p className="sw-muted">
          {downloads?.source === 'remote'
            ? 'This server has no builds of its own, so these come from the public Companion feed. Installed apps update themselves from it.'
            : "Installers come from this server's update feed; installed apps update themselves."}
        </p>
        {downloads === null && <div className="sw-loading"><Spinner /> Reading the update feed...</div>}
        {downloads && list.length === 0 && (
          <div className="sw-muted">
            No app builds are published on this server yet{downloads.feedUrl ? ', and the public feed did not answer' : ''}. You can always use this web app
            {downloads.feedUrl ? (
              <>, or try the public feed later: <code>{downloads.feedUrl}</code></>
            ) : (
              ', or ask whoever runs your builds for the installers'
            )}
            .
          </div>
        )}
        {list.length > 0 && (
          <ul className="sw-downloads">
            {list.map((d) => (
              <li key={`${d.platform}-${d.label}`}>
                <a className="sw-download" href={d.localPath ? `${base}${d.localPath}` : d.url} target="_blank" rel="noreferrer noopener">
                  <span className="sw-download__name">{d.label}</span>
                  <span className="sw-download__ver">v{d.version}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ notifications

export function NotificationsStep({ ctx }: { ctx: StepCtx }) {
  const api = useApi(ctx.serverId);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' && nativePlatform() === 'browser' ? 'unsupported' : browserNotifications.getPermission(),
  );
  const [saved, setSaved] = useState<'browser' | 'off' | null>(ctx.status?.settings.notifications ?? null);
  const ask = async () => setPerm(await browserNotifications.requestPermission());
  const choose = async (c: 'browser' | 'off') => {
    setSaved(c);
    if (ctx.mode === 'server' && ctx.serverId && !ctx.setupError) {
      try {
        ctx.setStatus(await api<SetupStatus>('setup_update', { patch: { notifications: c } }));
      } catch {
        /* the choice is informational */
      }
    }
  };
  return (
    <div className="sw-stack">
      <div className="sw-choice-list">
        <button type="button" className={`sw-choice${saved !== 'off' ? ' sw-choice--on' : ''}`} onClick={() => void choose('browser')}>
          <span className="sw-choice__title">Notify me on this device</span>
          <span className="sw-choice__desc">When a session needs your input, finishes, or hits an error, this device shows a notification while Companion is open.</span>
        </button>
        <button type="button" className={`sw-choice${saved === 'off' ? ' sw-choice--on' : ''}`} onClick={() => void choose('off')}>
          <span className="sw-choice__title">No notifications</span>
          <span className="sw-choice__desc">Check in when you like. You can turn them on later in Settings, Notifications.</span>
        </button>
      </div>
      {saved !== 'off' && (
        <div className="sw-panel sw-panel--row">
          <span>
            Permission on this device: <strong>{perm === 'granted' ? 'allowed' : perm === 'denied' ? 'blocked' : perm === 'unsupported' ? 'not supported here' : 'not asked yet'}</strong>
          </span>
          {perm !== 'granted' && perm !== 'unsupported' && (
            <button type="button" className="sw-btn sw-btn--primary" onClick={() => void ask()} disabled={perm === 'denied'}>
              Allow notifications
            </button>
          )}
        </div>
      )}
      {perm === 'denied' && <Notice tone="warn">Notifications are blocked for this site. Allow them in the browser's site settings, then come back.</Notice>}
      <Notice tone="info">
        <strong>Phone push when the app is closed: coming soon.</strong> A hosted push relay will notify your phone without a Firebase project of your own. Until then, push works only if this server is configured with its own Firebase credentials (<code>fcm_credentials_path</code>); otherwise notifications arrive while the app is open.
      </Notice>
    </div>
  );
}

// ------------------------------------------------------------------ herald

export function HeraldStep({ ctx }: { ctx: StepCtx }) {
  const api = useApi(ctx.serverId);
  const heraldData = useHeraldData();
  const heraldSetup = useHeraldSetupCtx();
  const st = ctx.status;
  const [provider, setProvider] = useState<HeraldProviderChoice>(st?.settings.herald.provider ?? 'off');
  const [baseUrl, setBaseUrl] = useState(st?.settings.herald.baseUrl ?? '');
  const [model, setModel] = useState(st?.settings.herald.model ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (!loaded.current && st) {
      loaded.current = true;
      setProvider(st.settings.herald.provider);
      setBaseUrl(st.settings.herald.baseUrl);
      setModel(st.settings.herald.model);
    }
  }, [st]);
  const voice = useChecks(ctx, useMemo<PrereqId[]>(() => ['herald_voice'], []));
  const keySet = st?.secrets.find((s) => s.name === 'anthropic_api_key');
  const serverMode = ctx.mode === 'server' && !ctx.setupError;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      let next: SetupStatus | null = null;
      if (provider === 'anthropic' && key.trim()) {
        next = await api<SetupStatus>('setup_set_secret', { name: 'anthropic_api_key', value: key.trim() });
        setKey('');
      }
      const patch =
        provider === 'openai_compatible'
          ? { herald: { provider, baseUrl: baseUrl.trim(), model: model.trim() } }
          : { herald: { provider } };
      next = await api<SetupStatus>('setup_update', { patch });
      ctx.setStatus(next);
      setMsg({
        tone: 'ok',
        text: next.restartNeeded
          ? `Saved. Turning Herald on or off applies after the daemon restarts (${dockerOf(ctx) ? DOCKER.restart : 'bin/companion restart'}, when convenient).`
          : provider === 'off'
            ? 'Saved. Herald stays off.'
            : 'Saved. Herald picked up the new brain without a restart.',
      });
    } catch (e) {
      setMsg({ tone: 'error', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sw-stack">
      <p className="sw-lead">Herald is an optional voice and chat layer over all your sessions: it briefs you, answers questions about them, and relays your replies.</p>
      {serverMode && st && (
        <>
          <div className="sw-choice-list sw-choice-list--3">
            {(
              [
                ['anthropic', 'Claude (Anthropic API)', 'Best quality. Needs an Anthropic API key, billed to your account.'],
                ['openai_compatible', 'Local model', 'Any OpenAI-compatible server on your network (llama.cpp, vLLM, Ollama).'],
                ['off', 'Not now', 'Skip Herald. Everything else works without it.'],
              ] as Array<[HeraldProviderChoice, string, string]>
            ).map(([id, title, desc]) => (
              <button key={id} type="button" className={`sw-choice${provider === id ? ' sw-choice--on' : ''}`} onClick={() => setProvider(id)} aria-pressed={provider === id}>
                <span className="sw-choice__title">{title}</span>
                <span className="sw-choice__desc">{desc}</span>
              </button>
            ))}
          </div>
          {provider === 'anthropic' && (
            <label className="sw-field">
              <span className="sw-field__label">
                Anthropic API key{' '}
                <span className={`sw-pill${keySet?.set ? ' sw-pill--ok' : ''}`}>{keySet?.set ? (keySet.source === 'env' ? 'set (environment)' : 'set') : 'not set'}</span>
              </span>
              <input
                className="sw-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={keySet?.set ? 'Leave empty to keep the current key' : 'sk-ant-...'}
                value={key}
                maxLength={SETUP_LIMITS.secretMaxLength}
                onChange={(e) => setKey(e.target.value)}
              />
              <span className="sw-field__hint">Stored on the server in {st.secretsFile} (readable only by you). It is never shown again.</span>
            </label>
          )}
          {provider === 'openai_compatible' && (
            <div className="sw-grid2">
              <label className="sw-field">
                <span className="sw-field__label">Base URL</span>
                <input className="sw-input" placeholder="http://192.168.1.20:8000/v1" value={baseUrl} maxLength={SETUP_LIMITS.urlMaxLength} onChange={(e) => setBaseUrl(e.target.value)} />
              </label>
              <label className="sw-field">
                <span className="sw-field__label">Model</span>
                <input className="sw-input" placeholder="qwen3-30b-a3b" value={model} maxLength={SETUP_LIMITS.modelMaxLength} onChange={(e) => setModel(e.target.value)} />
              </label>
            </div>
          )}
          <div>
            <button type="button" className="sw-btn sw-btn--primary" onClick={() => void save()} disabled={busy || (provider === 'anthropic' && !key.trim() && !keySet?.set)}>
              {busy ? 'Saving...' : 'Save Herald settings'}
            </button>
          </div>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

          <div className="sw-panel">
            <div className="sw-panel__head">
              <span className="sw-panel__title">Voice service (optional)</span>
              {voice.checks?.[0] && <StatusIcon status={voice.checks[0].status} />}
            </div>
            <p className="sw-muted">Spoken replies, voice input and the wake word run locally on the server (about 1 GB of models). Text chat works without it.</p>
            {voice.checks?.[0]?.status === 'ok' ? (
              <Notice tone="ok">{voice.checks[0].detail}</Notice>
            ) : dockerOf(ctx) ? (
              <>
                <CopyCommand command={DOCKER.voiceUp} label="Start the voice container (downloads the models on first start)" />
                <p className="sw-muted">It answers here once its models are ready; this can take a few minutes the first time.</p>
              </>
            ) : (
              <>
                <CopyCommand command="bin/herald-voice install" label="1. Download the models (once)" />
                <CopyCommand command="bin/herald-voice install-unit" label="2. Run it as a service" />
              </>
            )}
            {!dockerOf(ctx) && <ServiceInstall ctx={ctx} target="voice" />}
          </div>
        </>
      )}
      <div className="sw-panel sw-panel--row">
        <div>
          <div className="sw-panel__title">Device check</div>
          <span className="sw-muted">Set up this device's microphone, speakers and wake word for Herald.</span>
        </div>
        <button type="button" className="sw-btn" onClick={() => heraldSetup.openCheck()} disabled={!heraldData.available}>
          Run device check
        </button>
      </div>
      {!heraldData.available && <span className="sw-muted">The device check opens once Herald is on and connected.</span>}
      <HeraldSetup />
    </div>
  );
}

// ------------------------------------------------------------------ remote

export function RemoteStep({ ctx }: { ctx: StepCtx }) {
  const api = useApi(ctx.serverId);
  const [info, setInfo] = useState<RemoteAccessInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!ctx.serverId || ctx.setupError) return;
    api<RemoteAccessInfo>('setup_remote').then(setInfo).catch((e) => setErr(errText(e)));
  }, [ctx.serverId, ctx.setupError, api]);
  if (ctx.setupError || !ctx.status) return <ServerOnly ctx={ctx} />;
  const docker = dockerOf(ctx);
  if (docker) return <DockerRemote ctx={ctx} info={info} err={err} />;
  return (
    <div className="sw-stack">
      <p className="sw-lead">At home, devices reach this server directly. To use Companion away from home, the safest option is a private network like Tailscale.</p>
      {err && <Notice tone="error">{err}</Notice>}
      {!info && !err && <div className="sw-loading"><Spinner /> Looking for Tailscale...</div>}
      {info?.tailscale.up && info.tailscale.url && (
        <div className="sw-panel">
          <div className="sw-panel__head">
            <span className="sw-panel__title">Tailscale is connected</span>
            <span className="sw-pill sw-pill--ok">Ready</span>
          </div>
          <p className="sw-muted">Any of your devices signed in to the same tailnet can use this address:</p>
          <CopyCommand command={info.tailscale.url} />
          <p className="sw-muted">For the microphone in a browser, serve it over HTTPS on the tailnet:</p>
          <CopyCommand command={`sudo tailscale serve --bg --https=8443 http://127.0.0.1:${info.port}`} />
        </div>
      )}
      {info && !info.tailscale.up && (
        <div className="sw-panel">
          <div className="sw-panel__title">{info.tailscale.installed ? 'Tailscale is installed but not connected' : 'Options'}</div>
          <ul className="sw-options">
            <li><strong>Tailscale (recommended).</strong> Free for personal use; only your devices can reach the server, nothing is exposed to the internet.</li>
            <li><strong>Home network only.</strong> Nothing to do: devices on your Wi-Fi already work.</li>
            <li><strong>Your own reverse proxy.</strong> Possible, but pairing by code and setup stay limited to your local network on purpose; pair remote devices with a QR.</li>
          </ul>
          <CopyCommand command={info.tailscale.installed ? 'sudo tailscale up' : 'curl -fsSL https://tailscale.com/install.sh | sh'} />
        </div>
      )}
      {info && info.lanUrls.length > 0 && (
        <div className="sw-panel">
          <div className="sw-panel__title">On your network</div>
          {info.lanUrls.map((u) => <CopyCommand key={u} command={u} />)}
        </div>
      )}
    </div>
  );
}

function DockerRemote({ ctx, info, err }: { ctx: StepCtx; info: RemoteAccessInfo | null; err: string | null }) {
  const docker = dockerOf(ctx);
  const here = ctx.server ? `${serverHttpBase(ctx.server)}/web/` : null;
  return (
    <div className="sw-stack">
      <p className="sw-lead">At home, devices reach this server directly. To use Companion away from home, the Tailscale sidecar gives it a private HTTPS address on your tailnet.</p>
      {err && <Notice tone="error">{err}</Notice>}
      {!info && !err && <div className="sw-loading"><Spinner /> Asking the Tailscale sidecar...</div>}
      {info?.tailscale.up && info.tailscale.url && (
        <div className="sw-panel">
          <div className="sw-panel__head">
            <span className="sw-panel__title">Tailscale sidecar is connected</span>
            <span className="sw-pill sw-pill--ok">Ready</span>
          </div>
          <p className="sw-muted">Any device signed in to the same tailnet can use this address (HTTPS, so the microphone works in browsers too):</p>
          <CopyCommand command={info.tailscale.url} />
        </div>
      )}
      {info && !info.tailscale.up && (
        <div className="sw-panel">
          <div className="sw-panel__title">{docker?.tailscaleSidecar && info.tailscale.installed ? 'The sidecar is running but not connected' : 'Add the Tailscale sidecar (optional)'}</div>
          <ol className="sw-steps">
            <li>Create an auth key in the Tailscale admin console (Settings, Keys).</li>
            <li>Put it in <code>.env</code> as <code>TS_AUTHKEY=tskey-auth-...</code></li>
            <li>Start it:</li>
          </ol>
          <CopyCommand command={DOCKER.tailscaleUp} />
          <p className="sw-muted">Turn on MagicDNS and HTTPS certificates for your tailnet once (DNS page of the admin console). Details: docs/docker.md.</p>
        </div>
      )}
      {here && (
        <div className="sw-panel">
          <div className="sw-panel__title">On your network</div>
          <p className="sw-muted">Devices at home use the address this one is using now (or this machine's LAN address with the same port):</p>
          <CopyCommand command={here} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ done

export function DoneStep({ ctx, flow }: { ctx: StepCtx; flow: string[] }) {
  const items = flow.filter((s) => s !== 'welcome' && s !== 'done') as Array<keyof typeof STEP_TITLES>;
  return (
    <div className="sw-stack">
      <ul className="sw-summary">
        {items.map((s) => {
          const m = ctx.marks[s];
          return (
            <li key={s} className={`sw-summary__item${m === 'done' ? ' is-done' : m === 'skipped' ? ' is-skipped' : ''}`}>
              <span className="sw-summary__icon">{m === 'done' ? <IconCheck /> : <IconSkip />}</span>
              <span>{STEP_TITLES[s]}</span>
              <span className="sw-summary__state">{m === 'done' ? 'Set up' : m === 'skipped' ? 'Skipped' : 'Not visited'}</span>
            </li>
          );
        })}
      </ul>
      {ctx.status?.restartNeeded && (
        <Notice tone="warn">
          Some settings apply after the daemon restarts. Nothing was restarted for you; when it suits you, run:
          <CopyCommand command={dockerOf(ctx) ? DOCKER.restart : 'bin/companion restart'} />
        </Notice>
      )}
      <div className="sw-panel">
        <div className="sw-panel__title">Next</div>
        <ul className="sw-options">
          <li>Pair your phone: Settings, Devices, Show pairing QR.</li>
          <li>Start sessions from the app with the + button, or keep using <code>claude</code> in tmux on the server.</li>
          <li>Skipped something? Settings, Setup runs this again and jumps to what is left.</li>
        </ul>
      </div>
    </div>
  );
}
