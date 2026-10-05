/**
 * GET /health: unauthenticated liveness for container healthchecks and
 * monitors. Answers ONLY { ok, version, setupComplete }: no name, id, paths,
 * tokens or session data.
 */
import * as http from 'http';
import { isSetupMode } from './config';
import { daemonVersion } from './pairing/identity';
import type { DaemonConfig } from './types';

export const HEALTH_PATH = '/health';

export interface HealthPayload {
  ok: true;
  version: string;
  setupComplete: boolean;
}

/** The version is the build's (version.ts), the same on host installs and in the image. */
export function healthPayload(config: Pick<DaemonConfig, 'setupComplete'>): HealthPayload {
  return {
    ok: true,
    version: daemonVersion(),
    setupComplete: !isSetupMode(config),
  };
}

/** Returns true when it answered (GET/HEAD /health). */
export function handleHealthRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  config: Pick<DaemonConfig, 'setupComplete'>
): boolean {
  if (urlPath !== HEALTH_PATH) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return true;
  }
  const body = JSON.stringify(healthPayload(config));
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
