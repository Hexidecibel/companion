import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appDownloads, servicePlan, sessionHint } from '../src/setup/info';

describe('setup info helpers', () => {
  it('session hints: trust dialog, login, missing claude, ready, gone', () => {
    const h = (pane: string, conversation = false, exists = true) => sessionHint(pane, { exists, conversation }).hint;
    expect(h('', false, false)).toBe('gone');
    expect(h('anything', true)).toBe('ready');
    expect(h('bash: claude: command not found')).toBe('claude_missing');
    expect(h('WARNING: Claude Code running in Bypass Permissions mode\n 1. No, exit\n 2. Yes, I accept')).toBe(
      'trust_dialog'
    );
    expect(h('Do you trust the files in this folder?')).toBe('trust_dialog');
    expect(h('Select login method:\n 1. Claude account')).toBe('login');
    expect(h('Welcome to Claude Code\n> ')).toBe('starting');
  });

  it('downloads: read-only links from the feed manifests, local paths only for files present', () => {
    const feed = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-feed-'));
    const st = path.join(feed, 'stable');
    fs.mkdirSync(st);
    fs.writeFileSync(
      path.join(st, 'android.json'),
      JSON.stringify({ versionName: '1.0.9', url: 'https://x.example/updates/stable/Companion_1.0.9_android.apk' })
    );
    fs.writeFileSync(path.join(st, 'Companion_1.0.9_android.apk'), 'apk');
    fs.writeFileSync(
      path.join(st, 'latest.json'),
      JSON.stringify({
        version: '1.0.9',
        platforms: {
          'linux-x86_64': { url: 'https://x.example/updates/stable/Companion_1.0.9_linux.AppImage' },
          'darwin-aarch64': { url: 'javascript:alert(1)' },
          'windows-x86_64': { url: 'https://x.example/updates/stable/..%2F..%2Fetc' },
        },
      })
    );
    const d = appDownloads(feed);
    expect(d.downloads.map((x) => x.platform)).toEqual(['android', 'linux', 'windows']);
    expect(d.downloads[0]).toMatchObject({ version: '1.0.9', localPath: '/updates/stable/Companion_1.0.9_android.apk' });
    expect(d.downloads[1].localPath).toBeNull();
    expect(d.downloads[2].localPath).toBeNull();
    expect(appDownloads(path.join(feed, 'missing')).downloads).toEqual([]);
    fs.rmSync(feed, { recursive: true, force: true });
  });

  it('service plan: daemon install never starts it (--no-start); voice blocked until models exist', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-svc-'));
    const p = {
      platform: 'linux' as NodeJS.Platform,
      home,
      binDir: '/repo/bin',
      daemonEntry: '/repo/daemon/dist/index.js',
      nodePath: '/usr/bin/node',
      voiceHome: path.join(home, 'voice'),
    };
    const d = servicePlan('daemon', p);
    expect(d.exec).toEqual({ cmd: '/repo/bin/companion', args: ['autostart', 'enable', '--no-start'] });
    expect(d.info).toMatchObject({ installed: false, supported: true });
    const v = servicePlan('voice', p);
    expect(v.exec).toBeNull();
    expect(v.info.blocker).toMatch(/install/);
    fs.mkdirSync(path.join(home, 'voice', 'venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'voice', 'venv', 'bin', 'python'), '');
    expect(servicePlan('voice', p).exec).toEqual({ cmd: '/repo/bin/herald-voice', args: ['install-unit'] });
    expect(servicePlan('voice', { ...p, platform: 'darwin' }).exec).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });
});
