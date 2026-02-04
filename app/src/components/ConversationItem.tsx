import React, { useMemo, useState, useRef, memo } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, Alert, LayoutAnimation, Platform, UIManager } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Markdown from '@ronradtke/react-native-markdown-display';
import { ConversationMessage, ConversationHighlight, ToolCall, Question } from '../types';
import { scaledFont } from '../theme/fonts';

// Content that should be treated as empty / not rendered
function isEmptyContent(content: string): boolean {
  const trimmed = content.trim();
  return !trimmed || trimmed === '(no content)';
}

interface ConversationItemProps {
  item: ConversationMessage | ConversationHighlight;
  showToolCalls?: boolean;
  onSelectOption?: (option: string) => void;
  onFileTap?: (filePath: string) => void;
  onMessageTap?: () => void;
  fontScale?: number;
}

const COLLAPSED_LINES = 12;
const COLLAPSED_HEIGHT = 250;

// Map file extension to language label
function getLanguageLabel(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React',
    py: 'Python', rs: 'Rust', go: 'Go', rb: 'Ruby', java: 'Java', kt: 'Kotlin',
    swift: 'Swift', c: 'C', cpp: 'C++', h: 'C Header', cs: 'C#',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
    html: 'HTML', css: 'CSS', scss: 'SCSS', md: 'Markdown',
    sh: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish',
    sql: 'SQL', graphql: 'GraphQL', proto: 'Protocol Buffers',
    dockerfile: 'Dockerfile', makefile: 'Makefile',
  };
  if (!ext) return null;
  return map[ext] || null;
}

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
    default: {
      // For unknown tools, try to extract a useful summary from the first string input field
      const firstStringValue = Object.values(input).find(
        (v) => typeof v === 'string' && v.length > 0 && v.length < 200
      );
      return firstStringValue ? `${tool.name}: ${String(firstStringValue).substring(0, 60)}` : tool.name;
    }
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

// Threshold for collapsing tool calls into a summary
const TOOL_COLLAPSE_THRESHOLD = 3;

// Group consecutive identical tool names (e.g., ["Read","Read","Read","Edit"] -> [{ name: "Read", count: 3 }, { name: "Edit", count: 1 }])
function groupToolNames(tools: ToolCall[]): { name: string; count: number }[] {
  const groups: { name: string; count: number }[] = [];
  for (const tool of tools) {
    const last = groups[groups.length - 1];
    if (last && last.name === tool.name) {
      last.count++;
    } else {
      groups.push({ name: tool.name, count: 1 });
    }
  }
  return groups;
}

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Tool calls container with collapse/expand for many tools
function ToolCallsContainer({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [showAll, setShowAll] = useState(false);
  const [allExpanded, setAllExpanded] = useState<boolean | undefined>(undefined);

  if (toolCalls.length === 0) return null;

  const completedCount = toolCalls.filter(t => t.status === 'completed').length;
  const runningCount = toolCalls.filter(t => t.status === 'running' || t.status === 'pending').length;
  const errorCount = toolCalls.filter(t => t.status === 'error').length;
  const toolGroups = groupToolNames(toolCalls);

  const animatedSetShowAll = (value: boolean) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setShowAll(value);
  };

  // For many tools, show a collapsed summary with first & last tool visible
  if (toolCalls.length >= TOOL_COLLAPSE_THRESHOLD && !showAll) {
    const firstTool = toolCalls[0];
    const lastTool = toolCalls[toolCalls.length - 1];
    return (
      <View style={styles.toolCallsContainer}>
        <TouchableOpacity
          style={toolGroupStyles.summaryBar}
          onPress={() => animatedSetShowAll(true)}
          activeOpacity={0.7}
        >
          <View style={toolGroupStyles.summaryLeft}>
            <Text style={toolGroupStyles.summaryCount}>{toolCalls.length} tools</Text>
            <View style={toolGroupStyles.toolChips}>
              {toolGroups.map((g, i) => (
                <View key={i} style={toolGroupStyles.toolChip}>
                  <Text style={toolGroupStyles.toolChipText}>
                    {g.name}{g.count > 1 ? ` x${g.count}` : ''}
                  </Text>
                </View>
              ))}
            </View>
            <View style={toolGroupStyles.summaryStats}>
              {completedCount > 0 && (
                <View style={[toolGroupStyles.statBadge, { backgroundColor: '#065f46' }]}>
                  <Text style={[toolGroupStyles.statText, { color: '#6ee7b7' }]}>{completedCount} done</Text>
                </View>
              )}
              {runningCount > 0 && (
                <View style={[toolGroupStyles.statBadge, { backgroundColor: '#713f12' }]}>
                  <Text style={[toolGroupStyles.statText, { color: '#fde68a' }]}>{runningCount} active</Text>
                </View>
              )}
              {errorCount > 0 && (
                <View style={[toolGroupStyles.statBadge, { backgroundColor: '#7f1d1d' }]}>
                  <Text style={[toolGroupStyles.statText, { color: '#fca5a5' }]}>{errorCount} error</Text>
                </View>
              )}
            </View>
          </View>
          <Text style={toolGroupStyles.expandText}>Show all ▶</Text>
        </TouchableOpacity>
        {/* Show first tool */}
        <ToolCard key={firstTool.id} tool={firstTool} forceExpanded={undefined} />
        {/* Show last tool if different from first */}
        {toolCalls.length > 1 && (
          <>
            {toolCalls.length > 2 && (
              <Text style={toolGroupStyles.ellipsis}>... {toolCalls.length - 2} more tools ...</Text>
            )}
            <ToolCard key={lastTool.id} tool={lastTool} forceExpanded={undefined} />
          </>
        )}
      </View>
    );
  }

  const toggleAll = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setAllExpanded(prev => prev === true ? false : true);
  };

  return (
    <View style={styles.toolCallsContainer}>
      {toolCalls.length > 1 && (
        <View style={toolGroupStyles.toolbar}>
          {toolCalls.length >= TOOL_COLLAPSE_THRESHOLD && (
            <TouchableOpacity onPress={() => animatedSetShowAll(false)}>
              <Text style={toolGroupStyles.collapseText}>◀ Collapse</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.expandAllButton} onPress={toggleAll}>
            <Text style={styles.expandAllText}>
              {allExpanded === true ? 'Collapse All' : 'Expand All'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
      {toolCalls.map((tool) => (
        <ToolCard key={tool.id} tool={tool} forceExpanded={allExpanded} />
      ))}
    </View>
  );
}

// Render a unified diff view
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const [showAll, setShowAll] = useState(false);
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const limit = showAll ? Infinity : 40;
  const isTruncated = oldLines.length > 40 || newLines.length > 40;

  return (
    <View style={diffStyles.container}>
      <View style={diffStyles.section}>
        <View style={diffStyles.header}>
          <Text style={diffStyles.headerText}>- Remove ({oldLines.length} lines)</Text>
        </View>
        <ScrollView style={diffStyles.scroll} nestedScrollEnabled>
          {oldLines.slice(0, limit).map((line, i) => (
            <View key={`old-${i}`} style={diffStyles.lineRow}>
              <Text style={diffStyles.lineNumber}>{i + 1}</Text>
              <Text style={diffStyles.removeLine}>{line}</Text>
            </View>
          ))}
          {!showAll && oldLines.length > 40 && (
            <Text style={diffStyles.truncated}>... {oldLines.length - 40} more lines</Text>
          )}
        </ScrollView>
      </View>
      <View style={diffStyles.section}>
        <View style={[diffStyles.header, diffStyles.addHeader]}>
          <Text style={diffStyles.headerText}>+ Add ({newLines.length} lines)</Text>
        </View>
        <ScrollView style={diffStyles.scroll} nestedScrollEnabled>
          {newLines.slice(0, limit).map((line, i) => (
            <View key={`new-${i}`} style={diffStyles.lineRow}>
              <Text style={diffStyles.lineNumber}>{i + 1}</Text>
              <Text style={diffStyles.addLine}>{line}</Text>
            </View>
          ))}
          {!showAll && newLines.length > 40 && (
            <Text style={diffStyles.truncated}>... {newLines.length - 40} more lines</Text>
          )}
        </ScrollView>
      </View>
      {isTruncated && (
        <TouchableOpacity style={diffStyles.showMoreButton} onPress={() => setShowAll(!showAll)}>
          <Text style={diffStyles.showMoreText}>{showAll ? 'Show less' : 'Show all'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// Write content view with line numbers and show more
function WriteContentView({ filePath, content }: { filePath: string; content: string }) {
  const [showAll, setShowAll] = useState(false);
  const langLabel = getLanguageLabel(filePath);
  const lines = content.split('\n');
  const charLimit = showAll ? Infinity : 2000;
  const truncatedContent = content.substring(0, charLimit);
  const isTruncated = content.length > 2000;
  const displayLines = truncatedContent.split('\n');

  return (
    <View style={toolCardStyles.section}>
      <View style={toolCardStyles.sectionHeader}>
        <Text style={toolCardStyles.sectionLabel}>File: {filePath}</Text>
        {langLabel && <Text style={toolCardStyles.langLabel}>{langLabel}</Text>}
        {content && (
          <TouchableOpacity
            style={toolCardStyles.copyButton}
            onPress={() => copyToClipboard(content, 'Content')}
          >
            <Text style={toolCardStyles.copyButtonText}>Copy</Text>
          </TouchableOpacity>
        )}
      </View>
      {content && (
        <>
          <Text style={toolCardStyles.lineCount}>{lines.length} lines</Text>
          <ScrollView style={toolCardStyles.codeScroll} nestedScrollEnabled>
            {displayLines.map((line, i) => (
              <View key={i} style={toolCardStyles.numberedLine}>
                <Text style={toolCardStyles.lineNum}>{i + 1}</Text>
                <Text style={toolCardStyles.codeText}>{line}</Text>
              </View>
            ))}
            {!showAll && isTruncated && (
              <Text style={diffStyles.truncated}>... content truncated</Text>
            )}
          </ScrollView>
          {isTruncated && (
            <TouchableOpacity style={diffStyles.showMoreButton} onPress={() => setShowAll(!showAll)}>
              <Text style={diffStyles.showMoreText}>{showAll ? 'Show less' : 'Show all'}</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

// Expandable tool card component
function ToolCard({ tool, forceExpanded }: { tool: ToolCall; forceExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const isExpanded = forceExpanded !== undefined ? forceExpanded : expanded;
  const summary = getToolSummary(tool);
  const icon = getToolIcon(tool.name);
  const hasOutput = tool.output && tool.output.length > 0;
  const statusColor = tool.status === 'completed' ? '#10b981' : tool.status === 'error' ? '#ef4444' : '#f59e0b';
  const statusText = tool.status === 'completed' ? 'done' : tool.status === 'error' ? 'error' : 'running';

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
      onPress={() => forceExpanded === undefined && setExpanded(!expanded)}
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
        <Text style={toolCardStyles.expandIcon}>{isExpanded ? '▼' : '▶'}</Text>
      </View>
      <Text style={toolCardStyles.summaryLine} numberOfLines={1}>{summary}</Text>
      {!isExpanded && outputPreview ? (
        <View style={toolCardStyles.preview}>
          <Text style={toolCardStyles.previewText} numberOfLines={2}>{outputPreview}</Text>
        </View>
      ) : null}

      {isExpanded && (
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
              <View style={toolCardStyles.sectionHeader}>
                <Text style={toolCardStyles.sectionLabel}>File:</Text>
                {getLanguageLabel(filePath) && (
                  <Text style={toolCardStyles.langLabel}>{getLanguageLabel(filePath)}</Text>
                )}
              </View>
              <Text style={toolCardStyles.filePath}>{filePath}</Text>
              <DiffView oldText={oldString} newText={newString} />
            </View>
          ) : null}

          {(tool.name === 'Write') && filePath ? (
            <WriteContentView filePath={filePath} content={newString} />
          ) : null}

          {/* Generic fallback for unknown tools */}
          {!['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch'].includes(tool.name) && Object.keys(tool.input || {}).length > 0 && (
            <View style={toolCardStyles.section}>
              <Text style={toolCardStyles.sectionLabel}>Input:</Text>
              {Object.entries(tool.input || {}).map(([key, value]) => (
                <View key={key} style={toolCardStyles.genericField}>
                  <Text style={toolCardStyles.genericFieldKey}>{key}:</Text>
                  <Text style={toolCardStyles.genericFieldValue} numberOfLines={4}>
                    {typeof value === 'string' ? value.substring(0, 500) : JSON.stringify(value)}
                  </Text>
                </View>
              ))}
            </View>
          )}

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
          ) : tool.status === 'running' ? (
            <View style={[toolCardStyles.pendingBadge, { backgroundColor: '#1e3a5f' }]}>
              <Text style={[toolCardStyles.pendingText, { color: '#60a5fa' }]}>Running...</Text>
            </View>
          ) : null}
        </View>
      )}
    </TouchableOpacity>
  );
}

function ConversationItemInner({ item, showToolCalls, onSelectOption, onFileTap, onMessageTap, fontScale = 1 }: ConversationItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  // Per-question selections for multi-question mode: Map<questionIndex, Set<optionLabel>>
  const [perQuestionSelections, setPerQuestionSelections] = useState<Map<number, Set<string>>>(new Map());
  // Per-question "Other" freetext values
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(new Map());
  // Per-question "Other" active state
  const [otherActive, setOtherActive] = useState<Set<number>>(new Set());
  const isUser = item.type === 'user';
  const message = item as ConversationMessage;

  // Filter "(no content)" assistant messages that have no tools or options
  const hasToolCalls = showToolCalls && 'toolCalls' in message && message.toolCalls?.length;
  // Only show options if there are options AND we're actually waiting for a choice
  // (auto-approved tools will have options but isWaitingForChoice will be false)
  const hasOptions = 'options' in message && message.options && message.options.length > 0 && message.isWaitingForChoice;
  const isMultiSelect = 'multiSelect' in message && message.multiSelect === true;
  // Check for multiple questions
  const allQuestions: Question[] | undefined = 'questions' in message ? (message as ConversationMessage).questions : undefined;
  const hasMultipleQuestions = allQuestions && allQuestions.length > 1 && message.isWaitingForChoice;

  // Skip rendering if assistant message is just "(no content)" with no tools or options
  if (!isUser && isEmptyContent(item.content) && !hasToolCalls && !hasOptions && !hasMultipleQuestions) {
    return null;
  }

  // Build scaled markdown styles when fontScale !== 1
  const scaledMarkdownStyles = useMemo(() => {
    if (fontScale === 1) return markdownStyles;
    return StyleSheet.create({
      ...markdownStyles,
      body: {
        ...markdownStyles.body,
        fontSize: scaledFont(15, fontScale),
        lineHeight: scaledFont(22, fontScale),
      },
      heading1: {
        ...markdownStyles.heading1,
        fontSize: scaledFont(18, fontScale),
      },
      heading2: {
        ...markdownStyles.heading2,
        fontSize: scaledFont(16, fontScale),
      },
      heading3: {
        ...markdownStyles.heading3,
        fontSize: scaledFont(15, fontScale),
      },
      code_inline: {
        ...markdownStyles.code_inline,
        fontSize: scaledFont(13, fontScale),
      },
      code_block: {
        ...markdownStyles.code_block,
        fontSize: scaledFont(13, fontScale),
      },
    });
  }, [fontScale]);

  // Handle option selection - toggle for multi-select, immediate send for single-select
  const handleOptionPress = (label: string) => {
    if (isMultiSelect) {
      setSelectedOptions(prev => {
        const newSet = new Set(prev);
        if (newSet.has(label)) {
          newSet.delete(label);
        } else {
          newSet.add(label);
        }
        return newSet;
      });
    } else {
      onSelectOption?.(label);
    }
  };

  // Handle per-question option selection (multi-question mode)
  const handleQuestionOptionPress = (questionIdx: number, label: string, questionMultiSelect: boolean) => {
    if (questionMultiSelect) {
      // Toggle in per-question set
      setPerQuestionSelections(prev => {
        const next = new Map(prev);
        const current = new Set(next.get(questionIdx) || []);
        if (current.has(label)) {
          current.delete(label);
        } else {
          current.add(label);
        }
        next.set(questionIdx, current);
        return next;
      });
      // Deactivate "Other" if selecting a regular option
      setOtherActive(prev => {
        const next = new Set(prev);
        next.delete(questionIdx);
        return next;
      });
    } else {
      // Single-select: set to just this one
      setPerQuestionSelections(prev => {
        const next = new Map(prev);
        next.set(questionIdx, new Set([label]));
        return next;
      });
      // Deactivate "Other"
      setOtherActive(prev => {
        const next = new Set(prev);
        next.delete(questionIdx);
        return next;
      });
    }
  };

  // Toggle "Other" freetext for a question
  const handleOtherToggle = (questionIdx: number) => {
    setOtherActive(prev => {
      const next = new Set(prev);
      if (next.has(questionIdx)) {
        next.delete(questionIdx);
      } else {
        next.add(questionIdx);
        // Clear regular selections for single-select questions
        if (allQuestions && !allQuestions[questionIdx].multiSelect) {
          setPerQuestionSelections(p => {
            const n = new Map(p);
            n.delete(questionIdx);
            return n;
          });
        }
      }
      return next;
    });
  };

  // Submit all selected options for multi-select (single question)
  const handleMultiSelectSubmit = () => {
    if (selectedOptions.size > 0) {
      const selectedLabels = Array.from(selectedOptions).join(', ');
      onSelectOption?.(selectedLabels);
      setSelectedOptions(new Set());
    }
  };

  // Submit all answers for multi-question mode
  const handleMultiQuestionSubmit = () => {
    if (!allQuestions) return;
    const answers: string[] = [];
    for (let i = 0; i < allQuestions.length; i++) {
      if (otherActive.has(i)) {
        const text = otherTexts.get(i)?.trim();
        answers.push(text || '');
      } else {
        const selected = perQuestionSelections.get(i);
        if (selected && selected.size > 0) {
          answers.push(Array.from(selected).join(', '));
        } else {
          answers.push('');
        }
      }
    }
    onSelectOption?.(answers.join('\n'));
    setPerQuestionSelections(new Map());
    setOtherTexts(new Map());
    setOtherActive(new Set());
  };

  // Check if multi-question submit is ready (all questions have an answer)
  const multiQuestionReady = useMemo(() => {
    if (!allQuestions || !hasMultipleQuestions) return false;
    for (let i = 0; i < allQuestions.length; i++) {
      if (otherActive.has(i)) {
        if (!(otherTexts.get(i)?.trim())) return false;
      } else {
        const selected = perQuestionSelections.get(i);
        if (!selected || selected.size === 0) return false;
      }
    }
    return true;
  }, [allQuestions, hasMultipleQuestions, perQuestionSelections, otherActive, otherTexts]);

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

  // Counter for unique keys in markdown rules
  const keyCounter = useRef(0);
  const getUniqueKey = (prefix: string) => `${prefix}-${keyCounter.current++}`;

  // Custom rules for code blocks (simple text rendering for reliability)
  const rules = useMemo(
    () => ({
      fence: (node: { content: string; sourceInfo: string }, _children: React.ReactNode, _parent: unknown, _styles: Record<string, unknown>) => {
        const content = node?.content || '';
        const sourceInfo = node?.sourceInfo || '';
        return (
          <View key={getUniqueKey('fence')} style={codeBlockStyles.container}>
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
          <View key={getUniqueKey('codeblock')} style={codeBlockStyles.container}>
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

        // Match absolute paths (/path/to/file), home paths (~/path), or relative paths with directory (dir/file.ext)
        const isFilePath =
          /^\/[\w./-]+$/.test(content) ||  // Absolute path
          content.startsWith('~/') ||       // Home path
          /^[\w.-]+\/[\w./-]*\.\w+$/.test(content);  // Relative path with extension (docs/file.md)

        if (isFilePath && onFileTap) {
          return (
            <Text
              key={getUniqueKey('code-path')}
              style={[styles.code_inline as object, filePathStyles.filePath]}
              onPress={() => onFileTap(content)}
            >
              {content}
            </Text>
          );
        }

        return (
          <Text key={getUniqueKey('code')} style={styles.code_inline as object}>
            {content}
          </Text>
        );
      },
    }),
    [onFileTap]
  );

  const handleBubbleTap = () => {
    // If we have a message tap handler (for full viewer), use that
    if (onMessageTap) {
      onMessageTap();
    } else if (needsExpansion) {
      // Otherwise toggle expansion for backwards compatibility
      setExpanded(!expanded);
    }
  };

  return (
    <View style={[styles.container, isUser ? styles.userContainer : styles.assistantContainer]}>
      <TouchableOpacity
        style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}
        onPress={handleBubbleTap}
        activeOpacity={onMessageTap || needsExpansion ? 0.8 : 1}
      >
        <View style={styles.headerRow}>
          <Text style={[styles.role, isUser ? styles.userRole : styles.assistantRole]}>
            {isUser ? 'You' : 'Assistant'}
          </Text>
          {(needsExpansion || onMessageTap) && !isUser && (
            <Text style={styles.expandHint}>
              {onMessageTap ? 'tap to view full' : (expanded ? '▼ collapse' : '▶ expand')}
            </Text>
          )}
        </View>
        {isUser ? (
          <Text style={[styles.content, styles.userContent]}>{item.content}</Text>
        ) : (
          <View style={!expanded && needsExpansion ? styles.collapsedContent : undefined}>
            <Markdown style={scaledMarkdownStyles} rules={rules}>
              {item.content}
            </Markdown>
            {!expanded && needsExpansion && (
              <View style={styles.fadeOverlay}>
                <View style={styles.fadeLayer1} />
                <View style={styles.fadeLayer2} />
                <View style={styles.fadeLayer3} />
                <View style={styles.tapMoreRow}>
                  <View style={styles.tapMoreLine} />
                  <Text style={styles.tapMoreText}>tap to see more</Text>
                  <View style={styles.tapMoreLine} />
                </View>
              </View>
            )}
          </View>
        )}
        {hasMultipleQuestions && allQuestions ? (
          <View style={styles.optionsContainer}>
            {allQuestions.map((q, qIdx) => {
              const qSelections = perQuestionSelections.get(qIdx) || new Set<string>();
              const isOtherActive = otherActive.has(qIdx);
              return (
                <View key={qIdx} style={[styles.questionSection, qIdx > 0 && styles.questionSectionSpacing]}>
                  <View style={styles.questionHeaderChip}>
                    <Text style={styles.questionHeaderText}>{q.header}</Text>
                  </View>
                  <Text style={styles.questionText}>{q.question}</Text>
                  {q.multiSelect && (
                    <Text style={styles.multiSelectHint}>Select one or more:</Text>
                  )}
                  {q.options.map((option, oIdx) => {
                    const isSelected = !isOtherActive && qSelections.has(option.label);
                    return (
                      <TouchableOpacity
                        key={oIdx}
                        style={[
                          styles.optionButton,
                          oIdx > 0 && styles.optionButtonSpacing,
                          isSelected && styles.optionButtonSelected,
                        ]}
                        onPress={() => handleQuestionOptionPress(qIdx, option.label, q.multiSelect)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.optionLabelRow}>
                          <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                            {isSelected && <Text style={styles.checkmark}>✓</Text>}
                          </View>
                          <Text style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}>
                            {option.label}
                          </Text>
                        </View>
                        {option.description && (
                          <Text style={styles.optionDescription}>{option.description}</Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                  {/* "Other" freetext option */}
                  <TouchableOpacity
                    style={[
                      styles.optionButton,
                      styles.optionButtonSpacing,
                      isOtherActive && styles.optionButtonSelected,
                    ]}
                    onPress={() => handleOtherToggle(qIdx)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.optionLabelRow}>
                      <View style={[styles.checkbox, isOtherActive && styles.checkboxSelected]}>
                        {isOtherActive && <Text style={styles.checkmark}>✓</Text>}
                      </View>
                      <Text style={[styles.optionLabel, isOtherActive && styles.optionLabelSelected]}>
                        Other
                      </Text>
                    </View>
                  </TouchableOpacity>
                  {isOtherActive && (
                    <TextInput
                      style={styles.otherTextInput}
                      placeholder="Type your answer..."
                      placeholderTextColor="#6b7280"
                      value={otherTexts.get(qIdx) || ''}
                      onChangeText={(text) => setOtherTexts(prev => {
                        const next = new Map(prev);
                        next.set(qIdx, text);
                        return next;
                      })}
                      autoFocus
                    />
                  )}
                </View>
              );
            })}
            <TouchableOpacity
              style={[
                styles.submitButton,
                !multiQuestionReady && styles.submitButtonDisabled,
              ]}
              onPress={handleMultiQuestionSubmit}
              disabled={!multiQuestionReady}
              activeOpacity={0.7}
            >
              <Text style={[
                styles.submitButtonText,
                !multiQuestionReady && styles.submitButtonTextDisabled,
              ]}>
                Submit Answers
              </Text>
            </TouchableOpacity>
          </View>
        ) : hasOptions && (
          <View style={styles.optionsContainer}>
            {isMultiSelect && (
              <Text style={styles.multiSelectHint}>Select one or more options:</Text>
            )}
            {message.options!.map((option, index) => {
              const isSelected = selectedOptions.has(option.label);
              return (
                <TouchableOpacity
                  key={index}
                  style={[
                    styles.optionButton,
                    index > 0 && styles.optionButtonSpacing,
                    isMultiSelect && isSelected && styles.optionButtonSelected,
                  ]}
                  onPress={() => handleOptionPress(option.label)}
                  activeOpacity={0.7}
                >
                  <View style={styles.optionLabelRow}>
                    {isMultiSelect && (
                      <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                        {isSelected && <Text style={styles.checkmark}>✓</Text>}
                      </View>
                    )}
                    <Text style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}>
                      {option.label}
                    </Text>
                  </View>
                  {option.description && (
                    <Text style={styles.optionDescription}>{option.description}</Text>
                  )}
                </TouchableOpacity>
              );
            })}
            {isMultiSelect && (
              <TouchableOpacity
                style={[
                  styles.submitButton,
                  selectedOptions.size === 0 && styles.submitButtonDisabled,
                ]}
                onPress={handleMultiSelectSubmit}
                disabled={selectedOptions.size === 0}
                activeOpacity={0.7}
              >
                <Text style={[
                  styles.submitButtonText,
                  selectedOptions.size === 0 && styles.submitButtonTextDisabled,
                ]}>
                  Submit ({selectedOptions.size} selected)
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {hasToolCalls && (
          <ToolCallsContainer toolCalls={message.toolCalls!} />
        )}
        <Text style={styles.time}>{formatTime(item.timestamp)}</Text>
      </TouchableOpacity>
    </View>
  );
}

const toolGroupStyles = StyleSheet.create({
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1f2937',
    borderRadius: 6,
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#6b7280',
  },
  summaryLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    flexWrap: 'wrap',
    gap: 6,
  },
  summaryCount: {
    color: '#d1d5db',
    fontSize: 13,
    fontWeight: '600',
  },
  summaryStats: {
    flexDirection: 'row',
    gap: 4,
  },
  statBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statText: {
    fontSize: 10,
    fontWeight: '600',
  },
  toolChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  toolChip: {
    backgroundColor: '#374151',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  toolChipText: {
    color: '#9ca3af',
    fontSize: 10,
    fontWeight: '500',
  },
  ellipsis: {
    color: '#6b7280',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 6,
    fontStyle: 'italic',
  },
  expandText: {
    color: '#9ca3af',
    fontSize: 11,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    marginBottom: -4,
  },
  collapseText: {
    color: '#9ca3af',
    fontSize: 11,
  },
});

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
    maxHeight: 200,
    padding: 8,
  },
  lineRow: {
    flexDirection: 'row',
  },
  lineNumber: {
    color: '#4b5563',
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 16,
    width: 30,
    textAlign: 'right',
    marginRight: 8,
  },
  removeLine: {
    color: '#fca5a5',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    flex: 1,
  },
  addLine: {
    color: '#86efac',
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    flex: 1,
  },
  truncated: {
    color: '#6b7280',
    fontSize: 10,
    fontStyle: 'italic',
    marginTop: 4,
  },
  showMoreButton: {
    paddingVertical: 6,
    alignItems: 'center',
    backgroundColor: '#1a2332',
  },
  showMoreText: {
    color: '#3b82f6',
    fontSize: 11,
    fontWeight: '600',
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
    maxHeight: 200,
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
  langLabel: {
    color: '#6b7280',
    fontSize: 10,
    fontWeight: '500',
    backgroundColor: '#1f2937',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
    overflow: 'hidden',
  },
  lineCount: {
    color: '#6b7280',
    fontSize: 10,
    marginBottom: 4,
  },
  numberedLine: {
    flexDirection: 'row',
  },
  lineNum: {
    color: '#4b5563',
    fontFamily: 'monospace',
    fontSize: 10,
    width: 30,
    textAlign: 'right',
    marginRight: 8,
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
  genericField: {
    marginBottom: 4,
  },
  genericFieldKey: {
    color: '#9ca3af',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 1,
  },
  genericFieldValue: {
    color: '#d1d5db',
    fontSize: 12,
    fontFamily: 'monospace',
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
    flexWrap: 'wrap',
  },
  heading1: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 6,
    marginBottom: 4,
  },
  heading2: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 6,
    marginBottom: 3,
  },
  heading3: {
    color: '#f3f4f6',
    fontSize: 15,
    fontWeight: 'bold',
    marginTop: 4,
    marginBottom: 2,
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
    overflow: 'hidden',
  },
  code_block: {
    color: '#e5e7eb',
    fontFamily: 'monospace',
    fontSize: 13,
    flexWrap: 'wrap',
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
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  text: {
    flexShrink: 1,
    flexWrap: 'wrap',
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
    height: 80,
  },
  fadeLayer1: {
    height: 20,
    backgroundColor: 'rgba(55, 65, 81, 0.3)',
  },
  fadeLayer2: {
    height: 20,
    backgroundColor: 'rgba(55, 65, 81, 0.7)',
  },
  fadeLayer3: {
    height: 12,
    backgroundColor: 'rgba(55, 65, 81, 1)',
  },
  tapMoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#374151',
    paddingBottom: 2,
    paddingHorizontal: 4,
  },
  tapMoreLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#4b5563',
  },
  tapMoreText: {
    fontSize: 11,
    color: '#9ca3af',
    marginHorizontal: 8,
    fontWeight: '500',
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
    flexShrink: 1,
    flexWrap: 'wrap',
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
  multiSelectHint: {
    color: '#9ca3af',
    fontSize: 12,
    marginBottom: 8,
    fontStyle: 'italic',
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
  optionButtonSelected: {
    backgroundColor: '#1e3a5f',
    borderColor: '#60a5fa',
  },
  optionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#3b82f6',
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    backgroundColor: '#3b82f6',
  },
  checkmark: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  optionLabel: {
    color: '#60a5fa',
    fontSize: 14,
    fontWeight: '600',
  },
  optionLabelSelected: {
    color: '#93c5fd',
  },
  optionDescription: {
    color: '#9ca3af',
    fontSize: 12,
    marginTop: 4,
  },
  submitButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    padding: 14,
    marginTop: 12,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    backgroundColor: '#374151',
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  submitButtonTextDisabled: {
    color: '#6b7280',
  },
  questionSection: {
    backgroundColor: '#111827',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  questionSectionSpacing: {
    marginTop: 12,
  },
  questionHeaderChip: {
    backgroundColor: '#1e3a5f',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    alignSelf: 'flex-start',
    marginBottom: 6,
  },
  questionHeaderText: {
    color: '#93c5fd',
    fontSize: 11,
    fontWeight: '600',
  },
  questionText: {
    color: '#e5e7eb',
    fontSize: 14,
    marginBottom: 8,
  },
  otherTextInput: {
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
    color: '#f3f4f6',
    fontSize: 14,
  },
  toolCallsContainer: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#4b5563',
  },
  expandAllButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 4,
  },
  expandAllText: {
    color: '#60a5fa',
    fontSize: 12,
    fontWeight: '500',
  },
});

// Memoize to prevent re-renders when parent re-renders but props unchanged
// This is important for FlatList performance during rapid message updates
export const ConversationItem = memo(ConversationItemInner, (prevProps, nextProps) => {
  // Only re-render if these key props change
  return (
    prevProps.item.id === nextProps.item.id &&
    prevProps.item.content === nextProps.item.content &&
    prevProps.item.timestamp === nextProps.item.timestamp &&
    prevProps.showToolCalls === nextProps.showToolCalls &&
    prevProps.fontScale === nextProps.fontScale &&
    // For messages with options, check if options changed
    ('options' in prevProps.item ? prevProps.item.options : undefined) ===
    ('options' in nextProps.item ? nextProps.item.options : undefined) &&
    ('questions' in prevProps.item ? prevProps.item.questions : undefined) ===
    ('questions' in nextProps.item ? nextProps.item.questions : undefined) &&
    ('isWaitingForChoice' in prevProps.item ? prevProps.item.isWaitingForChoice : undefined) ===
    ('isWaitingForChoice' in nextProps.item ? nextProps.item.isWaitingForChoice : undefined)
  );
});
