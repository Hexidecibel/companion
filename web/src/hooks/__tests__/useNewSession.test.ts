import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Resp = { success: boolean; payload?: unknown; error?: string; type?: string };
let handler: (type: string, payload: unknown) => Resp | Promise<Resp>;
const calls: Array<{ type: string; payload: unknown }> = [];

vi.mock('../../services/ConnectionManager', () => ({
  connectionManager: {
    getConnection: () => ({
      isConnected: () => true,
      sendRequest: async (type: string, payload?: unknown) => {
        calls.push({ type, payload });
        return handler(type, payload);
      },
    }),
  },
}));

import { useNewSession } from '../useNewSession';
import { addRecentDirectory } from '../../services/recentDirectories';
import { combineRecents, mergeRecents } from '../../services/recentDirectories';
import { fetchProjectDirs } from '../../services/projectDirs';

const tmuxPayload = { sessions: [{ name: 's', workingDir: '/live/one' }], activeSession: null, homeDir: '/h' };
const browsePayload = { currentPath: '/h', entries: [] };

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
});

describe('recents helpers', () => {
  it('mergeRecents dedupes by path (trailing slash too), newest wins, sorted, capped', () => {
    const out = mergeRecents(
      [
        [{ path: '/a', name: 'a', lastUsed: 1 }, { path: '/b/', name: 'b', lastUsed: 5 }],
        [{ path: '/a/', name: 'a', lastUsed: 9 }, { path: '/c', name: 'c', lastUsed: 2 }],
      ],
      2,
    );
    expect(out).toEqual([
      { path: '/a', name: 'a', lastUsed: 9 },
      { path: '/b', name: 'b', lastUsed: 5 },
    ]);
  });

  it('combineRecents puts explicit recents before live-session dirs', () => {
    const out = combineRecents(
      [{ path: '/d', name: 'd', lastUsed: 3 }],
      [{ path: '/l', name: 'l', lastUsed: 4 }],
      [{ path: '/s', name: 's', lastUsed: 100 }, { path: '/d', name: 'd', lastUsed: 100 }],
      10,
    );
    expect(out.map((d) => d.path)).toEqual(['/l', '/d', '/s']);
  });

  it('fetchProjectDirs returns null for an older daemon / timeout', async () => {
    expect(
      await fetchProjectDirs({ sendRequest: async () => ({ success: false, error: 'Unknown message type: get_project_dirs' }) }),
    ).toBeNull();
    expect(
      await fetchProjectDirs({ sendRequest: async () => { throw new Error('Request timeout'); } }),
    ).toBeNull();
  });
});

describe('useNewSession', () => {
  it('uses daemon recents + favorites, keeps local recents and live session dirs', async () => {
    addRecentDirectory('srv', '/local/old');
    handler = (type) => {
      if (type === 'get_project_dirs') {
        return {
          success: true,
          payload: {
            recents: [{ path: '/daemon/p', name: 'p', lastUsed: Date.now() + 1000 }],
            favorites: [{ root: '/src', name: 'src', entries: [{ name: 'x', path: '/src/x' }] }],
          },
        };
      }
      if (type === 'list_tmux_sessions') return { success: true, payload: tmuxPayload };
      if (type === 'browse_directories') return { success: true, payload: browsePayload };
      return { success: false, error: 'Unknown' };
    };
    const { result } = renderHook(() => useNewSession('srv'));
    await waitFor(() => expect(result.current.recentsLoading).toBe(false));
    expect(result.current.favoritesSupported).toBe(true);
    expect(result.current.favorites[0].entries[0].path).toBe('/src/x');
    expect(result.current.recents.map((r) => r.path)).toEqual(['/daemon/p', '/local/old', '/live/one']);
  });

  it('falls back to local recents on an older daemon', async () => {
    addRecentDirectory('srv', '/local/old');
    handler = (type) => {
      if (type === 'list_tmux_sessions') return { success: true, payload: tmuxPayload };
      if (type === 'browse_directories') return { success: true, payload: browsePayload };
      return { success: false, error: `Unknown message type: ${type}` };
    };
    const { result } = renderHook(() => useNewSession('srv'));
    await waitFor(() => expect(result.current.recentsLoading).toBe(false));
    expect(result.current.favoritesSupported).toBe(false);
    expect(result.current.favorites).toEqual([]);
    expect(result.current.recents.map((r) => r.path)).toEqual(['/local/old', '/live/one']);
  });

  it('pin / unpin update favorites from the daemon answer; errors surface', async () => {
    const fav = { root: '/h/src', name: 'src', entries: [] };
    handler = (type, payload) => {
      if (type === 'get_project_dirs') return { success: true, payload: { recents: [], favorites: [] } };
      if (type === 'add_favorite_dir') {
        return (payload as { path: string }).path === '/h/src'
          ? { success: true, payload: { recents: [], favorites: [fav] } }
          : { success: false, error: 'Not a folder: /nope' };
      }
      if (type === 'remove_favorite_dir') return { success: true, payload: { recents: [], favorites: [] } };
      if (type === 'list_tmux_sessions') return { success: true, payload: tmuxPayload };
      return { success: true, payload: browsePayload };
    };
    const { result } = renderHook(() => useNewSession('srv'));
    await waitFor(() => expect(result.current.recentsLoading).toBe(false));
    await act(async () => { expect(await result.current.pinFavorite('/h/src')).toBe(true); });
    expect(result.current.favorites).toEqual([fav]);
    await act(async () => { expect(await result.current.pinFavorite('/nope')).toBe(false); });
    expect(result.current.error).toBe('Not a folder: /nope');
    await act(async () => { await result.current.unpinFavorite('/h/src'); });
    expect(result.current.favorites).toEqual([]);
    expect(calls.find((c) => c.type === 'remove_favorite_dir')?.payload).toEqual({ path: '/h/src' });
  });
});
