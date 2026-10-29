#!/usr/bin/env node
/**
 * bin/companion profile: account profiles (several Claude / Codex logins).
 *
 *   list                          every profile (the two defaults + config `profiles`)
 *   add <id> --agent claude|codex [--label L] [--home DIR] [--no-share]
 *                                 create the home (0700), symlink the shared non-secret
 *                                 bits from the default home, add the config entry
 *   remove <id>                   drop the config entry (the home stays on disk)
 *   login <id> [--tmux]           print the login command; --tmux starts it in a
 *                                 tagged tmux session `login-<id>` (open it in the app)
 *   env-path <id>                 the profile's env file (API keys; mode 600)
 *
 * Common: --config PATH (default $COMPANION_CONFIG / $CONFIG_PATH / ~/.companion/config.json).
 * The running daemon re-reads `profiles` when config.json changes: no restart.
 * Never reads, copies or prints credentials.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DEFAULT_IDS = { claude: 'claude', codex: 'codex' };
/** Non-secret bits shared with the default home (symlinked). Never credentials / history. */
const SHARED = {
  claude: ['CLAUDE.md', 'settings.json', 'skills', 'agents', 'commands', 'hooks', 'plugins'],
  codex: ['config.toml', 'AGENTS.md', 'skills', 'prompts'],
};
const HOME_VAR = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
/** Same as the daemon's handlers/profiles.ts LOGIN_COMMANDS. */
const LOGIN_COMMANDS = { claude: 'claude auth login', codex: 'codex login --device-auth' };

function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

function configPathFrom(env = process.env) {
  return (
    env.COMPANION_CONFIG || env.CONFIG_PATH || path.join(os.homedir(), '.companion', 'config.json')
  );
}

function readConfig(file) {
  if (!fs.existsSync(file)) throw new Error(`config not found: ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('config is not an object');
  return raw;
}

function writeConfig(file, raw) {
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

/** The default homes the daemon would use (code_home, codex home). */
function defaultHomes(raw, env = process.env) {
  const codeHome = path.resolve(expandHome(raw.code_home || raw.claude_home || '~/.claude'));
  let codexHome;
  if (raw.codex_home) codexHome = expandHome(raw.codex_home);
  else if (env.CODEX_HOME) codexHome = env.CODEX_HOME;
  else if (path.basename(codeHome) === '.claude')
    codexHome = path.join(path.dirname(codeHome), '.codex');
  else codexHome = path.join(os.homedir(), '.codex');
  return { claude: codeHome, codex: path.resolve(codexHome) };
}

function envFileFor(configFile, entry) {
  const configured = entry && (entry.env_file || entry.envFile);
  return configured
    ? path.resolve(expandHome(configured))
    : path.join(path.dirname(configFile), 'profiles', `${entry.id}.env`);
}

function allProfiles(raw, configFile) {
  const homes = defaultHomes(raw);
  const out = [
    { id: 'claude', label: 'Claude', agent: 'claude', home: homes.claude, isDefault: true },
    { id: 'codex', label: 'Codex', agent: 'codex', home: homes.codex, isDefault: true },
  ];
  for (const e of Array.isArray(raw.profiles) ? raw.profiles : []) {
    if (!e || !ID_RE.test(e.id) || (e.agent !== 'claude' && e.agent !== 'codex') || !e.home)
      continue;
    out.push({
      id: e.id,
      label: e.label || e.id,
      agent: e.agent,
      home: path.resolve(expandHome(e.home)),
      isDefault: false,
      envFile: envFileFor(configFile, e),
    });
  }
  return out;
}

/** Cheap login state, like the daemon: a credentials file exists (never read). */
function loginState(p) {
  if (p.agent === 'claude' && fs.existsSync(path.join(p.home, '.credentials.json')))
    return 'logged in';
  if (p.agent === 'codex' && fs.existsSync(path.join(p.home, 'auth.json'))) return 'logged in';
  if (p.envFile && fs.existsSync(p.envFile)) {
    const names = fs
      .readFileSync(p.envFile, 'utf-8')
      .split('\n')
      .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l))
      .filter(Boolean)
      .map((m) => m[1]);
    const keyVars =
      p.agent === 'claude'
        ? ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']
        : ['OPENAI_API_KEY', 'CODEX_API_KEY'];
    if (keyVars.some((k) => names.includes(k))) return 'API key (env file)';
  }
  return 'not logged in';
}

/** Symlink the shared non-secret bits; returns the names linked. */
function shareFromDefault(agent, defaultHome, home) {
  const linked = [];
  for (const name of SHARED[agent]) {
    const src = path.join(defaultHome, name);
    const dst = path.join(home, name);
    if (!fs.existsSync(src)) continue;
    let present = false;
    try {
      fs.lstatSync(dst);
      present = true;
    } catch {
      /* absent */
    }
    if (present) continue;
    fs.symlinkSync(src, dst);
    linked.push(name);
  }
  return linked;
}

function addProfile(configFile, opts) {
  const { id, agent } = opts;
  if (!ID_RE.test(id || ''))
    throw new Error(`invalid id "${id}": lowercase letters, digits, _ and - (max 32)`);
  if (agent !== 'claude' && agent !== 'codex') throw new Error('--agent must be claude or codex');
  if (Object.values(DEFAULT_IDS).includes(id)) throw new Error(`"${id}" is a default profile id`);
  const raw = readConfig(configFile);
  const list = Array.isArray(raw.profiles) ? raw.profiles : [];
  if (list.some((e) => e && e.id === id)) throw new Error(`profile "${id}" already exists`);
  const defaults = defaultHomes(raw);
  const home = path.resolve(
    expandHome(opts.home || (agent === 'claude' ? `~/.claude-${id}` : `~/.codex-${id}`))
  );
  if (/['\\\n\r]/.test(home)) throw new Error('home must not contain quotes or backslashes');
  if (home === defaults[agent]) throw new Error(`that is the default ${agent} home`);
  if (list.some((e) => e && e.agent === agent && path.resolve(expandHome(e.home || '')) === home))
    throw new Error(`another ${agent} profile already uses ${home}`);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const linked = opts.share === false ? [] : shareFromDefault(agent, defaults[agent], home);
  const entry = { id, label: opts.label || id, agent, home };
  raw.profiles = [...list, entry];
  writeConfig(configFile, raw);
  const envDir = path.join(path.dirname(configFile), 'profiles');
  fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
  return { entry, linked, envFile: path.join(envDir, `${id}.env`) };
}

function removeProfile(configFile, id) {
  const raw = readConfig(configFile);
  const list = Array.isArray(raw.profiles) ? raw.profiles : [];
  const hit = list.find((e) => e && e.id === id);
  if (!hit) throw new Error(`no profile "${id}" in ${configFile}`);
  raw.profiles = list.filter((e) => e !== hit);
  if (raw.profiles.length === 0) delete raw.profiles;
  writeConfig(configFile, raw);
  return hit;
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** The shell line that logs a profile in (env file sourced when present). */
function loginLine(p) {
  const base = LOGIN_COMMANDS[p.agent];
  const envPart = p.isDefault && p.agent === 'claude' ? '' : `${HOME_VAR[p.agent]}=${shq(p.home)} `;
  if (p.envFile && fs.existsSync(p.envFile)) {
    return `env ${envPart}sh -c 'set -a; . "$0"; set +a; exec "$@"' ${shq(p.envFile)} ${base}`;
  }
  return envPart ? `env ${envPart}${base}` : base;
}

function startLoginTmux(p) {
  const name = `login-${p.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const tmux = (args) => execFileSync('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    tmux(['has-session', '-t', `=${name}`]);
    return { name, existed: true };
  } catch {
    /* not running */
  }
  const envArgs =
    p.isDefault && p.agent === 'claude' ? [] : ['-e', `${HOME_VAR[p.agent]}=${p.home}`];
  tmux(['new-session', '-d', '-s', name, '-c', os.homedir(), ...envArgs]);
  tmux(['set-environment', '-t', name, 'COMPANION_APP', '1']);
  let cmd = LOGIN_COMMANDS[p.agent];
  if (p.envFile && fs.existsSync(p.envFile))
    cmd = `sh -c 'set -a; . "$0"; set +a; exec "$@"' ${shq(p.envFile)} ${cmd}`;
  tmux(['send-keys', '-t', name, cmd, 'Enter']);
  return { name, existed: false };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-share') out.share = false;
    else if (a === '--share') out.share = true;
    else if (a === '--tmux') out.tmux = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[k] = v;
      i++;
    } else out._.push(a);
  }
  return out;
}

const USAGE = `Usage: companion profile <command>
  list                                  every profile and its login state
  add <id> --agent claude|codex [--label L] [--home DIR] [--no-share]
                                        new login: creates the home (default ~/.claude-<id> /
                                        ~/.codex-<id>), symlinks shared settings from the
                                        default home, adds it to config.json
  remove <id>                           drop it from config.json (the home stays on disk)
  login <id> [--tmux]                   the login command; --tmux runs it in tmux session
                                        login-<id> (also: Settings > Accounts > Log in in the app)
  env-path <id>                         env file for API keys (KEY=VALUE, mode 600, quote values
                                        with spaces); sourced only by that profile's sessions
  Options: --config PATH. The daemon picks changes up without a restart.`;

function main(argv) {
  const args = parseArgs(argv);
  const [cmd, id] = args._;
  if (!cmd || args.help) {
    console.log(USAGE);
    return cmd || args.help ? 0 : 2;
  }
  const configFile = args.config || configPathFrom();
  switch (cmd) {
    case 'list': {
      const raw = readConfig(configFile);
      for (const p of allProfiles(raw, configFile)) {
        console.log(
          `${p.id.padEnd(14)} ${p.agent.padEnd(7)} ${p.isDefault ? 'default ' : '        '}${p.home}  [${loginState(p)}]${p.label !== p.id && !p.isDefault ? `  "${p.label}"` : ''}`
        );
      }
      return 0;
    }
    case 'add': {
      const r = addProfile(configFile, {
        id,
        agent: args.agent,
        label: args.label,
        home: args.home,
        share: args.share,
      });
      console.log(
        `Added ${r.entry.agent} profile "${r.entry.id}" (${r.entry.label}): ${r.entry.home}`
      );
      console.log(
        r.linked.length
          ? `  Shared from the default home (symlinks): ${r.linked.join(', ')}`
          : '  Nothing shared.'
      );
      console.log(`  API keys (optional): ${r.envFile} (KEY=VALUE, chmod 600)`);
      console.log(
        `  Log in: companion profile login ${r.entry.id} --tmux   (or Settings > Accounts in the app)`
      );
      console.log('  The running daemon picks it up within a few seconds (no restart).');
      return 0;
    }
    case 'remove': {
      const hit = removeProfile(configFile, id);
      console.log(
        `Removed profile "${hit.id}" from ${configFile}. Its home ${hit.home} is left on disk.`
      );
      return 0;
    }
    case 'login': {
      const raw = readConfig(configFile);
      const p = allProfiles(raw, configFile).find((x) => x.id === id);
      if (!p) throw new Error(`no profile "${id}" (companion profile list)`);
      if (args.tmux) {
        const t = startLoginTmux(p);
        console.log(
          t.existed
            ? `tmux session ${t.name} is already open: tmux attach -t ${t.name}`
            : `Started ${LOGIN_COMMANDS[p.agent]} for ${p.id} in tmux session ${t.name} (tagged: it shows in the app).\n  Attach: tmux attach -t ${t.name}`
        );
      } else {
        console.log(loginLine(p));
      }
      return 0;
    }
    case 'env-path': {
      const raw = readConfig(configFile);
      const p = allProfiles(raw, configFile).find((x) => x.id === id && !x.isDefault);
      const file = p ? p.envFile : path.join(path.dirname(configFile), 'profiles', `${id}.env`);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      console.log(file);
      if (fs.existsSync(file)) {
        const mode = (fs.statSync(file).mode & 0o777).toString(8);
        if (mode !== '600') console.error(`  WARNING: mode ${mode}; chmod 600 ${file}`);
      } else console.error('  not present yet (create it with mode 600; never commit it)');
      return 0;
    }
    default:
      console.error(`Unknown command: ${cmd}\n${USAGE}`);
      return 2;
  }
}

module.exports = {
  addProfile,
  removeProfile,
  allProfiles,
  defaultHomes,
  shareFromDefault,
  loginLine,
  loginState,
  LOGIN_COMMANDS,
  SHARED,
};

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}
