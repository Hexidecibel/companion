import { classifyChangedFile, classifyRevert, ChangedFileStats } from '../../herald/danger';

const mod = (over: Partial<ChangedFileStats> = {}): ChangedFileStats => ({ status: 'modified', additions: 3, deletions: 1, ...over });
const kinds = (rel: string, stats: ChangedFileStats = mod(), added?: string[]) =>
  classifyChangedFile(`/p/${rel}`, rel, stats, added).map((f) => `${f.kind}:${f.level}`);

describe('classifyChangedFile', () => {
  it.each([
    ['db/migrations/003_users.sql', 'migration:high'],
    ['prisma/migrations/x/migration.sql', 'migration:high'],
    ['.github/workflows/deploy.yml', 'ci:high'],
    ['bin/deploy', 'ci:high'],
    ['.env.production', 'env:high'],
    ['certs/server.pem', 'secrets:high'],
    ['config/credentials.json', 'secrets:high'],
    ['.claude/settings.local.json', 'agent_config:high'],
    ['.husky/pre-commit', 'agent_config:high'],
    ['deploy/companion.service', 'permissions:high'],
    ['src/auth/session.ts', 'security:high'],
    ['vite.config.ts', 'config:medium'],
    ['tsconfig.json', 'config:medium'],
    ['Dockerfile', 'config:medium'],
    ['docker-compose.yml', 'config:medium'],
    ['package-lock.json', 'lockfile:low'],
  ])('%s -> %s', (rel, expected) => {
    expect(kinds(rel)).toContain(expected);
  });

  it('plain source files are clean', () => {
    expect(kinds('src/components/Button.tsx')).toEqual([]);
    expect(kinds('docs/authors.md')).toEqual([]);
  });

  it('deletions scale with size', () => {
    expect(kinds('src/a.ts', mod({ status: 'deleted', additions: 0, deletions: 10 }))).toContain('deleted:medium');
    expect(kinds('src/a.ts', mod({ status: 'deleted', additions: 0, deletions: 140 }))).toContain('deleted:high');
    const f = classifyChangedFile('/p/a', 'a', mod({ status: 'deleted', additions: 0, deletions: 140 }));
    expect(f[0].reason).toBe('deletes the file (140 lines)');
  });

  it('secret-looking added lines, dependency blocks, mode, rewrite, binary, outside, foreign', () => {
    expect(kinds('src/x.ts', mod(), ['const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"'])).toContain('secrets:high');
    expect(kinds('package.json', mod(), ['    "react": "^18.2.0",'])).toContain('dependency:medium');
    expect(kinds('package.json', mod(), ['  "version": "1.2.3",'])).not.toContain('dependency:medium');
    expect(kinds('bin/run.sh', mod({ modeChanged: true, newMode: '100755' }))).toContain('permissions:high');
    expect(kinds('src/a.ts', mod({ additions: 250, deletions: 100 }))).toContain('large_rewrite:medium');
    expect(kinds('src/a.ts', mod({ additions: 30, deletions: 30, fileLines: 50 }))).toContain('large_rewrite:medium');
    expect(kinds('logo.png', mod({ binary: true }))).toContain('binary:low');
    expect(kinds('a.ts', mod({ outsideProject: true }))).toContain('outside_project:low');
    expect(kinds('a.ts', mod({ alsoChangedBy: ['Out4'] }))).toContain('foreign:medium');
  });

  it('sorts high first', () => {
    const f = classifyChangedFile('/p/package-lock.json', 'src/auth/package-lock.json', mod());
    expect(f[0].level).toBe('high');
  });
});

describe('classifyRevert', () => {
  const base = { effect: 'patch' as const, wholeFile: false, risks: [], changedLines: 4, sessionWorking: false, path: 'a.ts' };
  it.each([
    [{}, 'echo'],
    [{ effect: 'delete' as const }, 'hard_confirm'],
    [{ wholeFile: true }, 'hard_confirm'],
    [{ risks: [{ kind: 'ci' as const, level: 'high' as const, reason: 'CI workflow' }] }, 'hard_confirm'],
    [{ risks: [{ kind: 'config' as const, level: 'medium' as const, reason: 'config' }] }, 'echo'],
    [{ changedLines: 201 }, 'hard_confirm'],
    [{ sessionWorking: true }, 'hard_confirm'],
  ])('%j -> %s', (over, tier) => {
    expect(classifyRevert({ ...base, ...over }).tier).toBe(tier);
  });
});
