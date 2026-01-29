import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { wsService } from '../services/websocket';

interface TerminalScreenProps {
  sessionName: string;
  onBack: () => void;
}

export function TerminalScreen({ sessionName, onBack }: TerminalScreenProps) {
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const scrollRef = useRef<ScrollView>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Auto-scroll to bottom when output changes
  useEffect(() => {
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 50);
  }, [output]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>&#8249; Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {sessionName}
        </Text>
        <TouchableOpacity
          style={[styles.refreshToggle, autoRefresh && styles.refreshToggleActive]}
          onPress={() => setAutoRefresh(!autoRefresh)}
        >
          <Text style={[styles.refreshToggleText, autoRefresh && styles.refreshToggleTextActive]}>
            Auto
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.terminal}
        contentContainerStyle={styles.terminalContent}
        horizontal={false}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={fetchOutput}
            tintColor="#3b82f6"
          />
        }
      >
        <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
          <Text style={styles.terminalText} selectable>
            {output || (loading ? 'Loading...' : 'No output')}
          </Text>
        </ScrollView>
      </ScrollView>
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
  refreshToggle: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#374151',
    minWidth: 50,
    alignItems: 'center',
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
  terminal: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  terminalContent: {
    padding: 8,
    paddingBottom: 40,
  },
  terminalText: {
    color: '#c9d1d9',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
});
