import { beforeEach, describe, expect, it } from 'vitest';
import { cleanLabel, describeActive, detectDeviceLabel, detectDevicePlatform, deviceKey, deviceLabel, loadCustomLabel, saveCustomLabel } from '../heraldDevice';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
};

describe('detectDeviceLabel', () => {
  it('names browsers by browser and OS', () => {
    expect(detectDeviceLabel({ userAgent: UA.chromeWin, platform: 'Win32' })).toBe('Chrome on Windows');
    expect(detectDeviceLabel({ userAgent: UA.edgeWin })).toBe('Edge on Windows');
    expect(detectDeviceLabel({ userAgent: UA.safariMac, platform: 'MacIntel' })).toBe('Safari on Mac');
    expect(detectDeviceLabel({ userAgent: UA.firefoxLinux })).toBe('Firefox on Linux');
    expect(detectDeviceLabel({ userAgent: UA.android })).toBe('Chrome on Android');
    expect(detectDeviceLabel({ userAgent: '' })).toBe('Browser');
  });

  it('names the Companion app by platform', () => {
    expect(detectDeviceLabel({ userAgent: UA.android, tauri: true })).toBe('Companion app on Android');
    expect(detectDeviceLabel({ userAgent: UA.iphone, tauri: true })).toBe('Companion app on iPhone');
    expect(detectDeviceLabel({ userAgent: UA.safariMac, tauri: true })).toBe('Mac desktop');
    expect(detectDeviceLabel({ userAgent: UA.chromeWin, tauri: true })).toBe('Windows desktop');
  });
});

describe('device identity storage', () => {
  beforeEach(() => localStorage.clear());

  it('a rename persists; an empty name goes back to the detected one', () => {
    expect(loadCustomLabel()).toBeNull();
    expect(saveCustomLabel('  Windows\tPC ')).toBe('Windows PC');
    expect(deviceLabel()).toBe('Windows PC');
    const detected = saveCustomLabel('   ');
    expect(loadCustomLabel()).toBeNull();
    expect(deviceLabel()).toBe(detected);
    expect(cleanLabel('x'.repeat(100))).toHaveLength(60);
  });

  it('the device key is random, valid and stable', () => {
    const k = deviceKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(deviceKey()).toBe(k);
    localStorage.clear();
    expect(deviceKey()).not.toBe(k);
  });

  it('describes the active device', () => {
    expect(describeActive(null, 'me')).toBeNull();
    expect(describeActive({ id: 'me', label: 'Chrome on Mac', pinned: false, reason: 'recent' }, 'me')).toBe('This device');
    expect(describeActive({ id: 'pc', label: 'Windows PC', pinned: true, reason: 'claimed' }, 'me')).toBe('Windows PC · pinned');
  });
});

describe('detectDevicePlatform (reported with presence for "on my PC")', () => {
  const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
  const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  it('OS and native-vs-browser', () => {
    expect(detectDevicePlatform({ userAgent: WIN, tauri: true })).toEqual({ os: 'windows', app: 'native' });
    expect(detectDevicePlatform({ userAgent: WIN })).toEqual({ os: 'windows', app: 'browser' });
    expect(detectDevicePlatform({ userAgent: MAC, tauri: true })).toEqual({ os: 'macos', app: 'native' });
    expect(detectDevicePlatform({ userAgent: ANDROID, tauri: true })).toEqual({ os: 'android', app: 'native' });
    expect(detectDevicePlatform({ userAgent: IPAD })).toEqual({ os: 'ipados', app: 'browser' });
    expect(detectDevicePlatform({ userAgent: 'curl/8' })).toEqual({ os: 'unknown', app: 'browser' });
  });
});
