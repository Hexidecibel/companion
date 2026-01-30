import { TmuxManager } from '../src/tmux-manager';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// These tests require git to be installed
// They use real filesystem operations in a temp directory

describe('TmuxManager worktree support', () => {
  let tmpDir: string;
  let repoDir: string;
  let tmux: TmuxManager;

  beforeAll(async () => {
    // Create a temp directory with a git repo
    const { stdout } = await execAsync('mktemp -d');
    tmpDir = stdout.trim();
    repoDir = `${tmpDir}/test-repo`;
    await execAsync(`mkdir -p ${repoDir}`);
    await execAsync('git init', { cwd: repoDir });
    await execAsync('git config user.email "test@test.com"', { cwd: repoDir });
    await execAsync('git config user.name "Test"', { cwd: repoDir });
    await execAsync('touch README.md', { cwd: repoDir });
    await execAsync('git add . && git commit -m "init"', { cwd: repoDir });

    tmux = new TmuxManager('test');
  });

  afterAll(async () => {
    // Clean up temp directory
    await execAsync(`rm -rf ${tmpDir}`).catch(() => {});
  });

  describe('isGitRepo', () => {
    it('returns true for a git repository', async () => {
      const result = await tmux.isGitRepo(repoDir);
      expect(result).toBe(true);
    });

    it('returns false for a non-git directory', async () => {
      const result = await tmux.isGitRepo(tmpDir);
      expect(result).toBe(false);
    });

    it('returns false for non-existent directory', async () => {
      const result = await tmux.isGitRepo('/nonexistent/path');
      expect(result).toBe(false);
    });
  });

  describe('createWorktree', () => {
    afterEach(async () => {
      // Clean up any worktrees created
      try {
        const { stdout } = await execAsync('git worktree list --porcelain', { cwd: repoDir });
        const paths = stdout.split('\n')
          .filter(l => l.startsWith('worktree '))
          .map(l => l.replace('worktree ', ''))
          .filter(p => p !== repoDir);
        for (const p of paths) {
          await execAsync(`git worktree remove "${p}" --force`, { cwd: repoDir }).catch(() => {});
        }
      } catch {
        // ignore
      }
    });

    it('creates a worktree with a branch name', async () => {
      const result = await tmux.createWorktree(repoDir, 'feature-test');
      expect(result.success).toBe(true);
      expect(result.worktreePath).toBeDefined();
      expect(result.branch).toBe('feature-test');

      // Verify the worktree exists
      const { stdout } = await execAsync('git worktree list', { cwd: repoDir });
      expect(stdout).toContain('feature-test');
    });

    it('creates a worktree with auto-generated branch name', async () => {
      const result = await tmux.createWorktree(repoDir);
      expect(result.success).toBe(true);
      expect(result.worktreePath).toBeDefined();
      expect(result.branch).toBeDefined();
      // Auto-generated branch starts with "wt-"
      expect(result.branch).toMatch(/^wt-/);
    });

    it('fails for non-git directory', async () => {
      const result = await tmux.createWorktree(tmpDir, 'test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a git repository');
    });

    it('fails if branch already exists as worktree', async () => {
      await tmux.createWorktree(repoDir, 'duplicate-test');
      const result = await tmux.createWorktree(repoDir, 'duplicate-test');
      expect(result.success).toBe(false);
    });
  });

  describe('removeWorktree', () => {
    it('removes an existing worktree', async () => {
      const create = await tmux.createWorktree(repoDir, 'to-remove');
      expect(create.success).toBe(true);

      const result = await tmux.removeWorktree(repoDir, create.worktreePath!);
      expect(result.success).toBe(true);

      // Verify it's gone
      const { stdout } = await execAsync('git worktree list', { cwd: repoDir });
      expect(stdout).not.toContain('to-remove');
    });

    it('returns error for non-existent worktree', async () => {
      const result = await tmux.removeWorktree(repoDir, '/nonexistent/path');
      expect(result.success).toBe(false);
    });
  });

  describe('listWorktrees', () => {
    afterEach(async () => {
      try {
        const { stdout } = await execAsync('git worktree list --porcelain', { cwd: repoDir });
        const paths = stdout.split('\n')
          .filter(l => l.startsWith('worktree '))
          .map(l => l.replace('worktree ', ''))
          .filter(p => p !== repoDir);
        for (const p of paths) {
          await execAsync(`git worktree remove "${p}" --force`, { cwd: repoDir }).catch(() => {});
        }
      } catch {
        // ignore
      }
    });

    it('lists worktrees including the main one', async () => {
      const worktrees = await tmux.listWorktrees(repoDir);
      expect(worktrees.length).toBeGreaterThanOrEqual(1);
      // Main worktree should be listed (path may be resolved symlink)
      expect(worktrees.some(wt => wt.isMain)).toBe(true);
      expect(worktrees[0].branch).toBeDefined();
    });

    it('includes created worktrees', async () => {
      await tmux.createWorktree(repoDir, 'list-test');
      const worktrees = await tmux.listWorktrees(repoDir);
      expect(worktrees.length).toBe(2);
      expect(worktrees.some(wt => wt.branch === 'list-test')).toBe(true);
    });

    it('returns empty for non-git directory', async () => {
      const worktrees = await tmux.listWorktrees(tmpDir);
      expect(worktrees).toEqual([]);
    });
  });
});
