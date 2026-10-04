/**
 * secrets.env: 0600, atomic, other lines kept, never logged, never returned.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadSecretsEnv,
  parseSecretsEnv,
  secretStatuses,
  validateSecretValue,
  writeSecretsFileKey,
} from '../src/setup/secrets';
import { SetupService } from '../src/setup/service';
import { SetupStateStore } from '../src/setup/state';
import { CheckRunner } from '../src/setup/checks';

const KEY = 'sk-ant-api03-TESTVALUE_abcdefghijklmnop0123456789';

describe('secrets.env', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-secrets-'));
    file = path.join(dir, 'sub', 'secrets.env');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('writes 0600 in a 0700 directory, atomically, keeping other lines', () => {
    fs.mkdirSync(path.dirname(file), { mode: 0o700 });
    fs.writeFileSync(file, '# mine\nOTHER_THING=keep-me\nANTHROPIC_API_KEY=old\n', { mode: 0o600 });
    writeSecretsFileKey('ANTHROPIC_API_KEY', KEY, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const parsed = parseSecretsEnv(fs.readFileSync(file, 'utf8'));
    expect(parsed.get('ANTHROPIC_API_KEY')).toBe(KEY);
    expect(parsed.get('OTHER_THING')).toBe('keep-me');
    expect(fs.readFileSync(file, 'utf8')).toContain('# mine');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['secrets.env']);
  });

  it('creates the file and directory with tight modes when missing; removes keys', () => {
    writeSecretsFileKey('ANTHROPIC_API_KEY', KEY, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    writeSecretsFileKey('ANTHROPIC_API_KEY', null, file);
    expect(parseSecretsEnv(fs.readFileSync(file, 'utf8')).has('ANTHROPIC_API_KEY')).toBe(false);
  });

  it('a failed write leaves the old file intact and does not leak the value', () => {
    writeSecretsFileKey('ANTHROPIC_API_KEY', 'first-value', file);
    // A read-only directory: the temp file cannot be created.
    fs.chmodSync(path.dirname(file), 0o500);
    let msg = '';
    try {
      writeSecretsFileKey('ANTHROPIC_API_KEY', KEY, file);
    } catch (err) {
      msg = (err as Error).message;
    }
    fs.chmodSync(path.dirname(file), 0o700);
    expect(msg).toContain('EACCES');
    expect(msg).not.toContain(KEY);
    expect(parseSecretsEnv(fs.readFileSync(file, 'utf8')).get('ANTHROPIC_API_KEY')).toBe('first-value');
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects values that could break the file or inject another key', () => {
    expect(() => validateSecretValue('abc\nEVIL=1')).toThrow();
    expect(() => validateSecretValue('has space')).toThrow();
    expect(() => validateSecretValue('"quoted"')).toThrow();
    expect(() => validateSecretValue('')).toThrow();
    expect(() => validateSecretValue('x'.repeat(401))).toThrow();
    expect(validateSecretValue(`  ${KEY}  `)).toBe(KEY);
  });

  it('startup load never overrides the environment and reports names only', () => {
    writeSecretsFileKey('ANTHROPIC_API_KEY', KEY, file);
    writeSecretsFileKey('UNRELATED', 'x', file);
    const env: NodeJS.ProcessEnv = {};
    const warn = jest.fn();
    expect(loadSecretsEnv(env, file, warn)).toEqual(['ANTHROPIC_API_KEY']);
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(env.UNRELATED).toBeUndefined();
    const env2: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'from-systemd' };
    expect(loadSecretsEnv(env2, file, warn)).toEqual([]);
    expect(env2.ANTHROPIC_API_KEY).toBe('from-systemd');
    expect(warn).not.toHaveBeenCalled();
    fs.chmodSync(file, 0o644);
    loadSecretsEnv({}, file, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chmod 600'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });

  it('status says set / where, never the value', () => {
    writeSecretsFileKey('ANTHROPIC_API_KEY', KEY, file);
    const st = secretStatuses({ ANTHROPIC_API_KEY: KEY }, file, new Set(['ANTHROPIC_API_KEY']));
    expect(st).toEqual([{ name: 'anthropic_api_key', set: true, source: 'secrets_file' }]);
    expect(secretStatuses({ ANTHROPIC_API_KEY: 'x' }, path.join(dir, 'none'))).toEqual([
      { name: 'anthropic_api_key', set: true, source: 'env' },
    ]);
    expect(secretStatuses({}, path.join(dir, 'none'))[0]).toMatchObject({ set: false, source: 'none' });
    expect(JSON.stringify(st)).not.toContain(KEY);
  });

  it('SetupService.setSecret: stored, live in env, never logged, never in the response', () => {
    const env: NodeJS.ProcessEnv = { COMPANION_SECRETS_FILE: file };
    const logs: string[] = [];
    const reloadHerald = jest.fn().mockReturnValue('live' as const);
    const consoleSpies = ['log', 'warn', 'error', 'info'].map((m) =>
      jest.spyOn(console, m as 'log').mockImplementation((...a) => logs.push(a.join(' ')))
    );
    const svc = new SetupService({
      config: { listeners: [{ port: 1, token: 't' }], tmuxSession: 'main', codeHome: dir, mdnsEnabled: false, pushDelayMs: 1, autoApproveTools: [], git: false, setupComplete: false } as any,
      configPath: () => path.join(dir, 'config.json'),
      identity: () => ({ id: 'a'.repeat(32), name: 'Box', version: '1' }),
      rename: () => {},
      deviceCount: () => 1,
      checks: new CheckRunner(() => ({}) as any),
      run: jest.fn(),
      state: new SetupStateStore(path.join(dir, 'state.json')),
      home: dir,
      feedDir: () => dir,
      lanAddresses: () => [],
      servicePaths: () => ({}) as any,
      reloadHerald,
      spawnSession: jest.fn(),
      sessionExists: jest.fn(),
      capturePane: jest.fn(),
      conversationFor: jest.fn(),
      sendToSession: jest.fn(),
      secretsFromFile: new Set(),
      env,
      log: (l) => logs.push(l),
    });
    const status = svc.setSecret('anthropic_api_key', KEY);
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(reloadHerald).toHaveBeenCalled();
    expect(status.secrets).toEqual([{ name: 'anthropic_api_key', set: true, source: 'secrets_file' }]);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
    expect(logs.join('\n')).toContain('ANTHROPIC_API_KEY');
    expect(() => svc.setSecret('github_token', 'x')).toThrow(/Unknown secret/);
    expect(() => svc.setSecret('anthropic_api_key', 'a\nb')).toThrow();
    consoleSpies.forEach((s) => s.mockRestore());
  });
});
