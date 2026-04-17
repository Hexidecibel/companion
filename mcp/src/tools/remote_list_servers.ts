import { DaemonPool } from '../daemon-client';

export interface ListedServer {
  name: string;
  host: string;
  port: number;
  connected: boolean;
  capabilities:
    | {
        exec: boolean;
        dispatch: boolean;
        read: boolean;
        write: { enabled: boolean; roots: string[] };
      }
    | null;
}

export function remoteListServers(
  pool: DaemonPool
): { origin: string; servers: ListedServer[] } {
  const servers: ListedServer[] = pool.list().map((cfg) => {
    const client = pool.getCached(cfg.name);
    const connected = client?.isConnected() ?? false;
    const caps = client?.getCapabilities();
    return {
      name: cfg.name,
      host: cfg.host,
      port: cfg.port,
      connected,
      capabilities: caps
        ? {
            exec: caps.exec,
            dispatch: caps.dispatch,
            read: caps.enabled,
            write: { enabled: caps.write.enabled, roots: caps.write.roots },
          }
        : null,
    };
  });
  return { origin: pool.getOrigin(), servers };
}
