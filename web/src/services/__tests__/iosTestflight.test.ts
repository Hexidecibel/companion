import { describe, expect, it } from 'vitest';
import { isNewerIosBuild, parseIosFeed } from '../iosTestflight';

describe('iosTestflight', () => {
  it('parses a valid feed and rejects malformed ones', () => {
    expect(parseIosFeed(JSON.stringify({ build: 80, versionName: '1.0.812', testflightUrl: 'itms-beta://beta.itunes.apple.com/v1/app/123456789', publishedAt: 'x' }))).toEqual({
      build: 80,
      versionName: '1.0.812',
      testflightUrl: 'itms-beta://beta.itunes.apple.com/v1/app/123456789',
      publishedAt: 'x',
    });
    expect(parseIosFeed('nope')).toBeNull();
    expect(parseIosFeed(JSON.stringify({ build: '80' }))).toBeNull();
    expect(parseIosFeed(JSON.stringify({ build: -1 }))).toBeNull();
    // Only TestFlight links are ever opened.
    expect(parseIosFeed(JSON.stringify({ build: 80, testflightUrl: 'https://evil.example' }))?.testflightUrl).toBe('itms-beta://');
  });

  it('offers only a strictly newer build than a known installed one', () => {
    const e = parseIosFeed(JSON.stringify({ build: 80 }));
    expect(isNewerIosBuild(e, 24)).toBe(true);
    expect(isNewerIosBuild(e, 80)).toBe(false);
    expect(isNewerIosBuild(e, 81)).toBe(false);
    expect(isNewerIosBuild(e, 0)).toBe(false);
    expect(isNewerIosBuild(e, null)).toBe(false);
    expect(isNewerIosBuild(null, 24)).toBe(false);
  });
});
