/* eslint-disable @typescript-eslint/no-var-requires */
const iosf = require('../scripts/ios-feed.js');

function jobs(conclusion: string | null, stepName = 'Upload IPA to TestFlight') {
  return [
    { name: 'Build Android APK (Tauri)', conclusion: 'success', steps: [{ name: 'Build APK', conclusion: 'success' }] },
    {
      name: 'Build iOS (Tauri)',
      conclusion: 'success',
      steps: [
        { name: 'Verify CFBundleVersion in produced IPA', conclusion: 'success' },
        ...(conclusion === null ? [] : [{ name: stepName, conclusion }]),
        { name: 'Upload IPA artifact', conclusion: 'success' },
      ],
    },
  ];
}

describe('ios feed helpers', () => {
  it('detects a TestFlight upload only when the upload step succeeded', () => {
    expect(iosf.testflightUploaded(jobs('success'))).toBe(true);
    expect(iosf.testflightUploaded(jobs('skipped'))).toBe(false);
    expect(iosf.testflightUploaded(jobs('failure'))).toBe(false);
    expect(iosf.testflightUploaded(jobs(null))).toBe(false);
    expect(iosf.testflightUploaded([])).toBe(false);
    expect(iosf.testflightUploaded(undefined)).toBe(false);
  });

  it('publishes only with the ios-ipa artifact AND a TestFlight upload', () => {
    expect(iosf.shouldPublishIos({ artifacts: ['ios-ipa', 'updater-linux'], jobs: jobs('success') }).ok).toBe(true);
    const noIpa = iosf.shouldPublishIos({ artifacts: ['updater-linux'], jobs: jobs('success') });
    expect(noIpa).toEqual({ ok: false, reason: 'no ios-ipa artifact' });
    const skipped = iosf.shouldPublishIos({ artifacts: ['ios-ipa'], jobs: jobs('skipped') });
    expect(skipped.ok).toBe(false);
    expect(skipped.reason).toMatch(/TestFlight/);
  });

  it('builds the entry with the run number as build and a TestFlight link', () => {
    const now = Date.UTC(2026, 9, 18, 12, 0, 0, 123);
    expect(iosf.buildIosEntry({ build: 80, versionName: '1.0.812', runId: '123', now })).toEqual({
      build: 80,
      versionName: '1.0.812',
      publishedAt: '2026-10-18T12:00:00Z',
      testflightUrl: 'itms-beta://',
      runId: 123,
      notes: 'Companion 1.0.812 (build 80) is on TestFlight',
    });
    expect(iosf.buildIosEntry({ build: 80, versionName: '', appleId: '1234567890', now }).testflightUrl).toBe(
      'itms-beta://beta.itunes.apple.com/v1/app/1234567890'
    );
    expect(iosf.testflightUrl('not-an-id')).toBe('itms-beta://');
  });

  it('never goes back to an older build (equal is a re-publish)', () => {
    expect(() => iosf.checkPublishable(null, 80)).not.toThrow();
    expect(() => iosf.checkPublishable({ build: 80 }, 80)).not.toThrow();
    expect(() => iosf.checkPublishable({ build: 80 }, 81)).not.toThrow();
    expect(() => iosf.checkPublishable({ build: 80 }, 79)).toThrow(/older build 79/);
    expect(() => iosf.checkPublishable(null, 0)).toThrow(/bad iOS build/);
  });
});
