import { scoreTemplates, ScoredTemplate } from '../src/scaffold/scorer';
import { StackTemplate } from '../src/scaffold/types';
import { templates } from '../src/scaffold/templates';

// Minimal test templates for unit tests
const testTemplates: StackTemplate[] = [
  {
    id: 'react-typescript',
    name: 'React + TypeScript',
    description: 'Modern React app',
    type: 'frontend',
    icon: '',
    tags: ['react', 'typescript', 'vite', 'frontend'],
    scoring: {
      primaryKeywords: ['react', 'vite', 'jsx', 'tsx', 'component', 'spa'],
      secondaryKeywords: ['frontend', 'ui', 'interface', 'web', 'app', 'client', 'browser'],
      useCases: ['react app', 'single page', 'web app', 'frontend app', 'react dashboard', 'react project'],
      typeSignals: { frontend: 3, spa: 3, dashboard: 2, widget: 1, ui: 2 },
    },
    files: [],
  },
  {
    id: 'node-express',
    name: 'Node.js + Express',
    description: 'REST API with Express',
    type: 'backend',
    icon: '',
    tags: ['node', 'express', 'typescript', 'backend', 'api'],
    scoring: {
      primaryKeywords: ['express', 'node', 'rest', 'api', 'server', 'endpoint'],
      secondaryKeywords: ['backend', 'http', 'middleware', 'route', 'json', 'microservice'],
      useCases: ['rest api', 'node api', 'express server', 'backend service', 'api server', 'web server'],
      typeSignals: { api: 3, server: 3, backend: 2, microservice: 2, service: 1 },
    },
    files: [],
  },
  {
    id: 'python-fastapi',
    name: 'Python + FastAPI',
    description: 'Python API with FastAPI',
    type: 'backend',
    icon: '',
    tags: ['python', 'fastapi', 'backend', 'api', 'async'],
    scoring: {
      primaryKeywords: ['python', 'fastapi', 'uvicorn', 'pydantic'],
      secondaryKeywords: ['async', 'api', 'ml', 'machine learning', 'data', 'science', 'model'],
      useCases: ['python api', 'fastapi service', 'python ml service', 'python backend', 'data api', 'machine learning api'],
      typeSignals: { python: 3, ml: 2, 'machine learning': 2, data: 1, science: 1 },
    },
    files: [],
  },
];

describe('scoreTemplates', () => {
  it('returns all templates with score 0 for empty description', () => {
    const results = scoreTemplates(testTemplates, '');
    expect(results).toHaveLength(3);
    results.forEach(r => {
      expect(r.score).toBe(0);
      expect(r.matchedKeywords).toEqual([]);
    });
  });

  it('returns all templates with score 0 for whitespace-only description', () => {
    const results = scoreTemplates(testTemplates, '   ');
    results.forEach(r => expect(r.score).toBe(0));
  });

  it('scores "React dashboard" with react-typescript first', () => {
    const results = scoreTemplates(testTemplates, 'React dashboard');
    expect(results[0].templateId).toBe('react-typescript');
    expect(results[0].score).toBeGreaterThan(0.5);
    expect(results[0].matchedKeywords).toContain('react');
  });

  it('scores "REST API" with node-express first', () => {
    const results = scoreTemplates(testTemplates, 'REST API');
    expect(results[0].templateId).toBe('node-express');
    expect(results[0].score).toBe(1);
  });

  it('scores "Python ML service" with python-fastapi first', () => {
    const results = scoreTemplates(testTemplates, 'Python ML service');
    expect(results[0].templateId).toBe('python-fastapi');
    expect(results[0].score).toBe(1);
  });

  it('normalizes scores between 0 and 1', () => {
    const results = scoreTemplates(testTemplates, 'A React frontend web app');
    results.forEach(r => {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    });
    // At least one should have score 1 (the max)
    expect(results[0].score).toBe(1);
  });

  it('is case insensitive', () => {
    const lower = scoreTemplates(testTemplates, 'react dashboard');
    const upper = scoreTemplates(testTemplates, 'REACT DASHBOARD');
    const mixed = scoreTemplates(testTemplates, 'React Dashboard');

    expect(lower[0].templateId).toBe(upper[0].templateId);
    expect(lower[0].templateId).toBe(mixed[0].templateId);
    expect(lower[0].score).toBe(upper[0].score);
    expect(lower[0].score).toBe(mixed[0].score);
  });

  it('produces stable sort for tied scores', () => {
    // Description that matches nothing specific
    const results = scoreTemplates(testTemplates, 'a completely unrelated thing');
    // Should all be 0, sorted by templateId alphabetically
    results.forEach(r => expect(r.score).toBe(0));
    // Verify deterministic order
    const first = results.map(r => r.templateId);
    const second = scoreTemplates(testTemplates, 'a completely unrelated thing').map(r => r.templateId);
    expect(first).toEqual(second);
  });

  it('matches useCase substrings within longer descriptions', () => {
    const results = scoreTemplates(testTemplates, 'I want to build a react app with charts');
    expect(results[0].templateId).toBe('react-typescript');
    expect(results[0].matchedKeywords).toContain('react app');
  });

  it('handles templates without scoring metadata', () => {
    const noScoringTemplates: StackTemplate[] = [
      {
        id: 'bare',
        name: 'Bare Template',
        description: 'No scoring',
        type: 'frontend',
        icon: '',
        tags: ['react'],
        files: [],
      },
      ...testTemplates,
    ];
    const results = scoreTemplates(noScoringTemplates, 'React dashboard');
    // bare template should still appear (with lower score from tag match only)
    expect(results.find(r => r.templateId === 'bare')).toBeDefined();
    expect(results[0].templateId).toBe('react-typescript');
  });

  // Integration tests with full 7-template set
  describe('full template set integration', () => {
    it('has all 7 registered templates', () => {
      expect(templates.length).toBe(7);
    });

    it('scores "React dashboard" - react-typescript wins', () => {
      const results = scoreTemplates(templates, 'React dashboard');
      expect(results[0].templateId).toBe('react-typescript');
    });

    it('scores "REST API with Express" - node-express wins', () => {
      const results = scoreTemplates(templates, 'REST API with Express');
      expect(results[0].templateId).toBe('node-express');
    });

    it('scores "Python ML service" - python-fastapi wins', () => {
      const results = scoreTemplates(templates, 'Python ML service');
      expect(results[0].templateId).toBe('python-fastapi');
    });

    it('scores "Material UI marketing website" - react-mui-website wins', () => {
      const results = scoreTemplates(templates, 'Material UI marketing website');
      expect(results[0].templateId).toBe('react-mui-website');
    });

    it('scores "SEO blog with SSR" - nextjs wins', () => {
      const results = scoreTemplates(templates, 'SEO blog with SSR');
      expect(results[0].templateId).toBe('nextjs');
    });

    it('scores "Go command line tool" - go-cli wins', () => {
      const results = scoreTemplates(templates, 'Go command line tool');
      expect(results[0].templateId).toBe('go-cli');
    });

    it('scores "npm utility package" - typescript-library wins', () => {
      const results = scoreTemplates(templates, 'npm utility package');
      expect(results[0].templateId).toBe('typescript-library');
    });

    it('every template has scoring metadata', () => {
      for (const t of templates) {
        expect(t.scoring).toBeDefined();
        expect(t.scoring!.primaryKeywords.length).toBeGreaterThan(0);
        expect(t.scoring!.useCases.length).toBeGreaterThan(0);
      }
    });

    it('no two templates share the same id', () => {
      const ids = templates.map(t => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
