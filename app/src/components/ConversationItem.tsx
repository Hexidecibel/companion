import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Markdown from '@ronradtke/react-native-markdown-display';
import { ConversationMessage, ConversationHighlight, ToolCall } from '../types';

interface ConversationItemProps {
  item: ConversationMessage | ConversationHighlight;
  showToolCalls?: boolean;
  onSelectOption?: (option: string) => void;
  onFileTap?: (filePath: string) => void;
}

const COLLAPSED_LINES = 12;
const COLLAPSED_HEIGHT = 250;

// Helper to get a summary of tool input for display
function getToolSummary(tool: ToolCall): string {
  const input = tool.input || {};
  switch (tool.name) {
    case 'Bash':
      return input.command ? String(input.command).substring(0, 80) : 'Execute command';
    case 'Read':
      return input.file_path ? String(input.file_path) : 'Read file';
    case 'Edit':
      return input.file_path ? `Edit ${input.file_path}` : 'Edit file';
    case 'Write':
      return input.file_path ? `Write ${input.file_path}` : 'Write file';
    case 'Glob':
      return input.pattern ? `Find ${input.pattern}` : 'Find files';
    case 'Grep':
      return input.pattern ? `Search: ${input.pattern}` : 'Search files';
    case 'Task':
      return input.description ? String(input.description) : 'Run task';
    case 'WebFetch':
      return input.url ? String(input.url) : 'Fetch URL';
    case 'WebSearch':
      return input.query ? `Search: ${input.query}` : 'Web search';
    default:
      return tool.name;
  }
}

// Get tool icon based on type
function getToolIcon(toolName: string): string {
  switch (toolName) {
    case 'Bash': return '⌨️';
    case 'Read': return '📖';
    case 'Edit': return '✏️';
    case 'Write': return '📝';
    case 'Glob': return '🔍';
    case 'Grep': return '🔎';
    case 'Task': return '🤖';
    case 'WebFetch': return '🌐';
    case 'WebSearch': return '🔍';
    default: return '⚙️';
  }
}

// Format duration in human-readable form
function formatDuration(startMs: number, endMs?: number): string {
  const end = endMs || Date.now();
  const durationMs = end - startMs;
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

// Copy text to clipboard with feedback
async function copyToClipboard(text: string, label: string) {
  try {
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', `${label} copied to clipboard`);
  } catch {
    Alert.alert('Error', 'Failed to copy to clipboard');
  }
}

// Render a unified diff view
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  return (
    <View style={diffStyles.container}>
      <View style={diffStyles.section}>
        <View style={diffStyles.header}>
          <Text style={diffStyles.headerText}>- Remove</Text>
        </View>
        <ScrollView style={diffStyles.scroll} nestedScrollEnabled>
          {oldLines.slice(0, 20).map((line, i) => (
            <Text key={`old-${i}`} style={diffStyles.removeLine}>
              {line}
            </Text>
          ))}
          {oldLines.length > 20 && (
            <Text style={diffStyles.truncated}>... {oldLines.length - 20} more lines</Text>
          )}
        </ScrollView>
      </View>
      <View style={diffStyles.section}>
        <View style={[diffStyles.header, diffStyles.addHeader]}>
          <Text style={diffStyles.headerText}>+ Add</Text>
        </View>
        <ScrollView style={diffStyles.scroll} nestedScrollEnabled>
          {newLines.slice(0, 20).map((line, i) => (
            <Text key={`new-${i}`} style={diffStyles.addLine}>
              {line}
            </Text>
          ))}
          {newLines.length > 20 && (
            <Text style={diffStyles.truncated}>... {newLines.length - 20} more lines</Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

// Expandable tool card component
function ToolCard({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummary(tool);
  const icon = getToolIcon(tool.name);
  const hasOutput = tool.output && tool.output.length > 0;
  const statusColor = tool.status === 'pending' ? '#f59e0b' : '#10b981';
  const statusText = tool.status === 'pending' ? 'running' : 'done';

  // Extract input values safely
  const input = tool.input || {};
  const command = input.command ? String(input.command) : '';
  const filePath = input.file_path ? String(input.file_path) : '';
  const oldString = input.old_string ? String(input.old_string) : '';
  const newString = input.new_string ? String(input.new_string) : '';

  // Calculate duration if timestamps available
  const duration = tool.startedAt
    ? formatDuration(tool.startedAt, tool.completedAt)
    : null;

  // Get preview of output (first 2 lines)
  const outputPreview = hasOutput
    ? tool.output!.split('\n').slice(0, 2).join('\n').substring(0, 150)
    : '';

  return (
    <TouchableOpacity
      style={toolCardStyles.container}
      onPress={() => setExpanded(!expanded)}
      activeOpacity={0.7}
    >
      <View style={toolCardStyles.header}>
        <View style={toolCardStyles.headerLeft}>
          <Text style={toolCardStyles.icon}>{icon}</Text>
          <Text style={toolCardStyles.name}>{tool.name}</Text>
          <View style={[toolCardStyles.statusBadge, { backgroundColor: statusColor }]}>
            <Text style={toolCardStyles.statusText}>{statusText}</Text>
          </View>
          {duration && tool.status === 'completed' && (
            <Text style={toolCardStyles.duration}>{duration}</Text>
          )}
        </View>
        <Text style={toolCardStyles.expandIcon}>{expanded ? '▼' : '▶'}</Text>
      </View>
      <Text style={toolCardStyles.summaryLine} numberOfLines={1}>{summary}</Text>
      {!expanded && outputPreview ? (
        <View style={toolCardStyles.preview}>
          <Text style={toolCardStyles.previewText} numberOfLines={2}>{outputPreview}</Text>
        </View>
      ) : null}

      {expanded && (
        <View style={toolCardStyles.details}>
          {/* Show input details */}
          {tool.name === 'Bash' && command ? (
            <View style={toolCardStyles.section}>
              <View style={toolCardStyles.sectionHeader}>
                <Text style={toolCardStyles.sectionLabel}>Command:</Text>
                <TouchableOpacity
                  style={toolCardStyles.copyButton}
                  onPress={() => copyToClipboard(command, 'Command')}
                >
                  <Text style={toolCardStyles.copyButtonText}>Copy</Text>
                </TouchableOpacity>
              </View>
              <ScrollView style={toolCardStyles.codeScroll} nestedScrollEnabled>
                <Text style={toolCardStyles.codeText}>{command}</Text>
              </ScrollView>
            </View>
          ) : null}

          {(tool.name === 'Edit') && filePath && oldString ? (
            <View style={toolCardStyles.section}>
              <Text style={toolCardStyles.sectionLabel}>File:</Text>
              <Text style={toolCardStyles.filePath}>{filePath}</Text>
              <DiffView oldText={oldString} newText={newString} />
            </View>
          ) : null}

          {(tool.name === 'Write') && filePath ? (
            <View style={toolCardStyles.section}>
              <View style={toolCardStyles.sectionHeader}>
                <Text style={toolCardStyles.sectionLabel}>File: {filePath}</Text>
                {newString && (
                  <TouchableOpacity
                    style={toolCardStyles.copyButton}
                    onPress={() => copyToClipboard(newString, 'Content')}
                  >
                    <Text style={toolCardStyles.copyButtonText}>Copy</Text>
                  </TouchableOpacity>
                )}
              </View>
              {newString && (
                <ScrollView style={toolCardStyles.codeScroll} nestedScrollEnabled>
                  <Text style={toolCardStyles.codeText}>
                    {newString.substring(0, 1000)}
                    {newString.length > 1000 ? '\n... (truncated)' : ''}
                  </Text>
                </ScrollView>
              )}
            </View>
          ) : null}

          {/* Show output */}
          {hasOutput ? (
            <View style={toolCardStyles.section}>
              <View style={toolCardStyles.sectionHeader}>
                <Text style={toolCardStyles.sectionLabel}>Output:</Text>
                <TouchableOpacity
                  style={toolCardStyles.copyButton}
                  onPress={() => copyToClipboard(tool.output!, 'Output')}
                >
                  <Text style={toolCardStyles.copyButtonText}>Copy</Text>
                </TouchableOpacity>
              </View>
              <ScrollView style={toolCardStyles.outputScroll} nestedScrollEnabled>
                <Text style={toolCardStyles.outputText}>
                  {tool.output!.substring(0, 2000)}
                  {tool.output!.length > 2000 ? '\n... (truncated)' : ''}
                </Text>
              </ScrollView>
            </View>
          ) : null}

          {tool.status === 'pending' ? (
            <View style={toolCardStyles.pendingBadge}>
              <Text style={toolCardStyles.pendingText}>Waiting for approval</Text>
            </View>
          ) : null}
        </View>
      )}
    </TouchableOpacity>
  );
}

export function ConversationItem({ item, showToolCalls, onSelectOption, onFileTap }: ConversationItemProps) {
  const [expanded, setExpanded] = useState(false);
  const isUser = item.type === 'user';
  const message = item as ConversationMessage;
  const hasToolCalls = showToolCalls && 'toolCalls' in message && message.toolCalls?.length;
  const hasOptions = 'options' in message && message.options && message.options.length > 0;

  // Check if content is long enough to need expansion
  const lineCount = item.content.split('\n').length;
  const charCount = item.content.length;
  const needsExpansion = !isUser && (lineCount > COLLAPSED_LINES || charCount > 800);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Regex to detect file paths (absolute, home, or relative with extension)
  const filePathRegex = /(?:^|\s)(\/[\w./-]+|~\/[\w./-]+|[\w.-]+\/[\w./-]*\.\w+)/g;

  // Helper to render text with clickable file paths
  const renderTextWithFilePaths = (text: string, baseStyle: object) => {
    if (!text || !onFileTap) {
      return <Text style={baseStyle}>{text || ''}</Text>;
    }

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    filePathRegex.lastIndex = 0;
    while ((match = filePathRegex.exec(text)) !== null) {
      const filePath = match[1];
      const matchStart = match.index + (match[0].length - filePath.length);

      // Add text before the match
      if (matchStart > lastIndex) {
        parts.push(
          <Text key={`text-${lastIndex}`} style={baseStyle}>
            {text.slice(lastIndex, matchStart)}
          </Text>
        );
      }

      // Add the clickable file path
      parts.push(
        <Text
          key={`path-${matchStart}`}
          style={[baseStyle, filePathStyles.filePath]}
          onPress={() => onFileTap(filePath)}
        >
          {filePath}
        </Text>
      );

      lastIndex = matchStart + filePath.length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push(
        <Text key={`text-${lastIndex}`} style={baseStyle}>
          {text.slice(lastIndex)}
        </Text>
      );
    }

    return parts.length > 0 ? <Text>{parts}</Text> : <Text style={baseStyle}>{text}</Text>;
  };

  // Custom rules for code blocks (simple text rendering for reliability)
  const rules = useMemo(
    () => ({
      fence: (node: { content: string; sourceInfo: string }, _children: React.ReactNode, _parent: unknown, _styles: Record<string, unknown>) => {
        const content = node?.content || '';
        const sourceInfo = node?.sourceInfo || '';
        return (
          <View key={`fence-${content.slice(0, 20)}`} style={codeBlockStyles.container}>
            {sourceInfo ? (
              <View style={codeBlockStyles.languageTag}>
                <Text style={codeBlockStyles.languageText}>{sourceInfo}</Text>
              </View>
            ) : null}
            <ScrollView style={codeBlockStyles.scrollView} nestedScrollEnabled>
              <Text style={codeBlockStyles.codeText}>{content.trim()}</Text>
            </ScrollView>
          </View>
        );
      },
      code_block: (node: { content: string }, _children: React.ReactNode, _parent: unknown, _styles: Record<string, unknown>) => {
        const content = node?.content || '';
        return (
          <View key={`codeblock-${content.slice(0, 20)}`} style={codeBlockStyles.container}>
            <ScrollView style={codeBlockStyles.scrollView} nestedScrollEnabled>
              <Text style={codeBlockStyles.codeText}>{content.trim()}</Text>
            </ScrollView>
          </View>
        );
      },
      // Make inline code with file paths clickable
      code_inline: (node: { content: string }, _children: React.ReactNode, _parent: unknown, styles: Record<string, unknown>) => {
        const content = node?.content || '';
        if (!content) {
          return null;
        }

        // Match absolute paths (/path/to/file), home paths (~/path), or relative paths with extension (dir/file.ext)
        const isFilePath =
          /^\/[\w./-]+$/.test(content) ||  // Absolute path
          content.startsWith('~/') ||       // Home path
          /^[\w.-]+\/[\w./-]*\.\w+$/.test(content) ||  // Relative path with extension (docs/file.md)
          /^[\w.-]+\.\w{1,5}$/.test(content);  // Just filename with extension (file.md)

        if (isFilePath && onFileTap) {
          return (
            <Text
              key={`code-${content}`}
              style={[styles.code_inline as object, filePathStyles.filePath]}
              onPress={() => onFileTap(content)}
            >
              {content}
            </Text>
          );
        }

        return (
          <Text key={`code-${content}`} style={styles.code_inline as object}>
            {content}
          </Text>
        );
      },
    }),
    [onFileTap]
  );

  const toggleExpanded = () => {
    if (needsExpansion) {
      setExpanded(!expanded);
    }
  };

  return (
    <View style={[styles.container, isUser ? styles.userContainer : styles.assistantContainer]}>
      <TouchableOpacity
        style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}
        onPress={toggleExpanded}
        activeOpacity={needsExpansion ? 0.8 : 1}
      >
        <View style={styles.headerRow}>
          <Text style={[styles.role, isUser ? styles.userRole : styles.assistantRole]}>
            {isUser ? 'You' : 'Claude'}
          </Text>
          {needsExpansion && (
            <Text style={styles.expandHint}>
              {expanded ? '▼ tap to collapse' : '▶ tap to expand'}
            </Text>
          )}
        </View>
        {isUser ? (
          <Text style={[styles.content, styles.userContent]}>{item.content}</Text>
        ) : (
          <View style={!expanded && needsExpansion ? styles.collapsedContent : undefined}>
            <Markdown style={markdownStyles} rules={rules}>
              {item.content}
            </Markdown>
            {!expanded && needsExpansion && <View style={styles.fadeOverlay} />}
          </View>
        )}
        {hasOptions && (
          <View style={styles.optionsContainer}>
            {message.options!.map((option, index) => (
              <TouchableOpacity
                key={index}
                style={[styles.optionButton, index > 0 && styles.optionButtonSpacing]}
                onPress={() => onSelectOption?.(option.label)}
                activeOpacity={0.7}
              >
                <Text style={styles.optionLabel}>{option.label}</Text>
                {option.description && (
                  <Text style={styles.optionDescription}>{option.description}</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}
        {hasToolCalls && (
          <View style={styles.toolCallsContainer}>
            {message.toolCalls!.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </View>
        )}
        <Text style={styles.time}>{formatTime(item.timestamp)}</Text>
      </TouchableOpacity>
    </View>
  );
}

const filePathStyles = StyleSheet.create({
  filePath: {
    color: '#60a5fa',
    textDecorationLine: 'underline',
  },
});

const diffStyles = StyleSheet.create({
  container: {
    marginTop: 8,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#111827',
  },
  section: {
    marginBottom: 1,
  },
  header: {
    backgroundColor: '#7f1d1d',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  addHeader: {
    backgroundColor: '#14532d',
  },
  headerText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  scroll: {
    maxHeight: 100,
    padding: 8,
  },
  removeLine: {
    color: '#fca5a5',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  addLine: {
    color: '#86efac',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  truncated: {
    color: '#6b7280',
    fontSize: 10,
    fontStyle: 'italic',
    marginTop: 4,
  },
});

const toolCardStyles = StyleSheet.create({
  container: {
    backgroundColor: '#1f2937',
    borderRadius: 6,
    marginTop: 8,
    paddingBottom: 2,
    borderLeftWidth: 3,
    borderLeftColor: '#3b82f6',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    flex: 1,
  },
  icon: {
    fontSize: 14,
    marginRight: 6,
  },
  name: {
    color: '#e5e7eb',
    fontSize: 13,
    fontWeight: '600',
    marginRight: 8,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  duration: {
    color: '#6b7280',
    fontSize: 10,
    marginLeft: 8,
  },
  summaryLine: {
    color: '#9ca3af',
    fontSize: 12,
    paddingHorizontal: 10,
    paddingBottom: 6,
  },
  preview: {
    backgroundColor: '#111827',
    marginHorizontal: 10,
    marginBottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 4,
  },
  previewText: {
    color: '#9ca3af',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  expandIcon: {
    color: '#6b7280',
    fontSize: 10,
  },
  details: {
    borderTopWidth: 1,
    borderTopColor: '#374151',
    padding: 10,
  },
  section: {
    marginBottom: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  sectionLabel: {
    color: '#6b7280',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  copyButton: {
    backgroundColor: '#374151',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  copyButtonText: {
    color: '#9ca3af',
    fontSize: 10,
    fontWeight: '600',
  },
  codeScroll: {
    backgroundColor: '#111827',
    borderRadius: 4,
    padding: 8,
    maxHeight: 120,
  },
  codeText: {
    color: '#e5e7eb',
    fontFamily: 'monospace',
    fontSize: 11,
  },
  filePath: {
    color: '#60a5fa',
    fontSize: 12,
    marginBottom: 8,
  },
  outputScroll: {
    backgroundColor: '#111827',
    borderRadius: 4,
    padding: 8,
    maxHeight: 200,
  },
  outputText: {
    color: '#9ca3af',
    fontFamily: 'monospace',
    fontSize: 10,
  },
  pendingBadge: {
    backgroundColor: '#78350f',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  pendingText: {
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '500',
  },
});

const codeBlockStyles = StyleSheet.create({
  container: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    marginVertical: 8,
    overflow: 'hidden',
    maxHeight: 200,
  },
  languageTag: {
    backgroundColor: '#374151',
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    borderBottomRightRadius: 4,
  },
  languageText: {
    color: '#9ca3af',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  scrollView: {
    padding: 12,
  },
  codeText: {
    color: '#e5e7eb',
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
  },
});

const markdownStyles = StyleSheet.create({
  body: {
    color: '#f3f4f6',
    fontSize: 15,
    lineHeight: 22,
    flexShrink: 1,
  },
  heading1: {
    color: '#f3f4f6',
    fontSize: 20,
    fontWeight: 'bold',
    marginTop: 12,
    marginBottom: 8,
  },
  heading2: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 10,
    marginBottom: 6,
  },
  heading3: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 8,
    marginBottom: 4,
  },
  strong: {
    fontWeight: 'bold',
    color: '#f3f4f6',
  },
  em: {
    fontStyle: 'italic',
    color: '#f3f4f6',
  },
  bullet_list: {
    marginVertical: 4,
  },
  ordered_list: {
    marginVertical: 4,
  },
  list_item: {
    marginVertical: 2,
  },
  bullet_list_icon: {
    color: '#9ca3af',
    marginRight: 8,
  },
  ordered_list_icon: {
    color: '#9ca3af',
    marginRight: 8,
  },
  code_inline: {
    backgroundColor: '#1f2937',
    color: '#a78bfa',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  fence: {
    backgroundColor: '#1f2937',
    padding: 12,
    borderRadius: 8,
    marginVertical: 8,
  },
  code_block: {
    color: '#e5e7eb',
    fontFamily: 'monospace',
    fontSize: 13,
  },
  blockquote: {
    backgroundColor: '#1f2937',
    borderLeftWidth: 4,
    borderLeftColor: '#3b82f6',
    paddingLeft: 12,
    paddingVertical: 8,
    marginVertical: 8,
  },
  link: {
    color: '#60a5fa',
    textDecorationLine: 'underline',
  },
  hr: {
    backgroundColor: '#4b5563',
    height: 1,
    marginVertical: 12,
  },
  table: {
    borderWidth: 1,
    borderColor: '#4b5563',
    borderRadius: 4,
    marginVertical: 8,
  },
  th: {
    backgroundColor: '#1f2937',
    padding: 8,
    borderBottomWidth: 1,
    borderColor: '#4b5563',
  },
  td: {
    padding: 8,
    borderBottomWidth: 1,
    borderColor: '#374151',
  },
  tr: {
    borderBottomWidth: 1,
    borderColor: '#374151',
  },
  paragraph: {
    marginVertical: 4,
  },
});

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  userContainer: {
    alignItems: 'flex-end',
  },
  assistantContainer: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '85%',
    padding: 12,
    borderRadius: 16,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  expandHint: {
    fontSize: 10,
    color: '#6b7280',
  },
  collapsedContent: {
    maxHeight: 250,
    overflow: 'hidden',
    position: 'relative',
  },
  fadeOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 40,
    backgroundColor: 'rgba(55, 65, 81, 0.95)',
  },
  userBubble: {
    backgroundColor: '#3b82f6',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: '#374151',
    borderBottomLeftRadius: 4,
  },
  role: {
    fontSize: 11,
    fontWeight: '600',
  },
  userRole: {
    color: '#bfdbfe',
  },
  assistantRole: {
    color: '#9ca3af',
  },
  content: {
    fontSize: 15,
    lineHeight: 22,
  },
  userContent: {
    color: '#ffffff',
  },
  assistantContent: {
    color: '#f3f4f6',
  },
  time: {
    fontSize: 10,
    color: '#9ca3af',
    marginTop: 6,
    alignSelf: 'flex-end',
  },
  optionsContainer: {
    marginTop: 12,
  },
  optionButtonSpacing: {
    marginTop: 8,
  },
  optionButton: {
    backgroundColor: '#1f2937',
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 8,
    padding: 12,
  },
  optionLabel: {
    color: '#60a5fa',
    fontSize: 14,
    fontWeight: '600',
  },
  optionDescription: {
    color: '#9ca3af',
    fontSize: 12,
    marginTop: 4,
  },
  toolCallsContainer: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#4b5563',
  },
});
