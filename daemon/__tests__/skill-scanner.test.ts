import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanProjectSkills, scanGlobalSkills, parseSkillFile } from '../src/skill-scanner';

describe('skill-scanner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseSkillFile', () => {
    it('should extract title from H1 and first paragraph as description', () => {
      const filePath = path.join(tmpDir, 'test.md');
      fs.writeFileSync(
        filePath,
        '# My Cool Skill\n\nThis skill does amazing things for your project.\n\n## Instructions\n\n1. Do stuff\n'
      );

      const result = parseSkillFile(filePath);
      expect(result).toEqual({
        id: 'test',
        name: 'My Cool Skill',
        description: 'This skill does amazing things for your project.',
        filePath,
      });
    });

    it('should handle files with no description paragraph', () => {
      const filePath = path.join(tmpDir, 'bare.md');
      fs.writeFileSync(filePath, '# Just a Title\n\n## Steps\n\n1. Do it\n');

      const result = parseSkillFile(filePath);
      expect(result).toEqual({
        id: 'bare',
        name: 'Just a Title',
        description: '',
        filePath,
      });
    });

    it('should handle files with no H1 — use filename as name', () => {
      const filePath = path.join(tmpDir, 'no-heading.md');
      fs.writeFileSync(filePath, 'Just some text with no heading.\n\nMore text.\n');

      const result = parseSkillFile(filePath);
      expect(result).toEqual({
        id: 'no-heading',
        name: 'no-heading',
        description: 'Just some text with no heading.',
        filePath,
      });
    });

    it('should return null for non-existent files', () => {
      const result = parseSkillFile(path.join(tmpDir, 'missing.md'));
      expect(result).toBeNull();
    });
  });

  describe('scanProjectSkills', () => {
    it('should scan .claude/commands/ directory', () => {
      const commandsDir = path.join(tmpDir, '.claude', 'commands');
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, 'deploy.md'), '# Deploy App\n\nDeploy to production.\n');
      fs.writeFileSync(path.join(commandsDir, 'test.md'), '# Run Tests\n\nRun the test suite.\n');

      const skills = scanProjectSkills(tmpDir);
      expect(skills).toHaveLength(2);
      expect(skills.map((s) => s.id).sort()).toEqual(['deploy', 'test']);
      expect(skills[0].source).toBe('project');
    });

    it('should return empty array if commands dir missing', () => {
      const skills = scanProjectSkills(tmpDir);
      expect(skills).toEqual([]);
    });

    it('should ignore non-.md files', () => {
      const commandsDir = path.join(tmpDir, '.claude', 'commands');
      fs.mkdirSync(commandsDir, { recursive: true });
      fs.writeFileSync(path.join(commandsDir, 'deploy.md'), '# Deploy\n\nDeploy.\n');
      fs.writeFileSync(path.join(commandsDir, 'notes.txt'), 'not a skill');

      const skills = scanProjectSkills(tmpDir);
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('deploy');
    });
  });

  describe('scanGlobalSkills', () => {
    it('should scan ~/.claude/commands/ directory', () => {
      const globalDir = path.join(tmpDir, '.claude', 'commands');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.writeFileSync(path.join(globalDir, 'commit.md'), '# Smart Commit\n\nGenerate commit messages.\n');

      const skills = scanGlobalSkills(globalDir);
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('commit');
      expect(skills[0].source).toBe('global');
    });

    it('should return empty array if dir missing', () => {
      const skills = scanGlobalSkills(path.join(tmpDir, 'nonexistent'));
      expect(skills).toEqual([]);
    });
  });
});
