/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * installers.json helpers (publish-update): Tauri bundler names -> published
 * installer names, and the manifest that sits next to the (unchanged, Tauri
 * format) latest.json.
 */
const inst = require('../scripts/installers-feed.js');

describe('installers feed helpers', () => {
  it('classifies the bundler dmg / deb and names the published files', () => {
    expect(inst.classifyInstaller('Companion_1.0.527_aarch64.dmg')).toEqual({
      version: '1.0.527',
      os: 'darwin',
      arch: 'aarch64',
      kind: 'dmg',
      name: 'Companion_1.0.527_darwin-aarch64.dmg',
    });
    expect(inst.classifyInstaller('Companion_1.0.527_x64.dmg').name).toBe('Companion_1.0.527_darwin-x86_64.dmg');
    expect(inst.classifyInstaller('Companion_1.0.527_amd64.deb')).toMatchObject({
      os: 'linux',
      arch: 'x86_64',
      kind: 'deb',
      name: 'Companion_1.0.527_linux-x86_64.deb',
    });
    for (const n of [
      'Companion_1.0.527_x64-setup.exe',
      'Companion_1.0.527_amd64.AppImage',
      'Companion_1.0.527_darwin-aarch64.app.tar.gz',
      'Other_1.0.527_aarch64.dmg',
      'Companion_1.0_aarch64.dmg',
    ]) {
      expect(inst.classifyInstaller(n)).toBeNull();
    }
    expect(inst.INSTALLER_NAME.test('Companion_1.0.527_darwin-aarch64.dmg')).toBe(true);
    expect(inst.INSTALLER_NAME.test('Companion_1.0.527_linux-x86_64.deb')).toBe(true);
    expect(inst.bundleInstallerKind('-setup.exe')).toBe('nsis');
    expect(inst.bundleInstallerKind('.AppImage')).toBe('appimage');
    expect(inst.bundleInstallerKind('.app.tar.gz')).toBeNull();
  });

  it('builds installers.json with urls, sha256 and size', () => {
    const m = inst.buildInstallersManifest({
      version: '1.0.527',
      baseUrl: 'https://dev.example/updates',
      channel: 'stable',
      now: Date.UTC(2026, 9, 5, 1, 2, 3, 456),
      entries: [
        { version: '1.0.527', os: 'darwin', arch: 'aarch64', kind: 'dmg', name: 'Companion_1.0.527_darwin-aarch64.dmg', sha256: 'a', size: 3 },
        { version: '1.0.527', os: 'windows', arch: 'x86_64', kind: 'nsis', name: 'Companion_1.0.527_windows-x86_64-setup.exe', sha256: 'b', size: 2 },
      ],
    });
    expect(m).toEqual({
      version: '1.0.527',
      pub_date: '2026-10-05T01:02:03Z',
      installers: {
        'darwin-aarch64-dmg': {
          kind: 'dmg',
          file: 'Companion_1.0.527_darwin-aarch64.dmg',
          url: 'https://dev.example/updates/stable/Companion_1.0.527_darwin-aarch64.dmg',
          sha256: 'a',
          size: 3,
        },
        'windows-x86_64-nsis': {
          kind: 'nsis',
          file: 'Companion_1.0.527_windows-x86_64-setup.exe',
          url: 'https://dev.example/updates/stable/Companion_1.0.527_windows-x86_64-setup.exe',
          sha256: 'b',
          size: 2,
        },
      },
    });
  });

  it('refuses a version mismatch or two installers for one slot', () => {
    const base = { baseUrl: 'https://d/u', channel: 'stable', now: 0 };
    const dmg = { os: 'darwin', arch: 'aarch64', kind: 'dmg', name: 'x.dmg', sha256: 'a', size: 1 };
    expect(() =>
      inst.buildInstallersManifest({ ...base, version: '1.0.527', entries: [{ ...dmg, version: '1.0.526' }] })
    ).toThrow(/1.0.526/);
    expect(() =>
      inst.buildInstallersManifest({ ...base, version: '1.0.527', entries: [dmg, { ...dmg, name: 'y.dmg' }] })
    ).toThrow(/two darwin-aarch64-dmg/);
  });
});
