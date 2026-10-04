import React, { useState, useEffect } from 'react';
import { Server } from '../types';
import { useServers } from '../hooks/useServers';
import { AddServerFlow } from './AddServerFlow';

interface ServerFormProps {
  serverId?: string;
  onClose: () => void;
}

/**
 * Edit an existing server (token form), or add one: the pairing flow
 * (AddServerFlow) leads, with the token form kept as "Enter token manually".
 */
export function ServerForm({ serverId, onClose }: ServerFormProps) {
  if (!serverId) return <AddServerFlow onClose={onClose} />;
  return <ManualServerForm serverId={serverId} onClose={onClose} />;
}

interface ManualServerFormProps {
  serverId?: string;
  onClose: () => void;
  /** Add mode: prefill from a discovered daemon or the pairing flow. */
  prefill?: { name?: string; host: string; port: number; tls: boolean };
  /** Add mode inside the pairing flow: back to it instead of closing. */
  onBack?: () => void;
}

export function ManualServerForm({ serverId, onClose, prefill, onBack }: ManualServerFormProps) {
  const { getServer, addServer, updateServer } = useServers();
  const existing = serverId ? getServer(serverId) : undefined;

  // Pre-fill host/port from window.location when adding a new server
  // (the web client is typically served by the daemon itself)
  const detectedHost = window.location.hostname;
  const detectedPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
  const detectedTls = window.location.protocol === 'https:';

  const [name, setName] = useState(prefill?.name ?? '');
  const [host, setHost] = useState(existing ? '' : prefill?.host ?? detectedHost);
  const [port, setPort] = useState(existing ? '9877' : String(prefill?.port ?? detectedPort));
  const [token, setToken] = useState('');
  const [useTls, setUseTls] = useState(existing ? false : prefill?.tls ?? detectedTls);
  const [enabled, setEnabled] = useState(true);
  const [sshUser, setSshUser] = useState('');

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setHost(existing.host);
      setPort(String(existing.port));
      setToken(existing.token);
      setUseTls(existing.useTls);
      setEnabled(existing.enabled !== false);
      setSshUser(existing.sshUser || '');
    }
  }, [existing]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const server: Server = {
      ...(existing || {}),
      id: existing?.id || (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      name: name.trim() || host,
      host: host.trim(),
      port: parseInt(port, 10) || 9877,
      token: token.trim(),
      useTls,
      enabled,
      sshUser: sshUser.trim() || undefined,
      // A hand-typed token is the server token (re-pair to get a device token).
      ...(existing && token.trim() === existing.token ? {} : { authKind: 'legacy' as const, deviceId: undefined }),
    };

    if (existing) {
      updateServer(server);
    } else {
      addServer(server);
    }

    onClose();
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content server-form-modal">
        <div className="modal-header">
          {onBack && !existing && (
            <button className="icon-btn small" onClick={onBack} title="Back">&larr;</button>
          )}
          <h3>{existing ? 'Edit Server' : 'Enter token manually'}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="form-container" onFocus={(e) => {
          // Scroll focused input into view on mobile when keyboard opens
          const target = e.target as HTMLElement;
          if (target.tagName === 'INPUT') {
            setTimeout(() => target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
          }
        }}>
          <form onSubmit={handleSubmit} className="server-form">
            <div className="form-group">
              <label htmlFor="name">Name</label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Server"
              />
            </div>

            <div className="form-group">
              <label htmlFor="host">Host</label>
              <input
                id="host"
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="port">Port</label>
              <input
                id="port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="token">Token</label>
              <input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Auth token"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="sshUser">SSH User (optional)</label>
              <input
                id="sshUser"
                type="text"
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                placeholder="username"
              />
            </div>

            <div className="form-group checkbox">
              <input
                id="useTls"
                type="checkbox"
                checked={useTls}
                onChange={(e) => setUseTls(e.target.checked)}
              />
              <label htmlFor="useTls">Use TLS (wss://)</label>
            </div>

            <div className="form-group checkbox">
              <input
                id="enabled"
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <label htmlFor="enabled">Enabled</label>
            </div>

            <button type="submit" className="btn-primary">
              {existing ? 'Save' : 'Add Server'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
