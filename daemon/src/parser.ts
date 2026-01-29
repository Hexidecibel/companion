import * as fs from 'fs';
import { ConversationMessage, ConversationHighlight, ToolCall, SessionStatus, QuestionOption, SessionUsage, CompactionEvent, TaskItem } from './types';
import { APPROVAL_TOOLS, KNOWN_TOOL_NAMES, getToolDescription, isKnownTool } from './tool-config';

// Re-export TaskItem for tests
export { TaskItem } from './types';

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;  // For tool_use blocks
  tool_use_id?: string;  // For tool_result blocks
  name?: string;
  input?: unknown;
  content?: string | Array<{ type: string; text?: string }>;  // For tool_result blocks
}

interface JsonlEntry {
  type: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  timestamp?: string;
  parentUuid?: string;
  uuid?: string;
}

interface AskUserQuestionInput {
  questions?: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
}

const MAX_MESSAGES = 100; // Limit to most recent messages

// KNOWN_TOOLS alias for backward compatibility in this file
const KNOWN_TOOLS = KNOWN_TOOL_NAMES;

// Rate-limit parser warnings: max one per key per 60s
const _warnedRecently = new Map<string, number>();
function logParserWarning(type: string, details: string): void {
  const key = `${type}:${details.substring(0, 100)}`;
  const now = Date.now();
  const last = _warnedRecently.get(key);
  if (last && now - last < 60000) return;
  _warnedRecently.set(key, now);
  console.log(`[PARSER_WARN] ${type}: ${details}`);
}

/**
 * Fast function to detect current activity by reading only the last few KB of a file.
 * Much faster than parsing the entire conversation file.
 * Tracks tool_result entries to avoid showing stale "pending" status for completed tools.
 */
export function detectCurrentActivityFast(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    // Read last 32KB - enough to get recent messages
    const readSize = Math.min(32 * 1024, fileSize);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, fileSize - readSize));
    fs.closeSync(fd);

    const tail = buffer.toString('utf-8');
    const lines = tail.split('\n').filter(line => line.trim());

    // Collect tool_result IDs from recent lines so we know which tools completed
    const completedToolIds = new Set<string>();
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry: JsonlEntry = JSON.parse(lines[i]);
        if (entry.message?.content && Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              completedToolIds.add(block.tool_use_id);
            }
          }
        }
      } catch {
        continue;
      }
    }

    // Walk backward to find the most recent meaningful entry
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry: JsonlEntry = JSON.parse(lines[i]);
        if (entry.message?.role === 'user') {
          return 'Processing...';
        }
        if (entry.message?.role === 'assistant' && entry.message.content) {
          const entryContent = entry.message.content;
          if (Array.isArray(entryContent)) {
            // Find the last tool_use that hasn't been completed
            for (let j = entryContent.length - 1; j >= 0; j--) {
              const block = entryContent[j];
              if (block.type === 'tool_use' && block.name && block.id) {
                // Skip tools that already have results
                if (completedToolIds.has(block.id)) {
                  continue;
                }

                // Warn about unknown tools
                if (!isKnownTool(block.name)) {
                  logParserWarning('unknown_tool', `Unrecognized tool: ${block.name}`);
                }

                // Check if this needs approval
                if (APPROVAL_TOOLS.includes(block.name)) {
                  const input = block.input as Record<string, unknown> | undefined;
                  if (block.name === 'Bash' && input?.command) {
                    const cmd = (input.command as string).substring(0, 40);
                    return `Approve? ${cmd}${(input.command as string).length > 40 ? '...' : ''}`;
                  }
                  if ((block.name === 'Edit' || block.name === 'Write') && input?.file_path) {
                    const fileName = (input.file_path as string).split('/').pop() || input.file_path;
                    return `Approve ${block.name.toLowerCase()}: ${fileName}?`;
                  }
                  return `Approve ${block.name}?`;
                }

                return getToolDescription(block.name);
              }
            }
          }
          return undefined; // Assistant message, all tools completed
        }
      } catch {
        continue;
      }
    }

    return undefined;
  } catch (err) {
    return undefined;
  }
}

export function parseConversationFile(filePath: string, limit: number = MAX_MESSAGES, preReadContent?: string): ConversationMessage[] {
  const content = preReadContent ?? (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '');
  if (!content) {
    return [];
  }

  const lines = content.split('\n').filter(line => line.trim());

  // First pass: collect all tool results, start times, and completion times
  const toolResults = new Map<string, string>();
  const toolStartTimes = new Map<string, number>();
  const toolCompleteTimes = new Map<string, number>();

  for (const line of lines) {
    try {
      const entry: JsonlEntry = JSON.parse(line);
      const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

      if (entry.message?.content && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          // Track tool_use start times
          if (block.type === 'tool_use' && block.id) {
            toolStartTimes.set(block.id, timestamp);
          }

          // Track tool_result completion times and outputs
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolCompleteTimes.set(block.tool_use_id, timestamp);

            // Extract output content - can be string or array of content blocks
            let output = '';
            if (typeof block.content === 'string') {
              output = block.content;
            } else if (Array.isArray(block.content)) {
              output = block.content
                .filter(c => c.type === 'text' && c.text)
                .map(c => c.text || '')
                .join('\n');
            }
            toolResults.set(block.tool_use_id, output);
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  const completedToolIds = new Set(toolResults.keys());

  const messages: ConversationMessage[] = [];

  // Process from the end to get most recent messages first
  for (let i = lines.length - 1; i >= 0 && messages.length < limit * 2; i--) {
    try {
      const entry: JsonlEntry = JSON.parse(lines[i]);

      if (entry.type === 'user' || entry.type === 'assistant') {
        const message = parseEntry(entry, toolResults, toolStartTimes, toolCompleteTimes);
        if (message) {
          messages.unshift(message); // Add to beginning to maintain order
        }
      } else if (entry.type && entry.type !== 'summary') {
        logParserWarning('unknown_entry_type', `Unexpected JSONL entry type: ${entry.type}`);
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Return only the limit number of messages
  return messages.slice(-limit);
}

function parseEntry(
  entry: JsonlEntry,
  toolResults: Map<string, string>,
  toolStartTimes: Map<string, number>,
  toolCompleteTimes: Map<string, number>
): ConversationMessage | null {
  const message = entry.message;
  if (!message) return null;

  let content = '';
  const toolCalls: ToolCall[] = [];
  let options: QuestionOption[] | undefined;
  let isWaitingForChoice = false;
  let multiSelect = false;

  if (typeof message.content === 'string') {
    content = message.content;
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        content += block.text;
      } else if (block.type === 'tool_use') {
        if (!block.name) {
          logParserWarning('missing_tool_name', `tool_use block without name, id: ${block.id}`);
          continue;
        }
        if (!KNOWN_TOOLS.has(block.name)) {
          logParserWarning('unknown_tool', `Unrecognized tool in parseEntry: ${block.name}`);
        }
        const toolId = block.id || entry.uuid || '';
        const output = toolResults.get(toolId);
        const isPending = !output && output !== '';
        const startedAt = toolStartTimes.get(toolId);
        const completedAt = toolCompleteTimes.get(toolId);

        toolCalls.push({
          id: toolId,
          name: block.name,
          input: (block.input as Record<string, unknown>) || {},
          output: output,
          status: isPending ? 'pending' : 'completed',
          startedAt,
          completedAt,
        });

        // Extract options from AskUserQuestion tool (only if still pending)
        if (block.name === 'AskUserQuestion' && isPending) {
          const input = block.input as AskUserQuestionInput;
          console.log(`Parser: Found AskUserQuestion tool, questions count: ${input.questions?.length || 0}`);
          if (input.questions && input.questions.length > 0) {
            const question = input.questions[0];
            content = question.question;
            options = question.options.map(opt => ({
              label: opt.label,
              description: opt.description,
            }));
            isWaitingForChoice = true;
            multiSelect = question.multiSelect || false;
            console.log(`Parser: Extracted ${options.length} options for question: "${content.substring(0, 50)}..." (multiSelect: ${multiSelect})`);
          }
        } else if (block.name === 'AskUserQuestion' && !isPending) {
          // Show the question content but no options (already answered)
          const input = block.input as AskUserQuestionInput;
          if (input.questions && input.questions.length > 0) {
            content = input.questions[0].question;
          }
        }
        // Add Yes/No options for pending approval tools
        // But NOT for Task tools - they run in background and stay "pending" for a long time
        else if (isPending && APPROVAL_TOOLS.includes(block.name) && block.name !== 'Task') {
          const input = block.input as Record<string, unknown>;
          let description = '';

          // Build a helpful description based on tool type
          if (block.name === 'Bash' && input.command) {
            description = `Run: ${(input.command as string).substring(0, 100)}`;
          } else if ((block.name === 'Edit' || block.name === 'Write') && input.file_path) {
            description = `${block.name}: ${input.file_path}`;
          } else if (block.name === 'Task' && input.description) {
            description = `Task: ${input.description}`;
          } else {
            description = `Allow ${block.name}?`;
          }

          options = [
            { label: 'yes', description: `Approve: ${description}` },
            { label: 'no', description: 'Reject this action' },
          ];
          isWaitingForChoice = true;
          console.log(`Parser: Pending ${block.name} tool needs approval: "${description.substring(0, 50)}..."`);
        }
      } else if (block.type === 'tool_result') {
        // Skip tool results entirely - they're internal Claude responses
        // We only want to show actual user-typed messages
      }
    }
  }

  const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

  return {
    id: entry.uuid || String(timestamp),
    type: entry.type as 'user' | 'assistant',
    content,
    timestamp,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    options,
    isWaitingForChoice,
    multiSelect: multiSelect || undefined,
  };
}

export function extractHighlights(messages: ConversationMessage[]): ConversationHighlight[] {
  // Find the index of the last user message - anything before this has been "responded to"
  let lastUserMessageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'user') {
      lastUserMessageIndex = i;
      break;
    }
  }

  const highlights = messages
    .filter(msg => {
      // Include user messages with content
      if (msg.type === 'user' && msg.content && msg.content.trim()) return true;
      // Include assistant messages with content OR toolCalls
      if (msg.type === 'assistant') {
        const hasContent = msg.content && msg.content.trim();
        const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
        return hasContent || hasToolCalls;
      }
      return false;
    })
    .map((msg, index, arr) => {
      const isLastMessage = index === arr.length - 1;
      const originalIndex = messages.indexOf(msg);

      // Check if this message has pending approval tools
      const hasPendingApprovalTools = msg.toolCalls?.some(
        tc => tc.status === 'pending' && APPROVAL_TOOLS.includes(tc.name) && tc.name !== 'Task'
      ) ?? false;

      // Check if all tools in this message are already completed/errored
      const allToolsCompleted = (msg.toolCalls?.length ?? 0) > 0 && msg.toolCalls?.every(
        tc => tc.status === 'completed' || tc.status === 'error' || tc.output !== undefined
      );

      // Check if user already responded after this message (tool is running, not waiting)
      const userRespondedAfter = originalIndex < messages.length - 1 &&
        messages.slice(originalIndex + 1).some(m => m.type === 'user');

      // Show options if:
      // 1. This message has options AND
      // 2. Either it's the last message OR it has pending approval tools AND
      // 3. Tools haven't all completed AND
      // 4. User hasn't already responded (tool would be running, not waiting)
      const showOptions = msg.options && msg.options.length > 0 &&
        (isLastMessage || hasPendingApprovalTools) && !allToolsCompleted && !userRespondedAfter;

      // If user responded after this message, pending tools are now running (not waiting for approval)
      const toolCalls = userRespondedAfter && msg.toolCalls
        ? msg.toolCalls.map(tc => tc.status === 'pending' ? { ...tc, status: 'running' as const } : tc)
        : msg.toolCalls;

      return {
        id: msg.id,
        type: msg.type as 'user' | 'assistant',
        content: msg.content,
        timestamp: msg.timestamp,
        options: showOptions ? msg.options : undefined,
        isWaitingForChoice: showOptions ? msg.isWaitingForChoice : false,
        multiSelect: showOptions ? msg.multiSelect : undefined,
        toolCalls,
      };
    });

  // Log if the last highlight has options
  const lastHighlight = highlights[highlights.length - 1];
  if (lastHighlight?.options && lastHighlight.options.length > 0) {
    console.log(`Parser: Last message has ${lastHighlight.options.length} options`);
  }

  return highlights;
}

export function detectWaitingForInput(messages: ConversationMessage[]): boolean {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];

  // If the last message is from the assistant
  if (lastMessage.type === 'assistant') {
    // Check for pending tool calls that need approval
    if (lastMessage.toolCalls) {
      const hasPendingApproval = lastMessage.toolCalls.some(
        tc => tc.status === 'pending' && APPROVAL_TOOLS.includes(tc.name)
      );
      if (hasPendingApproval) {
        return true;
      }
    }

    // Check for text content that looks like a question
    if (lastMessage.content.trim()) {
      const questionPatterns = [
        /\?$/,
        /would you like/i,
        /do you want/i,
        /should I/i,
        /let me know/i,
        /please confirm/i,
        /please provide/i,
      ];

      for (const pattern of questionPatterns) {
        if (pattern.test(lastMessage.content)) {
          return true;
        }
      }

      // Also check if there are no pending tool calls (Claude is done working)
      if (!lastMessage.toolCalls || lastMessage.toolCalls.every(tc => tc.status === 'completed')) {
        return true;
      }
    }
  }

  return false;
}

export interface ActivityDetail {
  summary: string;
  toolName?: string;
  input?: string;
  output?: string;
  timestamp: number;
}

export function detectCurrentActivity(messages: ConversationMessage[]): string | undefined {
  if (messages.length === 0) return undefined;

  const lastMessage = messages[messages.length - 1];

  // If last message is from user, Claude is processing
  if (lastMessage.type === 'user') {
    return 'Processing...';
  }

  // Check for tool calls in the last assistant message
  if (lastMessage.type === 'assistant' && lastMessage.toolCalls && lastMessage.toolCalls.length > 0) {
    const lastTool = lastMessage.toolCalls[lastMessage.toolCalls.length - 1];

    // Check if this is a pending approval
    if (lastTool.status === 'pending' && APPROVAL_TOOLS.includes(lastTool.name)) {
      const input = lastTool.input as Record<string, unknown>;
      if (lastTool.name === 'Bash' && input.command) {
        const cmd = (input.command as string).substring(0, 40);
        return `Approve? ${cmd}${(input.command as string).length > 40 ? '...' : ''}`;
      }
      if ((lastTool.name === 'Edit' || lastTool.name === 'Write') && input.file_path) {
        const filePath = input.file_path as string;
        const fileName = filePath.split('/').pop() || filePath;
        return `Approve ${lastTool.name.toLowerCase()}: ${fileName}?`;
      }
      return `Approve ${lastTool.name}?`;
    }

    const description = getToolDescription(lastTool.name);

    // Add file path info if available
    if (lastTool.input) {
      const input = lastTool.input as Record<string, unknown>;
      if (input.file_path) {
        const filePath = input.file_path as string;
        const fileName = filePath.split('/').pop() || filePath;
        return `${description}: ${fileName}`;
      }
      if (input.command) {
        const cmd = (input.command as string).substring(0, 30);
        return `${description}: ${cmd}${(input.command as string).length > 30 ? '...' : ''}`;
      }
    }

    return description;
  }

  // Don't show "waiting for input" - there's already a separate indicator for that
  return undefined;
}

export function getRecentActivity(messages: ConversationMessage[], limit: number = 5): ActivityDetail[] {
  const activities: ActivityDetail[] = [];

  // Go through messages in reverse to get recent activity
  for (let i = messages.length - 1; i >= 0 && activities.length < limit; i--) {
    const msg = messages[i];

    if (msg.type === 'assistant' && msg.toolCalls) {
      for (const tool of msg.toolCalls) {
        if (activities.length >= limit) break;

        const input = tool.input as Record<string, unknown>;
        let inputStr = '';
        let outputStr = tool.output || '';

        // Format input based on tool type
        if (input.file_path) {
          inputStr = input.file_path as string;
        } else if (input.command) {
          inputStr = input.command as string;
        } else if (input.pattern) {
          inputStr = `Pattern: ${input.pattern}`;
        } else if (input.query) {
          inputStr = input.query as string;
        }

        activities.push({
          summary: `${tool.name}${inputStr ? `: ${inputStr.substring(0, 100)}` : ''}`,
          toolName: tool.name,
          input: inputStr,
          output: outputStr.substring(0, 2000), // Limit output size
          timestamp: msg.timestamp,
        });
      }
    }
  }

  return activities.reverse(); // Return in chronological order
}

export function getSessionStatus(
  conversationPath: string,
  isProcessRunning: boolean
): SessionStatus {
  const messages = parseConversationFile(conversationPath);
  const lastMessage = messages[messages.length - 1];

  return {
    isRunning: isProcessRunning,
    isWaitingForInput: isProcessRunning && detectWaitingForInput(messages),
    lastActivity: lastMessage?.timestamp || 0,
    conversationId: conversationPath,
    currentActivity: isProcessRunning ? detectCurrentActivity(messages) : undefined,
  };
}

/**
 * Get list of pending tools that need approval from the last message
 */
export function getPendingApprovalTools(messages: ConversationMessage[]): string[] {
  if (messages.length === 0) return [];

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.type !== 'assistant' || !lastMessage.toolCalls) return [];

  return lastMessage.toolCalls
    .filter(tc => tc.status === 'pending')
    .map(tc => tc.name);
}

interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface UsageJsonlEntry {
  type: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    model?: string;
    usage?: UsageData;
  };
}

/**
 * Detect compaction events in a conversation file
 * Returns the most recent compaction summary if found
 */
export function detectCompaction(
  filePath: string,
  sessionId: string,
  sessionName: string,
  projectPath: string,
  lastCheckedLine: number = 0,
  preReadContent?: string
): { event: CompactionEvent | null; lastLine: number } {
  const content = preReadContent ?? (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '');
  if (!content) {
    return { event: null, lastLine: 0 };
  }

  const lines = content.split('\n').filter(line => line.trim());
  let compactionEvent: CompactionEvent | null = null;

  // Only check lines after lastCheckedLine to avoid re-detecting old compactions
  for (let i = lastCheckedLine; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);

      // Look for summary type entries (Claude compaction)
      if (entry.type === 'summary' && entry.summary) {
        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
        compactionEvent = {
          sessionId,
          sessionName,
          projectPath,
          summary: entry.summary,
          timestamp,
        };
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { event: compactionEvent, lastLine: lines.length };
}

/**
 * Extract usage data from a conversation JSONL file
 */
export function extractUsageFromFile(filePath: string, sessionName: string): SessionUsage {
  const result: SessionUsage = {
    sessionId: filePath,
    sessionName,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    messageCount: 0,
    currentContextTokens: 0,
  };

  if (!fs.existsSync(filePath)) {
    return result;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  const seenMessageIds = new Set<string>();

  for (const line of lines) {
    try {
      const entry: UsageJsonlEntry = JSON.parse(line);

      // Only count assistant messages with usage data
      if (entry.type === 'assistant' && entry.message?.usage) {
        const msgId = (entry as { message?: { id?: string } }).message?.id;

        // Skip duplicate message IDs (same message can appear multiple times as it streams)
        if (msgId && seenMessageIds.has(msgId)) {
          continue;
        }
        if (msgId) {
          seenMessageIds.add(msgId);
        }

        const usage = entry.message.usage;

        // Only add non-zero usage (final message has the totals)
        if (usage.input_tokens && usage.input_tokens > 0) {
          result.totalInputTokens += usage.input_tokens;
          result.messageCount++;
        }
        if (usage.output_tokens && usage.output_tokens > 0) {
          result.totalOutputTokens += usage.output_tokens;
        }
        if (usage.cache_creation_input_tokens && usage.cache_creation_input_tokens > 0) {
          result.totalCacheCreationTokens += usage.cache_creation_input_tokens;
        }
        if (usage.cache_read_input_tokens && usage.cache_read_input_tokens > 0) {
          result.totalCacheReadTokens += usage.cache_read_input_tokens;
        }
        // Track current context size from the most recent message
        if (usage.input_tokens) {
          result.currentContextTokens = usage.input_tokens;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return result;
}

// Input types for TaskCreate/TaskUpdate tools
interface TaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

interface TaskUpdateInput {
  taskId: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlockedBy?: string[];
  addBlocks?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Extract tasks from JSONL content (from TaskCreate/TaskUpdate tool calls)
 */
export function extractTasks(content: string): TaskItem[] {
  const lines = content.split('\n').filter(line => line.trim());

  // Track tasks by temporary ID (toolu_xxx) until we get real ID from result
  const pendingTasks = new Map<string, { task: Partial<TaskItem>; timestamp: number }>();
  // Map toolu_xxx to real task ID
  const toolIdToTaskId = new Map<string, string>();
  // Final tasks by real ID
  const tasks = new Map<string, TaskItem>();

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (entry.message?.content && Array.isArray(entry.message.content)) {
        const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

        for (const block of entry.message.content) {
          // Handle TaskCreate
          if (block.type === 'tool_use' && block.name === 'TaskCreate') {
            const input = block.input as TaskCreateInput;
            const toolId = block.id as string;

            pendingTasks.set(toolId, {
              task: {
                subject: input.subject,
                description: input.description,
                activeForm: input.activeForm,
                status: 'pending',
                blockedBy: [],
                blocks: [],
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              timestamp,
            });
          }

          // Handle TaskUpdate
          if (block.type === 'tool_use' && block.name === 'TaskUpdate') {
            const input = block.input as TaskUpdateInput;
            const taskId = input.taskId;

            // Find existing task
            const existingTask = tasks.get(taskId);
            if (existingTask) {
              // Handle deletion
              if (input.status === 'deleted') {
                tasks.delete(taskId);
                continue;
              }

              // Apply updates
              if (input.status) {
                existingTask.status = input.status as TaskItem['status'];
              }
              if (input.subject) {
                existingTask.subject = input.subject;
              }
              if (input.description) {
                existingTask.description = input.description;
              }
              if (input.activeForm) {
                existingTask.activeForm = input.activeForm;
              } else if (input.status === 'completed') {
                // Clear activeForm when completed
                existingTask.activeForm = undefined;
              }
              if (input.owner) {
                existingTask.owner = input.owner;
              }
              if (input.addBlockedBy) {
                existingTask.blockedBy = [
                  ...(existingTask.blockedBy || []),
                  ...input.addBlockedBy,
                ];
              }
              if (input.addBlocks) {
                existingTask.blocks = [
                  ...(existingTask.blocks || []),
                  ...input.addBlocks,
                ];
              }
              existingTask.updatedAt = timestamp;
            }
          }

          // Handle tool_result to get real task IDs
          if (block.type === 'tool_result' && block.tool_use_id) {
            const toolId = block.tool_use_id as string;
            const pending = pendingTasks.get(toolId);

            if (pending) {
              // Extract task ID from result content
              let resultContent = '';
              if (typeof block.content === 'string') {
                resultContent = block.content;
              } else if (Array.isArray(block.content)) {
                resultContent = block.content
                  .filter((c: { type: string; text?: string }) => c.type === 'text' && c.text)
                  .map((c: { text?: string }) => c.text || '')
                  .join('\n');
              }

              // Try to extract task ID from "Task created with ID: X"
              const idMatch = resultContent.match(/(?:Task created with ID:|id[:\s]+)(\d+)/i);
              if (idMatch) {
                const realId = idMatch[1];
                toolIdToTaskId.set(toolId, realId);

                // Create the task with real ID
                tasks.set(realId, {
                  id: realId,
                  subject: pending.task.subject || '',
                  description: pending.task.description || '',
                  status: pending.task.status || 'pending',
                  activeForm: pending.task.activeForm,
                  owner: pending.task.owner,
                  blockedBy: pending.task.blockedBy,
                  blocks: pending.task.blocks,
                  createdAt: pending.task.createdAt || timestamp,
                  updatedAt: pending.task.updatedAt || timestamp,
                });
              }

              pendingTasks.delete(toolId);
            }
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Return tasks sorted by ID (numeric order)
  return Array.from(tasks.values()).sort((a, b) => {
    const aNum = parseInt(a.id, 10);
    const bNum = parseInt(b.id, 10);
    return aNum - bNum;
  });
}
