import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { wsService } from '../services/websocket';

interface SubAgent {
  agentId: string;
  slug: string;
  sessionId: string;
  status: 'running' | 'completed' | 'error';
  startedAt: number;
  completedAt?: number;
  description?: string;
  subagentType?: string;
  messageCount: number;
  lastActivity: number;
  currentActivity?: string;
}

interface AgentTree {
  sessionId: string;
  agents: SubAgent[];
  totalAgents: number;
  runningCount: number;
  completedCount: number;
}

interface AgentTreeScreenProps {
  onBack: () => void;
  sessionId?: string;
}

export function AgentTreeScreen({ onBack, sessionId }: AgentTreeScreenProps) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tree, setTree] = useState<AgentTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  const loadAgentTree = useCallback(async () => {
    try {
      setError(null);
      if (!wsService.isConnected()) {
        setError('Not connected to server');
        setLoading(false);
        return;
      }

      const response = await wsService.sendRequest('get_agent_tree', { sessionId });
      if (response.success && response.payload) {
        setTree(response.payload as AgentTree);
      } else {
        setError(response.error || 'Failed to load agent tree');
      }
    } catch (err) {
      setError('Failed to fetch agent data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadAgentTree();

    // Refresh every 5 seconds while viewing
    const interval = setInterval(loadAgentTree, 5000);
    return () => clearInterval(interval);
  }, [loadAgentTree]);

  const onRefresh = () => {
    setRefreshing(true);
    loadAgentTree();
  };

  const toggleExpanded = (agentId: string) => {
    setExpandedAgents(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  const formatTimestamp = (ts: number): string => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDuration = (start: number, end?: number): string => {
    const endTime = end || Date.now();
    const seconds = Math.floor((endTime - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  };

  const getStatusColor = (status: SubAgent['status']): string => {
    switch (status) {
      case 'running': return '#22c55e';
      case 'completed': return '#3b82f6';
      case 'error': return '#ef4444';
      default: return '#6b7280';
    }
  };

  const getStatusIcon = (status: SubAgent['status']): string => {
    switch (status) {
      case 'running': return '●';
      case 'completed': return '✓';
      case 'error': return '✕';
      default: return '○';
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>Loading agents...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Sub-Agents</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#3b82f6"
          />
        }
      >
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={loadAgentTree}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : tree ? (
          <>
            {/* Summary */}
            <View style={styles.summaryBar}>
              <View style={styles.summaryItem}>
                <Text style={styles.summaryValue}>{tree.totalAgents}</Text>
                <Text style={styles.summaryLabel}>Total</Text>
              </View>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryValue, { color: '#22c55e' }]}>
                  {tree.runningCount}
                </Text>
                <Text style={styles.summaryLabel}>Running</Text>
              </View>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryValue, { color: '#3b82f6' }]}>
                  {tree.completedCount}
                </Text>
                <Text style={styles.summaryLabel}>Done</Text>
              </View>
            </View>

            {/* Agent List */}
            <View style={styles.section}>
              {tree.agents.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyIcon}>🤖</Text>
                  <Text style={styles.emptyTitle}>No Sub-Agents</Text>
                  <Text style={styles.emptyText}>
                    Sub-agents appear when background tasks are spawned
                  </Text>
                </View>
              ) : (
                tree.agents.map((agent) => {
                  const isExpanded = expandedAgents.has(agent.agentId);

                  return (
                    <TouchableOpacity
                      key={agent.agentId}
                      style={styles.agentCard}
                      onPress={() => toggleExpanded(agent.agentId)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.agentHeader}>
                        <Text style={[styles.statusIcon, { color: getStatusColor(agent.status) }]}>
                          {getStatusIcon(agent.status)}
                        </Text>
                        <View style={styles.agentInfo}>
                          <Text style={styles.agentSlug} numberOfLines={1}>
                            {agent.slug || agent.agentId}
                          </Text>
                          <Text style={styles.agentMeta}>
                            {agent.status === 'running'
                              ? `Running for ${formatDuration(agent.startedAt)}`
                              : `Completed in ${formatDuration(agent.startedAt, agent.completedAt)}`
                            }
                            {' • '}{agent.messageCount} msgs
                          </Text>
                        </View>
                        <Text style={styles.expandIcon}>{isExpanded ? '▼' : '▶'}</Text>
                      </View>

                      {isExpanded && (
                        <View style={styles.agentDetails}>
                          {agent.description && (
                            <View style={styles.detailRow}>
                              <Text style={styles.detailLabel}>Task:</Text>
                              <Text style={styles.detailValue} numberOfLines={3}>
                                {agent.description}
                              </Text>
                            </View>
                          )}
                          {agent.currentActivity && (
                            <View style={styles.detailRow}>
                              <Text style={styles.detailLabel}>Activity:</Text>
                              <Text style={styles.detailValue} numberOfLines={2}>
                                {agent.currentActivity}
                              </Text>
                            </View>
                          )}
                          <View style={styles.detailRow}>
                            <Text style={styles.detailLabel}>Started:</Text>
                            <Text style={styles.detailValue}>
                              {formatTimestamp(agent.startedAt)}
                            </Text>
                          </View>
                          {agent.completedAt && (
                            <View style={styles.detailRow}>
                              <Text style={styles.detailLabel}>Finished:</Text>
                              <Text style={styles.detailValue}>
                                {formatTimestamp(agent.completedAt)}
                              </Text>
                            </View>
                          )}
                          <View style={styles.detailRow}>
                            <Text style={styles.detailLabel}>Agent ID:</Text>
                            <Text style={[styles.detailValue, styles.agentId]}>
                              {agent.agentId}
                            </Text>
                          </View>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })
              )}
            </View>

            {/* Info */}
            <View style={styles.section}>
              <View style={styles.infoBox}>
                <Text style={styles.infoText}>
                  Sub-agents are spawned when the Task tool is used to run background work.
                  Tap an agent to see more details.
                </Text>
              </View>
            </View>
          </>
        ) : (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>No agent data available</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111827',
  },
  loadingText: {
    color: '#9ca3af',
    fontSize: 16,
    marginTop: 12,
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
    fontSize: 17,
    fontWeight: '600',
  },
  placeholder: {
    minWidth: 60,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 40,
  },
  summaryBar: {
    flexDirection: 'row',
    backgroundColor: '#1f2937',
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    padding: 16,
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  summaryValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#f3f4f6',
  },
  summaryLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  summaryDivider: {
    width: 1,
    backgroundColor: '#374151',
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  agentCard: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  agentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusIcon: {
    fontSize: 18,
    marginRight: 12,
    width: 20,
    textAlign: 'center',
  },
  agentInfo: {
    flex: 1,
  },
  agentSlug: {
    fontSize: 15,
    fontWeight: '600',
    color: '#f3f4f6',
  },
  agentMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  expandIcon: {
    fontSize: 12,
    color: '#6b7280',
    marginLeft: 8,
  },
  agentDetails: {
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#374151',
  },
  detailRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  detailLabel: {
    fontSize: 13,
    color: '#6b7280',
    width: 70,
  },
  detailValue: {
    fontSize: 13,
    color: '#d1d5db',
    flex: 1,
  },
  agentId: {
    fontFamily: 'monospace',
    fontSize: 12,
  },
  errorBox: {
    margin: 16,
    padding: 20,
    backgroundColor: '#7f1d1d',
    borderRadius: 12,
    alignItems: 'center',
  },
  errorText: {
    fontSize: 16,
    color: '#fecaca',
    marginBottom: 12,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: '#dc2626',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  emptyBox: {
    backgroundColor: '#1f2937',
    padding: 32,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#f3f4f6',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
  },
  infoBox: {
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#8b5cf6',
    marginBottom: 24,
  },
  infoText: {
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 18,
  },
});
