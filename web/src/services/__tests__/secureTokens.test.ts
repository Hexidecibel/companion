import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  addPluginListener: vi.fn(async () => ({ unregister: async () => {} })),
}));

import { nativeSecureStore, type SecureStoreBackend } from '../nativeBridge';
import {
  initSecureTokens,
  resetSecureTokens,
  secureTokenKey,
  secureTokensActive,
  secureTokensIdle,
} from '../secureTokens';
import { addServer, deleteServer, getServers, saveServers, updateServer } from '../storage';
import { SERVERS_KEY } from '../storageKeys';
import { setNativeEnv } from '../../test/nativeEnv';
import type { Server } from '../../types';

const server = (id: string, token: string, over: Partial<Server> = {}): Server => ({
  id, name: id, host: `10.0.0.${id.length}`, port: 9877, token, useTls: false, ...over,
});
const stored = () => JSON.parse(localStorage.getItem(SERVERS_KEY) || '[]') as Array<Server & { tokenStore?: string }>;

/** An in-memory Keystore / Keychain. */
function memBackend(over: Partial<SecureStoreBackend> = {}) {
  const map = new Map<string, string>();
  const b: SecureStoreBackend & { map: Map<string, string> } = {
    map,
    get: vi.fn(async (k: string) => map.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void map.set(k, v)),
    delete: vi.fn(async (k: string) => void map.delete(k)),
    ...over,
  };
  return b;
}

describe('secure token storage (mobile)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSecureTokens();
    invoke.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    resetSecureTokens();
    setNativeEnv('browser');
    vi.restoreAllMocks();
  });

  it('first launch: moves plaintext tokens to secure storage, then removes the plaintext copy', async () => {
    localStorage.setItem(SERVERS_KEY, JSON.stringify([server('a', 'cdt1.aaa'), server('b', 'legacy-token')]));
    const b = memBackend();
    await initSecureTokens(b);
    expect(b.map.get(secureTokenKey('a'))).toBe('cdt1.aaa');
    expect(b.map.get(secureTokenKey('b'))).toBe('legacy-token');
    expect(stored().map((s) => [s.token, s.tokenStore])).toEqual([['', 'secure'], ['', 'secure']]);
    expect(localStorage.getItem(SERVERS_KEY)).not.toContain('cdt1.aaa');
    // The app still sees the real tokens.
    expect(getServers().map((s) => s.token)).toEqual(['cdt1.aaa', 'legacy-token']);
    expect(getServers()[0]).not.toHaveProperty('tokenStore');
  });

  it('next launch: tokens are read back from secure storage', async () => {
    const b = memBackend();
    localStorage.setItem(SERVERS_KEY, JSON.stringify([server('a', 'cdt1.aaa')]));
    await initSecureTokens(b);
    resetSecureTokens(); // app restart: memory gone
    expect(getServers()[0].token).toBe('');
    await initSecureTokens(b);
    expect(getServers()[0].token).toBe('cdt1.aaa');
  });

  it('keeps the plaintext copy when the write cannot be verified, or the native side is too old', async () => {
    localStorage.setItem(SERVERS_KEY, JSON.stringify([server('a', 'cdt1.aaa')]));
    const lying = memBackend({ get: vi.fn(async () => 'something else') });
    await initSecureTokens(lying);
    expect(stored()[0].token).toBe('cdt1.aaa');
    expect(getServers()[0].token).toBe('cdt1.aaa');

    resetSecureTokens();
    const old = memBackend({
      get: vi.fn(async () => { throw new Error('unknown command'); }),
      set: vi.fn(async () => { throw new Error('unknown command'); }),
    });
    await initSecureTokens(old);
    expect(secureTokensActive()).toBe(false);
    expect(stored()[0].token).toBe('cdt1.aaa');
    // Saving keeps working the old way.
    addServer(server('c', 'cdt1.ccc'));
    expect(stored().find((s) => s.id === 'c')!.token).toBe('cdt1.ccc');
  });

  it('new and changed tokens go to secure storage on save; removed servers forget theirs', async () => {
    const b = memBackend();
    await initSecureTokens(b);
    addServer(server('n', 'cdt1.new'));
    // Never a moment without a copy: plaintext until the move is verified.
    expect(stored()[0].token).toBe('cdt1.new');
    await secureTokensIdle();
    expect(stored()[0]).toMatchObject({ token: '', tokenStore: 'secure' });
    expect(getServers()[0].token).toBe('cdt1.new');

    updateServer({ ...getServers()[0], token: 'cdt1.rotated' });
    await secureTokensIdle();
    expect(b.map.get(secureTokenKey('n'))).toBe('cdt1.rotated');
    expect(getServers()[0].token).toBe('cdt1.rotated');
    expect(localStorage.getItem(SERVERS_KEY)).not.toContain('rotated');

    deleteServer('n');
    await secureTokensIdle();
    expect(b.map.has(secureTokenKey('n'))).toBe(false);
    expect(getServers()).toEqual([]);
  });

  it('other server fields still save normally', async () => {
    const b = memBackend();
    localStorage.setItem(SERVERS_KEY, JSON.stringify([server('a', 'cdt1.aaa')]));
    await initSecureTokens(b);
    saveServers([{ ...getServers()[0], name: 'Renamed' }]);
    expect(stored()[0]).toMatchObject({ name: 'Renamed', token: '', tokenStore: 'secure' });
    expect(getServers()[0]).toMatchObject({ name: 'Renamed', token: 'cdt1.aaa' });
  });

  it('desktop and browser keep app storage (no backend)', async () => {
    setNativeEnv('desktop');
    expect(nativeSecureStore()).toBeNull();
    setNativeEnv('browser');
    expect(nativeSecureStore()).toBeNull();
    localStorage.setItem(SERVERS_KEY, JSON.stringify([server('a', 'cdt1.aaa')]));
    await initSecureTokens();
    expect(secureTokensActive()).toBe(false);
    expect(stored()[0].token).toBe('cdt1.aaa');
  });

  it('the bridge calls the herald-native plugin and rejects on failure', async () => {
    setNativeEnv('android');
    const b = nativeSecureStore()!;
    invoke.mockResolvedValueOnce({ value: 'v1' });
    expect(await b.get('server-token.a')).toBe('v1');
    expect(invoke).toHaveBeenLastCalledWith('plugin:herald-native|secure_get', { key: 'server-token.a' });
    invoke.mockResolvedValueOnce({});
    expect(await b.get('server-token.b')).toBeNull();
    invoke.mockResolvedValueOnce(null);
    await b.set('server-token.a', 'v2');
    expect(invoke).toHaveBeenLastCalledWith('plugin:herald-native|secure_set', { key: 'server-token.a', value: 'v2' });
    invoke.mockResolvedValueOnce(null);
    await b.delete('server-token.a');
    expect(invoke).toHaveBeenLastCalledWith('plugin:herald-native|secure_delete', { key: 'server-token.a' });
    invoke.mockRejectedValueOnce(new Error('Keystore failure'));
    await expect(b.set('x', 'y')).rejects.toThrow('Keystore failure');
    setNativeEnv('ios');
    expect(nativeSecureStore()).not.toBeNull();
  });

  it('end to end on Android with mocked native calls', async () => {
    setNativeEnv('android');
    const map = new Map<string, string>();
    invoke.mockImplementation(async (cmd: string, args: { key: string; value?: string }) => {
      if (cmd.endsWith('secure_set')) map.set(args.key, args.value!);
      if (cmd.endsWith('secure_get')) return map.has(args.key) ? { value: map.get(args.key) } : {};
      if (cmd.endsWith('secure_delete')) map.delete(args.key);
      return null;
    });
    localStorage.setItem(SERVERS_KEY, JSON.stringify([server('a', 'cdt1.aaa')]));
    await initSecureTokens();
    expect(map.get(secureTokenKey('a'))).toBe('cdt1.aaa');
    expect(localStorage.getItem(SERVERS_KEY)).not.toContain('cdt1.aaa');
    expect(getServers()[0].token).toBe('cdt1.aaa');
  });

  it('entry names fit the plugin\'s allowed characters', () => {
    expect(secureTokenKey('1700000000000')).toBe('server-token.1700000000000');
    expect(secureTokenKey('a b/c')).toMatch(/^server-token\.a_b_c\.[0-9a-f]+$/);
    expect(secureTokenKey('a b/c')).not.toBe(secureTokenKey('a_b_c'));
  });
});
