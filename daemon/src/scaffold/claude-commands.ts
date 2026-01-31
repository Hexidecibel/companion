/**
 * Generates CLAUDE.md content and .claude/commands/*.md files
 * tailored to each project template.
 */

export interface CommandFile {
  name: string;   // e.g., 'up', 'test'
  path: string;   // e.g., '.claude/commands/up.md'
  content: string; // The prompt template
}

// Stack-specific configuration for command generation
interface StackConfig {
  upCmd: string;
  downCmd: string;
  testCmd: string;
  buildCmd?: string;
  installCmd?: string;
  devServer?: string;
  language: string;
}

const STACK_CONFIGS: Record<string, StackConfig> = {
  'react-typescript': {
    upCmd: 'npm run dev',
    downCmd: 'Stop the Vite dev server (Ctrl+C in terminal)',
    testCmd: 'npm test',
    buildCmd: 'npm run build',
    installCmd: 'npm install',
    devServer: 'Vite dev server',
    language: 'TypeScript',
  },
  'react-mui-website': {
    upCmd: 'npm run dev',
    downCmd: 'Stop the Vite dev server (Ctrl+C in terminal)',
    testCmd: 'npm test',
    buildCmd: 'npm run build',
    installCmd: 'npm install',
    devServer: 'Vite dev server',
    language: 'TypeScript',
  },
  'node-express': {
    upCmd: 'npm run dev',
    downCmd: 'Stop the Express server (Ctrl+C in terminal)',
    testCmd: 'npm test',
    buildCmd: 'npm run build',
    installCmd: 'npm install',
    devServer: 'Express dev server with ts-node',
    language: 'TypeScript',
  },
  'python-fastapi': {
    upCmd: 'uvicorn main:app --reload',
    downCmd: 'Stop the uvicorn server (Ctrl+C in terminal)',
    testCmd: 'pytest',
    installCmd: 'pip install -r requirements.txt',
    devServer: 'uvicorn with hot reload',
    language: 'Python',
  },
  'nextjs': {
    upCmd: 'npm run dev',
    downCmd: 'Stop the Next.js dev server (Ctrl+C in terminal)',
    testCmd: 'npm test',
    buildCmd: 'npm run build',
    installCmd: 'npm install',
    devServer: 'Next.js dev server',
    language: 'TypeScript',
  },
  'go-cli': {
    upCmd: 'go run .',
    downCmd: 'N/A (CLI exits after execution)',
    testCmd: 'go test ./...',
    buildCmd: 'go build -o bin/',
    language: 'Go',
  },
  'typescript-library': {
    upCmd: 'npm run build -- --watch',
    downCmd: 'Stop the TypeScript watcher (Ctrl+C in terminal)',
    testCmd: 'npm test',
    buildCmd: 'npm run build',
    installCmd: 'npm install',
    language: 'TypeScript',
  },
};

const DEFAULT_CONFIG: StackConfig = {
  upCmd: 'npm run dev',
  downCmd: 'Stop the dev server',
  testCmd: 'npm test',
  buildCmd: 'npm run build',
  installCmd: 'npm install',
  language: 'TypeScript',
};

function getStackConfig(templateId: string): StackConfig {
  return STACK_CONFIGS[templateId] || DEFAULT_CONFIG;
}

/**
 * Generate CLAUDE.md content for a project.
 */
export function generateClaudeMd(
  projectName: string,
  description: string,
  templateId: string,
): string {
  const config = getStackConfig(templateId);

  const sections: string[] = [];

  sections.push(`# ${projectName}`);
  sections.push('');
  sections.push(description);
  sections.push('');

  // Commands section
  sections.push('## Commands');
  sections.push('');
  if (config.installCmd) {
    sections.push(`- Install: \`${config.installCmd}\``);
  }
  if (config.buildCmd) {
    sections.push(`- Build: \`${config.buildCmd}\``);
  }
  sections.push(`- Dev: \`${config.upCmd}\``);
  sections.push(`- Test: \`${config.testCmd}\``);
  sections.push('');

  // Code style
  sections.push('## Code Style');
  sections.push('');
  sections.push(`- Language: ${config.language}`);
  sections.push('- Use functional patterns where possible');
  sections.push('- Keep functions small and focused');
  sections.push('- Prefer explicit types over `any`');
  sections.push('');

  // Workflow
  sections.push('## Workflow');
  sections.push('');
  sections.push('Use the slash commands for common tasks:');
  sections.push('- `/up` — Start dev server');
  sections.push('- `/down` — Stop services');
  sections.push('- `/test` — Run test suite');
  sections.push('- `/todo` — Capture a task');
  sections.push('- `/plan` — Plan implementation from todo');
  sections.push('- `/work` — Implement planned items');
  sections.push('');

  return sections.join('\n');
}

/**
 * Generate .claude/commands/*.md files for a project.
 */
export function generateCommandFiles(
  projectName: string,
  templateId: string,
): CommandFile[] {
  const config = getStackConfig(templateId);

  const commands: CommandFile[] = [
    {
      name: 'up',
      path: '.claude/commands/up.md',
      content: generateUpCommand(projectName, config),
    },
    {
      name: 'down',
      path: '.claude/commands/down.md',
      content: generateDownCommand(projectName, config),
    },
    {
      name: 'todo',
      path: '.claude/commands/todo.md',
      content: generateTodoCommand(projectName),
    },
    {
      name: 'plan',
      path: '.claude/commands/plan.md',
      content: generatePlanCommand(projectName),
    },
    {
      name: 'work',
      path: '.claude/commands/work.md',
      content: generateWorkCommand(projectName, config),
    },
    {
      name: 'test',
      path: '.claude/commands/test.md',
      content: generateTestCommand(projectName, config),
    },
  ];

  return commands;
}

function generateUpCommand(projectName: string, config: StackConfig): string {
  const lines: string[] = [];
  lines.push(`# Start ${projectName}`);
  lines.push('');
  lines.push(`Start the development server/services for ${projectName}.`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  if (config.installCmd) {
    lines.push(`1. Install dependencies if needed: \`${config.installCmd}\``);
    lines.push(`2. Start: \`${config.upCmd}\``);
  } else {
    lines.push(`1. Start: \`${config.upCmd}\``);
  }
  lines.push('');
  return lines.join('\n');
}

function generateDownCommand(projectName: string, config: StackConfig): string {
  const lines: string[] = [];
  lines.push(`# Stop ${projectName}`);
  lines.push('');
  lines.push(`Stop running services for ${projectName}.`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  lines.push(`1. ${config.downCmd}`);
  lines.push('');
  return lines.join('\n');
}

function generateTodoCommand(_projectName: string): string {
  return `# Add Todo Item

Quickly capture ideas and tasks to todo.md.

## Usage

\`\`\`
/todo <description>
\`\`\`

## Instructions

1. The item to add: \`$ARGUMENTS\`

2. Read or create todo.md

3. Add the item as a bullet point:
   - Format: \`- <the text>\`
   - Add under the appropriate section

4. Confirm what was added

## Notes

- This is for quick capture - don't overthink it
- Use \`/plan\` later to process these into detailed plans
- Use \`/work\` to implement from the plan
`;
}

function generatePlanCommand(_projectName: string): string {
  return `# Plan from Todo

Process todo.md items into detailed implementation plans.

## Instructions

1. Read todo.md

2. Read plan.md (if exists)

3. For each unplanned item in todo.md:
   - Ask clarifying questions if needed
   - Understand the scope and requirements
   - Identify which files need changes

4. Write detailed plan to plan.md:
   \`\`\`markdown
   # Implementation Plan

   ## Item: <title>
   **Status:** planned | in-progress | done

   ### Requirements
   - <bullet points>

   ### Files to Modify
   - \`path/to/file\` - <what changes>

   ### Implementation Steps
   1. <step>
   2. <step>

   ### Tests Needed
   - <test case>
   \`\`\`

5. Mark items as planned in todo.md

## Rules

- NO CODING in this phase
- Ask questions if anything is unclear
- Keep plans focused and actionable
`;
}

function generateWorkCommand(_projectName: string, config: StackConfig): string {
  const typeCheck = config.language === 'Python' ? 'mypy .' : config.language === 'Go' ? 'go vet ./...' : 'npx tsc --noEmit';
  return `# Work on Planned Items

Implement items from plan.md using TDD. If multiple items can be parallelized, spawn worker sessions.

## Instructions

1. Read plan.md

2. Find ALL items with **Status: planned** or **Status: in-progress**

3. **If 2+ planned items exist, analyze parallelism:**

   a. For each item, look at the "Files to Modify" section
   b. Compare file lists between items \u2014 items with NO shared files can run in parallel
   c. Group items into:
      - **Parallel group**: Items with non-overlapping files
      - **Sequential group**: Items that share files with another item

   d. Present the analysis via AskUserQuestion:
      - Show which items can be parallelized and why
      - Show which items must be sequential and why (list shared files)
      - Options: [Parallelize] [Work sequentially] [Let me choose]

   e. If user approves parallelization, spawn worker sessions by calling the
      companion daemon API with a \\\`spawn_work_group\\\` message via curl to
      \\\`http://localhost:9877\\\`. Include the token from config, a group name,
      the current session ID, the parent directory, and a workers array with
      each worker's taskSlug, taskDescription, planSection, and files list.

   f. After spawning, continue working on sequential items (if any) using TDD
   g. When done with sequential items, check worker status and report

4. **If only 1 item, or user chose sequential:** Follow TDD for each item:

   a. **Write tests first**
      - Create/update test files based on "Tests Needed" section
      - Run tests - they should fail (red)

   b. **Implement the feature**
      - Follow the "Implementation Steps" from plan
      - Make tests pass (green)
      - Run type check: \`${typeCheck}\`

   c. **Refactor if needed**
      - Clean up code while keeping tests green

   d. **Commit**
      - Commit with descriptive message
      - Update plan.md status to "done"

5. When ALL items are done (including parallel workers), merge if needed by
   calling the daemon API with a \\\`merge_work_group\\\` message.

## Rules

- Tests first, always
- Commit after each completed item
- NO push without explicit approval
- Ask if stuck or unclear
- When spawning workers, each worker handles ONE plan item only
- Workers should not modify files outside their scope
`;
}

function generateTestCommand(_projectName: string, config: StackConfig): string {
  const lines: string[] = [];
  lines.push(`# Run Tests`);
  lines.push('');
  lines.push('Run the project test suite.');
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  lines.push(`1. Run: \`${config.testCmd}\``);
  lines.push('2. Report results: pass/fail count, any failures');
  lines.push('3. If tests fail, show the failure details');
  lines.push('');
  return lines.join('\n');
}
