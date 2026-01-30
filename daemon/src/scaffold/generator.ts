import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ProjectConfig, ScaffoldProgress, ScaffoldResult, StackTemplate } from './types';
import { getTemplate } from './templates';
import { generateClaudeMd, generateCommandFiles } from './claude-commands';

// Expand ~ to home directory
function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p === '~') {
    return os.homedir();
  }
  return p;
}

const execAsync = promisify(exec);

type ProgressCallback = (progress: ScaffoldProgress) => void;

// Replace template variables with actual values
function interpolate(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

// Convert project name to valid identifier (for package names, etc.)
function toValidName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function scaffoldProject(
  config: ProjectConfig,
  onProgress?: ProgressCallback
): Promise<ScaffoldResult> {
  const template = getTemplate(config.stackId);
  if (!template) {
    return {
      success: false,
      projectPath: config.location,
      filesCreated: [],
      error: `Unknown template: ${config.stackId}`,
    };
  }

  const projectPath = path.join(expandPath(config.location), toValidName(config.name));
  const filesCreated: string[] = [];

  const variables: Record<string, string> = {
    projectName: toValidName(config.name),
    projectDescription: config.description || `A ${template.name} project`,
  };

  try {
    // Step 1: Create project directory
    onProgress?.({
      step: 'Creating project directory',
      progress: 5,
      complete: false,
    });

    await fs.mkdir(projectPath, { recursive: true });

    // Step 2: Create files from template
    const totalFiles = template.files.length;
    for (let i = 0; i < template.files.length; i++) {
      const file = template.files[i];
      const filePath = path.join(projectPath, interpolate(file.path, variables));
      const fileContent = interpolate(file.template, variables);

      onProgress?.({
        step: 'Creating files',
        detail: file.path,
        progress: 10 + Math.floor((i / totalFiles) * 50),
        complete: false,
      });

      // Ensure directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, fileContent, 'utf-8');
      filesCreated.push(file.path);
    }

    // Step 2b: Generate CLAUDE.md and .claude/commands/
    onProgress?.({
      step: 'Generating CLAUDE.md and commands',
      progress: 58,
      complete: false,
    });

    const claudeMdContent = generateClaudeMd(
      variables.projectName,
      config.description || `A ${template.name} project`,
      config.stackId,
    );
    const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
    await fs.writeFile(claudeMdPath, claudeMdContent, 'utf-8');
    filesCreated.push('CLAUDE.md');

    const commandFiles = generateCommandFiles(variables.projectName, config.stackId);
    const commandsDir = path.join(projectPath, '.claude', 'commands');
    await fs.mkdir(commandsDir, { recursive: true });
    for (const cmd of commandFiles) {
      const cmdPath = path.join(projectPath, cmd.path);
      await fs.writeFile(cmdPath, cmd.content, 'utf-8');
      filesCreated.push(cmd.path);
    }

    // Step 3: Initialize git if requested
    if (config.options.initGit) {
      onProgress?.({
        step: 'Initializing git repository',
        progress: 60,
        complete: false,
      });

      try {
        // Check if git is available
        await execAsync('which git');
        await execAsync('git init', { cwd: projectPath });
        await execAsync('git add .', { cwd: projectPath });
        await execAsync('git commit -m "Initial commit from Companion"', { cwd: projectPath });

        // Step 3b: Create GitHub repo if requested
        if (config.options.createGitHubRepo) {
          onProgress?.({
            step: 'Creating GitHub repository',
            progress: 65,
            complete: false,
          });

          try {
            // Check if gh CLI is available
            await execAsync('which gh');
            const visibility = config.options.privateRepo ? '--private' : '--public';
            const repoName = toValidName(config.name);
            await execAsync(
              `gh repo create ${repoName} ${visibility} --source=. --remote=origin --push`,
              { cwd: projectPath, timeout: 30000 }
            );
          } catch (ghError) {
            console.warn('GitHub repo creation failed (gh CLI may not be installed or authenticated):', ghError);
            // Non-fatal, continue
          }
        }
      } catch (gitError) {
        console.warn('Git init failed (git may not be installed):', gitError);
        // Non-fatal, continue
      }
    }

    // Step 4: Run post-create commands if any
    if (template.postCreate && template.postCreate.length > 0) {
      for (let i = 0; i < template.postCreate.length; i++) {
        const cmd = template.postCreate[i];
        onProgress?.({
          step: cmd.description,
          progress: 70 + Math.floor((i / template.postCreate.length) * 25),
          complete: false,
        });

        try {
          await execAsync(cmd.command, { cwd: projectPath, timeout: 120000 });
        } catch (cmdError) {
          console.warn(`Post-create command failed: ${cmd.command}`, cmdError);
          // Non-fatal for MVP, continue
        }
      }
    }

    onProgress?.({
      step: 'Complete',
      progress: 100,
      complete: true,
    });

    return {
      success: true,
      projectPath,
      filesCreated,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    onProgress?.({
      step: 'Error',
      detail: errorMessage,
      progress: 0,
      complete: true,
      error: errorMessage,
    });

    return {
      success: false,
      projectPath,
      filesCreated,
      error: errorMessage,
    };
  }
}

// Preview what will be created without actually creating
export async function previewScaffold(
  config: ProjectConfig
): Promise<{ files: string[]; projectPath: string } | { error: string }> {
  const template = getTemplate(config.stackId);
  if (!template) {
    return { error: `Unknown template: ${config.stackId}` };
  }

  const projectPath = path.join(expandPath(config.location), toValidName(config.name));
  const files = template.files.map(f => f.path);

  // Include CLAUDE.md and commands in preview
  files.push('CLAUDE.md');
  const commandFiles = generateCommandFiles(toValidName(config.name), config.stackId);
  for (const cmd of commandFiles) {
    files.push(cmd.path);
  }

  return { files, projectPath };
}
