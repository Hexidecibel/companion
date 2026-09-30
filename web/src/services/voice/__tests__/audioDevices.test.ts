import { describe, expect, it } from 'vitest';
import {
  chooseInput,
  classifyInputLabel,
  classifyInputPort,
  classifyOutput,
  classifyOutputLabel,
  classifyOutputPort,
  looksHandsFree,
  resolveDefault,
  type DeviceLike,
} from '../audioDevices';

const out = (label: string, deviceId = label, groupId?: string): DeviceLike => ({ kind: 'audiooutput', label, deviceId, groupId });
const mic = (label: string, deviceId = label, groupId?: string): DeviceLike => ({ kind: 'audioinput', label, deviceId, groupId });

describe('output classification (labels)', () => {
  it('headphones, Bluetooth headphones, speakers', () => {
    expect(classifyOutputLabel('Headphones (Arctis 7 Game)')).toBe('headphones');
    expect(classifyOutputLabel('Default - Headset Earphone (HyperX Cloud Flight Wireless)')).toBe('headphones');
    expect(classifyOutputLabel('AirPods Pro (Bluetooth)')).toBe('bluetooth-headphones');
    expect(classifyOutputLabel('Headphones (WH-1000XM4 Stereo)')).toBe('bluetooth-headphones');
    expect(classifyOutputLabel('Galaxy Buds2 Pro')).toBe('bluetooth-headphones');
    expect(classifyOutputLabel('Speakers (Realtek(R) Audio)')).toBe('speakers');
    expect(classifyOutputLabel('MacBook Pro Speakers (Built-in)')).toBe('speakers');
    expect(classifyOutputLabel('Mac mini Speakers')).toBe('speakers');
    expect(classifyOutputLabel('LG HDR 4K (HDMI)')).toBe('speakers');
    expect(classifyOutputLabel('JBL Flip 5')).toBe('speakers');
    expect(classifyOutputLabel('Built-in Audio Analog Stereo')).toBe('speakers');
  });

  it('a Mac 3.5 mm jack is NOT headphones: desk speakers plug in there too', () => {
    expect(classifyOutputLabel('External Headphones (Built-in)')).toBe('unknown');
    expect(classifyOutputLabel('External Headphones')).toBe('unknown');
  });

  it('virtual devices say nothing about the real output', () => {
    expect(classifyOutputLabel('CABLE Input (VB-Audio Virtual Cable)')).toBe('unknown');
    expect(classifyOutputLabel('Voicemeeter Input (VB-Audio Voicemeeter VAIO)')).toBe('unknown');
    expect(classifyOutputLabel('BlackHole 2ch')).toBe('unknown');
    expect(classifyOutputLabel('')).toBe('unknown');
  });
});

describe('input classification (labels)', () => {
  it('Bluetooth headset mics (the trap), wired headsets, built-in, USB', () => {
    expect(classifyInputLabel('Headset (WH-1000XM4 Hands-Free AG Audio)')).toBe('bluetooth-headset');
    expect(classifyInputLabel('AirPods Pro (Bluetooth)')).toBe('bluetooth-headset');
    expect(classifyInputLabel('Microphone (Arctis 7 Chat)')).toBe('headset');
    expect(classifyInputLabel('External Microphone (Built-in)')).toBe('headset');
    expect(classifyInputLabel('MacBook Pro Microphone (Built-in)')).toBe('builtin');
    expect(classifyInputLabel('Microphone Array (Realtek(R) Audio)')).toBe('builtin');
    expect(classifyInputLabel('iPad Microphone')).toBe('builtin');
    expect(classifyInputLabel('Yeti Stereo Microphone')).toBe('external');
    expect(classifyInputLabel('Microphone (Shure MV7)')).toBe('external');
    expect(classifyInputLabel('Microphone (Elgato Wave:3)')).toBe('external');
    expect(classifyInputLabel('Microphone (NVIDIA Broadcast)')).toBe('unknown');
  });

  it('recognises Windows hands-free endpoints', () => {
    expect(looksHandsFree('Headset (Jabra Elite 85t Hands-Free AG Audio)')).toBe(true);
    expect(looksHandsFree('Headphones (Jabra Elite 85t Stereo)')).toBe(false);
    expect(looksHandsFree('Microphone (USB Audio Device)')).toBe(false);
  });
});

describe('native ports', () => {
  it('maps route ports; a Bluetooth speaker is a speaker', () => {
    expect(classifyOutputPort({ type: 'bluetooth', name: 'AirPods', profile: 'a2dp' })).toBe('bluetooth-headphones');
    expect(classifyOutputPort({ type: 'bluetooth', name: 'JBL Charge 5', profile: 'a2dp' })).toBe('speakers');
    expect(classifyOutputPort({ type: 'wired-headphones', name: 'Headphones' })).toBe('headphones');
    expect(classifyOutputPort({ type: 'builtin-speaker', name: 'Speaker' })).toBe('speakers');
    expect(classifyOutputPort({ type: 'jack', name: 'External Headphones' })).toBe('unknown');
    expect(classifyOutputPort({ type: 'usb', name: 'HyperX Cloud II' })).toBe('headphones');
    expect(classifyInputPort({ type: 'builtin-mic', name: 'iPhone Microphone' })).toBe('builtin');
    expect(classifyInputPort({ type: 'bluetooth', name: 'AirPods', profile: 'hfp' })).toBe('bluetooth-headset');
    expect(classifyInputPort({ type: 'usb', name: 'Yeti' })).toBe('external');
  });

  it('prefers the native route over labels; WKWebView lists no outputs', () => {
    const devices = [out('Default - Speakers', 'default'), out('Speakers')];
    expect(classifyOutput(devices, { platform: 'ios', outputs: [{ type: 'bluetooth', name: 'AirPods Pro', profile: 'a2dp' }], inputs: [] }).kind).toBe('bluetooth-headphones');
    // WebKit: only inputs; a Bluetooth headset mic tells us the headset is on.
    expect(classifyOutput([mic('AirPods Pro')], null).kind).toBe('bluetooth-headphones');
    expect(classifyOutput([mic('MacBook Pro Microphone')], null).kind).toBe('unknown');
    // macOS route says "jack": unknown, even though labels would guess.
    expect(classifyOutput([], { platform: 'macos', outputs: [{ type: 'jack', name: 'External Headphones' }], inputs: [] }).kind).toBe('unknown');
  });
});

describe('resolveDefault', () => {
  it("finds the real device behind Chrome's 'default' entry", () => {
    const devices = [mic('Default - Yeti Stereo Microphone', 'default', 'g1'), mic('MacBook Pro Microphone', 'm1', 'g2'), mic('Yeti Stereo Microphone', 'y1', 'g1')];
    expect(resolveDefault(devices, 'audioinput')?.deviceId).toBe('y1');
  });
  it('takes the first entry when there is no pseudo default (WebKit)', () => {
    expect(resolveDefault([mic('iPad Microphone', 'a'), mic('AirPods', 'b')], 'audioinput')?.deviceId).toBe('a');
  });
});

describe('chooseInput: the Bluetooth trap', () => {
  const macAirPods = [
    mic('Default - AirPods Pro (Bluetooth)', 'default', 'ga'),
    mic('AirPods Pro (Bluetooth)', 'air', 'ga'),
    mic('MacBook Pro Microphone (Built-in)', 'mbp', 'gb'),
    mic('Yeti Stereo Microphone', 'yeti', 'gy'),
  ];

  it('replaces a Bluetooth headset mic with the built-in one', () => {
    const c = chooseInput(macAirPods, { avoidBluetooth: true });
    expect(c).toMatchObject({ deviceId: 'mbp', kind: 'builtin', reason: 'avoid-bluetooth', onlyBluetooth: false });
  });

  it('Windows: default comms mic is the Hands-Free endpoint -> laptop array', () => {
    const win = [
      mic('Default - Headset (WH-1000XM4 Hands-Free AG Audio)', 'default', 'gh'),
      mic('Communications - Headset (WH-1000XM4 Hands-Free AG Audio)', 'communications', 'gh'),
      mic('Headset (WH-1000XM4 Hands-Free AG Audio)', 'hfp', 'gh'),
      mic('Microphone Array (Realtek(R) Audio)', 'arr', 'gr'),
    ];
    expect(chooseInput(win, { avoidBluetooth: true })).toMatchObject({ deviceId: 'arr', reason: 'avoid-bluetooth' });
  });

  it('a desktop without a built-in mic takes the USB mic', () => {
    const desk = [mic('Default - AirPods Pro', 'default', 'ga'), mic('AirPods Pro', 'air', 'ga'), mic('Yeti Stereo Microphone', 'yeti', 'gy')];
    expect(chooseInput(desk, { avoidBluetooth: true })).toMatchObject({ deviceId: 'yeti', kind: 'external' });
  });

  it('keeps the default when it is not Bluetooth (no pinning: it follows the OS)', () => {
    const c = chooseInput([mic('Default - Yeti Stereo Microphone', 'default', 'gy'), mic('Yeti Stereo Microphone', 'yeti', 'gy'), mic('AirPods Pro', 'air')], { avoidBluetooth: true });
    expect(c).toMatchObject({ reason: 'default', kind: 'external' });
    expect(c.deviceId).toBeUndefined();
  });

  it('warns when the Bluetooth headset is the only mic', () => {
    const c = chooseInput([mic('AirPods Pro (Bluetooth)', 'air')], { avoidBluetooth: true });
    expect(c).toMatchObject({ reason: 'only-bluetooth', onlyBluetooth: true });
    expect(c.deviceId).toBeUndefined();
  });

  it('setting off: keep the Bluetooth mic', () => {
    const c = chooseInput(macAirPods, { avoidBluetooth: false });
    expect(c).toMatchObject({ reason: 'default', kind: 'bluetooth-headset' });
    expect(c.deviceId).toBeUndefined();
  });

  it('never picks a virtual device as the replacement', () => {
    const c = chooseInput([mic('AirPods Pro', 'air'), mic('BlackHole 2ch', 'bh'), mic('Microphone (NVIDIA Broadcast)', 'nv')], { avoidBluetooth: true });
    expect(c.onlyBluetooth).toBe(true);
  });

  it('an explicit pick wins while it exists', () => {
    expect(chooseInput(macAirPods, { avoidBluetooth: true, userDeviceId: 'air' })).toMatchObject({ deviceId: 'air', reason: 'user' });
    expect(chooseInput(macAirPods, { avoidBluetooth: true, userDeviceId: 'gone' }).reason).toBe('avoid-bluetooth');
  });

  it('before permission there are no labels: open the default and decide after', () => {
    const c = chooseInput([mic('', 'x'), mic('', 'y')], { avoidBluetooth: true });
    expect(c.reason).toBe('no-labels');
    expect(c.deviceId).toBeUndefined();
    expect(chooseInput([], { avoidBluetooth: true }).reason).toBe('no-devices');
  });
});
