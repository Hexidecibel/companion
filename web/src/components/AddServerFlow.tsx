import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useServers } from '../hooks/useServers';
import { discoverDaemons, DiscoveredDaemon } from '../services/discovery';
import {
  guessDeviceName,
  PairingClient,
  PairLink,
  PairState,
  PairTarget,
  parsePairLink,
  serverFromPairing,
} from '../services/pairing';
import { nativePlatform } from '../utils/platform';
import { ManualServerForm } from './ServerForm';
import { QRScannerModal } from './QRScannerModal';
import '../styles/pairing.css';

interface AddServerFlowProps {
  onClose: () => void;
  /** Opened from a companion:// link (deep link or pasted). */
  initialLink?: PairLink;
}

type View =
  | { kind: 'home' }
  | { kind: 'code'; target: PairTarget; label: string }
  | { kind: 'link'; link: PairLink }
  | { kind: 'manual'; prefill?: { name?: string; host: string; port: number; tls: boolean } }
  | { kind: 'done'; name: string };

function detectedTarget(): PairTarget | null {
  if (typeof window === 'undefined' || nativePlatform() !== 'browser') return null;
  const { hostname, port, protocol } = window.location;
  if (!hostname) return null;
  const tls = protocol === 'https:';
  return { host: hostname, port: Number(port) || (tls ? 443 : 80), tls };
}

/**
 * Add a server: nearby daemons (native apps), scan / paste a pairing link,
 * pair by address with a code, or the old token form (Advanced).
 */
export function AddServerFlow({ onClose, initialLink }: AddServerFlowProps) {
  const { servers, addServer, updateServer } = useServers();
  const [view, setView] = useState<View>(initialLink ? { kind: 'link', link: initialLink } : { kind: 'home' });
  const [deviceName, setDeviceName] = useState(() => guessDeviceName());
  const native = nativePlatform() !== 'browser';

  const save = useCallback(
    (target: PairTarget, state: PairState) => {
      if (state.phase !== 'approved' || !state.outcome) return;
      const server = serverFromPairing(target, state.outcome, servers);
      if (servers.some((s) => s.id === server.id)) updateServer(server);
      else addServer(server);
      setView({ kind: 'done', name: server.name });
    },
    [servers, addServer, updateServer],
  );

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {view.kind === 'manual' ? (
        <ManualServerForm onClose={onClose} prefill={view.prefill} onBack={() => setView({ kind: 'home' })} />
      ) : (
        <div className="modal-content server-form-modal pairing-modal">
          <div className="modal-header">
            {view.kind !== 'home' && view.kind !== 'done' && (
              <button className="icon-btn small" onClick={() => setView({ kind: 'home' })} title="Back">&larr;</button>
            )}
            <h3>Add Server</h3>
            <button className="modal-close" onClick={onClose}>&times;</button>
          </div>
          <div className="form-container pairing-body">
            {view.kind === 'home' && (
              <HomeView
                native={native}
                deviceName={deviceName}
                onDeviceName={setDeviceName}
                pairedIds={new Set(servers.map((s) => s.daemonId).filter((x): x is string => !!x))}
                onPair={(target, label) => setView({ kind: 'code', target, label })}
                onLink={(link) => setView({ kind: 'link', link })}
                onManual={(prefill) => setView({ kind: 'manual', prefill })}
              />
            )}
            {view.kind === 'code' && (
              <CodePairing target={view.target} label={view.label} deviceName={deviceName} onDone={save} />
            )}
            {view.kind === 'link' && (
              <LinkPairing link={view.link} deviceName={deviceName} onDeviceName={setDeviceName} onDone={save} />
            )}
            {view.kind === 'done' && (
              <div className="pairing-done">
                <div className="pairing-done-title">Paired with {view.name}</div>
                <p className="pairing-muted">This device has its own sign-in now. You can see and revoke it in Settings, Devices.</p>
                <button className="btn-primary" onClick={onClose}>Done</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ home

function HomeView(props: {
  native: boolean;
  deviceName: string;
  onDeviceName: (n: string) => void;
  pairedIds: Set<string>;
  onPair: (t: PairTarget, label: string) => void;
  onLink: (l: PairLink) => void;
  onManual: (prefill?: { name?: string; host: string; port: number; tls: boolean }) => void;
}) {
  const { native, pairedIds, onPair, onLink, onManual } = props;
  const [nearby, setNearby] = useState<DiscoveredDaemon[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanQr, setScanQr] = useState(false);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const detected = useMemo(detectedTarget, []);
  const [host, setHost] = useState(detected?.host ?? '');
  const [port, setPort] = useState(String(detected?.port ?? 9877));
  const [tls, setTls] = useState(detected?.tls ?? false);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setNearby(await discoverDaemons(3000));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (native) void scan();
  }, [native, scan]);

  const submitPaste = () => {
    const link = parsePairLink(paste);
    if (!link) {
      setPasteError('That is not a Companion pairing link (it starts with companion://pair).');
      return;
    }
    onLink(link);
  };

  return (
    <>
      <div className="form-group">
        <label htmlFor="pair-device-name">This device's name</label>
        <input
          id="pair-device-name"
          type="text"
          value={props.deviceName}
          maxLength={60}
          onChange={(e) => props.onDeviceName(e.target.value)}
        />
      </div>

      {native && (
        <section className="pairing-section">
          <div className="pairing-section-head">
            <span>Nearby</span>
            <button className="pairing-link-btn" onClick={() => void scan()} disabled={scanning}>
              {scanning ? 'Searching...' : 'Search again'}
            </button>
          </div>
          {nearby === null && !scanning && (
            <div className="pairing-muted">Nearby search is not available in this app version.</div>
          )}
          {nearby && nearby.length === 0 && !scanning && (
            <div className="pairing-muted">
              No servers found on this network. Make sure the server is running and on the same Wi-Fi, or use a pairing QR.
            </div>
          )}
          {nearby && nearby.length > 0 && (
            <ul className="pairing-nearby">
              {nearby.map((d) => {
                const paired = !!d.daemonId && pairedIds.has(d.daemonId);
                return (
                  <li key={d.key}>
                    <button
                      className="pairing-nearby-item"
                      onClick={() =>
                        d.pairing
                          ? onPair({ host: d.host, port: d.port, tls: d.tls }, d.name)
                          : onManual({ name: d.name, host: d.host, port: d.port, tls: d.tls })
                      }
                    >
                      <span className="pairing-nearby-name">{d.name}</span>
                      <span className="pairing-nearby-meta">
                        {d.host}:{d.port}
                        {d.version ? ` - v${d.version}` : ''}
                      </span>
                      {paired && <span className="pairing-badge">Paired</span>}
                      {!d.pairing && <span className="pairing-badge pairing-badge-muted">Token</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="pairing-section">
        <div className="pairing-section-head"><span>Pairing QR or link</span></div>
        <button className="btn-secondary pairing-wide-btn" onClick={() => setScanQr(true)}>Scan QR code</button>
        <div className="pairing-paste">
          <input
            type="text"
            value={paste}
            placeholder="or paste a companion://pair link"
            onChange={(e) => {
              setPaste(e.target.value);
              setPasteError(null);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') submitPaste(); }}
          />
          <button className="btn-secondary" onClick={submitPaste} disabled={!paste.trim()}>Use link</button>
        </div>
        {pasteError && <div className="pairing-error">{pasteError}</div>}
        <div className="pairing-muted">
          Make one on the server with <code>companion pair --qr</code>, or in the app on a signed-in device: Settings, Devices.
        </div>
      </section>

      <section className="pairing-section">
        <div className="pairing-section-head"><span>Pair by address</span></div>
        <div className="pairing-address">
          <input type="text" value={host} placeholder="192.168.1.100" onChange={(e) => setHost(e.target.value)} aria-label="Host" />
          <input type="number" value={port} onChange={(e) => setPort(e.target.value)} aria-label="Port" />
        </div>
        <label className="pairing-check">
          <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} /> Use TLS (wss://)
        </label>
        <button
          className="btn-primary"
          disabled={!host.trim() || !(Number(port) > 0)}
          onClick={() => onPair({ host: host.trim(), port: Number(port), tls }, host.trim())}
        >
          Pair with a code
        </button>
      </section>

      <button className="pairing-link-btn pairing-advanced" onClick={() => onManual(undefined)}>
        Advanced: enter the server token manually
      </button>

      {scanQr && (
        <QRScannerModal
          hint="Point the camera at the pairing QR"
          onClose={() => setScanQr(false)}
          onText={(text) => {
            const link = parsePairLink(text);
            if (!link) return false;
            setScanQr(false);
            onLink(link);
            return true;
          }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ code flow

function CodePairing(props: {
  target: PairTarget;
  label: string;
  deviceName: string;
  onDone: (t: PairTarget, s: PairState) => void;
}) {
  const { target, label, deviceName, onDone } = props;
  const [state, setState] = useState<PairState>({ phase: 'connecting' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const clientRef = useRef<PairingClient | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const c = new PairingClient(target, (s) => setState({ ...s }));
    clientRef.current = c;
    void c.start(deviceName.trim() || guessDeviceName());
    return () => c.close();
    // deviceName is read once per attempt on purpose.
  }, [target, attempt]); // eslint-disable-line

  useEffect(() => {
    if (state.phase === 'approved') onDone(target, state);
  }, [state, target, onDone]);

  const submit = async () => {
    if (!clientRef.current || code.replace(/\D/g, '').length !== 6) return;
    setBusy(true);
    try {
      await clientRef.current.confirm(code);
    } finally {
      setBusy(false);
      setCode('');
    }
  };

  const finished = state.phase === 'denied' || state.phase === 'expired' || state.phase === 'locked' || state.phase === 'error';

  return (
    <div className="pairing-code">
      <div className="pairing-target">
        Pairing with <strong>{label}</strong> <span className="pairing-muted">({target.host}:{target.port})</span>
      </div>
      {state.phase === 'connecting' && <div className="pairing-muted">Asking the server...</div>}
      {state.phase === 'waiting' && (
        <>
          <p className="pairing-instructions">
            Enter the 6-digit code shown on your server, or approve this device from another one you're signed in on.
          </p>
          <p className="pairing-muted">
            The code is in the server's log, in <code>companion pair</code>, and in the app on your other devices.
          </p>
          <input
            className="pairing-code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            placeholder="123456"
            autoFocus
            onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            aria-label="Pairing code"
          />
          {state.error && (
            <div className="pairing-error">
              {state.error}
              {state.attemptsLeft !== undefined ? ` (${state.attemptsLeft} tries left)` : ''}
            </div>
          )}
          <button className="btn-primary" onClick={() => void submit()} disabled={busy || code.replace(/\D/g, '').length !== 6}>
            {busy ? 'Checking...' : 'Pair'}
          </button>
          <div className="pairing-waiting"><span className="pairing-spinner" /> Waiting for approval</div>
        </>
      )}
      {finished && (
        <>
          <div className="pairing-error">{state.error || 'Pairing failed'}</div>
          <button className="btn-primary" onClick={() => { setState({ phase: 'connecting' }); setAttempt((a) => a + 1); }}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ QR / link

function LinkPairing(props: {
  link: PairLink;
  deviceName: string;
  onDeviceName: (n: string) => void;
  onDone: (t: PairTarget, s: PairState) => void;
}) {
  const { link, deviceName, onDone } = props;
  const [state, setState] = useState<PairState>({ phase: 'idle' });
  const target = useMemo<PairTarget>(() => ({ host: link.host, port: link.port, tls: link.tls }), [link]);

  const go = async () => {
    const c = new PairingClient(target, (s) => setState({ ...s }));
    const s = await c.redeem(link, deviceName.trim() || guessDeviceName());
    if (s.phase === 'approved') onDone(target, s);
  };

  return (
    <div className="pairing-code">
      <div className="pairing-target">
        Pair with <strong>{link.name || link.host}</strong>{' '}
        <span className="pairing-muted">({link.host}:{link.port}{link.tls ? ', TLS' : ''})</span>
      </div>
      <div className="form-group">
        <label htmlFor="pair-link-device-name">This device's name</label>
        <input
          id="pair-link-device-name"
          type="text"
          value={deviceName}
          maxLength={60}
          onChange={(e) => props.onDeviceName(e.target.value)}
        />
      </div>
      {state.error && <div className="pairing-error">{state.error}</div>}
      <button className="btn-primary" onClick={() => void go()} disabled={state.phase === 'connecting'}>
        {state.phase === 'connecting' ? 'Pairing...' : 'Pair this device'}
      </button>
      <p className="pairing-muted">Only open pairing links you made yourself. Each link works once, for 10 minutes.</p>
    </div>
  );
}
