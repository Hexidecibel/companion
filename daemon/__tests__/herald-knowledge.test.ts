import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  chunkMarkdown,
  focusChunk,
  rankChunks,
  RESULT_BUDGET_CHARS,
  selectWithinBudget,
  FileChunkCache,
} from '../src/herald/knowledge/retrieval';
import {
  isDeniedPath,
  redactSecrets,
  safeReadText,
  REDACTED,
} from '../src/herald/knowledge/redact';
import {
  KnowledgeBase,
  KnowledgePaths,
  resolveKnowledgePaths,
} from '../src/herald/knowledge/sources';
import { HeraldToolbox } from '../src/herald/knowledge/toolbox';
import {
  executeTool,
  TOOL_SPECS,
  validateToolCall,
  ToolEnv,
  TurnToolState,
} from '../src/herald/tools';

// Fake secrets: built by concatenation so this file never contains a live-looking token.
const FAKE = {
  anthropic: 'sk-ant-' + 'api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4',
  openai: 'sk-' + 'proj-' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2',
  ghp: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  ghpat: 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuv',
  slack: 'xoxb-' + '1234567890-0987654321-AbCdEfGhIjKl',
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  jwt:
    'eyJ' +
    'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  hexNearKey: 'f3a9' + 'c0de4b1e5a7d9c2b3a4f5e6d7c8b9a0f1e2d3c4b',
  b64NearSecret: 'QmFzZTY0' + 'U2VjcmV0VmFsdWVUaGF0SXNMb25nRW5vdWdo',
  shortToken: 'as',
  envValue: 'Pa55w0rd' + 'Value123',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfake\n-----END RSA PRIVATE KEY-----',
};

const SECRET_DOC = `# Setup

Anthropic key: ${FAKE.anthropic}
openai ${FAKE.openai}
github ${FAKE.ghp} and ${FAKE.ghpat}
slack ${FAKE.slack}
aws ${FAKE.aws}
jwt ${FAKE.jwt}
api key = ${FAKE.hexNearKey}
the secret is ${FAKE.b64NearSecret}
config: {"token": "${FAKE.shortToken}"}
- **Daemon config:** (token: "${FAKE.shortToken}")
DB_PASSWORD=${FAKE.envValue}
${FAKE.pem}

References are fine: inf://prod/companion/ANTHROPIC_API_KEY and op://cush/app/token
`;

function assertNoSecrets(text: string) {
  for (const [k, v] of Object.entries(FAKE)) {
    if (k === 'shortToken') {
      expect(text).not.toMatch(/token["']?\s*[:=]\s*["']as["']/i);
      continue;
    }
    if (k === 'pem') {
      expect(text).not.toContain('MIIEowIBAAKCAQEAfake');
      continue;
    }
    expect(text).not.toContain(v);
  }
}

describe('redaction', () => {
  it('scrubs every seeded token shape', () => {
    const out = redactSecrets(SECRET_DOC);
    assertNoSecrets(out);
    expect(out).toContain(REDACTED);
  });

  it('keeps secret references and ordinary prose', () => {
    const out = redactSecrets(SECRET_DOC);
    expect(out).toContain('inf://prod/companion/ANTHROPIC_API_KEY');
    expect(out).toContain('op://cush/app/token');
    const prose = 'Auth: Token in `authenticate` message. Port 9877. Rotate the token monthly.';
    expect(redactSecrets(prose)).toBe(prose);
    expect(redactSecrets('ANTHROPIC_API_KEY=inf://prod/companion/ANTHROPIC_API_KEY')).toContain(
      'inf://prod/companion/ANTHROPIC_API_KEY'
    );
  });

  it('does not treat long plain words or paths as secrets', () => {
    const s =
      'the password reset flow lives in /home/u/local/src/companion/daemon/src/herald/knowledge';
    expect(redactSecrets(s)).toBe(s);
  });
});

describe('denylist', () => {
  const home = '/home/someone';
  it.each([
    '/x/.env',
    '/x/.env.local',
    '/x/.env.production',
    '/x/server.key',
    '/x/cert.pem',
    `${home}/.ssh/config`,
    `${home}/.ssh/id_ed25519`,
    '/x/id_rsa',
    '/x/config.json',
    `${home}/.config/cush-tools/infisical.env`,
    `${home}/.config/cush-tools/op.env`,
    '/tmp/secure-entry/anthropic',
    '/tmp/exchange/big',
  ])('denies %s', (p) => {
    expect(isDeniedPath(p, [home])).toBe(true);
  });

  it.each([
    '/x/CLAUDE.md',
    '/x/plan.md',
    `${home}/.claude/CLAUDE.md`,
    '/mnt/hexinas/apps/INFRASTRUCTURE.md',
  ])('allows %s', (p) => {
    expect(isDeniedPath(p, [home])).toBe(false);
  });

  it('refuses a harmless-looking symlink to a secret file (realpath check)', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-deny-'));
    try {
      fs.writeFileSync(path.join(d, '.env'), `KEY=${FAKE.envValue}\n`);
      fs.symlinkSync(path.join(d, '.env'), path.join(d, 'CLAUDE.md'));
      expect(await safeReadText(path.join(d, 'CLAUDE.md'))).toBeNull();
      expect(await safeReadText(path.join(d, '.env'))).toBeNull();
      fs.writeFileSync(path.join(d, 'plan.md'), SECRET_DOC);
      const ok = await safeReadText(path.join(d, 'plan.md'));
      expect(ok).not.toBeNull();
      assertNoSecrets(ok!.text);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('retrieval', () => {
  const doc = [
    '# Infra',
    'Intro text about the server.',
    '## Port Registry',
    'All ports in use.',
    '',
    '| Port | Service | Binding | Protocol |',
    '|------|---------|---------|----------|',
    ...Array.from(
      { length: 120 },
      (_, i) => `| ${3000 + i} | Service number ${i} | 0.0.0.0 | TCP |`
    ),
    '| 8096 | Jellyfin (jellyfin.cush.rocks) | 0.0.0.0 (Docker) | TCP |',
    '## Media Stack',
    'Jellyfin runs side by side with Plex. It lives in docker.',
    '## SSL / Certbot',
    'Certificates renew via certbot standalone.',
    '```',
    '# not a heading inside a fence',
    '```',
  ].join('\n');

  it('splits by headings with heading paths and ignores # inside code fences', () => {
    const chunks = chunkMarkdown('/infra.md', doc);
    expect(chunks.some((c) => c.headings.join(' > ') === 'Infra > Port Registry')).toBe(true);
    expect(chunks.some((c) => c.headings.includes('not a heading inside a fence'))).toBe(false);
    // The huge table is split into bounded chunks.
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(2400 + 200);
  });

  it('ranks heading matches first and focuses tables on matching rows', () => {
    const ranked = rankChunks(chunkMarkdown('/infra.md', doc), 'jellyfin port');
    expect(ranked.length).toBeGreaterThan(0);
    const { sections } = selectWithinBudget(ranked, 'jellyfin port');
    const all = sections.map((s) => s.text).join('\n');
    expect(all).toContain('8096');
    // Focused: the 120 unrelated rows are not returned.
    expect(all).not.toContain('Service number 57');
    const ssl = rankChunks(chunkMarkdown('/infra.md', doc), 'ssl certbot renew');
    expect(ssl[0].headings).toContain('SSL / Certbot');
  });

  it('keeps results within the budget and flags truncation', () => {
    const big = Array.from(
      { length: 40 },
      (_, i) => `## Section ${i}\n${'deploy step '.repeat(300)}`
    ).join('\n');
    const ranked = rankChunks(chunkMarkdown('/big.md', big), 'deploy step');
    const { sections, truncated } = selectWithinBudget(ranked, 'deploy step');
    const total = sections.reduce((n, s) => n + s.text.length + s.section.length, 0);
    expect(total).toBeLessThanOrEqual(RESULT_BUDGET_CHARS);
    expect(truncated).toBe(true);
  });

  it('returns nothing for unrelated queries', () => {
    expect(rankChunks(chunkMarkdown('/infra.md', doc), 'banana smoothie recipe')).toHaveLength(0);
  });

  it('focusChunk leaves non-table text alone', () => {
    expect(focusChunk('plain text about ports', 'port')).toBe('plain text about ports');
  });

  it('cache re-reads only when mtime/size changes', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-cache-'));
    try {
      const f = path.join(d, 'notes.md');
      fs.writeFileSync(f, '# A\nalpha');
      const cache = new FileChunkCache({ statTtlMs: 0 });
      const a = await cache.get(f);
      expect(a![0].text).toBe('alpha');
      expect(await cache.get(f)).toBe(a); // same object: not re-parsed
      fs.writeFileSync(f, '# A\nbeta gamma');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(f, later, later);
      const b = await cache.get(f);
      expect(b![0].text).toBe('beta gamma');
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('knowledge sources', () => {
  let root: string;
  let paths: KnowledgePaths;
  let kb: KnowledgeBase;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-kb-'));
    const home = path.join(root, 'home');
    paths = {
      userHome: home,
      infraDoc: path.join(root, 'nas', 'INFRASTRUCTURE.md'),
      cushToolsDir: path.join(home, 'local', 'src', 'cush-tools'),
      projectsRoot: path.join(home, 'local', 'src'),
      memoryRoot: path.join(home, '.claude', 'projects'),
      userClaudeMd: path.join(home, '.claude', 'CLAUDE.md'),
    };
    const w = (p: string, s: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, s);
    };
    w(
      paths.infraDoc,
      `# Infra\n## Port Registry\n| Port | Service |\n|---|---|\n| 8096 | Jellyfin |\n| 9877 | Companion |\n## Secrets\n${SECRET_DOC}`
    );
    w(
      path.join(paths.cushToolsDir, 'README.md'),
      `# cush-tools\n## Drop (receive files)\nbin/drop myfiles saves uploads to ~/drops.\n## Serve (serve a directory)\nbin/serve ./dist app shares a folder.\n`
    );
    w(path.join(paths.cushToolsDir, '.env'), `FRP_TOKEN=${FAKE.envValue}\n`);
    w(
      paths.userClaudeMd,
      `# Global\n## Other\nunrelated serve words\n## cush-tools\n### Verify before sharing\nAlways ping a tunnel URL before sharing it.\n`
    );
    w(
      path.join(paths.projectsRoot, 'companion', 'CLAUDE.md'),
      `# Companion\n## Deploy\nDeploy by building web and daemon.\n## Keys\n${SECRET_DOC}`
    );
    w(path.join(paths.projectsRoot, 'companion', 'config.json'), `{"token": "${FAKE.anthropic}"}`);
    w(path.join(paths.projectsRoot, 'companion', '.env'), `ANTHROPIC_API_KEY=${FAKE.anthropic}`);
    w(
      path.join(paths.projectsRoot, 'doc-upload-site', 'plan.md'),
      `# Plan\n## Deploy\nDeploy the doc upload site with docker compose.\n`
    );
    w(path.join(paths.projectsRoot, 'no-notes', 'README.md'), `# nothing\nDeploy deploy deploy.\n`);
    w(
      path.join(
        paths.memoryRoot,
        '-home-u-local-src-companion',
        'memory',
        'aj-box-deploy-mechanism.md'
      ),
      `---\nname: aj-box-deploy-mechanism\ndescription: "How to deploy Companion code updates to AJ's Mac mini (rsync + launchd)"\n---\nNot a git checkout. rsync the built dist, then launchctl kickstart. token: "${FAKE.shortToken}"\n`
    );
    w(
      path.join(paths.memoryRoot, '-home-u', 'memory', 'misc.md'),
      `---\nname: misc\ndescription: unrelated\n---\nbananas\n`
    );
    kb = new KnowledgeBase(paths);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('search_infra finds the port row and redacts', async () => {
    const r = await kb.searchInfra('jellyfin port');
    expect(r.found).toBe(true);
    expect(JSON.stringify(r)).toContain('8096');
    const s = await kb.searchInfra('secrets anthropic key github aws');
    assertNoSecrets(JSON.stringify(s));
    expect(await kb.infraPortInfo(8096)).toBe('Jellyfin');
    expect(await kb.infraPortInfo(1234)).toBeNull();
  });

  it('search_infra reports an unavailable mount instead of guessing', async () => {
    fs.rmSync(path.dirname(paths.infraDoc), { recursive: true, force: true });
    const r = await kb.searchInfra('jellyfin');
    expect(r.found).toBe(false);
    expect(r.unavailable).toBe(true);
    expect(r.note).toMatch(/isn't reachable/);
  });

  it('cush_tools_help searches the README and only the cush-tools section of CLAUDE.md', async () => {
    const r = await kb.cushToolsHelp('share receive files drop');
    expect(r.found).toBe(true);
    expect(r.results![0].text).toMatch(/drop/);
    const v = await kb.cushToolsHelp('verify tunnel before sharing');
    expect(JSON.stringify(v)).toContain('ping a tunnel URL');
    const all = await kb.cushToolsHelp('unrelated serve words');
    expect((all.results || []).map((r) => r.text).join('\n')).not.toContain(
      'unrelated serve words'
    );
    expect(JSON.stringify(await kb.cushToolsHelp('frp token'))).not.toContain(FAKE.envValue);
  });

  it('search_project_notes only covers projects with CLAUDE.md/plan.md, ranks the named one first', async () => {
    expect(await kb.listProjects()).toEqual(['companion', 'doc-upload-site']);
    const named = await kb.searchProjectNotes('deploy', 'doc upload site');
    expect(named.project).toBe('doc-upload-site');
    expect(named.results![0].source).toContain('doc-upload-site');
    const mentioned = await kb.searchProjectNotes('how do I deploy companion');
    expect(mentioned.results![0].source).toContain('companion');
    const unknown = await kb.searchProjectNotes('deploy', 'zzz-nothing');
    expect(unknown.found).toBe(false);
    const keys = await kb.searchProjectNotes('keys anthropic github token secret', 'companion');
    assertNoSecrets(JSON.stringify(keys));
  });

  it('search_memory uses frontmatter and labels the project', async () => {
    const r = await kb.searchMemory("deploy to AJ's box");
    expect(r.found).toBe(true);
    expect(r.results![0].section).toContain('aj-box-deploy-mechanism');
    expect(r.results![0].section).toContain('companion memory');
    expect(r.results![0].text).toMatch(/rsync/);
    assertNoSecrets(JSON.stringify(r));
    expect((await kb.searchMemory('quantum chromodynamics')).found).toBe(false);
  });

  it('tool layer: knowledge tools go through validation and never leak secrets', async () => {
    const toolbox = new HeraldToolbox({
      paths,
      status: async () => ({ ok: true, server: 'running', tools: [] }),
    });
    const env = { toolbox } as unknown as ToolEnv;
    const state: TurnToolState = { userText: '', sessionRefs: new Map(), proposals: [] };
    for (const [name, args] of [
      ['search_infra', { query: 'secrets anthropic key' }],
      ['search_project_notes', { query: 'keys token', project: 'companion' }],
      ['search_memory', { query: 'deploy aj token' }],
      ['cush_tools_help', { query: 'token' }],
    ] as const) {
      const v = validateToolCall(name, JSON.stringify(args));
      expect(v.ok).toBe(true);
      const out = await executeTool(
        name,
        (v as { value: Record<string, unknown> }).value,
        env,
        state
      );
      expect(out.isError).toBe(false);
      assertNoSecrets(out.content);
    }
    expect(validateToolCall('search_infra', '{}').ok).toBe(false);
    expect(validateToolCall('search_infra', JSON.stringify({ query: 'x'.repeat(400) })).ok).toBe(
      false
    );
  });

  it('resolveKnowledgePaths derives the real home from code_home (sandbox HOME is ignored)', () => {
    const p = resolveKnowledgePaths('/home/realuser/.claude');
    expect(p.userHome).toBe('/home/realuser');
    expect(p.memoryRoot).toBe('/home/realuser/.claude/projects');
    expect(p.projectsRoot).toBe('/home/realuser/local/src');
  });

  it('every new tool has a spec', () => {
    const names = TOOL_SPECS.map((t) => t.name);
    for (const n of [
      'search_infra',
      'cush_tools_help',
      'cush_status',
      'search_project_notes',
      'search_memory',
      'propose_cush_command',
    ])
      expect(names).toContain(n);
  });
});

describe('protocol mirror', () => {
  /** Normalize a TS types file: drop comments and whitespace so layout differences don't matter. */
  function normalize(file: string): string {
    return fs
      .readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\s+/g, '')
      .replace(/;(?=})/g, '')
      .replace(/,(?=})/g, '');
  }

  function decls(src: string): Map<string, string> {
    const out = new Map<string, string>();
    const re = /export(?:interface|type)(\w+)/g;
    let m: RegExpExecArray | null;
    const starts: Array<{ name: string; at: number }> = [];
    while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
    starts.forEach((s, i) =>
      out.set(s.name, src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : undefined))
    );
    return out;
  }

  it('web/src/types/herald.ts mirrors daemon protocol.ts exactly (modulo formatting)', () => {
    const daemon = decls(normalize(path.join(__dirname, '../src/herald/protocol.ts')));
    const web = decls(normalize(path.join(__dirname, '../../web/src/types/herald.ts')));
    expect(Array.from(web.keys()).sort()).toEqual(Array.from(daemon.keys()).sort());
    for (const [name, body] of daemon)
      expect({ name, body: web.get(name) }).toEqual({ name, body });
    expect(daemon.get('HeraldAction')).toContain("'cush_command'");
  });
});
