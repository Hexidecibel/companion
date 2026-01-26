import * as fs from 'fs';
import { ConversationMessage, ConversationHighlight, ToolCall, SessionStatus, QuestionOption } from './types';

interface JsonlEntry {
  type: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; tool_use_id?: string; name?: string; input?: unknown }>;
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

export function parseConversationFile(filePath: string, limit: number = MAX_MESSAGES): ConversationMessage[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const messages: ConversationMessage[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  // Process from the end to get most recent messages first
  for (let i = lines.length - 1; i >= 0 && messages.length < limit * 2; i--) {
    try {
      const entry: JsonlEntry = JSON.parse(lines[i]);

      if (entry.type === 'user' || entry.type === 'assistant') {
        const message = parseEntry(entry);
        if (message) {
          messages.unshift(message); // Add to beginning to maintain order
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Return only the limit number of messages
  return messages.slice(-limit);
}

function parseEntry(entry: JsonlEntry): ConversationMessage | null {
  const message = entry.message;
  if (!message) return null;

  let content = '';
  const toolCalls: ToolCall[] = [];
  let options: QuestionOption[] | undefined;
  let isWaitingForChoice = false;

  if (typeof message.content === 'string') {
    content = message.content;
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        content += block.text;
      } else if (block.type === 'tool_use' && block.name) {
        toolCalls.push({
          id: block.tool_use_id || entry.uuid || '',
          name: block.name,
          input: (block.input as Record<string, unknown>) || {},
          status: 'completed',
        });

        // Extract options from AskUserQuestion tool
        if (block.name === 'AskUserQuestion') {
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
            console.log(`Parser: Extracted ${options.length} options for question: "${content.substring(0, 50)}..."`);
          }
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
  };
}

export function extractHighlights(messages: ConversationMessage[]): ConversationHighlight[] {
  const highlights = messages
    .filter(msg => {
      // Always include messages with options (e.g., AskUserQuestion)
      if (msg.options && msg.options.length > 0) return true;
      // Otherwise require actual content
      if (!msg.content || !msg.content.trim()) return false;
      // Include user messages with content
      if (msg.type === 'user') return true;
      // Include assistant messages with content
      if (msg.type === 'assistant') return true;
      return false;
    })
    .map(msg => ({
      id: msg.id,
      type: msg.type as 'user' | 'assistant',
      content: msg.content,
      timestamp: msg.timestamp,
      options: msg.options,
      isWaitingForChoice: msg.isWaitingForChoice,
    }));

  // Log if any highlights have options
  const withOptions = highlights.filter(h => h.options && h.options.length > 0);
  if (withOptions.length > 0) {
    console.log(`Parser: ${withOptions.length} highlight(s) with options found`);
  }

  return highlights;
}

export function detectWaitingForInput(messages: ConversationMessage[]): boolean {
  if (messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];

  // If the last message is from the assistant and contains text, Claude is likely waiting
  if (lastMessage.type === 'assistant' && lastMessage.content.trim()) {
    // Check for question patterns
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

    // Also check if there are no pending tool calls
    if (!lastMessage.toolCalls || lastMessage.toolCalls.every(tc => tc.status === 'completed')) {
      return true;
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

    // Map tool names to friendly descriptions
    const toolDescriptions: Record<string, string> = {
      'Read': 'Reading file',
      'Write': 'Writing file',
      'Edit': 'Editing file',
      'Bash': 'Running command',
      'Glob': 'Searching files',
      'Grep': 'Searching code',
      'Task': 'Running agent',
      'WebFetch': 'Fetching web page',
      'WebSearch': 'Searching web',
      'AskUserQuestion': 'Waiting for response',
    };

    const description = toolDescriptions[lastTool.name] || `Using ${lastTool.name}`;

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
