import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ProfileRegistry,
  buildProfiles,
  envFileKeys,
  parseProfilesBlock,
} from '../registry';
import { ProcEnvCache, pickEnviron } from '../environ';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-test-'));
}

describe('parseProfilesBlock', () => {
  it('accepts valid entries and expands ~', () => {
    const { profiles, warnings } = parseProfilesBlock(
      [
        { id: 'work', label: 'Work', agent: 'claude', home: '~/.claude-work', env: { FOO: 'x' } },
        { id: 'cdx2', agent: 'codex', home: '/srv/codex2', env_file: '~/.companion/profiles/cdx2.env' },
      ],
      { homeDir: '/home/u' }
    );
    expect(warnings).toEqual([]);
    expect(profiles[0]).toMatchObject({ id: 'work', label: 'Work', agent: 'claude', home: '/home/u/.claude-work', env: { FOO: 'x' } });
    expect(profiles[1]).toMatchObject({ id: 'cdx2', label: 'cdx2', envFile: '/home/u/.companion/profiles/cdx2.env' });
  });

  it('skips invalid entries and reserved env', () => {
    const { profiles, warnings } = parseProfilesBlock([
      { id: 'Bad Id', agent: 'claude', home: '/x' },
      { id: 'a', agent: 'gpt', home: '/x' },
      { id: 'b', agent: 'claude' },
      { id: 'c', agent: 'claude', home: "/x/it's" },
      { id: 'd', agent: 'claude', home: '/d', env: { CLAUDE_CONFIG_DIR: '/evil', PATH: '/p', OK: '1', 'BAD-K': '2' } },
    ]);
    expect(profiles.map((p) => p.id)).toEqual(['d']);
    expect(profiles[0].env).toEqual({ OK: '1' });
    expect(warnings.length).toBeGreaterThanOrEqual(6);
  });

  it('non-array is ignored', () => {
    expect(parseProfilesBlock({}).profiles).toEqual([]);
    expect(parseProfilesBlock(undefined).warnings).toEqual([]);
  });
});

describe('buildProfiles', () => {
  it('always has the two defaults first and drops clashes', () => {
    const configured = parseProfilesBlock([
      { id: 'claude', agent: 'claude', home: '/a' },
      { id: 'same', agent: 'claude', home: '/h/.claude' },
      { id: 'w', agent: 'claude', home: '/w' },
      { id: 'w', agent: 'codex', home: '/w2' },
    ]).profiles;
    const warns: string[] = [];
    const all = buildProfiles({ codeHome: '/h/.claude', codexHome: '/h/.codex' }, configured, (l) => warns.push(l));
    expect(all.map((p) => `${p.id}:${p.isDefault}`)).toEqual(['claude:true', 'codex:true', 'w:false']);
    expect(warns).toHaveLength(3);
  });
});

describe('envFileKeys', () => {
  it('names only', () => {
    expect(envFileKeys('# c\nexport A=1\nB = "x"\n\nnot a line\nA=2\n')).toEqual(['A', 'B']);
  });
});

describe('ProfileRegistry', () => {
  it('without config: defaults only, codex beside code_home', () => {
    const r = new ProfileRegistry({ codeHome: '/h/.claude', configPath: null, log: () => {} });
    expect(r.list().map((p) => p.id)).toEqual(['claude', 'codex']);
    expect(r.codexHome).toBe('/h/.codex');
    expect(r.hasExtra()).toBe(false);
  });

  it('forHome: exact, real path, unknown and unset fall back to the default', () => {
    const d = tmp();
    const work = path.join(d, 'work');
    fs.mkdirSync(work);
    fs.symlinkSync(work, path.join(d, 'link'));
    const r = new ProfileRegistry({
      codeHome: path.join(d, '.claude'),
      configPath: null,
      profilesRaw: [{ id: 'work', agent: 'claude', home: work }],
      log: () => {},
    });
    expect(r.forHome('claude', work).id).toBe('work');
    expect(r.forHome('claude', path.join(d, 'link')).id).toBe('work');
    expect(r.forHome('claude', '/nowhere').id).toBe('claude');
    expect(r.forHome('claude', undefined).id).toBe('claude');
    expect(r.forHome('codex', work).id).toBe('codex');
  });

  it('launchPlan: default claude gets nothing, others their home var + env + env file', async () => {
    const d = tmp();
    const cfgDir = path.join(d, 'cfg');
    fs.mkdirSync(path.join(cfgDir, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'profiles', 'w.env'), 'ANTHROPIC_API_KEY=secret\n', { mode: 0o600 });
    const r = new ProfileRegistry({
      codeHome: path.join(d, '.claude'),
      configPath: null,
      configDir: cfgDir,
      profilesRaw: [
        { id: 'w', agent: 'claude', home: path.join(d, 'w'), env: { X: '1' } },
        { id: 'c2', agent: 'codex', home: path.join(d, 'c2') },
      ],
      log: () => {},
    });
    expect(await r.launchPlan(r.get('claude')!)).toEqual({ env: {} });
    expect(await r.launchPlan(r.get('codex')!)).toEqual({ env: { CODEX_HOME: path.join(d, '.codex') } });
    expect(await r.launchPlan(r.get('w')!)).toEqual({
      env: { X: '1', CLAUDE_CONFIG_DIR: path.join(d, 'w') },
      envFile: path.join(cfgDir, 'profiles', 'w.env'),
    });
    expect(await r.launchPlan(r.get('c2')!)).toEqual({ env: { CODEX_HOME: path.join(d, 'c2') } });
  });

  it('loginState and info never include values', async () => {
    const d = tmp();
    const cfgDir = path.join(d, 'cfg');
    fs.mkdirSync(path.join(cfgDir, 'profiles'), { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'profiles', 'k.env'), 'ANTHROPIC_API_KEY=sk-secret\n');
    const claudeHome = path.join(d, '.claude');
    fs.mkdirSync(claudeHome);
    fs.writeFileSync(path.join(claudeHome, '.credentials.json'), '{}');
    const c2 = path.join(d, 'c2');
    fs.mkdirSync(c2);
    fs.writeFileSync(path.join(c2, 'auth.json'), '{}');
    const r = new ProfileRegistry({
      codeHome: claudeHome,
      codexHome: path.join(d, 'nocodex'),
      configPath: null,
      configDir: cfgDir,
      profilesRaw: [
        { id: 'k', agent: 'claude', home: path.join(d, 'k') },
        { id: 'c2', agent: 'codex', home: c2 },
      ],
      log: () => {},
    });
    const info = await r.info();
    const by = Object.fromEntries(info.map((i) => [i.id, i]));
    expect(by.claude.loginState).toBe('logged_in');
    expect(by.codex.loginState).toBe('logged_out');
    expect(by.k.loginState).toBe('api_key');
    expect(by.k.envKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(by.c2.loginState).toBe('logged_in');
    expect(JSON.stringify(info)).not.toContain('sk-secret');
  });

  it('refresh re-reads the config on mtime change and emits changed', async () => {
    const d = tmp();
    const cfg = path.join(d, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ port: 1 }));
    const r = new ProfileRegistry({ codeHome: path.join(d, '.claude'), configPath: cfg, log: () => {} });
    expect(r.hasExtra()).toBe(false);
    const changed = jest.fn();
    r.on('changed', changed);
    expect(await r.refresh()).toBe(false);
    fs.writeFileSync(cfg, JSON.stringify({ profiles: [{ id: 'w', agent: 'claude', home: path.join(d, 'w') }] }));
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(cfg, t, t);
    expect(await r.refresh()).toBe(true);
    expect(r.get('w')?.agent).toBe('claude');
    expect(changed).toHaveBeenCalledTimes(1);
    // invalid JSON keeps the list
    fs.writeFileSync(cfg, '{nope');
    const t2 = new Date(Date.now() + 9000);
    fs.utimesSync(cfg, t2, t2);
    expect(await r.refresh()).toBe(false);
    expect(r.get('w')).toBeDefined();
  });
});

describe('environ', () => {
  it('pickEnviron selects keys', () => {
    expect(pickEnviron('A=1\0CLAUDE_CONFIG_DIR=/x=y\0B=2\0', ['CLAUDE_CONFIG_DIR', 'B'])).toEqual({
      CLAUDE_CONFIG_DIR: '/x=y',
      B: '2',
    });
  });

  it('ProcEnvCache reads a fake proc root and re-reads on a new start time', async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '42'));
    fs.writeFileSync(path.join(root, '42', 'environ'), 'CODEX_HOME=/a\0');
    const c = new ProcEnvCache(['CODEX_HOME'], root);
    expect(await c.read(42, 1)).toEqual({ CODEX_HOME: '/a' });
    fs.writeFileSync(path.join(root, '42', 'environ'), 'CODEX_HOME=/b\0');
    expect(await c.read(42, 1)).toEqual({ CODEX_HOME: '/a' });
    expect(await c.read(42, 2)).toEqual({ CODEX_HOME: '/b' });
    expect(await c.read(7)).toEqual({});
    c.retain([]);
    expect(await c.read(42, 2)).toEqual({ CODEX_HOME: '/b' });
  });
});
