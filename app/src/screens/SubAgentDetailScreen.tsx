import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { ConversationItem } from '../components/ConversationItem';
import { SubAgent, ConversationHighlight } from '../types';
import { wsService } from '../services/websocket';

interface SubAgentDetailScreenProps {
  agentId: string;
  initialAgent?: SubAgent;
  onBack: () => void;
}

function formatDuration(startMs: number, endMs?: number): string {
  const end = endMs || Date.now();
  const durationMs = end - startMs;
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function SubAgentDetailScreen({ agentId, initialAgent, onBack }: SubAgentDetailScreenProps) {
  const [agent, setAgent] = useState<SubAgent | null>(initialAgent || null);
  const [highlights, setHighlights] = useState<ConversationHighlight[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollViewRef = useRef<ScrollView>(null);

  const fetchDetail = useCallback(async () => {
    try {
      const response = await wsService.sendRequest('get_agent_detail', { agentId });
      if (response.success && response.payload) {
        const detail = response.payload as { agent: SubAgent; highlights: ConversationHighlight[] };
        setAgent(detail.agent);
        setHighlights(detail.highlights);
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  // Initial fetch + auto-refresh while running
  useEffect(() => {
    fetchDetail();

    const interval = setInterval(() => {
      fetchDetail();
    }, 3000);

    return () => clearInterval(interval);
  }, [fetchDetail]);

  const isRunning = agent?.status === 'running';

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>{'< Back'}</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {agent?.slug || agent?.agentId?.slice(0, 8) || 'Agent'}
          </Text>
          <View style={styles.headerStatusRow}>
            <View
              style={[styles.statusDot, { backgroundColor: isRunning ? '#22c55e' : '#3b82f6' }]}
            />
            <Text style={styles.headerStatus}>
              {isRunning ? 'Running' : 'Completed'}
              {agent ? ` · ${formatDuration(agent.startedAt, agent.completedAt)}` : ''}
            </Text>
          </View>
        </View>
        <View style={styles.placeholder} />
      </View>

      {/* Description */}
      {agent?.description && (
        <View style={styles.descriptionBar}>
          <Text style={styles.descriptionText} numberOfLines={3}>
            {agent.description}
          </Text>
        </View>
      )}

      {/* Conversation */}
      {loading && highlights.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#3b82f6" />
          <Text style={styles.loadingText}>Loading agent conversation...</Text>
        </View>
      ) : highlights.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No conversation data available</Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollViewRef}
          style={styles.conversationList}
          contentContainerStyle={styles.conversationContent}
          onContentSizeChange={() => {
            scrollViewRef.current?.scrollToEnd({ animated: false });
          }}
        >
          {highlights.map((item) => (
            <ConversationItem key={item.id} item={item} showToolCalls={true} />
          ))}
          {isRunning && (
            <View style={styles.runningIndicator}>
              <ActivityIndicator size="small" color="#22c55e" />
              <Text style={styles.runningText}>Agent is working...</Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
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
    fontSize: 16,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: '600',
  },
  headerStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  headerStatus: {
    color: '#9ca3af',
    fontSize: 12,
  },
  placeholder: {
    minWidth: 60,
  },
  descriptionBar: {
    backgroundColor: '#1a2332',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  descriptionText: {
    color: '#9ca3af',
    fontSize: 13,
    lineHeight: 18,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#9ca3af',
    fontSize: 14,
    marginTop: 12,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: '#6b7280',
    fontSize: 14,
  },
  conversationList: {
    flex: 1,
  },
  conversationContent: {
    paddingVertical: 8,
  },
  runningIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  runningText: {
    color: '#22c55e',
    fontSize: 13,
    marginLeft: 8,
    fontStyle: 'italic',
  },
});
