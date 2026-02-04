import { StackTemplate } from '../types';

export const nodeExpressTemplate: StackTemplate = {
  id: 'node-express',
  name: 'Node.js + Express + TypeScript',
  description: 'REST API with Express, TypeScript, and best practices',
  type: 'backend',
  icon: '🟢',
  tags: ['node', 'express', 'typescript', 'backend', 'api'],
  scoring: {
    primaryKeywords: ['express', 'node', 'rest', 'api', 'server', 'endpoint'],
    secondaryKeywords: ['backend', 'http', 'middleware', 'route', 'json', 'microservice'],
    useCases: [
      'rest api',
      'node api',
      'express server',
      'backend service',
      'api server',
      'web server',
    ],
    typeSignals: { api: 3, server: 3, backend: 2, microservice: 2, service: 1 },
  },
  files: [
    {
      path: 'package.json',
      template: `{
  "name": "{{projectName}}",
  "version": "1.0.0",
  "description": "{{projectDescription}}",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest",
    "lint": "eslint src/"
  },
  "dependencies": {
    "express": "^4.21.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^22.7.5",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4",
    "eslint": "^9.13.0",
    "@typescript-eslint/eslint-plugin": "^8.11.0",
    "@typescript-eslint/parser": "^8.11.0"
  }
}`,
    },
    {
      path: 'tsconfig.json',
      template: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}`,
    },
    {
      path: 'src/index.ts',
      template: `import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { router } from './routes/index.js';

config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api', router);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(\`Server running on http://localhost:\${port}\`);
});`,
    },
    {
      path: 'src/routes/index.ts',
      template: `import { Router } from 'express';

export const router = Router();

router.get('/', (req, res) => {
  res.json({ message: 'Welcome to {{projectName}} API' });
});

// Add your routes here
// router.use('/users', usersRouter);`,
    },
    {
      path: 'src/types/index.ts',
      template: `// Add your types here

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}`,
    },
    {
      path: '.env',
      template: `PORT=3000
NODE_ENV=development`,
    },
    {
      path: '.env.example',
      template: `PORT=3000
NODE_ENV=development`,
    },
    {
      path: '.gitignore',
      template: `# Dependencies
node_modules

# Build
dist

# Environment
.env
.env.local
.env.*.local

# Logs
*.log
npm-debug.log*

# Editor
.vscode/*
!.vscode/extensions.json
.idea

# OS
.DS_Store`,
    },
    {
      path: 'CLAUDE.md',
      template: `# {{projectName}}

{{projectDescription}}

## Tech Stack
- Node.js with TypeScript
- Express.js for HTTP server
- tsx for development (hot reload)

## Project Structure
\`\`\`
src/
├── index.ts       # Entry point, server setup
├── routes/        # API route handlers
│   └── index.ts   # Route definitions
└── types/         # TypeScript types
    └── index.ts
\`\`\`

## Commands
- \`npm run dev\` - Start dev server with hot reload
- \`npm run build\` - Build TypeScript to dist/
- \`npm start\` - Run production build
- \`npm test\` - Run tests
- \`npm run lint\` - Run linter

## API Endpoints
- \`GET /health\` - Health check
- \`GET /api\` - API root

## Development Notes
- Add routes in \`src/routes/\`
- Add middleware in \`src/middleware/\`
- Add services/business logic in \`src/services/\`
- Environment variables in \`.env\``,
    },
    {
      path: 'README.md',
      template: `# {{projectName}}

{{projectDescription}}

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`

Server will start at http://localhost:3000

## Scripts

- \`npm run dev\` - Start development server
- \`npm run build\` - Build for production
- \`npm start\` - Run production server
- \`npm test\` - Run tests`,
    },
  ],
  postCreate: [
    {
      command: 'npm install',
      description: 'Installing dependencies',
    },
  ],
  recommendedSkills: ['test', 'build', 'dev'],
};
