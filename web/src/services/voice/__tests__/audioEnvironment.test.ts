import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAudioEnvironmentForTests,
  computeEnvironment,
  environmentKey,
  getAudioEnvironment,
  onAudioEnvironmentChange,
  onAudioNotice,
  setNativeRouteSource,
  type AudioNotice,
  type EchoMeasurement,
} from '../audioEnvironment';
import { getAudioGraph } from '../audioGraph';
import type { NativeAudioRoute } from '../audioDevices';

const dev = (kind: string, label: string, deviceId = label, groupId = deviceId) => ({ kind, label, deviceId, groupId });
const closedMic = { open: false, label: null, deviceId: null, mode: 'none' as const, kind: 'unknown' as const };

describe('computeEnvironment', () => {
  it('labels: Windows headset + Discord virtual output', () => {
    const e = computeEnvironment({
      devices: [
        dev('audiooutput', 'Default - Headphones (Arctis 7 Game)', 'default', 'a'),
        dev('audiooutput', 'Headphones (Arctis 7 Game)', 'a'),
        dev('audiooutput', 'CABLE Input (VB-Audio Virtual Cable)', 'v'),
        dev('audioinput', 'Default - Microphone (Arctis 7 Chat)', 'default', 'm'),
        dev('audioinput', 'Microphone (Arctis 7 Chat)', 'm'),
      ],
      route: null,
      mic: closedMic,
      predictedAec: 'in-graph',
      avoidBluetooth: true,
      measured: null,
    });
    expect(e).toMatchObject({ output: 'headphones', input: 'headset', aec: 'in-graph', outputLabel: 'Headphones (Arctis 7 Game)' });
  });

  it('Mac mini: desk speakers in the jack, USB mic -> output unknown until measured', () => {
    const devices = [dev('audiooutput', 'External Headphones (Built-in)'), dev('audioinput', 'Yeti Stereo Microphone')];
    const base = { devices, route: null, mic: closedMic, predictedAec: 'in-graph' as const, avoidBluetooth: true };
    expect(computeEnvironment({ ...base, measured: null })).toMatchObject({ output: 'unknown', input: 'external' });
    // The echo check hears lots of Herald: still not headphones.
    const loud: EchoMeasurement = { erleDb: 31, erlDb: 2, cancelDb: 29, residualSpeechDetected: false, aec: 'in-graph', at: 1, envKey: 'k' };
    expect(computeEnvironment({ ...base, measured: loud }).output).toBe('unknown');
    // Nothing of Herald reaches the mic at all: it is headphones, whatever the label.
    const silent: EchoMeasurement = { erleDb: 62, erlDb: 58, cancelDb: 4, residualSpeechDetected: false, aec: 'in-graph', at: 1, envKey: 'k' };
    expect(computeEnvironment({ ...base, measured: silent }).output).toBe('headphones');
  });

  it('native route (iOS): AirPods for output, built-in mic in use', () => {
    const route: NativeAudioRoute = {
      platform: 'ios',
      outputs: [{ type: 'bluetooth', name: 'AirPods Pro', profile: 'a2dp' }],
      inputs: [{ type: 'builtin-mic', name: 'iPad Microphone' }],
    };
    expect(computeEnvironment({ devices: [], route, mic: closedMic, predictedAec: 'in-graph', avoidBluetooth: true, measured: null }))
      .toMatchObject({ output: 'bluetooth-headphones', input: 'builtin', outputLabel: 'AirPods Pro', inputLabel: 'iPad Microphone' });
  });

  it('an open mic reports what it actually captures with, and its cancellation mode', () => {
    const e = computeEnvironment({
      devices: [dev('audiooutput', 'MacBook Pro Speakers')],
      route: null,
      mic: { open: true, label: 'MacBook Pro Microphone', deviceId: 'mbp', mode: 'browser', kind: 'builtin' },
      predictedAec: 'in-graph',
      avoidBluetooth: true,
      measured: null,
    });
    expect(e).toMatchObject({ output: 'speakers', input: 'builtin', aec: 'browser', inputDeviceId: 'mbp' });
  });

  it('setups are keyed by output, input and canceller', () => {
    const a = environmentKey({ output: 'speakers', input: 'external', aec: 'in-graph', outputLabel: 'Mac mini Speakers', inputLabel: 'Yeti' });
    const b = environmentKey({ output: 'speakers', input: 'external', aec: 'browser', outputLabel: 'Mac mini Speakers', inputLabel: 'Yeti' });
    expect(a).not.toBe(b);
  });
});

describe('audio environment at runtime', () => {
  let devices: ReturnType<typeof dev>[] = [];
  const target = new EventTarget();
  const saved = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  beforeEach(() => {
    __resetAudioEnvironmentForTests();
    devices = [dev('audiooutput', 'Default - Speakers (Realtek(R) Audio)', 'default', 's'), dev('audiooutput', 'Speakers (Realtek(R) Audio)', 's')];
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: async () => devices,
        addEventListener: (t: string, cb: EventListener) => target.addEventListener(t, cb),
        removeEventListener: (t: string, cb: EventListener) => target.removeEventListener(t, cb),
      },
    });
  });
  afterEach(() => {
    setNativeRouteSource(null);
    if (saved) Object.defineProperty(navigator, 'mediaDevices', saved);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  it('devicechange: re-detects, resets the canceller when the output moved, and notifies', async () => {
    const reset = vi.spyOn(getAudioGraph(), 'resetAec');
    const seen: string[] = [];
    const notices: AudioNotice[] = [];
    const off = onAudioEnvironmentChange((e) => seen.push(e.output));
    const offN = onAudioNotice((n) => notices.push(n));
    expect((await getAudioEnvironment()).output).toBe('speakers');
    devices = [dev('audiooutput', 'Default - Headphones (WH-1000XM4 Stereo)', 'default', 'h'), dev('audiooutput', 'Headphones (WH-1000XM4 Stereo)', 'h'), dev('audiooutput', 'Speakers (Realtek(R) Audio)', 's')];
    target.dispatchEvent(new Event('devicechange'));
    target.dispatchEvent(new Event('devicechange')); // bursts collapse into one refresh
    await new Promise((r) => setTimeout(r, 600));
    expect(seen[seen.length - 1]).toBe('bluetooth-headphones');
    expect(reset).toHaveBeenCalledTimes(1);
    expect(notices).toContainEqual({ kind: 'output-changed', label: 'Headphones (WH-1000XM4 Stereo)' });
    off();
    offN();
  });

  it('native route changes are followed too', async () => {
    let r: NativeAudioRoute = { platform: 'android', outputs: [{ type: 'builtin-speaker', name: 'Phone speaker' }], inputs: [] };
    let fire: () => void = () => {};
    setNativeRouteSource({ get: async () => r, onChange: (cb) => { fire = cb; return () => {}; } });
    expect((await getAudioEnvironment()).output).toBe('speakers');
    const seen: string[] = [];
    const off = onAudioEnvironmentChange((e) => seen.push(e.output));
    r = { platform: 'android', outputs: [{ type: 'bluetooth', name: 'Galaxy Buds2', profile: 'a2dp' }], inputs: [] };
    fire();
    await new Promise((res) => setTimeout(res, 150));
    expect(seen[seen.length - 1]).toBe('bluetooth-headphones');
    off();
  });
});

describe('setup key stability', () => {
  it('the same mic gives the same key before and after it opens (Chrome "Default - " track labels, empty labels)', () => {
    const devices = [dev('audiooutput', 'Speakers (Desk)'), dev('audioinput', 'Default - Yeti Stereo Microphone', 'default', 'y'), dev('audioinput', 'Yeti Stereo Microphone', 'y')];
    const base = { devices, route: null, predictedAec: 'in-graph' as const, avoidBluetooth: true, measured: null };
    const closed = computeEnvironment({ ...base, mic: closedMic });
    const openDefault = computeEnvironment({ ...base, mic: { open: true, label: 'Default - Yeti Stereo Microphone', deviceId: 'default', mode: 'in-graph', kind: 'external' } });
    const openNoLabel = computeEnvironment({ ...base, mic: { open: true, label: '', deviceId: null, mode: 'in-graph', kind: 'unknown' } });
    expect(environmentKey(openDefault)).toBe(environmentKey(closed));
    expect(environmentKey(openNoLabel)).toBe(environmentKey(closed));
  });
});
