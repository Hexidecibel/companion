import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { ConversationMessage, ConversationHighlight, QuestionOption } from '../types';

interface ConversationItemProps {
  item: ConversationMessage | ConversationHighlight;
  showToolCalls?: boolean;
  onSelectOption?: (option: string) => void;
}

export function ConversationItem({ item, showToolCalls, onSelectOption }: ConversationItemProps) {
  const isUser = item.type === 'user';
  const message = item as ConversationMessage;
  const hasToolCalls = showToolCalls && 'toolCalls' in message && message.toolCalls?.length;
  const hasOptions = 'options' in message && message.options && message.options.length > 0;

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <View style={[styles.container, isUser ? styles.userContainer : styles.assistantContainer]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        <Text style={[styles.role, isUser ? styles.userRole : styles.assistantRole]}>
          {isUser ? 'You' : 'Claude'}
        </Text>
        {isUser ? (
          <Text style={[styles.content, styles.userContent]}>
            {item.content}
          </Text>
        ) : (
          <Markdown style={markdownStyles}>
            {item.content}
          </Markdown>
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
      </View>
    </View>
  );
}

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
    marginBottom: 4,
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
