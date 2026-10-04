/**
 * Setup mode detection, first-run config generation, and config writes that
 * preserve every key the writer does not manage.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-config-'));
const cfgPath = path.join(dir, 'config.json');
process.env.COMPANION_CONFIG = cfgPath;

import { isSetupMode, loadConfig, saveConfig, updateConfigFile } from '../src/config';
import { applySettingsPatch, readSettings } from '../src/setup/settings';

const quiet = () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
};

describe('setup mode detection', () => {
  afterEach(() => {
    fs.rmSync(cfgPath, { force: true });
    delete process.env.COMPANION_PORT;
    delete process.env.COMPANION_NAME;
    delete process.env.COMPANION_MDNS;
    jest.restoreAllMocks();
  });

  it('only an explicit setup_complete: false is setup mode', () => {
    expect(isSetupMode({ setupComplete: false })).toBe(true);
    expect(isSetupMode({ setupComplete: true })).toBe(false);
    expect(isSetupMode({})).toBe(false);
  });

  it('an existing install (token, no setup_complete key) is NOT thrown into setup mode', () => {
    quiet();
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ listeners: [{ port: 9877, token: 'existing-token' }], tmux_session: 'main' })
    );
    const c = loadConfig();
    expect(c.setupComplete).toBeUndefined();
    expect(isSetupMode(c)).toBe(false);
  });

  it('an existing install with paired devices and no key is complete too', () => {
    quiet();
    const devices = path.join(dir, 'devices.json');
    fs.writeFileSync(devices, JSON.stringify({ version: 1, devices: [{ id: 'a' }] }));
    fs.writeFileSync(cfgPath, JSON.stringify({ port: 9877, token: 't' }));
    expect(isSetupMode(loadConfig())).toBe(false);
    fs.rmSync(devices);
  });

  it('first run: generates a setup-mode config with hostname name and env overrides', () => {
    quiet();
    process.env.COMPANION_PORT = '9555';
    process.env.COMPANION_MDNS = '0';
    const c = loadConfig();
    expect(isSetupMode(c)).toBe(true);
    expect(c.listeners[0].port).toBe(9555);
    expect(c.listeners[0].token).toMatch(/^[0-9a-f]{32}$/);
    expect(c.name).toBe(os.hostname());
    expect(c.mdnsEnabled).toBe(false);
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(raw.setup_complete).toBe(false);
    expect(fs.statSync(cfgPath).mode & 0o777).toBe(0o600);
    // Second load: still setup mode (the key persists until the wizard ends).
    expect(isSetupMode(loadConfig())).toBe(true);
  });

  it('first run never prints the token', () => {
    const logs: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    const c = loadConfig();
    const { displayFirstRunWelcome } = jest.requireActual('../src/config');
    return displayFirstRunWelcome(c, cfgPath).then(() => {
      expect(logs.join('\n')).not.toContain(c.listeners[0].token);
      expect(logs.join('\n')).toContain('/web/');
    });
  });
});

describe('config writes preserve existing keys', () => {
  beforeEach(() => {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        listeners: [{ port: 9877, token: 'tok', tls: false }],
        allowedPaths: ['/srv'],
        anthropic_admin_api_key: 'admin-x',
        future_key: { nested: true },
        herald: { provider: 'anthropic', monthly_budget_usd: 5 },
      }),
      { mode: 0o640 }
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it('updateConfigFile keeps unknown keys and the file mode', () => {
    updateConfigFile((r) => {
      r.name = 'Box';
    });
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(raw).toMatchObject({
      name: 'Box',
      allowedPaths: ['/srv'],
      anthropic_admin_api_key: 'admin-x',
      future_key: { nested: true },
    });
    expect(fs.statSync(cfgPath).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('updateConfigFile refuses to overwrite a file it cannot parse', () => {
    fs.writeFileSync(cfgPath, '{ not json');
    expect(() => updateConfigFile((r) => (r.name = 'x'))).toThrow();
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe('{ not json');
  });

  it('saveConfig (token rotation path) no longer drops keys it does not manage', () => {
    quiet();
    const c = loadConfig();
    c.listeners[0].token = 'rotated';
    saveConfig(c);
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(raw.token).toBe('rotated');
    expect(raw.listeners).toBeUndefined();
    expect(raw.allowedPaths).toEqual(['/srv']);
    expect(raw.anthropic_admin_api_key).toBe('admin-x');
    expect(raw.future_key).toEqual({ nested: true });
    expect(raw.herald.monthly_budget_usd).toBe(5);
  });

  it('settings patch: herald provider change keeps the rest of the herald block', () => {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    applySettingsPatch(
      raw,
      { herald: { provider: 'openai_compatible', baseUrl: 'http://spark.local:8000/v1/', model: 'qwen3' } },
      os.homedir()
    );
    expect(raw.herald).toEqual({
      provider: 'openai_compatible',
      base_url: 'http://spark.local:8000/v1',
      model: 'qwen3',
      monthly_budget_usd: 5,
    });
    applySettingsPatch(raw, { herald: { provider: 'off' } }, os.homedir());
    expect(raw.herald.enabled).toBe(false);
    expect(raw.herald.monthly_budget_usd).toBe(5);
    applySettingsPatch(raw, { herald: { provider: 'anthropic' } }, os.homedir());
    expect(raw.herald.enabled).toBeUndefined();
  });

  it('settings patch: invalid fields throw before anything changes', () => {
    const raw = { name: 'Old', pairing: true };
    expect(() => applySettingsPatch(raw, { name: 'New', tmuxSession: 'bad name;rm' }, os.homedir())).toThrow();
    expect(raw).toEqual({ name: 'Old', pairing: true });
    expect(() => applySettingsPatch(raw, { herald: { provider: 'openai_compatible' } }, os.homedir())).toThrow(
      /base URL/
    );
    expect(() =>
      applySettingsPatch(raw, { herald: { provider: 'openai_compatible', baseUrl: 'http://u:p@h/v1', model: 'm' } }, os.homedir())
    ).toThrow(/secret/);
    expect(() => applySettingsPatch(raw, { projectRoots: ['/etc'] }, os.homedir())).toThrow();
  });

  it('pairing policy maps to the two config keys', () => {
    const raw: Record<string, unknown> = {};
    applySettingsPatch(raw, { pairing: 'anywhere' }, os.homedir());
    expect(raw).toEqual({ pairing: true, pairing_allow_public: true });
    applySettingsPatch(raw, { pairing: 'off' }, os.homedir());
    expect(raw).toEqual({ pairing: false, pairing_allow_public: false });
    quiet();
    const c = loadConfig();
    c.pairing = false;
    expect(readSettings(c, 'X', 'browser').pairing).toBe('off');
  });
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('no-op settings writes', () => {
  it('a notifications-only patch changes no config key', () => {
    const raw: Record<string, unknown> = { name: 'x' };
    expect(applySettingsPatch(raw, { notifications: 'off' }, os.homedir())).toMatchObject({
      configChanged: false,
      notifications: 'off',
    });
    expect(raw).toEqual({ name: 'x' });
    expect(applySettingsPatch(raw, { pairing: 'lan' }, os.homedir()).configChanged).toBe(true);
  });
});
