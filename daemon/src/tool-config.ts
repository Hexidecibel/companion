/**
 * Centralized tool definitions for CLI tools.
 * Used by parser and exposed to app via WebSocket.
 */

export interface ToolDefinition {
  name: string;
  displayName: string;
  icon: string;
  description: string;
  /** Field from tool input to use as one-line summary */
  summaryField?: string;
  /** Prefix for summary (e.g., "Edit" for "Edit src/foo.ts") */
  summaryPrefix?: string;
  /** Default summary when no input fields match */
  defaultSummary: string;
  /** Whether this tool requires user approval */
  requiresApproval: boolean;
}

export const DEFAULT_TOOL_CONFIG: Record<string, ToolDefinition> = {
  Bash: {
    name: 'Bash',
    displayName: 'Bash',
    icon: '⌨️',
    description: 'Running command',
    summaryField: 'command',
    defaultSummary: 'Execute command',
    requiresApproval: true,
  },
  Read: {
    name: 'Read',
    displayName: 'Read',
    icon: '📖',
    description: 'Reading file',
    summaryField: 'file_path',
    defaultSummary: 'Read file',
    requiresApproval: false,
  },
  Write: {
    name: 'Write',
    displayName: 'Write',
    icon: '📝',
    description: 'Writing file',
    summaryField: 'file_path',
    summaryPrefix: 'Write',
    defaultSummary: 'Write file',
    requiresApproval: true,
  },
  Edit: {
    name: 'Edit',
    displayName: 'Edit',
    icon: '✏️',
    description: 'Editing file',
    summaryField: 'file_path',
    summaryPrefix: 'Edit',
    defaultSummary: 'Edit file',
    requiresApproval: true,
  },
  Glob: {
    name: 'Glob',
    displayName: 'Glob',
    icon: '🔍',
    description: 'Searching files',
    summaryField: 'pattern',
    summaryPrefix: 'Find',
    defaultSummary: 'Find files',
    requiresApproval: false,
  },
  Grep: {
    name: 'Grep',
    displayName: 'Grep',
    icon: '🔎',
    description: 'Searching code',
    summaryField: 'pattern',
    summaryPrefix: 'Search:',
    defaultSummary: 'Search files',
    requiresApproval: false,
  },
  Task: {
    name: 'Task',
    displayName: 'Task',
    icon: '🤖',
    description: 'Running agent',
    summaryField: 'description',
    defaultSummary: 'Run task',
    requiresApproval: true,
  },
  WebFetch: {
    name: 'WebFetch',
    displayName: 'Web Fetch',
    icon: '🌐',
    description: 'Fetching web page',
    summaryField: 'url',
    defaultSummary: 'Fetch URL',
    requiresApproval: false,
  },
  WebSearch: {
    name: 'WebSearch',
    displayName: 'Web Search',
    icon: '🔍',
    description: 'Searching web',
    summaryField: 'query',
    summaryPrefix: 'Search:',
    defaultSummary: 'Web search',
    requiresApproval: false,
  },
  AskUserQuestion: {
    name: 'AskUserQuestion',
    displayName: 'Ask User',
    icon: '❓',
    description: 'Waiting for response',
    defaultSummary: 'Ask user',
    requiresApproval: false,
  },
  NotebookEdit: {
    name: 'NotebookEdit',
    displayName: 'Notebook Edit',
    icon: '📓',
    description: 'Editing notebook',
    summaryField: 'notebook_path',
    defaultSummary: 'Edit notebook',
    requiresApproval: true,
  },
  TodoRead: {
    name: 'TodoRead',
    displayName: 'Todo Read',
    icon: '📋',
    description: 'Reading todos',
    defaultSummary: 'Read todos',
    requiresApproval: false,
  },
  TodoWrite: {
    name: 'TodoWrite',
    displayName: 'Todo Write',
    icon: '📋',
    description: 'Writing todos',
    defaultSummary: 'Write todos',
    requiresApproval: false,
  },
  TaskCreate: {
    name: 'TaskCreate',
    displayName: 'Create Task',
    icon: '📋',
    description: 'Creating task',
    summaryField: 'subject',
    defaultSummary: 'Create task',
    requiresApproval: false,
  },
  TaskUpdate: {
    name: 'TaskUpdate',
    displayName: 'Update Task',
    icon: '📋',
    description: 'Updating task',
    summaryField: 'taskId',
    defaultSummary: 'Update task',
    requiresApproval: false,
  },
  TaskGet: {
    name: 'TaskGet',
    displayName: 'Get Task',
    icon: '📋',
    description: 'Getting task',
    summaryField: 'taskId',
    defaultSummary: 'Get task',
    requiresApproval: false,
  },
  TaskList: {
    name: 'TaskList',
    displayName: 'List Tasks',
    icon: '📋',
    description: 'Listing tasks',
    defaultSummary: 'List tasks',
    requiresApproval: false,
  },
  EnterPlanMode: {
    name: 'EnterPlanMode',
    displayName: 'Plan Mode',
    icon: '📐',
    description: 'Entering plan mode',
    defaultSummary: 'Enter plan mode',
    requiresApproval: true,
  },
  ExitPlanMode: {
    name: 'ExitPlanMode',
    displayName: 'Exit Plan',
    icon: '📐',
    description: 'Exiting plan mode',
    defaultSummary: 'Exit plan mode',
    requiresApproval: false,
  },
  Skill: {
    name: 'Skill',
    displayName: 'Skill',
    icon: '⚡',
    description: 'Running skill',
    summaryField: 'skill',
    defaultSummary: 'Run skill',
    requiresApproval: false,
  },
};

/** Set of all known tool names */
export const KNOWN_TOOL_NAMES = new Set(Object.keys(DEFAULT_TOOL_CONFIG));

/** Tools that require user approval (used for auto-approve detection) */
export const APPROVAL_TOOLS = Object.values(DEFAULT_TOOL_CONFIG)
  .filter((t) => t.requiresApproval)
  .map((t) => t.name);

/**
 * Get tool description for activity display (e.g., "Reading file").
 * Returns "Using ToolName" for unknown tools.
 */
export function getToolDescription(toolName: string): string {
  const config = DEFAULT_TOOL_CONFIG[toolName];
  return config?.description || `Using ${toolName}`;
}

/**
 * Check if a tool name is known.
 */
export function isKnownTool(toolName: string): boolean {
  return KNOWN_TOOL_NAMES.has(toolName);
}
