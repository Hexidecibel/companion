import { useCallback, useEffect, useState } from 'react';
import { connectionManager } from '../services/ConnectionManager';
import { useServers } from '../hooks/useServers';
import { guessDeviceName, pairingPlatform } from '../services/pairing';
import '../styles/pairing.css';

interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number | null;
  via: string;
}

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Settings > Devices for one connected server. */
export function DevicesCard({ serverId, serverName }: { serverId: string; serverName: string }) {
  const { getServer, updateServer } = useServers();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [qr, setQr] = useState<{ link: string; qrDataUrl?: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const conn = connectionManager.getConnection(serverId);

  const load = useCallback(async () => {
    if (!conn) return;
    try {
      const r = await conn.sendRequest('devices_list');
      if (!r.success) {
        if (/Unknown message type/i.test(r.error || '')) setUnsupported(true);
        else setError(r.error || 'Failed to load devices');
        return;
      }
      const p = r.payload as { devices: DeviceInfo[]; currentDeviceId: string | null };
      setDevices(p.devices);
      setCurrentId(p.currentDeviceId);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [conn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!conn) return null;
  const server = getServer(serverId);

  const run = async (type: string, payload: unknown, after?: (p: any) => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await conn.sendRequest(type, payload);
      if (!r.success) setError(r.error || 'Failed');
      else after?.(r.payload);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (unsupported) {
    return (
      <div className="settings-card">
        <div className="settings-card-label">{serverName}</div>
        <div className="settings-card-detail">This server does not support device pairing yet. Update it to manage devices.</div>
      </div>
    );
  }

  return (
    <div className="settings-card devices-card">
      <div className="settings-card-label">{serverName}</div>
      {devices && devices.length === 0 && (
        <div className="settings-card-detail">No paired devices yet. Everything signed in with the server token.</div>
      )}
      {devices && devices.length > 0 && (
        <ul className="devices-list">
          {devices.map((d) => (
            <li key={d.id} className="devices-row">
              {renaming?.id === d.id ? (
                <>
                  <input
                    value={renaming.name}
                    maxLength={60}
                    autoFocus
                    onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void run('device_rename', { deviceId: d.id, name: renaming.name }, () => { setRenaming(null); void load(); });
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    aria-label="Device name"
                  />
                  <button className="settings-action-btn" disabled={busy || !renaming.name.trim()} onClick={() => void run('device_rename', { deviceId: d.id, name: renaming.name }, () => { setRenaming(null); void load(); })}>Save</button>
                </>
              ) : (
                <>
                  <div className="devices-row-info">
                    <span className="devices-row-name">
                      {d.name}
                      {d.id === currentId && <span className="devices-this">This device</span>}
                    </span>
                    <span className="devices-row-meta">
                      {d.platform} - last seen {ago(d.lastSeenAt)} - paired {new Date(d.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <button className="settings-action-btn" onClick={() => setRenaming({ id: d.id, name: d.name })}>Rename</button>
                  {confirmRevoke === d.id ? (
                    <button
                      className="settings-action-btn settings-action-btn-danger"
                      disabled={busy}
                      onClick={() => void run('device_revoke', { deviceId: d.id }, () => { setConfirmRevoke(null); void load(); })}
                    >
                      {d.id === currentId ? 'Sign this app out?' : 'Confirm'}
                    </button>
                  ) : (
                    <button className="settings-action-btn settings-action-btn-danger" onClick={() => setConfirmRevoke(d.id)}>Revoke</button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="pairing-error">{error}</div>}
      <div className="devices-actions">
        <button
          className="settings-action-btn"
          disabled={busy || !server}
          onClick={() =>
            server &&
            void run('pair_qr_create', { host: server.host, port: server.port, tls: server.useTls }, (p) => setQr(p))
          }
        >
          Show pairing QR
        </button>
        {conn.authKind === 'legacy' && server && (
          <button
            className="settings-action-btn"
            disabled={busy}
            onClick={() =>
              void run('device_upgrade', { deviceName: guessDeviceName(), platform: pairingPlatform() }, (p) => {
                updateServer({ ...server, token: p.token, deviceId: p.deviceId, daemonId: p.daemonId, authKind: 'device' });
                void load();
              })
            }
          >
            Upgrade to a device token
          </button>
        )}
      </div>
      {qr && (
        <div className="devices-qr">
          {qr.qrDataUrl && <img src={qr.qrDataUrl} alt="Pairing QR code" />}
          <div className="settings-card-detail">
            Scan with the new device (Add server, Scan QR). One device, single use, until{' '}
            {new Date(qr.expiresAt).toLocaleTimeString()}.
          </div>
          <div className="devices-qr-link">{qr.link}</div>
          <button className="settings-action-btn" onClick={() => setQr(null)}>Hide</button>
        </div>
      )}
    </div>
  );
}
