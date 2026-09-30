import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listen = vi.fn();
const invoke = vi.fn();
const addPluginListener = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  addPluginListener: (...a: unknown[]) => addPluginListener(...a),
}));

import {
  chordToAccelerator,
  dispatchNativeEvent,
  getNativeInfo,
  listenNativeHerald,
  setAudioFocus,
  setGlobalShortcuts,
  setMediaSession,
  setTrayTonesMuted,
  type NativeHeraldHandlers,
} from '../nativeBridge';
import { setNativeEnv } from '../../test/nativeEnv';

function handlers(): NativeHeraldHandlers & Record<string, ReturnType<typeof vi.fn>> {
  return { talkDown: vi.fn(), talkUp: vi.fn(), toggle: vi.fn(), brief: vi.fn(), muteTones: vi.fn() };
}

beforeEach(() => {
  listen.mockReset();
  invoke.mockReset();
  addPluginListener.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  setNativeEnv('browser');
  vi.restoreAllMocks();
});

describe('dispatchNativeEvent', () => {
  it.each([
    ['talk_down', 'talkDown'],
    ['talk_up', 'talkUp'],
    ['toggle', 'toggle'],
    ['brief', 'brief'],
    ['mute_tones', 'muteTones'],
  ])('%s runs %s only', (action, handler) => {
    const h = handlers();
    expect(dispatchNativeEvent({ action }, h)).toBe(true);
    for (const [name, fn] of Object.entries(h)) expect(fn).toHaveBeenCalledTimes(name === handler ? 1 : 0);
  });

  it.each([null, undefined, 'toggle', {}, { action: 'reboot' }, { action: 3 }])('ignores %j', (payload) => {
    const h = handlers();
    expect(dispatchNativeEvent(payload, h)).toBe(false);
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('chordToAccelerator', () => {
  it('maps web chords to global-shortcut accelerators', () => {
    expect(chordToAccelerator('Ctrl+Alt+Space')).toBe('Ctrl+Alt+Space');
    expect(chordToAccelerator('Ctrl+Alt+Shift+H')).toBe('Ctrl+Alt+Shift+KeyH');
    expect(chordToAccelerator('Meta+Shift+1')).toBe('Shift+Super+Digit1');
    expect(chordToAccelerator('Alt+F9')).toBe('Alt+F9');
  });

  it('rejects chords that would eat typing or cannot parse', () => {
    expect(chordToAccelerator('H')).toBeNull();
    expect(chordToAccelerator('Shift+H')).toBeNull();
    expect(chordToAccelerator('')).toBeNull();
  });
});

describe('listenNativeHerald', () => {
  it('desktop: listens to the herald-native app event and dispatches its payload', async () => {
    setNativeEnv('desktop');
    const unlisten = vi.fn();
    let cb: ((e: { payload: unknown }) => void) | null = null;
    listen.mockImplementation(async (_name: string, fn: typeof cb) => { cb = fn; return unlisten; });
    const h = handlers();
    const off = await listenNativeHerald(h);
    expect(listen).toHaveBeenCalledWith('herald-native', expect.any(Function));
    cb!({ payload: { action: 'talk_down' } });
    cb!({ payload: { action: 'talk_up' } });
    expect(h.talkDown).toHaveBeenCalledTimes(1);
    expect(h.talkUp).toHaveBeenCalledTimes(1);
    off();
    expect(unlisten).toHaveBeenCalled();
    expect(addPluginListener).not.toHaveBeenCalled();
  });

  it.each(['android', 'ios'] as const)('%s: earbud media events arrive through the plugin listener', async (env) => {
    setNativeEnv(env);
    const unregister = vi.fn().mockResolvedValue(undefined);
    let cb: ((p: unknown) => void) | null = null;
    addPluginListener.mockImplementation(async (_p: string, _e: string, fn: typeof cb) => { cb = fn; return { unregister }; });
    const h = handlers();
    const off = await listenNativeHerald(h);
    expect(addPluginListener).toHaveBeenCalledWith('herald-native', 'media', expect.any(Function));
    cb!({ action: 'toggle' });
    expect(h.toggle).toHaveBeenCalledTimes(1);
    off();
    expect(unregister).toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('browser: no Tauri calls, a harmless unsubscribe', async () => {
    const off = await listenNativeHerald(handlers());
    expect(listen).not.toHaveBeenCalled();
    expect(addPluginListener).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });

  it('a failing native side never throws', async () => {
    setNativeEnv('desktop');
    listen.mockRejectedValue(new Error('no event plugin'));
    const off = await listenNativeHerald(handlers());
    expect(() => off()).not.toThrow();
  });
});

describe('desktop commands', () => {
  it('registers shortcuts as accelerators and returns the results', async () => {
    setNativeEnv('desktop');
    const results = [{ name: 'talk', accelerator: 'Ctrl+Alt+Space', ok: true, error: null }];
    invoke.mockResolvedValue(results);
    await expect(setGlobalShortcuts({ talk: 'Ctrl+Alt+Space', toggle: 'Ctrl+Alt+Shift+H', brief: '' })).resolves.toEqual(results);
    expect(invoke).toHaveBeenCalledWith('herald_set_shortcuts', {
      config: { talk: 'Ctrl+Alt+Space', toggle: 'Ctrl+Alt+Shift+KeyH', brief: null },
    });
  });

  it('an empty config unregisters everything', async () => {
    setNativeEnv('desktop');
    invoke.mockResolvedValue([]);
    await setGlobalShortcuts({});
    expect(invoke).toHaveBeenCalledWith('herald_set_shortcuts', { config: { talk: null, toggle: null, brief: null } });
  });

  it('tray and info commands', async () => {
    setNativeEnv('desktop');
    invoke.mockResolvedValue({ os: 'linux', wayland: true });
    await expect(getNativeInfo()).resolves.toEqual({ os: 'linux', wayland: true });
    await setTrayTonesMuted(true);
    expect(invoke).toHaveBeenCalledWith('herald_set_tray_state', { tonesMuted: true });
  });

  it('a failed command resolves to null instead of throwing', async () => {
    setNativeEnv('desktop');
    invoke.mockRejectedValue(new Error('command herald_set_shortcuts not found'));
    await expect(setGlobalShortcuts({ talk: 'Ctrl+Alt+Space' })).resolves.toBeNull();
  });

  it.each(['browser', 'android', 'ios'] as const)('%s: desktop commands are not sent', async (env) => {
    setNativeEnv(env);
    await expect(setGlobalShortcuts({ talk: 'Ctrl+Alt+Space' })).resolves.toBeNull();
    await expect(getNativeInfo()).resolves.toBeNull();
    await setTrayTonesMuted(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('mobile commands', () => {
  it.each(['android', 'ios'] as const)('%s: media session and audio focus go to the plugin', async (env) => {
    setNativeEnv(env);
    invoke.mockResolvedValue(null);
    await setMediaSession(true);
    await setAudioFocus(false);
    expect(invoke).toHaveBeenCalledWith('plugin:herald-native|set_media_session', { active: true });
    expect(invoke).toHaveBeenCalledWith('plugin:herald-native|set_audio_focus', { active: false });
  });

  it.each(['browser', 'desktop'] as const)('%s: mobile commands are not sent', async (env) => {
    setNativeEnv(env);
    await setMediaSession(true);
    await setAudioFocus(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
