import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import Markdown from '@ronradtke/react-native-markdown-display';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { wsService } from '../services/websocket';

interface FileViewerProps {
  filePath: string | null;
  onClose: () => void;
  onFileTap?: (path: string) => void;
}

// File types that should be downloaded instead of viewed
const DOWNLOADABLE_EXTENSIONS = ['apk', 'ipa', 'zip', 'tar.gz', 'tgz'];

function classifyContent(fileName: string, content: string): 'markdown' | 'diff' | 'code' {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'markdown';
  if (ext === 'diff' || ext === 'patch') return 'diff';
  if (content.startsWith('diff --git ') || content.startsWith('--- a/') || content.startsWith('Index: ')) return 'diff';
  return 'code';
}

function DiffLine({ line }: { line: string }) {
  let color = '#e5e7eb';
  let bg = 'transparent';
  if (line.startsWith('@@')) { color = '#93c5fd'; bg = 'rgba(59, 130, 246, 0.1)'; }
  else if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('Index: ')) { color = '#9ca3af'; }
  else if (line.startsWith('+')) { color = '#86efac'; bg = 'rgba(16, 185, 129, 0.1)'; }
  else if (line.startsWith('-')) { color = '#fca5a5'; bg = 'rgba(239, 68, 68, 0.1)'; }

  return (
    <Text style={[diffStyles.line, { color, backgroundColor: bg }]}>{line || ' '}</Text>
  );
}

const diffStyles = StyleSheet.create({
  line: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 12,
  },
});

function CodeView({ content }: { content: string }) {
  const lines = content.split('\n');
  const gutterWidth = String(lines.length).length * 9 + 16;

  return (
    <View style={codeStyles.container}>
      {lines.map((line, i) => (
        <View key={i} style={codeStyles.row}>
          <Text style={[codeStyles.lineNum, { width: gutterWidth }]}>{i + 1}</Text>
          <Text style={codeStyles.lineContent} selectable>{line || ' '}</Text>
        </View>
      ))}
    </View>
  );
}

const codeStyles = StyleSheet.create({
  container: {
    backgroundColor: '#0d1117',
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
  },
  lineNum: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 18,
    color: '#4b5563',
    textAlign: 'right',
    paddingRight: 8,
    paddingLeft: 8,
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  lineContent: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    color: '#e5e7eb',
    paddingRight: 12,
  },
});

const mdStyles = StyleSheet.create({
  body: { color: '#e5e7eb', fontSize: 14, lineHeight: 22 },
  heading1: { color: '#f3f4f6', fontSize: 22, fontWeight: '700', marginTop: 16, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: '#374151', paddingBottom: 6 },
  heading2: { color: '#f3f4f6', fontSize: 18, fontWeight: '600', marginTop: 14, marginBottom: 6, borderBottomWidth: 1, borderBottomColor: '#374151', paddingBottom: 4 },
  heading3: { color: '#f3f4f6', fontSize: 16, fontWeight: '600', marginTop: 12, marginBottom: 4 },
  heading4: { color: '#f3f4f6', fontSize: 14, fontWeight: '600', marginTop: 10, marginBottom: 4 },
  paragraph: { marginTop: 4, marginBottom: 4 },
  strong: { fontWeight: '700', color: '#f3f4f6' },
  em: { fontStyle: 'italic' },
  code_inline: { fontFamily: 'monospace', backgroundColor: '#1f2937', color: '#e5e7eb', paddingHorizontal: 4, borderRadius: 3, fontSize: 13 },
  code_block: { fontFamily: 'monospace', backgroundColor: '#0d1117', color: '#e5e7eb', padding: 12, borderRadius: 6, fontSize: 12, lineHeight: 18, marginVertical: 6 },
  fence: { fontFamily: 'monospace', backgroundColor: '#0d1117', color: '#e5e7eb', padding: 12, borderRadius: 6, fontSize: 12, lineHeight: 18, marginVertical: 6 },
  blockquote: { borderLeftWidth: 3, borderLeftColor: '#4b5563', paddingLeft: 12, marginVertical: 6 },
  link: { color: '#60a5fa' },
  list_item: { marginVertical: 2 },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  table: { borderWidth: 1, borderColor: '#374151', marginVertical: 8 },
  th: { borderWidth: 1, borderColor: '#374151', padding: 6, backgroundColor: '#1f2937' },
  td: { borderWidth: 1, borderColor: '#374151', padding: 6 },
  hr: { backgroundColor: '#374151', height: 1, marginVertical: 12 },
});

export function FileViewer({ filePath, onClose, onFileTap }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<string | null>(null);

  const fileName = filePath?.split('/').pop() || '';
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  const isDownloadable = DOWNLOADABLE_EXTENSIONS.some(ext =>
    fileName.toLowerCase().endsWith(`.${ext}`) || extension === ext
  );
  const isApk = extension === 'apk';

  useEffect(() => {
    if (!filePath) {
      setContent(null);
      setError(null);
      return;
    }

    // Don't auto-load downloadable files
    if (isDownloadable) {
      setContent(null);
      setError(null);
      setLoading(false);
      return;
    }

    const loadFile = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await wsService.sendRequest('read_file', { path: filePath });
        if (response.success && response.payload) {
          const payload = response.payload as { content: string };
          setContent(payload.content);
        } else {
          setError(response.error || 'Failed to load file');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file');
      } finally {
        setLoading(false);
      }
    };

    loadFile();
  }, [filePath, isDownloadable]);

  const handleDownload = useCallback(async () => {
    if (!filePath) return;

    setDownloading(true);
    setDownloadProgress('Requesting file...');
    setError(null);

    try {
      const response = await wsService.sendRequest('download_file', { path: filePath });

      if (!response.success || !response.payload) {
        throw new Error(response.error || 'Failed to download file');
      }

      const payload = response.payload as {
        fileName: string;
        size: number;
        mimeType: string;
        data: string;
      };

      setDownloadProgress(`Saving ${payload.fileName} (${Math.round(payload.size / 1024 / 1024)}MB)...`);

      const localUri = `${FileSystem.cacheDirectory}${payload.fileName}`;
      await FileSystem.writeAsStringAsync(localUri, payload.data, {
        encoding: FileSystem.EncodingType.Base64,
      });

      setDownloadProgress(null);

      if (isApk && Platform.OS === 'android') {
        Alert.alert(
          'Install APK',
          `${payload.fileName} downloaded. Install now?`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Install',
              onPress: async () => {
                try {
                  const contentUri = await FileSystem.getContentUriAsync(localUri);
                  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
                    data: contentUri,
                    flags: 1,
                    type: 'application/vnd.android.package-archive',
                  });
                } catch (installErr) {
                  Alert.alert('Install Error', String(installErr));
                }
              },
            },
          ]
        );
      } else {
        Alert.alert('Downloaded', `File saved to cache:\n${localUri}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  }, [filePath, isApk]);

  if (!filePath) return null;

  const contentType = content ? classifyContent(fileName, content) : 'code';

  const handleLinkPress = (url: string) => {
    if (onFileTap && !url.startsWith('http')) {
      onFileTap(url);
      return false;
    }
    return true;
  };

  return (
    <Modal
      visible={!!filePath}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <View style={styles.headerInfo}>
              <Text style={styles.fileName} numberOfLines={1}>
                {fileName}
              </Text>
              <Text style={styles.filePath} numberOfLines={1}>
                {filePath}
              </Text>
            </View>
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <Text style={styles.closeText}>{'\u00D7'}</Text>
            </TouchableOpacity>
          </View>

          {isDownloadable ? (
            <View style={styles.downloadContainer}>
              <View style={styles.fileIconContainer}>
                <Text style={styles.fileTypeLabel}>
                  {isApk ? 'Android Package' : extension.toUpperCase()}
                </Text>
              </View>

              {error ? (
                <View style={styles.downloadError}>
                  <Text style={styles.errorText}>{error}</Text>
                  <TouchableOpacity
                    style={styles.retryButton}
                    onPress={handleDownload}
                  >
                    <Text style={styles.retryButtonText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : downloading ? (
                <View style={styles.downloadingState}>
                  <ActivityIndicator size="large" color="#3b82f6" />
                  <Text style={styles.downloadingText}>
                    {downloadProgress || 'Downloading...'}
                  </Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.downloadButton}
                  onPress={handleDownload}
                >
                  <Text style={styles.downloadButtonText}>
                    {isApk && Platform.OS === 'android' ? 'Download & Install' : 'Download'}
                  </Text>
                </TouchableOpacity>
              )}

              {isApk && Platform.OS === 'android' && (
                <Text style={styles.installHint}>
                  You may need to enable &quot;Install from unknown sources&quot; in settings
                </Text>
              )}
            </View>
          ) : loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#3b82f6" />
              <Text style={styles.loadingText}>Loading file...</Text>
            </View>
          ) : error ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : content !== null ? (
            <ScrollView style={styles.contentScroll} showsVerticalScrollIndicator>
              {contentType === 'markdown' ? (
                <View style={styles.markdownWrap}>
                  <Markdown style={mdStyles} onLinkPress={handleLinkPress}>
                    {content}
                  </Markdown>
                </View>
              ) : contentType === 'diff' ? (
                <ScrollView horizontal showsHorizontalScrollIndicator>
                  <View style={styles.diffWrap}>
                    {content.split('\n').map((line, i) => (
                      <DiffLine key={i} line={line} />
                    ))}
                  </View>
                </ScrollView>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator>
                  <CodeView content={content} />
                </ScrollView>
              )}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

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
    marginRight: 12,
  },
  fileName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f3f4f6',
  },
  filePath: {
    fontSize: 11,
    color: '#6b7280',
    marginTop: 2,
    fontFamily: 'monospace',
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
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    color: '#9ca3af',
    fontSize: 14,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  errorText: {
    color: '#f87171',
    fontSize: 14,
    textAlign: 'center',
  },
  contentScroll: {
    flex: 1,
  },
  markdownWrap: {
    padding: 16,
  },
  diffWrap: {
    paddingVertical: 8,
    minWidth: '100%',
  },
  // Download UI styles
  downloadContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  fileIconContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  fileTypeLabel: {
    color: '#9ca3af',
    fontSize: 14,
    fontWeight: '500',
  },
  downloadButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 12,
    minWidth: 200,
    alignItems: 'center',
  },
  downloadButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  downloadingState: {
    alignItems: 'center',
  },
  downloadingText: {
    color: '#9ca3af',
    fontSize: 14,
    marginTop: 16,
    textAlign: 'center',
  },
  downloadError: {
    alignItems: 'center',
  },
  retryButton: {
    marginTop: 16,
    backgroundColor: '#374151',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#f3f4f6',
    fontSize: 14,
    fontWeight: '500',
  },
  installHint: {
    color: '#6b7280',
    fontSize: 12,
    marginTop: 24,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
});
