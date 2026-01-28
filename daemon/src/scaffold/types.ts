// Project specification extracted from user requirements
export interface ProjectSpec {
  name: string;
  description: string;
  type: 'frontend' | 'backend' | 'fullstack' | 'library' | 'cli';
  features: string[];
}

// A file to be created in the scaffold
export interface ScaffoldFile {
  path: string;
  content: string;
}

// Stack template definition
export interface StackTemplate {
  id: string;
  name: string;
  description: string;
  type: 'frontend' | 'backend' | 'fullstack' | 'library' | 'cli';
  icon: string;
  tags: string[];
  // Files to create - path supports {{variables}}
  files: {
    path: string;
    template: string; // Template content with {{variables}}
  }[];
  // Post-create commands (e.g., npm install)
  postCreate?: {
    command: string;
    description: string;
  }[];
  // Skills to recommend after scaffold
  recommendedSkills?: string[];
}

// User's project configuration
export interface ProjectConfig {
  name: string;
  description: string;
  location: string; // Full path where project will be created
  stackId: string;
  options: {
    initGit: boolean;
    createGitHubRepo: boolean;
    privateRepo: boolean;
    includeDocker: boolean;
    includeCI: boolean;
    includeLinter: boolean;
  };
}

// Progress update during scaffold
export interface ScaffoldProgress {
  step: string;
  detail?: string;
  progress: number; // 0-100
  complete: boolean;
  error?: string;
}

// Result of scaffold operation
export interface ScaffoldResult {
  success: boolean;
  projectPath: string;
  filesCreated: string[];
  error?: string;
}
