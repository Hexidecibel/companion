import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillCatalog, CatalogSkill } from '../src/skill-catalog';

describe('SkillCatalog', () => {
  let catalog: SkillCatalog;
  let tmpDir: string;

  beforeEach(() => {
    catalog = new SkillCatalog();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should load catalog with skills', () => {
    const skills = catalog.getAvailableSkills();
    expect(skills.length).toBeGreaterThan(0);
  });

  it('should have expected categories', () => {
    const skills = catalog.getAvailableSkills();
    const categories = [...new Set(skills.map((s) => s.category))];
    expect(categories).toContain('workflow');
    expect(categories).toContain('dev');
    expect(categories).toContain('git');
    expect(categories).toContain('ops');
    expect(categories).toContain('search');
  });

  it('should have required fields for each skill', () => {
    const skills = catalog.getAvailableSkills();
    for (const skill of skills) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(skill.category).toBeTruthy();
      expect(skill.content).toBeTruthy();
      expect(['universal', 'project-specific']).toContain(skill.scope);
    }
  });

  it('should get skill content by id', () => {
    const content = catalog.getSkillContent('todo');
    expect(content).toBeTruthy();
    expect(content).toContain('# Add Todo Item');
  });

  it('should return null for unknown skill', () => {
    const content = catalog.getSkillContent('nonexistent');
    expect(content).toBeNull();
  });

  it('should install a skill to project directory', () => {
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    catalog.installSkill('todo', 'project', tmpDir);

    expect(fs.existsSync(path.join(commandsDir, 'todo.md'))).toBe(true);
    const content = fs.readFileSync(path.join(commandsDir, 'todo.md'), 'utf-8');
    expect(content).toContain('# Add Todo Item');
  });

  it('should install a skill to global directory', () => {
    const globalDir = path.join(tmpDir, 'global-commands');
    catalog.installSkill('test', 'global', tmpDir, globalDir);

    expect(fs.existsSync(path.join(globalDir, 'test.md'))).toBe(true);
    const content = fs.readFileSync(path.join(globalDir, 'test.md'), 'utf-8');
    expect(content).toContain('# Run Tests');
  });

  it('should throw for unknown skill on install', () => {
    expect(() => catalog.installSkill('nonexistent', 'project', tmpDir)).toThrow();
  });

  it('should uninstall a skill from project', () => {
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    // First install
    catalog.installSkill('todo', 'project', tmpDir);
    expect(fs.existsSync(path.join(commandsDir, 'todo.md'))).toBe(true);

    // Then uninstall
    catalog.uninstallSkill('todo', 'project', tmpDir);
    expect(fs.existsSync(path.join(commandsDir, 'todo.md'))).toBe(false);
  });

  it('should get a skill by id', () => {
    const skill = catalog.getSkill('todo');
    expect(skill).toBeTruthy();
    expect(skill?.name).toBe('Add Todo Item');
  });
});
