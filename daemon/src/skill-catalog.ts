import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  scope: 'universal' | 'project-specific';
  prerequisites: string[];
  content: string;
}

export class SkillCatalog {
  private skills: CatalogSkill[] = [];

  constructor() {
    this.loadCatalog();
  }

  private loadCatalog(): void {
    try {
      const catalogPath = path.join(__dirname, 'skills', 'catalog.json');
      const raw = fs.readFileSync(catalogPath, 'utf-8');
      this.skills = JSON.parse(raw) as CatalogSkill[];
    } catch (err) {
      console.error('Failed to load skill catalog:', err);
      this.skills = [];
    }
  }

  getAvailableSkills(): CatalogSkill[] {
    return this.skills;
  }

  getSkill(id: string): CatalogSkill | null {
    return this.skills.find((s) => s.id === id) || null;
  }

  getSkillContent(id: string): string | null {
    const skill = this.skills.find((s) => s.id === id);
    return skill?.content || null;
  }

  installSkill(
    skillId: string,
    target: 'project' | 'global',
    projectRoot: string,
    globalDir?: string
  ): void {
    const skill = this.skills.find((s) => s.id === skillId);
    if (!skill) {
      throw new Error(`Unknown skill: ${skillId}`);
    }

    let targetDir: string;
    if (target === 'project') {
      targetDir = path.join(projectRoot, '.claude', 'commands');
    } else {
      targetDir = globalDir || path.join(os.homedir(), '.claude', 'commands');
    }

    fs.mkdirSync(targetDir, { recursive: true });
    const filePath = path.join(targetDir, `${skillId}.md`);
    fs.writeFileSync(filePath, skill.content, 'utf-8');
    console.log(`Installed skill '${skillId}' to ${filePath}`);
  }

  uninstallSkill(
    skillId: string,
    source: 'project' | 'global',
    projectRoot: string,
    globalDir?: string
  ): void {
    let targetDir: string;
    if (source === 'project') {
      targetDir = path.join(projectRoot, '.claude', 'commands');
    } else {
      targetDir = globalDir || path.join(os.homedir(), '.claude', 'commands');
    }

    const filePath = path.join(targetDir, `${skillId}.md`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Uninstalled skill '${skillId}' from ${filePath}`);
    }
  }
}
