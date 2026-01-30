import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  useWindowDimensions,
  ActivityIndicator,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { wsService } from '../services/websocket';
import { parseAnsiText, AnsiSpan } from '../utils/ansiParser';

interface TerminalScreenProps {
  sessionName: string;
  serverHost?: string;
  sshUser?: string;
  onBack: () => void;
}

const DEFAULT_FONT_SIZE = 11;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 20;
const SCROLL_BOTTOM_THRESHOLD = 120;

export function TerminalScreen({ sessionName, serverHost, sshUser, onBack }: TerminalScreenProps) {
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [sshCopied, setSshCopied] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isNearBottomRef = useRef(true);
  const { width: screenWidth } = useWindowDimensions();

  // Build SSH command
  const sshCommand = useMemo(() => {
    if (!serverHost) return null;
    const user = sshUser || 'user';
    return `ssh ${user}@${serverHost} -t 'tmux attach -t ${sessionName}'`;
  }, [serverHost, sshUser, sessionName]);

  const copySshCommand = useCallback(async () => {
    if (!sshCommand) return;
    await Clipboard.setStringAsync(sshCommand);
    setSshCopied(true);
    setTimeout(() => setSshCopied(false), 2000);
  }, [sshCommand]);

  const fetchOutput = useCallback(async () => {
    try {
      const response = await wsService.sendRequest('get_terminal_output', {
        sessionName,
        lines: 150,
      });
      if (response.success && response.payload) {
        const payload = response.payload as { output: string };
        setOutput(payload.output || '');
      }
    } catch {
      // Silently fail on fetch errors during polling
    } finally {
      setLoading(false);
    }
  }, [sessionName]);

  useEffect(() => {
    fetchOutput();
  }, [fetchOutput]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchOutput, 2000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, fetchOutput]);

  // Scroll-position-aware auto-scroll
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    isNearBottomRef.current = distanceFromBottom < SCROLL_BOTTOM_THRESHOLD;
  }, []);

  // Auto-scroll to bottom only when near bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: false });
      }, 50);
    }
  }, [output]);

  // Parse ANSI escape codes into styled spans
  const parsedLines = useMemo(() => parseAnsiText(output), [output]);

  const lineHeight = Math.round(fontSize * 1.45);

  const zoomIn = useCallback(() => {
    setFontSize(s => Math.min(s + 1, MAX_FONT_SIZE));
  }, []);

  const zoomOut = useCallback(() => {
    setFontSize(s => Math.max(s - 1, MIN_FONT_SIZE));
  }, []);

  const renderSpan = useCallback((span: AnsiSpan, index: number, currentFontSize: number) => {
    const style: Record<string, unknown> = {
      fontFamily: 'monospace',
      fontSize: currentFontSize,
    };

    if (span.inverse) {
      style.color = span.bgColor || '#0d1117';
      style.backgroundColor = span.color || '#c9d1d9';
    } else {
      if (span.color) style.color = span.color;
      if (span.bgColor) style.backgroundColor = span.bgColor;
    }

    if (span.bold) style.fontWeight = 'bold';
    if (span.dim) style.opacity = 0.6;
    if (span.underline) style.textDecorationLine = 'underline';

    return (
      <Text key={index} style={style}>
        {span.text}
      </Text>
    );
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>&#8249; Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {sessionName}
        </Text>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={[styles.zoomButton, fontSize <= MIN_FONT_SIZE && styles.zoomButtonDisabled]}
            onPress={zoomOut}
            disabled={fontSize <= MIN_FONT_SIZE}
          >
            <Text style={[styles.zoomButtonText, fontSize <= MIN_FONT_SIZE && styles.zoomButtonTextDisabled]}>-</Text>
          </TouchableOpacity>
          <Text style={styles.zoomLabel}>{fontSize}</Text>
          <TouchableOpacity
            style={[styles.zoomButton, fontSize >= MAX_FONT_SIZE && styles.zoomButtonDisabled]}
            onPress={zoomIn}
            disabled={fontSize >= MAX_FONT_SIZE}
          >
            <Text style={[styles.zoomButtonText, fontSize >= MAX_FONT_SIZE && styles.zoomButtonTextDisabled]}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.refreshToggle, autoRefresh && styles.refreshToggleActive]}
            onPress={() => setAutoRefresh(!autoRefresh)}
          >
            <Text style={[styles.refreshToggleText, autoRefresh && styles.refreshToggleTextActive]}>
              Auto
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* SSH Command Bar */}
      {sshCommand && (
        <TouchableOpacity style={styles.sshBar} onPress={copySshCommand} activeOpacity={0.7}>
          <Text style={styles.sshLabel}>{sshCopied ? 'Copied!' : 'SSH'}</Text>
          <Text style={styles.sshCommand} numberOfLines={1} ellipsizeMode="middle">
            {sshCommand}
          </Text>
        </TouchableOpacity>
      )}

      {loading && !output ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#3b82f6" />
          <Text style={styles.loadingText}>Loading terminal...</Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.terminal}
          contentContainerStyle={styles.terminalContent}
          horizontal={false}
          onScroll={handleScroll}
          scrollEventThrottle={100}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={fetchOutput}
              tintColor="#3b82f6"
            />
          }
        >
          <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
            <View style={{ minWidth: screenWidth - 16 }}>
              {parsedLines.map((spans, lineIdx) => (
                <Text
                  key={lineIdx}
                  style={{
                    color: '#c9d1d9',
                    fontFamily: 'monospace',
                    fontSize,
                    lineHeight,
                  }}
                  selectable
                >
                  {spans.map((span, spanIdx) => renderSpan(span, spanIdx, fontSize))}
                  {'\n'}
                </Text>
              ))}
            </View>
          </ScrollView>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#1f2937',
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  backButton: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    minWidth: 60,
  },
  backButtonText: {
    color: '#3b82f6',
    fontSize: 17,
  },
  headerTitle: {
    color: '#f3f4f6',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
    fontFamily: 'monospace',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  zoomButton: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoomButtonDisabled: {
    opacity: 0.4,
  },
  zoomButtonText: {
    color: '#c9d1d9',
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 18,
  },
  zoomButtonTextDisabled: {
    color: '#6b7280',
  },
  zoomLabel: {
    color: '#9ca3af',
    fontSize: 11,
    fontFamily: 'monospace',
    minWidth: 20,
    textAlign: 'center',
  },
  refreshToggle: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#374151',
    minWidth: 50,
    alignItems: 'center',
    marginLeft: 4,
  },
  refreshToggleActive: {
    backgroundColor: '#1e3a5f',
  },
  refreshToggleText: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '600',
  },
  refreshToggleTextActive: {
    color: '#60a5fa',
  },
  sshBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#161b22',
    borderBottomWidth: 1,
    borderBottomColor: '#21262d',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  sshLabel: {
    color: '#3b82f6',
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: '#1e3a5f',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  sshCommand: {
    color: '#8b949e',
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#0d1117',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#9ca3af',
    fontSize: 14,
    marginTop: 12,
  },
  terminal: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  terminalContent: {
    padding: 8,
    paddingBottom: 40,
  },
});
