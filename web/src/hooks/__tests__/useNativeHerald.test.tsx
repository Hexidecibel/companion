import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, fireEvent } from '@testing-library/react';

const bridge = vi.hoisted(() => ({
  listenNativeHerald: vi.fn(),
  setGlobalShortcuts: vi.fn(),
  getNativeInfo: vi.fn(),
  setTrayState: vi.fn(),
  getPassthroughStatus: vi.fn(),
  listenPassthroughStatus: vi.fn(),
  requestInputMonitoring: vi.fn(),
  setMediaSession: vi.fn(),
  setAudioFocus: vi.fn(),
}));
vi.mock('../../services/nativeBridge', () => bridge);

import {
  DEFAULT_NATIVE_PREFS,
  defaultPassthrough,
  loadNativePrefs,
  passthroughFor,
  nativeHandlers,
  nativeHeraldStore,
  useNativeHerald,
  type NativeHeraldHost,
} from '../useNativeHerald';
import { NativeHeraldSettings } from '../../components/herald/NativeHeraldSettings';
import type { NativeHeraldHandlers } from '../../services/nativeBridge';
import type { VoiceInputState } from '../../services/voice/voiceInput';

const idle: VoiceInputState = { phase: 'idle', source: null, level: 0, error: null, permission: 'granted' };

function makeHost(over: Partial<NativeHeraldHost> = {}, input: Partial<NativeHeraldHost['input']> = {}): NativeHeraldHost {
  return {
    runTrigger: vi.fn(),
    input: { state: idle, available: true, unavailableReason: null, start: vi.fn(), stop: vi.fn(), ...input },
    tonesOn: true,
    setTonesOn: vi.fn(),
    speaking: false,
    enabled: true,
    tone: vi.fn(),
    notice: vi.fn(),
    ...over,
  };
}

let captured: NativeHeraldHandlers | null = null;
const unlisten = vi.fn();

beforeEach(() => {
  localStorage.clear();
  nativeHeraldStore.reset();
  captured = null;
  unlisten.mockReset();
  bridge.listenNativeHerald.mockReset().mockImplementation(async (h: NativeHeraldHandlers) => { captured = h; return unlisten; });
  bridge.setGlobalShortcuts.mockReset().mockResolvedValue([]);
  bridge.getNativeInfo.mockReset().mockResolvedValue({ os: 'linux', wayland: false });
  bridge.setTrayState.mockReset().mockResolvedValue(undefined);
  bridge.getPassthroughStatus.mockReset().mockResolvedValue(null);
  bridge.listenPassthroughStatus.mockReset().mockResolvedValue(() => {});
  bridge.requestInputMonitoring.mockReset().mockResolvedValue(false);
  bridge.setMediaSession.mockReset().mockResolvedValue(undefined);
  bridge.setAudioFocus.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('nativeHandlers', () => {
  it('talk down starts a global capture; talk up stops only that capture', () => {
    const host = makeHost();
    const h = nativeHandlers(() => host);
    h.talkDown();
    expect(host.input.start).toHaveBeenCalledWith('global');
    h.talkUp();
    expect(host.input.stop).not.toHaveBeenCalled(); // state still idle here: not ours
    host.input.state = { ...idle, phase: 'listening', source: 'global' };
    h.talkUp();
    expect(host.input.stop).toHaveBeenCalledTimes(1);
  });

  it('key auto-repeat or a running capture never restarts', () => {
    const host = makeHost({}, { state: { ...idle, phase: 'listening', source: 'global' } });
    nativeHandlers(() => host).talkDown();
    expect(host.input.start).not.toHaveBeenCalled();
  });

  it('push-to-talk from another capture source is not ended by the global release', () => {
    const host = makeHost({}, { state: { ...idle, phase: 'listening', source: 'button' } });
    nativeHandlers(() => host).talkUp();
    expect(host.input.stop).not.toHaveBeenCalled();
  });

  it('unavailable voice input: error tone and a notice, no capture', () => {
    const host = makeHost({}, { available: false, unavailableReason: 'Voice service offline' });
    nativeHandlers(() => host).talkDown();
    expect(host.input.start).not.toHaveBeenCalled();
    expect(host.tone).toHaveBeenCalledWith('error');
    expect(host.notice).toHaveBeenCalledWith('Voice service offline');
  });

  it('toggle and brief run the remote-trigger actions', () => {
    const host = makeHost();
    const h = nativeHandlers(() => host);
    h.toggle();
    h.brief();
    expect(host.runTrigger).toHaveBeenNthCalledWith(1, 'toggle');
    expect(host.runTrigger).toHaveBeenNthCalledWith(2, 'brief');
  });

  it('mute tones flips the tones preference', () => {
    const host = makeHost({ tonesOn: true });
    nativeHandlers(() => host).muteTones();
    expect(host.setTonesOn).toHaveBeenCalledWith(false);
  });

  it('the overlay stop button, the tray item and the stop shortcut run the stop trigger', () => {
    const host = makeHost();
    nativeHandlers(() => host).stop();
    expect(host.runTrigger).toHaveBeenCalledWith('stop');
  });

  it('hold-to-talk while Herald speaks: stops on key-down, then listens', () => {
    const order: string[] = [];
    const host = makeHost(
      { speaking: true, speakingAnywhere: true, bargeIn: vi.fn(() => order.push('stop')) },
      { start: vi.fn(() => order.push('listen')) },
    );
    nativeHandlers(() => host).talkDown();
    expect(order).toEqual(['stop', 'listen']);
    expect(host.input.start).toHaveBeenCalledWith('global');
  });

  it('hold-to-talk while ANOTHER device speaks: stops that one too', () => {
    const bargeIn = vi.fn();
    const host = makeHost({ speaking: false, speakingAnywhere: true, bargeIn });
    nativeHandlers(() => host).talkDown();
    expect(bargeIn).toHaveBeenCalledTimes(1);
  });

  it('hold-to-talk while quiet: no barge-in; auto-repeat while speaking still stops (idempotent)', () => {
    const bargeIn = vi.fn();
    const quiet = makeHost({ bargeIn });
    nativeHandlers(() => quiet).talkDown();
    expect(bargeIn).not.toHaveBeenCalled();
    const busy = makeHost({ speaking: true, bargeIn }, { state: { ...idle, phase: 'listening', source: 'global' } });
    nativeHandlers(() => busy).talkDown();
    expect(bargeIn).toHaveBeenCalledTimes(1);
    expect(busy.input.start).not.toHaveBeenCalled();
  });

  it('tray volume reaches the volume command', () => {
    const volumeCommand = vi.fn();
    const host = makeHost({ volumeCommand });
    nativeHandlers(() => host).volume({ kind: 'set', value: 0.8 });
    expect(volumeCommand).toHaveBeenCalledWith({ kind: 'set', value: 0.8 });
  });

  it('while the device check waits for a press, presses go to it instead of Herald', () => {
    const host = makeHost();
    const probe = vi.fn();
    nativeHeraldStore.setProbe(probe);
    const h = nativeHandlers(() => host);
    h.talkDown();
    h.talkUp();
    h.toggle();
    h.brief();
    expect(probe.mock.calls.map((c) => c[0])).toEqual(['talk_down', 'talk_up', 'toggle', 'brief']);
    expect(host.input.start).not.toHaveBeenCalled();
    expect(host.runTrigger).not.toHaveBeenCalled();
    nativeHeraldStore.setProbe(null);
    h.toggle();
    expect(host.runTrigger).toHaveBeenCalledWith('toggle');
  });
});

describe('passthrough defaults', () => {
  it('on for hold-to-talk on Windows and macOS only', () => {
    const prefs = DEFAULT_NATIVE_PREFS;
    expect(passthroughFor(prefs, 'talk', { os: 'windows', wayland: false, passthrough: true })).toBe(true);
    expect(passthroughFor(prefs, 'talk', { os: 'macos', wayland: false, passthrough: true })).toBe(true);
    expect(passthroughFor(prefs, 'stop', { os: 'windows', wayland: false, passthrough: true })).toBe(false);
    expect(passthroughFor(prefs, 'toggle', { os: 'macos', wayland: false, passthrough: true })).toBe(false);
    // Linux (or an older app without the feature): never.
    expect(passthroughFor(prefs, 'talk', { os: 'linux', wayland: false, passthrough: false })).toBe(false);
    expect(passthroughFor(prefs, 'talk', { os: 'windows', wayland: false })).toBe(false);
    expect(passthroughFor(prefs, 'talk', null)).toBe(false);
    expect(defaultPassthrough('talk', 'windows')).toBe(true);
  });

  it('an explicit choice wins and persists', () => {
    const win = { os: 'windows', wayland: false, passthrough: true };
    nativeHeraldStore.setPassthrough('talk', false);
    nativeHeraldStore.setPassthrough('stop', true);
    const p = loadNativePrefs();
    expect(passthroughFor(p, 'talk', win)).toBe(false);
    expect(passthroughFor(p, 'stop', win)).toBe(true);
  });

  it('desktop on Windows: hold-to-talk is registered as passthrough', async () => {
    bridge.getNativeInfo.mockResolvedValue({ os: 'windows', wayland: false, passthrough: true });
    renderHook(() => useNativeHerald(makeHost(), 'desktop'));
    await act(async () => {});
    expect(bridge.setGlobalShortcuts).toHaveBeenLastCalledWith(
      expect.objectContaining({ talk: 'Ctrl+Alt+Space', passthrough: { talk: true, toggle: false, brief: false, stop: false } }),
    );
  });
});

describe('native prefs', () => {
  it('defaults avoid Discord and the browser chords', () => {
    expect(loadNativePrefs()).toEqual(DEFAULT_NATIVE_PREFS);
    const chords = [DEFAULT_NATIVE_PREFS.talkChord, DEFAULT_NATIVE_PREFS.toggleChord, DEFAULT_NATIVE_PREFS.briefChord, DEFAULT_NATIVE_PREFS.stopChord];
    for (const c of chords) expect(['Ctrl+Shift+M', 'Ctrl+Shift+D', 'Ctrl+Shift+Space', 'Ctrl+Shift+B']).not.toContain(c);
    expect(DEFAULT_NATIVE_PREFS.stopChord).toBe('Ctrl+Alt+Shift+S');
    expect(new Set(chords).size).toBe(chords.length);
  });

  it('persists edits and drops invalid stored chords', () => {
    nativeHeraldStore.setPref('talkChord', 'Ctrl+Alt+T');
    nativeHeraldStore.setPref('briefChord', '');
    expect(loadNativePrefs().talkChord).toBe('Ctrl+Alt+T');
    expect(loadNativePrefs().briefChord).toBe(''); // explicitly off
    localStorage.setItem('herald_native_prefs', JSON.stringify({ talkChord: 'T', earbudButton: 'yes' }));
    expect(loadNativePrefs().talkChord).toBe(DEFAULT_NATIVE_PREFS.talkChord);
    expect(loadNativePrefs().earbudButton).toBe(true);
  });
});

describe('useNativeHerald', () => {
  it('browser: touches nothing native', async () => {
    renderHook(() => useNativeHerald(makeHost(), 'browser'));
    await act(async () => {});
    expect(bridge.listenNativeHerald).not.toHaveBeenCalled();
    expect(bridge.setGlobalShortcuts).not.toHaveBeenCalled();
    expect(bridge.setMediaSession).not.toHaveBeenCalled();
  });

  it('desktop: registers the shortcuts, re-registers on change, clears when off', async () => {
    bridge.setGlobalShortcuts.mockResolvedValue([{ name: 'talk', accelerator: 'Ctrl+Alt+Space', ok: false, error: 'taken' }]);
    const { unmount } = renderHook(() => useNativeHerald(makeHost(), 'desktop'));
    await act(async () => {});
    expect(bridge.setGlobalShortcuts).toHaveBeenLastCalledWith({
      talk: 'Ctrl+Alt+Space',
      toggle: 'Ctrl+Alt+Shift+H',
      brief: 'Ctrl+Alt+Shift+B',
      stop: 'Ctrl+Alt+Shift+S',
      // Linux: no passthrough (the info says so), everything exclusive.
      passthrough: { talk: false, toggle: false, brief: false, stop: false },
    });
    expect(nativeHeraldStore.get().shortcuts[0].ok).toBe(false);
    expect(nativeHeraldStore.get().info).toEqual({ os: 'linux', wayland: false });
    expect(bridge.setTrayState).toHaveBeenLastCalledWith(false, undefined);

    await act(async () => nativeHeraldStore.setPref('toggleChord', 'Ctrl+Alt+Shift+J'));
    expect(bridge.setGlobalShortcuts).toHaveBeenLastCalledWith(expect.objectContaining({ toggle: 'Ctrl+Alt+Shift+J' }));
    await act(async () => nativeHeraldStore.setPref('globalShortcuts', false));
    expect(bridge.setGlobalShortcuts).toHaveBeenLastCalledWith({});
    expect(bridge.setMediaSession).not.toHaveBeenCalled();

    unmount();
    expect(unlisten).toHaveBeenCalled();
  });

  it('native input reaches the host through the listener', async () => {
    const host = makeHost();
    renderHook(() => useNativeHerald(host, 'desktop'));
    await act(async () => {});
    captured!.toggle();
    captured!.talkDown();
    expect(host.runTrigger).toHaveBeenCalledWith('toggle');
    expect(host.input.start).toHaveBeenCalledWith('global');
  });

  it('plays the listening earcon once when a global capture opens the mic', async () => {
    const host = makeHost();
    const { rerender } = renderHook((h: NativeHeraldHost) => useNativeHerald(h, 'desktop'), { initialProps: host });
    await act(async () => {});
    const listening = { ...host, input: { ...host.input, state: { ...idle, phase: 'listening' as const, source: 'global' as const } } };
    rerender(listening);
    rerender({ ...listening, speaking: true });
    expect(host.tone).toHaveBeenCalledTimes(1);
    expect(host.tone).toHaveBeenCalledWith('wake');
    // Push-to-talk from the page does not chime.
    rerender({ ...host, input: { ...host.input, state: { ...idle, phase: 'listening', source: 'button' } } });
    expect(host.tone).toHaveBeenCalledTimes(1);
  });

  it('mobile: the earbud button follows Herald being usable and the preference', async () => {
    const host = makeHost({ enabled: false });
    const { rerender } = renderHook((h: NativeHeraldHost) => useNativeHerald(h, 'android'), { initialProps: host });
    await act(async () => {});
    expect(bridge.setMediaSession).toHaveBeenLastCalledWith(false);
    rerender({ ...host, enabled: true });
    expect(bridge.setMediaSession).toHaveBeenLastCalledWith(true);
    await act(async () => nativeHeraldStore.setPref('earbudButton', false));
    expect(bridge.setMediaSession).toHaveBeenLastCalledWith(false);
    expect(bridge.setGlobalShortcuts).not.toHaveBeenCalled();
  });

  it('mobile: audio focus (ducking) follows Herald speaking', async () => {
    const host = makeHost();
    const { rerender } = renderHook((h: NativeHeraldHost) => useNativeHerald(h, 'ios'), { initialProps: host });
    await act(async () => {});
    rerender({ ...host, speaking: true });
    expect(bridge.setAudioFocus).toHaveBeenLastCalledWith(true);
    rerender({ ...host, speaking: false });
    expect(bridge.setAudioFocus).toHaveBeenLastCalledWith(false);
  });

  it('mobile: ducking can be turned off', async () => {
    nativeHeraldStore.setPref('duckOthers', false);
    const host = makeHost();
    const { rerender } = renderHook((h: NativeHeraldHost) => useNativeHerald(h, 'android'), { initialProps: host });
    await act(async () => {});
    rerender({ ...host, speaking: true });
    expect(bridge.setAudioFocus).not.toHaveBeenCalledWith(true);
  });
});

describe('NativeHeraldSettings', () => {
  it('renders nothing in a browser', () => {
    const { container } = render(<NativeHeraldSettings platform="browser" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('desktop: shortcut rows, conflicts and the Wayland note', () => {
    nativeHeraldStore.setShortcuts([{ name: 'brief', accelerator: 'Ctrl+Alt+Shift+KeyB', ok: false, error: 'already registered' }]);
    nativeHeraldStore.setInfo({ os: 'linux', wayland: true });
    render(<NativeHeraldSettings platform="desktop" />);
    expect(screen.getByText('Hold to talk')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Alt+Space')).toBeInTheDocument();
    expect(screen.getByText(/Ctrl\+Alt\+Shift\+B is taken by another app/)).toBeInTheDocument();
    expect(screen.getByText(/Wayland limits system-wide shortcuts/)).toBeInTheDocument();
    expect(screen.queryByText(/Earbud/)).toBeNull();
  });

  it('desktop on Windows: the stop row and the per-shortcut passthrough switch (on for talk)', () => {
    nativeHeraldStore.setInfo({ os: 'windows', wayland: false, passthrough: true });
    render(<NativeHeraldSettings platform="desktop" />);
    expect(screen.getByText('Stop speaking (tap)')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+Alt+Shift+S')).toBeInTheDocument();
    const talk = screen.getByText(/Let other apps see this key too \(recommended for push-to-talk\)/).closest('button')!;
    expect(talk).toHaveAttribute('aria-checked', 'true');
    const others = screen.getAllByRole('menuitemcheckbox').filter((b) => /Let other apps see this key too$/.test(b.textContent ?? ''));
    expect(others).toHaveLength(3);
    for (const b of others) expect(b).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(talk);
    expect(nativeHeraldStore.get().prefs.passthrough.talk).toBe(false);
  });

  it('desktop on macOS without Input Monitoring: explains and offers the permission', () => {
    nativeHeraldStore.setInfo({ os: 'macos', wayland: false, passthrough: true });
    nativeHeraldStore.setShortcuts([{ name: 'talk', accelerator: 'Ctrl+Alt+Space', ok: true, error: null, mode: 'exclusive', passthroughError: 'needs_permission' }]);
    render(<NativeHeraldSettings platform="desktop" />);
    expect(screen.getByText(/macOS needs the Input Monitoring permission/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Allow Input Monitoring…'));
    expect(bridge.requestInputMonitoring).toHaveBeenCalled();
  });

  it('desktop on Windows with an elevated game in front: says to run Companion as admin', () => {
    nativeHeraldStore.setInfo({ os: 'windows', wayland: false, passthrough: true });
    nativeHeraldStore.setPassthroughStatus({ supported: true, running: true, needsPermission: false, selfElevated: false, foregroundElevated: true });
    render(<NativeHeraldSettings platform="desktop" />);
    expect(screen.getByText(/runs as administrator/)).toBeInTheDocument();
  });

  it('desktop on Linux: no passthrough switch, a note instead', () => {
    nativeHeraldStore.setInfo({ os: 'linux', wayland: false, passthrough: false });
    render(<NativeHeraldSettings platform="desktop" />);
    expect(screen.queryByText(/Let other apps see this key too/)).toBeNull();
    expect(screen.getByText(/On Linux these keys belong to Companion alone/)).toBeInTheDocument();
  });

  it('desktop: capture a new chord; Backspace turns one off', () => {
    render(<NativeHeraldSettings platform="desktop" />);
    fireEvent.click(screen.getByText('Listen / stop (tap)'));
    expect(screen.getByText('Press keys…')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
    expect(nativeHeraldStore.get().prefs.toggleChord).toBe('Ctrl+Alt+K');
    fireEvent.click(screen.getByText('Brief me (tap)'));
    fireEvent.keyDown(window, { key: 'Backspace', code: 'Backspace' });
    expect(nativeHeraldStore.get().prefs.briefChord).toBe('');
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it.each(['android', 'ios'] as const)('%s: only the earbud toggle', (p) => {
    render(<NativeHeraldSettings platform={p} />);
    const toggle = screen.getByRole('menuitemcheckbox', { name: /Earbud button/ });
    expect(screen.queryByText('Hold to talk')).toBeNull();
    fireEvent.click(toggle);
    expect(nativeHeraldStore.get().prefs.earbudButton).toBe(false);
  });
});
