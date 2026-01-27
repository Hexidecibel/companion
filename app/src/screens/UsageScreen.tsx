import React, { useState, useEffect } from 'react';
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

interface SessionUsage {
  sessionId: string;
  sessionName: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  messageCount: number;
  estimatedCost: number;
}

interface UsageStats {
  sessions: SessionUsage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCost: number;
  periodStart: number;
  periodEnd: number;
}

interface UsageScreenProps {
  onBack: () => void;
}

export function UsageScreen({ onBack }: UsageScreenProps) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadUsage();
  }, []);

  const loadUsage = async () => {
    try {
      setError(null);
      if (!wsService.isConnected()) {
        setError('Not connected to server');
        setLoading(false);
        return;
      }

      const response = await wsService.sendRequest('get_usage');
      if (response.success && response.payload) {
        setUsage(response.payload as UsageStats);
      } else {
        setError(response.error || 'Failed to load usage data');
      }
    } catch (err) {
      setError('Failed to fetch usage statistics');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    loadUsage();
  };

  const formatNumber = (num: number): string => {
    if (num >= 1_000_000) {
      return (num / 1_000_000).toFixed(2) + 'M';
    }
    if (num >= 1_000) {
      return (num / 1_000).toFixed(1) + 'K';
    }
    return num.toLocaleString();
  };

  const formatCost = (cost: number): string => {
    return '$' + cost.toFixed(4);
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>Loading usage data...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Usage Statistics</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.content}
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
            <TouchableOpacity style={styles.retryButton} onPress={loadUsage}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : usage ? (
          <>
            {/* Total Summary Card */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Total Usage</Text>
              <View style={styles.summaryCard}>
                <View style={styles.costRow}>
                  <Text style={styles.costLabel}>Estimated Cost</Text>
                  <Text style={styles.costValue}>{formatCost(usage.totalEstimatedCost)}</Text>
                </View>
                <View style={styles.divider} />
                <View style={styles.statsGrid}>
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{formatNumber(usage.totalInputTokens)}</Text>
                    <Text style={styles.statLabel}>Input Tokens</Text>
                  </View>
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{formatNumber(usage.totalOutputTokens)}</Text>
                    <Text style={styles.statLabel}>Output Tokens</Text>
                  </View>
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{formatNumber(usage.totalCacheReadTokens)}</Text>
                    <Text style={styles.statLabel}>Cache Read</Text>
                  </View>
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{formatNumber(usage.totalCacheCreationTokens)}</Text>
                    <Text style={styles.statLabel}>Cache Write</Text>
                  </View>
                </View>
              </View>
            </View>

            {/* Per-Session Breakdown */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>By Session</Text>
              {usage.sessions.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>No session data available</Text>
                </View>
              ) : (
                usage.sessions
                  .sort((a, b) => b.estimatedCost - a.estimatedCost)
                  .map((session, index) => (
                    <View key={session.sessionId || index} style={styles.sessionCard}>
                      <View style={styles.sessionHeader}>
                        <Text style={styles.sessionName}>{session.sessionName}</Text>
                        <Text style={styles.sessionCost}>{formatCost(session.estimatedCost)}</Text>
                      </View>
                      <View style={styles.sessionStats}>
                        <Text style={styles.sessionStat}>
                          {formatNumber(session.totalInputTokens)} in
                        </Text>
                        <Text style={styles.sessionStatDivider}>•</Text>
                        <Text style={styles.sessionStat}>
                          {formatNumber(session.totalOutputTokens)} out
                        </Text>
                        <Text style={styles.sessionStatDivider}>•</Text>
                        <Text style={styles.sessionStat}>
                          {session.messageCount} msgs
                        </Text>
                      </View>
                    </View>
                  ))
              )}
            </View>

            {/* Info Box */}
            <View style={styles.section}>
              <View style={styles.infoBox}>
                <Text style={styles.infoText}>
                  Usage is calculated from conversation files on the server. Costs are
                  estimates based on current Claude API pricing and may not reflect
                  actual billing.
                </Text>
              </View>
            </View>
          </>
        ) : (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyText}>No usage data available</Text>
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
  section: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#9ca3af',
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  summaryCard: {
    backgroundColor: '#1f2937',
    borderRadius: 16,
    padding: 20,
  },
  costRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  costLabel: {
    fontSize: 16,
    color: '#9ca3af',
  },
  costValue: {
    fontSize: 28,
    fontWeight: '700',
    color: '#22c55e',
  },
  divider: {
    height: 1,
    backgroundColor: '#374151',
    marginVertical: 16,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -8,
  },
  statItem: {
    width: '50%',
    paddingHorizontal: 8,
    marginBottom: 12,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '600',
    color: '#f3f4f6',
    marginBottom: 2,
  },
  statLabel: {
    fontSize: 12,
    color: '#6b7280',
  },
  sessionCard: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  sessionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sessionName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f3f4f6',
    flex: 1,
    marginRight: 12,
  },
  sessionCost: {
    fontSize: 16,
    fontWeight: '600',
    color: '#22c55e',
  },
  sessionStats: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sessionStat: {
    fontSize: 13,
    color: '#6b7280',
  },
  sessionStatDivider: {
    fontSize: 13,
    color: '#4b5563',
    marginHorizontal: 8,
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
    padding: 24,
    borderRadius: 12,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
  },
  infoBox: {
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#3b82f6',
  },
  infoText: {
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 18,
  },
});
