import { StackTemplate } from '../types';

export const reactTypescriptTemplate: StackTemplate = {
  id: 'react-typescript',
  name: 'React + TypeScript',
  description: 'Modern React app with TypeScript, Vite, and best practices',
  type: 'frontend',
  icon: '⚛️',
  tags: ['react', 'typescript', 'vite', 'frontend'],
  scoring: {
    primaryKeywords: ['react', 'vite', 'jsx', 'tsx', 'component', 'spa'],
    secondaryKeywords: ['frontend', 'ui', 'interface', 'web', 'app', 'client', 'browser'],
    useCases: [
      'react app',
      'single page',
      'web app',
      'frontend app',
      'react dashboard',
      'react project',
    ],
    typeSignals: { frontend: 3, spa: 3, dashboard: 2, widget: 1, ui: 2 },
  },
  files: [
    {
      path: 'package.json',
      template: `{
  "name": "{{projectName}}",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview",
    "test": "vitest"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@eslint/js": "^9.13.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "eslint": "^9.13.0",
    "eslint-plugin-react-hooks": "^5.0.0",
    "eslint-plugin-react-refresh": "^0.4.14",
    "globals": "^15.11.0",
    "typescript": "~5.6.2",
    "typescript-eslint": "^8.11.0",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  }
}`,
    },
    {
      path: 'tsconfig.json',
      template: `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src"]
}`,
    },
    {
      path: 'vite.config.ts',
      template: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})`,
    },
    {
      path: 'index.html',
      template: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{projectName}}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
    },
    {
      path: 'src/main.tsx',
      template: `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)`,
    },
    {
      path: 'src/App.tsx',
      template: `import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <div className="app">
      <h1>{{projectName}}</h1>
      <p>{{projectDescription}}</p>
      <div className="card">
        <button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
      </div>
    </div>
  )
}

export default App`,
    },
    {
      path: 'src/App.css',
      template: `.app {
  max-width: 1280px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

.card {
  padding: 2em;
}

button {
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.6em 1.2em;
  font-size: 1em;
  font-weight: 500;
  font-family: inherit;
  background-color: #1a1a1a;
  color: #fff;
  cursor: pointer;
  transition: border-color 0.25s;
}

button:hover {
  border-color: #646cff;
}

button:focus,
button:focus-visible {
  outline: 4px auto -webkit-focus-ring-color;
}`,
    },
    {
      path: 'src/index.css',
      template: `:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: light dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}`,
    },
    {
      path: 'src/vite-env.d.ts',
      template: `/// <reference types="vite/client" />`,
    },
    {
      path: '.gitignore',
      template: `# Dependencies
node_modules

# Build
dist
dist-ssr
*.local

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
- React 18 with TypeScript
- Vite for build tooling
- Vitest for testing

## Project Structure
\`\`\`
src/
├── main.tsx      # Entry point
├── App.tsx       # Main component
├── App.css       # Component styles
└── index.css     # Global styles
\`\`\`

## Commands
- \`npm run dev\` - Start dev server
- \`npm run build\` - Build for production
- \`npm run test\` - Run tests
- \`npm run lint\` - Run linter

## Development Notes
- Components go in \`src/components/\`
- Hooks go in \`src/hooks/\`
- Types go in \`src/types/\`
- Services/API calls go in \`src/services/\``,
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

## Scripts

- \`npm run dev\` - Start development server
- \`npm run build\` - Build for production
- \`npm run preview\` - Preview production build
- \`npm run test\` - Run tests
- \`npm run lint\` - Lint code`,
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
