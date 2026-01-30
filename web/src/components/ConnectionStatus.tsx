import { ConnectionState } from '../types';

interface ConnectionStatusProps {
  state: ConnectionState;
}

const statusConfig: Record<ConnectionState['status'], { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'badge-connected' },
  connecting: { label: 'Connecting', className: 'badge-connecting' },
  reconnecting: { label: 'Reconnecting', className: 'badge-connecting' },
  disconnected: { label: 'Disconnected', className: 'badge-disconnected' },
  error: { label: 'Error', className: 'badge-error' },
};

export function ConnectionStatus({ state }: ConnectionStatusProps) {
  const config = statusConfig[state.status];
  return (
    <span className={`connection-badge ${config.className}`}>
      {config.label}
    </span>
  );
}
