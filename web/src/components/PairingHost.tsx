import { useEffect, useState } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import type { ServerConnection } from '../services/ServerConnection';
import { listenDeepLinks } from '../services/nativeBridge';
import { PairLink, parsePairLink, PendingPairing } from '../services/pairing';
import { AddServerFlow } from './AddServerFlow';
import '../styles/pairing.css';

/**
 * App-wide pairing glue: `companion://pair` deep links open the add-server
 * flow, and every signed-in client offers "Approve new device?".
 */
export function PairingHost() {
  const [link, setLink] = useState<PairLink | null>(null);

  useEffect(() => {
    let off = () => {};
    let alive = true;
    void listenDeepLinks((url) => {
      const l = parsePairLink(url);
      if (l) setLink(l);
    }).then((f) => {
      if (alive) off = f;
      else f();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return (
    <>
      <PairApprovalPrompt />
      {link && <AddServerFlow initialLink={link} onClose={() => setLink(null)} />}
    </>
  );
}

interface ServerPending {
  serverName: string;
  pending: PendingPairing[];
}

/** Pending pairing requests per connected server (pair_pending broadcasts). */
export function usePendingPairings(): Record<string, ServerPending> {
  const [byServer, setByServer] = useState<Record<string, ServerPending>>({});

  useEffect(() => {
    const hooked = new Map<ServerConnection, { off: () => void; connected: boolean }>();
    const attach = () => {
      for (const snap of connectionManager.getSnapshots()) {
        const conn = connectionManager.getConnection(snap.serverId);
        if (!conn) continue;
        const set = (pending: PendingPairing[]) =>
          setByServer((prev) => ({ ...prev, [snap.serverId]: { serverName: conn.getServer().name, pending } }));
        const fetch = () => {
          conn
            .sendRequest('pair_pending_list')
            .then((r) => {
              if (r.success) set(((r.payload as { pending?: PendingPairing[] })?.pending) ?? []);
            })
            .catch(() => {});
        };
        const connected = snap.state.status === 'connected';
        const h = hooked.get(conn);
        if (h) {
          if (connected && !h.connected) fetch();
          h.connected = connected;
          continue;
        }
        const offMsg = conn.onMessage((m) => {
          if (m.type === 'pair_pending') set(((m.payload as { pending?: PendingPairing[] })?.pending) ?? []);
        });
        hooked.set(conn, { off: offMsg, connected });
        if (connected) fetch();
      }
      // Drop servers that went away.
      const live = new Set(connectionManager.getSnapshots().map((s) => s.serverId));
      setByServer((prev) => {
        const keys = Object.keys(prev).filter((k) => !live.has(k));
        if (!keys.length) return prev;
        const next = { ...prev };
        keys.forEach((k) => delete next[k]);
        return next;
      });
    };
    attach();
    const offChange = connectionManager.onChange(() => attach());
    return () => {
      offChange();
      hooked.forEach((h) => h.off());
    };
  }, []);

  return byServer;
}

const PLATFORM_LABEL: Record<string, string> = {
  android: 'Android',
  ios: 'iPhone / iPad',
  desktop: 'Desktop app',
  web: 'Browser',
  cli: 'Command line',
  other: 'Device',
};

/** "Approve new device?" with the code, on every signed-in client. Never by voice. */
export function PairApprovalPrompt() {
  const byServer = usePendingPairings();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const items = Object.entries(byServer).flatMap(([serverId, v]) =>
    v.pending.map((p) => ({ serverId, serverName: v.serverName, p })),
  );
  const now = Date.now();
  const current = items.find(({ p }) => !dismissed.has(p.pairingId) && p.expiresAt > now);

  useEffect(() => {
    if (!current) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [current]);

  if (!current) return null;
  const { serverId, serverName, p } = current;
  const secondsLeft = Math.max(0, Math.round((p.expiresAt - now) / 1000));

  const decide = async (approve: boolean) => {
    const conn = connectionManager.getConnection(serverId);
    if (!conn) return;
    setBusy(true);
    setError(null);
    try {
      const r = await conn.sendRequest(approve ? 'pair_approve' : 'pair_deny', { pairingId: p.pairingId });
      if (!r.success) setError(r.error || 'Failed');
      else setDismissed((d) => new Set(d).add(p.pairingId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pair-approve-overlay" role="dialog" aria-modal="true" aria-label="Approve new device">
      <div className="pair-approve-card">
        <div className="pair-approve-title">Approve new device?</div>
        <div>
          <strong>{p.deviceName}</strong> ({PLATFORM_LABEL[p.platform] || p.platform}) wants to sign in to{' '}
          <strong>{serverName}</strong>.
        </div>
        <div className="pairing-muted">
          From {p.addr}. Its code is below; only approve if you are setting up this device right now.
        </div>
        <div className="pair-approve-code" aria-label="Pairing code">{p.code}</div>
        <div className="pairing-muted">Expires in {secondsLeft}s</div>
        {error && <div className="pairing-error">{error}</div>}
        <div className="pair-approve-actions">
          <button className="pair-approve-deny" disabled={busy} onClick={() => void decide(false)}>Deny</button>
          <button className="pair-approve-approve" disabled={busy} onClick={() => void decide(true)}>Approve</button>
        </div>
        <div className="pair-approve-actions">
          <button className="pair-approve-later" onClick={() => setDismissed((d) => new Set(d).add(p.pairingId))}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
