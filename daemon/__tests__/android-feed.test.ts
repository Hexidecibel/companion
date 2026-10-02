/* eslint-disable @typescript-eslint/no-var-requires */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

const af = require('../scripts/android-feed.js');

const CERT = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const BADGING = `package: name='com.hexidecibel.companion' versionCode='1000505' versionName='1.0.505' platformBuildVersionName='16'\nsdkVersion:'24'\n`;
const CERTS = `Signer #1 certificate DN: CN=Android Debug, O=Android, C=US\nSigner #1 certificate SHA-256 digest: ${CERT}\nSigner #1 certificate SHA-1 digest: 0123\n`;

describe('android feed helpers', () => {
  it('parses aapt2 badging and apksigner certificate digests', () => {
    expect(af.parseBadging(BADGING)).toEqual({
      packageName: 'com.hexidecibel.companion',
      versionCode: 1000505,
      versionName: '1.0.505',
    });
    expect(() => af.parseBadging('nothing')).toThrow(/package line/);
    expect(af.parseCertDigests(CERTS)).toEqual([CERT]);
    expect(af.parseCertDigests(`certificate SHA-256 digest: ${'AB:'.repeat(31)}AB`)).toEqual([CERT]);
  });

  it('refuses an older or equal versionCode, a foreign package, unsigned or re-signed APKs', () => {
    const cur = { versionCode: 1000500, certSha256: [CERT] };
    const next = { packageName: af.PACKAGE_NAME, versionCode: 1000505, versionName: '1.0.505', certSha256: [CERT] };
    expect(() => af.checkPublishable(cur, next)).not.toThrow();
    expect(() => af.checkPublishable(null, next)).not.toThrow();
    expect(() => af.checkPublishable(cur, { ...next, versionCode: 1000500 })).toThrow(/must be higher/);
    expect(() => af.checkPublishable(cur, { ...next, versionCode: 1000499 })).toThrow(/must be higher/);
    expect(() => af.checkPublishable(cur, { ...next, packageName: 'evil.app' })).toThrow(/package/);
    expect(() => af.checkPublishable(cur, { ...next, certSha256: [] })).toThrow(/not signed/);
    expect(() => af.checkPublishable(cur, { ...next, certSha256: [OTHER] })).toThrow(/different certificate/);
  });

  it('builds the feed entry and prunes old APKs', () => {
    const e = af.buildEntry({
      info: { packageName: af.PACKAGE_NAME, versionCode: 1000505, versionName: '1.0.505' },
      sha256: 'f'.repeat(64),
      size: 3,
      certSha256: [CERT],
      baseUrl: 'https://dev.cush.rocks/updates',
      channel: 'stable',
      now: Date.parse('2026-10-02T10:00:00Z'),
    });
    expect(e).toMatchObject({
      versionCode: 1000505,
      versionName: '1.0.505',
      url: 'https://dev.cush.rocks/updates/stable/Companion_1.0.505_android-1000505.apk',
      sha256: 'f'.repeat(64),
      certSha256: [CERT],
      pub_date: '2026-10-02T10:00:00Z',
    });
    const names = ['latest.json', 'android.json', 'Companion_1.0.1_android-1000001.apk', 'Companion_1.0.3_android-1000003.apk', 'Companion_1.0.2_android-1000002.apk'];
    expect(af.apksToPrune(names, 2, 1000003)).toEqual(['Companion_1.0.1_android-1000001.apk']);
  });
});

describe('publish-update --apk (fake build-tools)', () => {
  let root: string;
  let feed: string;
  let sdk: string;
  const script = path.join(__dirname, '..', 'scripts', 'publish-update.js');

  function fakeTools(code: number, cert: string) {
    const bt = path.join(sdk, 'build-tools', '36.0.0');
    fs.mkdirSync(bt, { recursive: true });
    fs.writeFileSync(
      path.join(bt, 'aapt2'),
      `#!/bin/sh\necho "package: name='com.hexidecibel.companion' versionCode='${code}' versionName='1.0.${code - 1000000}'"\n`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(bt, 'apksigner'),
      `#!/bin/sh\necho "Signer #1 certificate SHA-256 digest: ${cert}"\n`,
      { mode: 0o755 }
    );
  }
  function publish(apk: string) {
    return execFileSync('node', [script, '--apk', apk, '--dir', feed], {
      env: { ...process.env, ANDROID_HOME: sdk },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-feed-'));
    feed = path.join(root, 'updates');
    sdk = path.join(root, 'sdk');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('publishes a newer APK with its sha256, refuses the same or an older versionCode', () => {
    const apk = path.join(root, 'app.apk');
    fs.writeFileSync(apk, 'APK-BYTES');
    fakeTools(1000505, CERT);
    publish(apk);
    const entry = JSON.parse(fs.readFileSync(path.join(feed, 'stable', 'android.json'), 'utf8'));
    expect(entry.versionCode).toBe(1000505);
    expect(entry.sha256).toBe(crypto.createHash('sha256').update('APK-BYTES').digest('hex'));
    expect(entry.certSha256).toEqual([CERT]);
    expect(fs.readFileSync(path.join(feed, 'stable', 'Companion_1.0.505_android-1000505.apk'), 'utf8')).toBe('APK-BYTES');

    expect(() => publish(apk)).toThrow(/must be higher/);
    fakeTools(1000400, CERT);
    expect(() => publish(apk)).toThrow(/must be higher/);
    fakeTools(1000600, OTHER);
    expect(() => publish(apk)).toThrow(/different certificate/);
    expect(JSON.parse(fs.readFileSync(path.join(feed, 'stable', 'android.json'), 'utf8')).versionCode).toBe(1000505);
  });
});
