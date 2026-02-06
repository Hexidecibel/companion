import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  source: 'project' | 'global';
  filePath: string;
}

export interface ParsedSkill {
  id: string;
  name: string;
  description: string;
  filePath: string;
}

/**
 * Parse a single skill .md file, extracting title (H1) and description (first paragraph).
 */
export function parseSkillFile(filePath: string): ParsedSkill | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const id = path.basename(filePath, '.md');

    const lines = content.split('\n');
    let name = id;
    let description = '';
    let foundTitle = false;
    let descLines: string[] = [];
    let pastTitle = false;

    for (const line of lines) {
      // Look for H1 title
      if (!foundTitle) {
        const h1Match = line.match(/^#\s+(.+)/);
        if (h1Match) {
          name = h1Match[1].trim();
          foundTitle = true;
          pastTitle = false;
          continue;
        }
      }

      // After title, skip blank lines then collect first paragraph
      if (foundTitle) {
        if (!pastTitle && line.trim() === '') {
          pastTitle = true;
          continue;
        }
        if (pastTitle) {
          // Stop at next heading, blank line after content, or special marker
          if (line.trim() === '' || line.startsWith('#') || line.startsWith('---')) {
            break;
          }
          descLines.push(line.trim());
        }
      }
    }

    // If no title found, use first non-empty line as description
    if (!foundTitle) {
      for (const line of lines) {
        if (line.trim()) {
          descLines = [line.trim()];
          break;
        }
      }
    }

    description = descLines.join(' ');

    return { id, name, description, filePath };
  } catch {
    return null;
  }
}

/**
 * Scan .claude/commands/*.md in a project directory.
 */
export function scanProjectSkills(projectRoot: string): InstalledSkill[] {
  const commandsDir = path.join(projectRoot, '.claude', 'commands');
  return scanDirectory(commandsDir, 'project');
}

/**
 * Scan a global commands directory (typically ~/.claude/commands/).
 */
export function scanGlobalSkills(globalCommandsDir?: string): InstalledSkill[] {
  const dir = globalCommandsDir || path.join(os.homedir(), '.claude', 'commands');
  return scanDirectory(dir, 'global');
}

function scanDirectory(dir: string, source: 'project' | 'global'): InstalledSkill[] {
  try {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    const skills: InstalledSkill[] = [];

    for (const file of files) {
      const filePath = path.join(dir, file);
      const parsed = parseSkillFile(filePath);
      if (parsed) {
        skills.push({ ...parsed, source });
      }
    }

    return skills;
  } catch {
    return [];
  }
}
