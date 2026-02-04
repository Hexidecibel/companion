import { StackTemplate } from '../types';

export const nextjsTemplate: StackTemplate = {
  id: 'nextjs',
  name: 'Next.js + TypeScript',
  description: 'Full-stack React framework with SSR, SSG, and API routes',
  type: 'fullstack',
  icon: '▲',
  tags: ['nextjs', 'react', 'typescript', 'fullstack', 'ssr'],
  scoring: {
    primaryKeywords: ['nextjs', 'next', 'ssr', 'ssg', 'vercel'],
    secondaryKeywords: [
      'fullstack',
      'seo',
      'blog',
      'cms',
      'static',
      'hybrid',
      'server',
      'rendering',
    ],
    useCases: [
      'seo blog',
      'fullstack app',
      'next.js app',
      'server rendered',
      'static site',
      'blog with ssr',
    ],
    typeSignals: { fullstack: 3, ssr: 3, ssg: 3, seo: 2, blog: 2, cms: 2 },
  },
  files: [
    {
      path: 'package.json',
      template: `{
  "name": "{{projectName}}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "^14.2.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/node": "^22.7.5",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "eslint": "^8.57.0",
    "eslint-config-next": "^14.2.0",
    "typescript": "^5.6.3"
  }
}`,
    },
    {
      path: 'tsconfig.json',
      template: `{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}`,
    },
    {
      path: 'next.config.ts',
      template: `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;`,
    },
    {
      path: 'src/app/layout.tsx',
      template: `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '{{projectName}}',
  description: '{{projectDescription}}',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}`,
    },
    {
      path: 'src/app/page.tsx',
      template: `export default function Home() {
  return (
    <main className="main">
      <h1>{{projectName}}</h1>
      <p>{{projectDescription}}</p>
      <div className="grid">
        <a href="/about" className="card">
          <h2>About</h2>
          <p>Learn more about this project.</p>
        </a>
        <a href="/api/hello" className="card">
          <h2>API</h2>
          <p>Check out the API routes.</p>
        </a>
      </div>
    </main>
  );
}`,
    },
    {
      path: 'src/app/globals.css',
      template: `:root {
  --foreground: #ededed;
  --background: #0a0a0a;
}

* {
  box-sizing: border-box;
  padding: 0;
  margin: 0;
}

html,
body {
  max-width: 100vw;
  overflow-x: hidden;
}

body {
  color: var(--foreground);
  background: var(--background);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

a {
  color: inherit;
  text-decoration: none;
}

.main {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6rem 2rem;
  min-height: 100vh;
}

.main h1 {
  font-size: 2.5rem;
  margin-bottom: 0.5rem;
}

.main p {
  color: #888;
  margin-bottom: 2rem;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
  max-width: 600px;
  width: 100%;
}

.card {
  padding: 1.5rem;
  border-radius: 8px;
  border: 1px solid #333;
  transition: border-color 0.2s, background 0.2s;
}

.card:hover {
  border-color: #555;
  background: #111;
}

.card h2 {
  font-size: 1.2rem;
  margin-bottom: 0.5rem;
}

.card p {
  font-size: 0.9rem;
  color: #888;
  margin-bottom: 0;
}`,
    },
    {
      path: 'src/app/about/page.tsx',
      template: `export default function About() {
  return (
    <main className="main">
      <h1>About</h1>
      <p>{{projectDescription}}</p>
      <a href="/">Back to home</a>
    </main>
  );
}`,
    },
    {
      path: 'src/app/api/hello/route.ts',
      template: `import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ message: 'Hello from {{projectName}}!' });
}`,
    },
    {
      path: '.gitignore',
      template: `# Dependencies
node_modules

# Next.js
.next/
out/

# Production
build

# Debug
npm-debug.log*

# Environment
.env*.local

# Vercel
.vercel

# IDE
.vscode
.idea

# OS
.DS_Store`,
    },
    {
      path: 'CLAUDE.md',
      template: `# {{projectName}}

{{projectDescription}}

## Tech Stack
- Next.js 14 with App Router
- React 18 with TypeScript
- CSS Modules / Global CSS

## Project Structure
\`\`\`
src/
├── app/
│   ├── layout.tsx      # Root layout
│   ├── page.tsx        # Home page
│   ├── globals.css     # Global styles
│   ├── about/
│   │   └── page.tsx    # About page
│   └── api/
│       └── hello/
│           └── route.ts  # API route
\`\`\`

## Commands
- \`npm run dev\` - Start dev server
- \`npm run build\` - Build for production
- \`npm start\` - Start production server
- \`npm run lint\` - Run ESLint

## Development Notes
- Pages go in \`src/app/\` (file-based routing)
- API routes go in \`src/app/api/\`
- Components go in \`src/components/\`
- Use Server Components by default, add 'use client' only when needed`,
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

Open [http://localhost:3000](http://localhost:3000) to see the app.

## Scripts

- \`npm run dev\` - Start development server
- \`npm run build\` - Build for production
- \`npm start\` - Run production server
- \`npm run lint\` - Lint code`,
    },
  ],
  postCreate: [
    {
      command: 'npm install',
      description: 'Installing dependencies',
    },
  ],
  recommendedSkills: ['build', 'dev'],
};
