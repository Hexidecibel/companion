import { StackTemplate } from '../types';

export const typescriptLibraryTemplate: StackTemplate = {
  id: 'typescript-library',
  name: 'TypeScript Library',
  description: 'Publishable npm package with tsup bundler and vitest',
  type: 'library',
  icon: '📦',
  tags: ['typescript', 'npm', 'library', 'package', 'tsup'],
  scoring: {
    primaryKeywords: ['npm', 'package', 'library', 'module', 'tsup'],
    secondaryKeywords: ['publish', 'bundle', 'sdk', 'utility', 'reusable', 'export'],
    useCases: [
      'npm package',
      'typescript library',
      'utility package',
      'npm utility',
      'shared library',
      'sdk package',
    ],
    typeSignals: { library: 3, package: 3, npm: 3, sdk: 2, module: 2, utility: 1 },
  },
  files: [
    {
      path: 'package.json',
      template: `{
  "name": "{{projectName}}",
  "version": "0.1.0",
  "description": "{{projectDescription}}",
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest",
    "test:run": "vitest run",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "devDependencies": {
    "eslint": "^9.13.0",
    "tsup": "^8.3.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  },
  "keywords": [],
  "license": "MIT"
}`,
    },
    {
      path: 'tsconfig.json',
      template: `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}`,
    },
    {
      path: 'tsup.config.ts',
      template: `import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});`,
    },
    {
      path: 'src/index.ts',
      template: `/**
 * {{projectName}}
 * {{projectDescription}}
 */

export { greet } from './greet';
export type { GreetOptions } from './greet';`,
    },
    {
      path: 'src/greet.ts',
      template: `export interface GreetOptions {
  name: string;
  greeting?: string;
}

/**
 * Generate a greeting message.
 */
export function greet(options: GreetOptions): string {
  const { name, greeting = 'Hello' } = options;
  return \`\${greeting}, \${name}!\`;
}`,
    },
    {
      path: 'src/__tests__/greet.test.ts',
      template: `import { describe, it, expect } from 'vitest';
import { greet } from '../greet';

describe('greet', () => {
  it('returns default greeting', () => {
    expect(greet({ name: 'World' })).toBe('Hello, World!');
  });

  it('uses custom greeting', () => {
    expect(greet({ name: 'World', greeting: 'Hi' })).toBe('Hi, World!');
  });
});`,
    },
    {
      path: '.gitignore',
      template: `# Dependencies
node_modules

# Build
dist

# Coverage
coverage

# Editor
.vscode/*
!.vscode/extensions.json
.idea

# Logs
*.log
npm-debug.log*

# OS
.DS_Store`,
    },
    {
      path: 'CLAUDE.md',
      template: `# {{projectName}}

{{projectDescription}}

## Tech Stack
- TypeScript with strict mode
- tsup for bundling (CJS + ESM)
- vitest for testing

## Project Structure
\`\`\`
src/
├── index.ts              # Public API exports
├── greet.ts              # Example module
└── __tests__/
    └── greet.test.ts     # Tests
\`\`\`

## Commands
- \`npm run build\` - Build with tsup (CJS + ESM + types)
- \`npm run dev\` - Watch mode
- \`npm test\` - Run tests in watch mode
- \`npm run test:run\` - Run tests once
- \`npm run typecheck\` - Type check
- \`npm run lint\` - Lint

## Development Notes
- Export all public API from \`src/index.ts\`
- Add new modules in \`src/\`
- Add tests in \`src/__tests__/\`
- Package supports both CJS and ESM consumers
- Run \`npm publish\` to publish (builds automatically via prepublishOnly)`,
    },
    {
      path: 'README.md',
      template: `# {{projectName}}

{{projectDescription}}

## Install

\`\`\`bash
npm install {{projectName}}
\`\`\`

## Usage

\`\`\`typescript
import { greet } from '{{projectName}}';

console.log(greet({ name: 'World' }));
// => "Hello, World!"
\`\`\`

## API

### \`greet(options)\`

Generate a greeting message.

- \`options.name\` - Name to greet (required)
- \`options.greeting\` - Custom greeting prefix (default: "Hello")

## Development

\`\`\`bash
npm install
npm test
npm run build
\`\`\``,
    },
  ],
  postCreate: [
    {
      command: 'npm install',
      description: 'Installing dependencies',
    },
  ],
  recommendedSkills: ['test', 'build'],
};
