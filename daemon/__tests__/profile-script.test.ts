import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ps = require('../scripts/profile.js');

function setup() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-script-'));
  fs.mkdirSync(path.join(t, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(t, '.claude', 'CLAUDE.md'), 'x');
  fs.writeFileSync(path.join(t, '.claude', '.credentials.json'), '{"secret":1}');
  fs.mkdirSync(path.join(t, '.codex'));
  fs.writeFileSync(path.join(t, '.codex', 'config.toml'), '');
  fs.writeFileSync(path.join(t, '.codex', 'auth.json'), '{}');
  const cfg = path.join(t, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ port: 1, code_home: path.join(t, '.claude') }), {
    mode: 0o600,
  });
  return { t, cfg };
}

describe('scripts/profile.js', () => {
  it('add shares only non-secret bits and writes the config entry', () => {
    const { t, cfg } = setup();
    const r = ps.addProfile(cfg, { id: 'work', agent: 'claude', home: path.join(t, 'cw') });
    expect(r.linked.sort()).toEqual(['CLAUDE.md', 'skills']);
    expect(fs.existsSync(path.join(t, 'cw', '.credentials.json'))).toBe(false);
    expect(fs.statSync(path.join(t, 'cw')).mode & 0o777).toBe(0o700);
    const raw = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(raw.profiles).toEqual([
      { id: 'work', label: 'work', agent: 'claude', home: path.join(t, 'cw') },
    ]);
    expect(raw.port).toBe(1);
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o600);
  });

  it('codex shares config.toml, never auth.json', () => {
    const { t, cfg } = setup();
    const r = ps.addProfile(cfg, { id: 'c2', agent: 'codex', home: path.join(t, 'c2') });
    expect(r.linked).toEqual(['config.toml']);
    expect(fs.existsSync(path.join(t, 'c2', 'auth.json'))).toBe(false);
  });

  it('refuses defaults, duplicates, the default home and bad ids', () => {
    const { t, cfg } = setup();
    expect(() => ps.addProfile(cfg, { id: 'claude', agent: 'claude' })).toThrow(/default/);
    expect(() => ps.addProfile(cfg, { id: 'Bad', agent: 'claude' })).toThrow(/invalid id/);
    expect(() =>
      ps.addProfile(cfg, { id: 'x', agent: 'claude', home: path.join(t, '.claude') })
    ).toThrow(/default claude home/);
    ps.addProfile(cfg, { id: 'w', agent: 'claude', home: path.join(t, 'w'), share: false });
    expect(() => ps.addProfile(cfg, { id: 'w', agent: 'claude' })).toThrow(/exists/);
  });

  it('login lines and remove', () => {
    const { t, cfg } = setup();
    ps.addProfile(cfg, { id: 'w', agent: 'claude', home: path.join(t, 'w'), share: false });
    const all = ps.allProfiles(JSON.parse(fs.readFileSync(cfg, 'utf-8')), cfg);
    const by = Object.fromEntries(all.map((p: { id: string }) => [p.id, p]));
    expect(ps.loginLine(by.claude)).toBe('claude auth login');
    expect(ps.loginLine(by.codex)).toBe(
      `env CODEX_HOME='${path.join(t, '.codex')}' codex login --device-auth`
    );
    expect(ps.loginLine(by.w)).toBe(
      `env CLAUDE_CONFIG_DIR='${path.join(t, 'w')}' claude auth login`
    );
    expect(ps.loginState(by.claude)).toBe('logged in');
    expect(ps.loginState(by.w)).toBe('not logged in');
    ps.removeProfile(cfg, 'w');
    expect(JSON.parse(fs.readFileSync(cfg, 'utf-8')).profiles).toBeUndefined();
    expect(fs.existsSync(path.join(t, 'w'))).toBe(true);
  });
});
