import { generateClaudeMd, generateCommandFiles, CommandFile } from '../src/scaffold/claude-commands';

describe('generateClaudeMd', () => {
  it('generates CLAUDE.md content with project name and description', () => {
    const result = generateClaudeMd('my-app', 'A todo list application', 'react-typescript');
    expect(result).toContain('my-app');
    expect(result).toContain('A todo list application');
  });

  it('includes build/test commands for the template type', () => {
    const result = generateClaudeMd('my-api', 'REST API', 'node-express');
    expect(result).toContain('npm');
  });

  it('includes build commands for Python templates', () => {
    const result = generateClaudeMd('my-api', 'Python API', 'python-fastapi');
    expect(result).toContain('pip');
  });

  it('includes build commands for Go templates', () => {
    const result = generateClaudeMd('my-cli', 'CLI tool', 'go-cli');
    expect(result).toContain('go');
  });

  it('returns content for unknown template with generic instructions', () => {
    const result = generateClaudeMd('my-app', 'App', 'unknown-template');
    expect(result).toContain('my-app');
    // Falls back to default config (npm-based)
    expect(result).toContain('npm');
  });
});

describe('generateCommandFiles', () => {
  it('returns 6 standard command files', () => {
    const files = generateCommandFiles('my-app', 'react-typescript');
    expect(files).toHaveLength(6);

    const names = files.map(f => f.name);
    expect(names).toContain('up');
    expect(names).toContain('down');
    expect(names).toContain('todo');
    expect(names).toContain('plan');
    expect(names).toContain('work');
    expect(names).toContain('test');
  });

  it('generates correct file paths under .claude/commands/', () => {
    const files = generateCommandFiles('my-app', 'react-typescript');
    for (const file of files) {
      expect(file.path).toBe(`.claude/commands/${file.name}.md`);
    }
  });

  it('includes stack-specific content in /up command', () => {
    const nodeFiles = generateCommandFiles('my-api', 'node-express');
    const upCmd = nodeFiles.find(f => f.name === 'up')!;
    expect(upCmd.content).toContain('npm');

    const pyFiles = generateCommandFiles('my-api', 'python-fastapi');
    const pyUp = pyFiles.find(f => f.name === 'up')!;
    expect(pyUp.content).toContain('uvicorn');

    const goFiles = generateCommandFiles('my-cli', 'go-cli');
    const goUp = goFiles.find(f => f.name === 'up')!;
    expect(goUp.content).toContain('go run');
  });

  it('includes stack-specific content in /test command', () => {
    const nodeFiles = generateCommandFiles('my-api', 'node-express');
    const testCmd = nodeFiles.find(f => f.name === 'test')!;
    expect(testCmd.content).toContain('npm test');

    const pyFiles = generateCommandFiles('my-api', 'python-fastapi');
    const pyTest = pyFiles.find(f => f.name === 'test')!;
    expect(pyTest.content).toContain('pytest');

    const goFiles = generateCommandFiles('my-cli', 'go-cli');
    const goTest = goFiles.find(f => f.name === 'test')!;
    expect(goTest.content).toContain('go test');
  });

  it('/todo command is stack-agnostic', () => {
    const files1 = generateCommandFiles('app1', 'react-typescript');
    const files2 = generateCommandFiles('app2', 'python-fastapi');

    const todo1 = files1.find(f => f.name === 'todo')!;
    const todo2 = files2.find(f => f.name === 'todo')!;

    // Both should contain the same structure (project-name-independent part)
    expect(todo1.content).toContain('todo.md');
    expect(todo2.content).toContain('todo.md');
  });

  it('/plan and /work commands reference todo.md and plan.md', () => {
    const files = generateCommandFiles('my-app', 'react-typescript');
    const plan = files.find(f => f.name === 'plan')!;
    const work = files.find(f => f.name === 'work')!;

    expect(plan.content).toContain('todo.md');
    expect(plan.content).toContain('plan.md');
    expect(work.content).toContain('plan.md');
  });
});
