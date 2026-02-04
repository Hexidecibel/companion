import { StackTemplate } from '../types';

export const reactMuiWebsiteTemplate: StackTemplate = {
  id: 'react-mui-website',
  name: 'React + MUI Website',
  description: 'Multi-page website with React, TypeScript, Material UI, and routing',
  type: 'frontend',
  icon: '🎨',
  tags: ['react', 'typescript', 'mui', 'material-ui', 'website', 'frontend'],
  scoring: {
    primaryKeywords: ['mui', 'material', 'website', 'landing', 'portfolio'],
    secondaryKeywords: ['react', 'pages', 'routing', 'navigation', 'design', 'theme', 'multi-page'],
    useCases: [
      'marketing website',
      'landing page',
      'portfolio site',
      'multi-page website',
      'material ui website',
      'company website',
    ],
    typeSignals: { website: 3, landing: 3, portfolio: 3, brochure: 2, marketing: 2 },
  },
  files: [
    {
      path: 'package.json',
      template: `{
  "name": "{{projectName}}",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "@emotion/react": "^11.13.0",
    "@emotion/styled": "^11.13.0",
    "@mui/icons-material": "^6.1.0",
    "@mui/material": "^6.1.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "typescript": "~5.6.2",
    "vite": "^5.4.10"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
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
    "noFallthroughCasesInSwitch": true
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
    <link rel="icon" href="/favicon.ico" />
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
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider, CssBaseline } from '@mui/material'
import { theme } from './theme'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
)`,
    },
    {
      path: 'src/theme.ts',
      template: `import { createTheme } from '@mui/material/styles'

export const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#90caf9',
    },
    secondary: {
      main: '#f48fb1',
    },
    background: {
      default: '#121212',
      paper: '#1e1e1e',
    },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    h1: {
      fontSize: '2.5rem',
      fontWeight: 700,
    },
    h2: {
      fontSize: '2rem',
      fontWeight: 600,
    },
  },
})`,
    },
    {
      path: 'src/App.tsx',
      template: `import { Routes, Route } from 'react-router-dom'
import { Box } from '@mui/material'
import { Navbar } from './components/Navbar'
import { Home } from './pages/Home'
import { About } from './pages/About'
import { Contact } from './pages/Contact'

function App() {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar />
      <Box component="main" sx={{ flex: 1, py: 4 }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/about" element={<About />} />
          <Route path="/contact" element={<Contact />} />
        </Routes>
      </Box>
    </Box>
  )
}

export default App`,
    },
    {
      path: 'src/components/Navbar.tsx',
      template: `import { AppBar, Toolbar, Typography, Button, Container, Box } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'

export function Navbar() {
  return (
    <AppBar position="static" color="transparent" elevation={0}>
      <Container maxWidth="lg">
        <Toolbar disableGutters>
          <Typography
            variant="h6"
            component={RouterLink}
            to="/"
            sx={{ textDecoration: 'none', color: 'inherit', flexGrow: 1 }}
          >
            {{projectName}}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button component={RouterLink} to="/" color="inherit">
              Home
            </Button>
            <Button component={RouterLink} to="/about" color="inherit">
              About
            </Button>
            <Button component={RouterLink} to="/contact" color="inherit">
              Contact
            </Button>
          </Box>
        </Toolbar>
      </Container>
    </AppBar>
  )
}`,
    },
    {
      path: 'src/pages/Home.tsx',
      template: `import { Container, Typography, Box, Button } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'

export function Home() {
  return (
    <Container maxWidth="lg">
      <Box sx={{ textAlign: 'center', py: 8 }}>
        <Typography variant="h1" gutterBottom>
          Welcome to {{projectName}}
        </Typography>
        <Typography variant="h5" color="text.secondary" paragraph>
          {{projectDescription}}
        </Typography>
        <Box sx={{ mt: 4 }}>
          <Button
            variant="contained"
            size="large"
            component={RouterLink}
            to="/about"
          >
            Learn More
          </Button>
        </Box>
      </Box>
    </Container>
  )
}`,
    },
    {
      path: 'src/pages/About.tsx',
      template: `import { Container, Typography, Box, Paper } from '@mui/material'

export function About() {
  return (
    <Container maxWidth="md">
      <Paper sx={{ p: 4 }}>
        <Typography variant="h2" gutterBottom>
          About
        </Typography>
        <Typography variant="body1" paragraph>
          This is the about page for {{projectName}}.
        </Typography>
        <Typography variant="body1" paragraph>
          {{projectDescription}}
        </Typography>
      </Paper>
    </Container>
  )
}`,
    },
    {
      path: 'src/pages/Contact.tsx',
      template: `import { Container, Typography, Box, Paper, TextField, Button } from '@mui/material'
import { useState } from 'react'

export function Contact() {
  const [formData, setFormData] = useState({ name: '', email: '', message: '' })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    console.log('Form submitted:', formData)
    // Add your form submission logic here
  }

  return (
    <Container maxWidth="sm">
      <Paper sx={{ p: 4 }}>
        <Typography variant="h2" gutterBottom>
          Contact Us
        </Typography>
        <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label="Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
            fullWidth
          />
          <TextField
            label="Email"
            type="email"
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            required
            fullWidth
          />
          <TextField
            label="Message"
            multiline
            rows={4}
            value={formData.message}
            onChange={(e) => setFormData({ ...formData, message: e.target.value })}
            required
            fullWidth
          />
          <Button type="submit" variant="contained" size="large">
            Send Message
          </Button>
        </Box>
      </Paper>
    </Container>
  )
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
- Material UI (MUI) v6 for components
- React Router v6 for navigation
- Vite for build tooling

## Project Structure
\`\`\`
src/
├── main.tsx          # Entry point
├── App.tsx           # Root component with routing
├── theme.ts          # MUI theme customization
├── components/       # Reusable components
│   └── Navbar.tsx
└── pages/            # Page components
    ├── Home.tsx
    ├── About.tsx
    └── Contact.tsx
\`\`\`

## Commands
- \`npm run dev\` - Start dev server
- \`npm run build\` - Build for production
- \`npm run preview\` - Preview production build

## Development Notes
- Add new pages in \`src/pages/\`
- Add reusable components in \`src/components/\`
- Customize theme in \`src/theme.ts\`
- Add routes in \`App.tsx\``,
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

## Pages

- **Home** - Landing page
- **About** - About page
- **Contact** - Contact form

## Tech Stack

- React + TypeScript
- Material UI
- React Router
- Vite`,
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
