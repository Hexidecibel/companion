import React, { useState, useEffect } from 'react';
import { Server } from '../types';
import { useServers } from '../hooks/useServers';

interface ServerFormProps {
  serverId?: string;
  onBack: () => void;
}

export function ServerForm({ serverId, onBack }: ServerFormProps) {
  const { getServer, addServer, updateServer } = useServers();
  const existing = serverId ? getServer(serverId) : undefined;

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('9877');
  const [token, setToken] = useState('');
  const [useTls, setUseTls] = useState(false);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setHost(existing.host);
      setPort(String(existing.port));
      setToken(existing.token);
      setUseTls(existing.useTls);
      setEnabled(existing.enabled !== false);
    }
  }, [existing]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const server: Server = {
      id: existing?.id || crypto.randomUUID(),
      name: name.trim() || host,
      host: host.trim(),
      port: parseInt(port, 10) || 9877,
      token: token.trim(),
      useTls,
      enabled,
    };

    if (existing) {
      updateServer(server);
    } else {
      addServer(server);
    }

    onBack();
  };

  return (
    <div className="screen">
      <header className="form-header">
        <button className="icon-btn" onClick={onBack}>
          &larr;
        </button>
        <h2>{existing ? 'Edit Server' : 'Add Server'}</h2>
        <div className="header-spacer" />
      </header>

      <div className="form-container">
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
  );
}
