/**
 * One version source: scripts/write-version.js writes dist/version.json at
 * build time (1.0.<git commit count>, or the Docker build arg), and every
 * daemon surface (/health, mDNS TXT, pair_hello, get_capabilities, the CLI)
 * reads it through version.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appVersion, resolveAppVersion } from '../src/version';
import { daemonVersion, loadDaemonIdentity } from '../src/pairing/identity';
import { healthPayload } from '../src/health';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveVersion } = require('../scripts/write-version.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-version-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('write-version.js resolveVersion', () => {
  const count = () => 527;
  it('the Docker build arg wins when it is x.y.z', () => {
    expect(resolveVersion({ COMPANION_VERSION: '1.0.600' }, '1.0.0', count)).toEqual({
      version: '1.0.600',
      source: 'COMPANION_VERSION',
    });
  });
  it('otherwise major.minor from package.json + the git commit count', () => {
    expect(resolveVersion({}, '1.0.0', count)).toEqual({ version: '1.0.527', source: 'git' });
    expect(resolveVersion({ COMPANION_VERSION: 'dev' }, '2.3.0', count).version).toBe('2.3.527');
  });
  it('no git: the package version', () => {
    const noGit = () => {
      throw new Error('not a git repository');
    };
    expect(resolveVersion({}, '1.0.0', noGit)).toEqual({ version: '1.0.0', source: 'package.json' });
    expect(resolveVersion({}, '1.0.0', () => NaN).source).toBe('package.json');
  });
});

describe('version.ts', () => {
  it('reads the generated version.json first, then ../package.json', () => {
    const dist = path.join(tmp, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    expect(resolveAppVersion(dist)).toBe('1.0.0');
    fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ version: '1.0.527' }));
    expect(resolveAppVersion(dist)).toBe('1.0.527');
    // A junk file is ignored.
    fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ version: 'x; rm -rf /' }));
    expect(resolveAppVersion(dist)).toBe('1.0.0');
    expect(resolveAppVersion(path.join(tmp, 'nowhere', 'deeper'))).toBe('0.0.0');
  });

  it('every surface reports the same version', () => {
    process.env.COMPANION_DAEMON_ID_FILE = path.join(tmp, 'daemon-id.json');
    const v = appVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(daemonVersion()).toBe(v);
    expect(loadDaemonIdentity('x').version).toBe(v);
    expect(healthPayload({}).version).toBe(v);
  });
});
