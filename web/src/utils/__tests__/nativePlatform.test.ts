import { afterEach, describe, expect, it } from 'vitest';
import { isNativeApp, nativePlatform } from '../platform';
import { voiceCopy } from '../../services/voice/platformCopy';
import { setNativeEnv } from '../../test/nativeEnv';

afterEach(() => setNativeEnv('browser'));

describe('nativePlatform', () => {
  it('is browser without the Tauri bridge, whatever the user agent', () => {
    setNativeEnv('browser');
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15)', configurable: true });
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    expect(nativePlatform()).toBe('browser');
    expect(isNativeApp()).toBe(false);
  });

  it.each([
    ['desktop', 'desktop'],
    ['android', 'android'],
    ['ios', 'ios'],
    ['ipad', 'ios'],
  ] as const)('%s build -> %s', (env, expected) => {
    setNativeEnv(env);
    expect(nativePlatform()).toBe(expected);
    expect(isNativeApp()).toBe(true);
  });

  it('a Mac without touch in Tauri is desktop', () => {
    setNativeEnv('ipad');
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
    expect(nativePlatform()).toBe('desktop');
  });
});

describe('voiceCopy', () => {
  it('browser hints talk about the browser and tabs', () => {
    const c = voiceCopy('browser');
    expect(c.micDenied).toMatch(/site settings/);
    expect(c.micInsecure).toMatch(/https/i);
    expect(c.keepListeningHidden).toMatch(/tab/);
  });

  it.each(['desktop', 'android', 'ios'] as const)('%s hints never mention the browser, tabs or https', (p) => {
    const c = voiceCopy(p);
    for (const text of Object.values(c)) {
      expect(text).not.toMatch(/browser|\btab\b|https/i);
    }
  });

  it('points at the right settings screen per platform', () => {
    expect(voiceCopy('android').micDenied).toMatch(/Apps > Companion/);
    expect(voiceCopy('ios').micDenied).toMatch(/Settings > Companion > Microphone/);
    expect(voiceCopy('desktop').micDenied).toMatch(/system privacy settings/);
  });
});
