/**
 * Daemon-side project folders (recents + favorite roots) for the New Session
 * panel. Older daemons do not know `get_project_dirs`: every helper resolves
 * to null on any failure so callers fall back to the local recents store.
 */
import type { ProjectDirsResponse } from '../types/projectDirs';

interface RequestConn {
  sendRequest(
    type: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<{ success: boolean; payload?: unknown; error?: string }>;
}

export type ProjectDirsResult =
  | { ok: true; data: ProjectDirsResponse }
  | { ok: false; error: string };

function parse(payload: unknown): ProjectDirsResponse | null {
  const p = payload as Partial<ProjectDirsResponse> | undefined;
  if (!p || !Array.isArray(p.recents) || !Array.isArray(p.favorites)) return null;
  return { recents: p.recents, favorites: p.favorites };
}

async function request(conn: RequestConn, type: string, payload?: unknown): Promise<ProjectDirsResult> {
  try {
    const resp = await conn.sendRequest(type, payload, 8000);
    const data = resp.success ? parse(resp.payload) : null;
    if (data) return { ok: true, data };
    return { ok: false, error: resp.error || 'Unexpected response' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Null when the daemon does not support project dirs (or the request failed). */
export async function fetchProjectDirs(conn: RequestConn): Promise<ProjectDirsResponse | null> {
  const r = await request(conn, 'get_project_dirs');
  return r.ok ? r.data : null;
}

export function addFavoriteDir(conn: RequestConn, path: string): Promise<ProjectDirsResult> {
  return request(conn, 'add_favorite_dir', { path });
}

export function removeFavoriteDir(conn: RequestConn, path: string): Promise<ProjectDirsResult> {
  return request(conn, 'remove_favorite_dir', { path });
}
