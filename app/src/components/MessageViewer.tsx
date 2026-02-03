import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import Markdown from '@ronradtke/react-native-markdown-display';
import { scaledFont } from '../theme/fonts';

interface MessageViewerProps {
  content: string | null;
  timestamp?: number;
  onClose: () => void;
  fontScale?: number;
}

export function MessageViewer({ content, timestamp, onClose, fontScale = 1 }: MessageViewerProps) {
  if (!content) return null;

  const formatTime = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const scaledStyles = useMemo(() => {
    if (fontScale === 1) return markdownStyles;
    return StyleSheet.create({
      ...markdownStyles,
      body: {
        ...markdownStyles.body,
        fontSize: scaledFont(15, fontScale),
        lineHeight: scaledFont(24, fontScale),
      },
      heading1: {
        ...markdownStyles.heading1,
        fontSize: scaledFont(22, fontScale),
      },
      heading2: {
        ...markdownStyles.heading2,
        fontSize: scaledFont(18, fontScale),
      },
      heading3: {
        ...markdownStyles.heading3,
        fontSize: scaledFont(16, fontScale),
      },
      code_inline: {
        ...markdownStyles.code_inline,
        fontSize: scaledFont(13, fontScale),
      },
      code_block: {
        ...markdownStyles.code_block,
        fontSize: scaledFont(13, fontScale),
        lineHeight: scaledFont(20, fontScale),
      },
    });
  }, [fontScale]);

  return (
    <Modal
      visible={!!content}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <View style={styles.headerInfo}>
              <Text style={styles.headerTitle}>Assistant</Text>
              {timestamp && (
                <Text style={styles.headerTime}>{formatTime(timestamp)}</Text>
              )}
            </View>
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <Text style={styles.closeText}>×</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.contentScroll}
            contentContainerStyle={styles.contentContainer}
          >
            <Markdown style={scaledStyles}>
              {content}
            </Markdown>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const markdownStyles = StyleSheet.create({
  body: {
    color: '#f3f4f6',
    fontSize: 15,
    lineHeight: 24,
  },
  heading1: {
    color: '#f3f4f6',
    fontSize: 22,
    fontWeight: 'bold',
    marginTop: 16,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
    paddingBottom: 8,
  },
  heading2: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 14,
    marginBottom: 6,
  },
  heading3: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 12,
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
    marginVertical: 8,
  },
  ordered_list: {
    marginVertical: 8,
  },
  list_item: {
    marginVertical: 4,
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
    padding: 16,
    borderRadius: 8,
    marginVertical: 12,
  },
  code_block: {
    color: '#e5e7eb',
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 20,
  },
  blockquote: {
    backgroundColor: '#1f2937',
    borderLeftWidth: 4,
    borderLeftColor: '#3b82f6',
    paddingLeft: 16,
    paddingVertical: 8,
    marginVertical: 12,
  },
  link: {
    color: '#60a5fa',
    textDecorationLine: 'underline',
  },
  hr: {
    backgroundColor: '#4b5563',
    height: 1,
    marginVertical: 16,
  },
  paragraph: {
    marginVertical: 8,
  },
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
  },
  container: {
    flex: 1,
    marginTop: 50,
    backgroundColor: '#111827',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
    backgroundColor: '#1f2937',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  headerInfo: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#f3f4f6',
  },
  headerTime: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  closeButton: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeText: {
    fontSize: 32,
    color: '#9ca3af',
    lineHeight: 32,
  },
  contentScroll: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
});
