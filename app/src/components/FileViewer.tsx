import React, { useState, useEffect } from 'react';
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
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { wsService } from '../services/websocket';

interface FileViewerProps {
  filePath: string | null;
  onClose: () => void;
}

// File types that should be downloaded instead of viewed
const DOWNLOADABLE_EXTENSIONS = ['apk', 'ipa', 'zip', 'tar.gz', 'tgz'];

export function FileViewer({ filePath, onClose }: FileViewerProps) {
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

  const handleDownload = async () => {
    if (!filePath) return;

    setDownloading(true);
    setDownloadProgress('Requesting file...');
    setError(null);

    try {
      // Request file from daemon
      const response = await wsService.sendRequest('download_file', { path: filePath });

      if (!response.success || !response.payload) {
        throw new Error(response.error || 'Failed to download file');
      }

      const payload = response.payload as {
        fileName: string;
        size: number;
        mimeType: string;
        data: string; // base64
      };

      setDownloadProgress(`Saving ${payload.fileName} (${Math.round(payload.size / 1024 / 1024)}MB)...`);

      // Save to device
      const localUri = `${FileSystem.cacheDirectory}${payload.fileName}`;
      await FileSystem.writeAsStringAsync(localUri, payload.data, {
        encoding: FileSystem.EncodingType.Base64,
      });

      setDownloadProgress(null);

      if (isApk && Platform.OS === 'android') {
        // Trigger install on Android
        Alert.alert(
          'Install APK',
          `${payload.fileName} downloaded. Install now?`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Install',
              onPress: async () => {
                try {
                  // Get content URI for the file
                  const contentUri = await FileSystem.getContentUriAsync(localUri);

                  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
                    data: contentUri,
                    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
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
  };

  if (!filePath) return null;

  // Determine if it's a code file for syntax styling
  const isCode = ['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'css', 'scss', 'json', 'yaml', 'yml', 'toml', 'sh', 'bash', 'zsh'].includes(extension);
  const isMarkdown = ['md', 'mdx', 'markdown'].includes(extension);

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
              <Text style={styles.closeText}>×</Text>
            </TouchableOpacity>
          </View>

          {isDownloadable ? (
            // Download UI for APK and other binary files
            <View style={styles.downloadContainer}>
              <View style={styles.fileIconContainer}>
                <Text style={styles.fileIcon}>{isApk ? '📦' : '📁'}</Text>
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
                  You may need to enable "Install from unknown sources" in settings
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
          ) : (
            <ScrollView
              style={styles.contentScroll}
              horizontal={false}
              showsVerticalScrollIndicator={true}
            >
              <ScrollView
                horizontal={true}
                showsHorizontalScrollIndicator={true}
                contentContainerStyle={styles.horizontalScroll}
              >
                <Text
                  style={[
                    styles.content,
                    isCode && styles.codeContent,
                    isMarkdown && styles.markdownContent,
                  ]}
                  selectable
                >
                  {content}
                </Text>
              </ScrollView>
            </ScrollView>
          )}
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
  horizontalScroll: {
    minWidth: '100%',
  },
  content: {
    padding: 16,
    fontSize: 14,
    lineHeight: 22,
    color: '#e5e7eb',
  },
  codeContent: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 20,
    backgroundColor: '#0d1117',
  },
  markdownContent: {
    fontSize: 14,
    lineHeight: 24,
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
  fileIcon: {
    fontSize: 64,
    marginBottom: 12,
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
