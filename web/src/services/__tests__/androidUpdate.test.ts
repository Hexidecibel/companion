import { describe, expect, it } from 'vitest';
import {
  ANDROID_CHECK_INTERVAL_MS,
  isNewerBuild,
  parseAndroidFeed,
  shouldCheck,
  updateErrorCode,
} from '../androidUpdate';

const SHA = 'ab'.repeat(32);
const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    versionCode: 1000505,
    versionName: '1.0.505',
    url: 'https://dev.cush.rocks/updates/stable/Companion_1.0.505_android-1000505.apk',
    sha256: SHA,
    size: 1234,
    ...over,
  });

describe('parseAndroidFeed', () => {
  it('accepts a well-formed entry', () => {
    expect(parseAndroidFeed(entry())).toMatchObject({ versionCode: 1000505, versionName: '1.0.505', sha256: SHA, size: 1234 });
  });
  it('rejects malformed entries (never offered)', () => {
    expect(parseAndroidFeed('not json')).toBeNull();
    expect(parseAndroidFeed(entry({ versionCode: '1000505' }))).toBeNull();
    expect(parseAndroidFeed(entry({ versionCode: 1.5 }))).toBeNull();
    expect(parseAndroidFeed(entry({ url: 'http://dev.cush.rocks/x.apk' }))).toBeNull();
    expect(parseAndroidFeed(entry({ url: 'https://dev.cush.rocks/x.exe' }))).toBeNull();
    expect(parseAndroidFeed(entry({ sha256: 'abc' }))).toBeNull();
  });
});

describe('isNewerBuild', () => {
  const e = parseAndroidFeed(entry());
  it('offers only a strictly higher versionCode', () => {
    expect(isNewerBuild(e, 1000504)).toBe(true);
    expect(isNewerBuild(e, 1000505)).toBe(false);
    expect(isNewerBuild(e, 1000506)).toBe(false);
    expect(isNewerBuild(null, 1)).toBe(false);
    expect(isNewerBuild(e, undefined)).toBe(false);
  });
});

describe('shouldCheck', () => {
  it('checks on launch and every 6 hours', () => {
    expect(shouldCheck(null, 1000)).toBe(true);
    expect(shouldCheck(0, ANDROID_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldCheck(0, ANDROID_CHECK_INTERVAL_MS)).toBe(true);
    expect(shouldCheck(5000, 1000)).toBe(true); // clock went backwards
  });
});

describe('updateErrorCode', () => {
  it('reads the native "code: message" rejections', () => {
    expect(updateErrorCode(new Error('install_permission: Install unknown apps is not allowed'))).toEqual({
      code: 'install_permission',
      message: 'Install unknown apps is not allowed',
    });
    expect(updateErrorCode('verify_failed: signed with a different certificate').code).toBe('verify_failed');
    expect(updateErrorCode('boom')).toEqual({ code: 'unknown', message: 'boom' });
  });
});
