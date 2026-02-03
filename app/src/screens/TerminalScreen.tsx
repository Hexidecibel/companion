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
  Alert,
  NativeSyntheticEvent,
  NativeScrollEvent,
  TextInput,
  Keyboard,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
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

const POLL_INTERVAL = 2000;
const INTERACTIVE_POLL_INTERVAL = 500;
const KEY_DEBOUNCE_MS = 50;

/** Virtual key definitions for the special key bar */
const VIRTUAL_KEYS: { label: string; key: string }[] = [
  { label: 'Esc', key: 'Escape' },
  { label: 'Tab', key: 'Tab' },
  { label: '\u2191', key: 'Up' },
  { label: '\u2193', key: 'Down' },
  { label: '\u2190', key: 'Left' },
  { label: '\u2192', key: 'Right' },
  { label: 'C-c', key: 'C-c' },
  { label: 'C-d', key: 'C-d' },
  { label: 'C-z', key: 'C-z' },
  { label: 'C-l', key: 'C-l' },
  { label: 'C-a', key: 'C-a' },
  { label: 'C-e', key: 'C-e' },
  { label: 'C-r', key: 'C-r' },
  { label: 'C-u', key: 'C-u' },
  { label: 'C-k', key: 'C-k' },
  { label: 'C-w', key: 'C-w' },
];

export function TerminalScreen({ sessionName, serverHost, sshUser, onBack }: TerminalScreenProps) {
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [sshCopied, setSshCopied] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isNearBottomRef = useRef(true);
  const hiddenInputRef = useRef<TextInput>(null);
  const keyBufferRef = useRef<string[]>([]);
  const keyFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevTextRef = useRef('');
  const { width: screenWidth } = useWindowDimensions();

  // Build SSH command
  const sshCommand = useMemo(() => {
    if (!serverHost) return null;
    const user = sshUser || 'user';
    return `ssh ${user}@${serverHost} -t 'tmux attach -t ${sessionName}'`;
  }, [serverHost, sshUser, sessionName]);

  const copySshCommand = useCallback(async () => {
    if (!sshCommand) return;
    try {
      await Clipboard.setStringAsync(sshCommand);
      setSshCopied(true);
      setTimeout(() => setSshCopied(false), 2000);
    } catch {
      Alert.alert('Copy Failed', sshCommand);
    }
  }, [sshCommand]);

  // Buffer and debounce raw key sends (50ms)
  const sendRawKey = useCallback((key: string) => {
    keyBufferRef.current.push(key);
    if (keyFlushTimerRef.current) clearTimeout(keyFlushTimerRef.current);
    keyFlushTimerRef.current = setTimeout(() => {
      const batch = keyBufferRef.current.splice(0);
      if (batch.length > 0) {
        wsService.sendRequest('send_terminal_keys', {
          sessionName,
          keys: batch,
        }).catch(() => {
          // Silently fail on key send errors
        });
      }
    }, KEY_DEBOUNCE_MS);
  }, [sessionName]);

  // Send a printable character as a raw key
  const sendLiteralChar = useCallback((ch: string) => {
    if (ch === ' ') {
      sendRawKey('Space');
    } else if (/^[a-zA-Z0-9\-+]$/.test(ch)) {
      sendRawKey(ch);
    }
    // Punctuation that fails daemon validation regex is dropped
  }, [sendRawKey]);

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

  // Polling - faster when interactive (500ms vs 2000ms)
  useEffect(() => {
    if (!autoRefresh && !interactive) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    const interval = interactive ? INTERACTIVE_POLL_INTERVAL : POLL_INTERVAL;
    intervalRef.current = setInterval(fetchOutput, interval);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, interactive, fetchOutput]);

  // Handle character input via onChangeText (most reliable cross-platform)
  const handleChangeText = useCallback((text: string) => {
    const prev = prevTextRef.current;
    if (text.length > prev.length) {
      const added = text.slice(prev.length);
      for (const ch of added) {
        sendLiteralChar(ch);
      }
    }
    prevTextRef.current = text;
    // Prevent text accumulation
    if (text.length > 50) {
      prevTextRef.current = '';
      hiddenInputRef.current?.clear();
    }
  }, [sendLiteralChar]);

  // Handle Backspace via onKeyPress (not captured by onChangeText when input is empty)
  const handleKeyPress = useCallback((e: NativeSyntheticEvent<{ key: string }>) => {
    const { key } = e.nativeEvent;
    if (key === 'Backspace') {
      sendRawKey('BSpace');
      if (prevTextRef.current.length > 0) {
        prevTextRef.current = prevTextRef.current.slice(0, -1);
      }
    }
  }, [sendRawKey]);

  // Handle Enter via onSubmitEditing (most reliable for Return key)
  const handleSubmitEditing = useCallback(() => {
    sendRawKey('Enter');
    setTimeout(() => hiddenInputRef.current?.focus(), 50);
  }, [sendRawKey]);

  // Handle virtual key press - send key and refocus input
  const handleVirtualKey = useCallback((key: string) => {
    sendRawKey(key);
    setTimeout(() => hiddenInputRef.current?.focus(), 50);
  }, [sendRawKey]);

  // Focus hidden input when interactive mode is toggled on
  useEffect(() => {
    if (interactive) {
      prevTextRef.current = '';
      setTimeout(() => hiddenInputRef.current?.focus(), 100);
    } else {
      Keyboard.dismiss();
    }
  }, [interactive]);

  // Reset interactive mode when session changes
  useEffect(() => {
    setInteractive(false);
  }, [sessionName]);

  // Cleanup key flush timer on unmount
  useEffect(() => {
    return () => {
      if (keyFlushTimerRef.current) clearTimeout(keyFlushTimerRef.current);
    };
  }, []);

  // Toggle interactive mode
  const toggleInteractive = useCallback(() => {
    setInteractive(prev => {
      if (!prev) {
        setAutoRefresh(true); // Ensure auto-refresh when going interactive
      }
      return !prev;
    });
  }, []);

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
      <LinearGradient colors={['#1a2744', '#1f1a3d']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.header}>
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
            style={[styles.interactiveToggle, interactive && styles.interactiveToggleActive]}
            onPress={toggleInteractive}
          >
            <Text style={[styles.interactiveToggleText, interactive && styles.interactiveToggleTextActive]}>
              Keys
            </Text>
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
      </LinearGradient>

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
          style={[styles.terminal, interactive && styles.terminalInteractive]}
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

      {/* Virtual Key Bar - shown when interactive */}
      {interactive && (
        <View style={styles.keyBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.keyBarContent}
            keyboardShouldPersistTaps="always"
          >
            {VIRTUAL_KEYS.map((vk) => (
              <TouchableOpacity
                key={vk.key}
                style={styles.keyButton}
                onPress={() => handleVirtualKey(vk.key)}
                activeOpacity={0.6}
              >
                <Text style={styles.keyButtonText}>{vk.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Hidden TextInput for keyboard capture */}
      {interactive && (
        <TextInput
          ref={hiddenInputRef}
          style={styles.hiddenInput}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          blurOnSubmit={false}
          onKeyPress={handleKeyPress}
          onChangeText={handleChangeText}
          onSubmitEditing={handleSubmitEditing}
          caretHidden
        />
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
  interactiveToggle: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#374151',
    minWidth: 50,
    alignItems: 'center',
    marginLeft: 4,
  },
  interactiveToggleActive: {
    backgroundColor: '#3b1f6e',
  },
  interactiveToggleText: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '600',
  },
  interactiveToggleTextActive: {
    color: '#c084fc',
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
    backgroundColor: '#1a1f4d',
  },
  refreshToggleText: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '600',
  },
  refreshToggleTextActive: {
    color: '#a78bfa',
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
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: '#7c3aed',
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
  terminalInteractive: {
    borderWidth: 1,
    borderColor: '#8b5cf6',
  },
  terminalContent: {
    padding: 8,
    paddingBottom: 40,
  },
  keyBar: {
    backgroundColor: '#161b22',
    borderTopWidth: 1,
    borderTopColor: '#30363d',
    paddingVertical: 6,
  },
  keyBarContent: {
    paddingHorizontal: 8,
    gap: 6,
  },
  keyButton: {
    backgroundColor: '#2d333b',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#444c56',
  },
  keyButtonText: {
    color: '#c9d1d9',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  hiddenInput: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: 1,
    height: 1,
    opacity: 0,
  },
});
