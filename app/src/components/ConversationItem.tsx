import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import Markdown from '@ronradtke/react-native-markdown-display';
import { ConversationMessage, ConversationHighlight } from '../types';

interface ConversationItemProps {
  item: ConversationMessage | ConversationHighlight;
  showToolCalls?: boolean;
  onSelectOption?: (option: string) => void;
  onFileTap?: (filePath: string) => void;
}

const COLLAPSED_LINES = 12;
const COLLAPSED_HEIGHT = 250;

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

  // Regex to detect file paths
  const filePathRegex = /(?:^|\s)((?:\/[\w.-]+)+(?:\.\w+)?|~\/[\w./-]+)/g;

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

        const isFilePath = /^(\/[\w.-]+)+(\.\w+)?$/.test(content) || content.startsWith('~/');

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
              <View key={tool.id} style={styles.toolCall}>
                <Text style={styles.toolName}>{tool.name}</Text>
                {tool.output && (
                  <Text style={styles.toolOutput} numberOfLines={3}>
                    {tool.output}
                  </Text>
                )}
              </View>
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
  toolCall: {
    backgroundColor: '#1f2937',
    padding: 8,
    borderRadius: 8,
    marginTop: 4,
  },
  toolName: {
    color: '#a78bfa',
    fontSize: 12,
    fontWeight: '600',
  },
  toolOutput: {
    color: '#9ca3af',
    fontSize: 11,
    marginTop: 4,
  },
});
