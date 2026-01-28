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
}

interface UsageStats {
  sessions: SessionUsage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  periodStart: number;
  periodEnd: number;
}

interface UsageScreenProps {
  onBack: () => void;
}

// Approximate limits (these can be configured)
const SESSION_TOKEN_LIMIT = 200_000; // ~200k context window
const WEEKLY_TOKEN_LIMIT = 5_000_000; // 5M weekly (adjustable)

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

  const getBarColor = (percentage: number): string => {
    if (percentage >= 90) return '#ef4444'; // red
    if (percentage >= 75) return '#f59e0b'; // amber
    return '#22c55e'; // green
  };

  const getWarningLevel = (percentage: number): 'none' | 'warning' | 'critical' => {
    if (percentage >= 90) return 'critical';
    if (percentage >= 75) return 'warning';
    return 'none';
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>Loading usage data...</Text>
      </View>
    );
  }

  const totalTokens = usage ? usage.totalInputTokens + usage.totalOutputTokens : 0;
  const weeklyPercentage = Math.min((totalTokens / WEEKLY_TOKEN_LIMIT) * 100, 100);
  const weeklyWarning = getWarningLevel(weeklyPercentage);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Usage</Text>
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
            <TouchableOpacity style={styles.retryButton} onPress={loadUsage}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : usage ? (
          <>
            {/* Weekly Warning */}
            {weeklyWarning !== 'none' && (
              <View style={[
                styles.warningBanner,
                weeklyWarning === 'critical' ? styles.warningCritical : styles.warningAmber
              ]}>
                <Text style={styles.warningIcon}>
                  {weeklyWarning === 'critical' ? '⚠️' : '⏳'}
                </Text>
                <Text style={styles.warningText}>
                  {weeklyWarning === 'critical'
                    ? `Approaching weekly limit (${weeklyPercentage.toFixed(0)}%)`
                    : `${weeklyPercentage.toFixed(0)}% of weekly limit used`
                  }
                </Text>
              </View>
            )}

            {/* Weekly Usage */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Total Usage</Text>
              <View style={styles.usageCard}>
                <View style={styles.usageHeader}>
                  <Text style={styles.usageLabel}>Total Tokens</Text>
                  <Text style={styles.usageValue}>{formatNumber(totalTokens)}</Text>
                </View>
                <View style={styles.progressBarContainer}>
                  <View
                    style={[
                      styles.progressBar,
                      {
                        width: `${weeklyPercentage}%`,
                        backgroundColor: getBarColor(weeklyPercentage)
                      }
                    ]}
                  />
                </View>
                <Text style={styles.limitText}>
                  {formatNumber(totalTokens)} / {formatNumber(WEEKLY_TOKEN_LIMIT)} weekly limit
                </Text>

                <View style={styles.tokenBreakdown}>
                  <View style={styles.tokenRow}>
                    <View style={[styles.tokenDot, { backgroundColor: '#3b82f6' }]} />
                    <Text style={styles.tokenLabel}>Input</Text>
                    <Text style={styles.tokenValue}>{formatNumber(usage.totalInputTokens)}</Text>
                  </View>
                  <View style={styles.tokenRow}>
                    <View style={[styles.tokenDot, { backgroundColor: '#8b5cf6' }]} />
                    <Text style={styles.tokenLabel}>Output</Text>
                    <Text style={styles.tokenValue}>{formatNumber(usage.totalOutputTokens)}</Text>
                  </View>
                  <View style={styles.tokenRow}>
                    <View style={[styles.tokenDot, { backgroundColor: '#06b6d4' }]} />
                    <Text style={styles.tokenLabel}>Cache Read</Text>
                    <Text style={styles.tokenValue}>{formatNumber(usage.totalCacheReadTokens)}</Text>
                  </View>
                </View>
              </View>
            </View>

            {/* Per-Session Usage */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>By Session</Text>
              {usage.sessions.length === 0 ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>No session data available</Text>
                </View>
              ) : (
                usage.sessions
                  .sort((a, b) => (b.totalInputTokens + b.totalOutputTokens) - (a.totalInputTokens + a.totalOutputTokens))
                  .map((session, index) => {
                    const sessionTotal = session.totalInputTokens + session.totalOutputTokens;
                    const sessionPercentage = Math.min((sessionTotal / SESSION_TOKEN_LIMIT) * 100, 100);
                    const sessionWarning = getWarningLevel(sessionPercentage);

                    return (
                      <View key={session.sessionId || index} style={styles.sessionCard}>
                        <View style={styles.sessionHeader}>
                          <Text style={styles.sessionName} numberOfLines={1}>{session.sessionName}</Text>
                          {sessionWarning !== 'none' && (
                            <Text style={styles.sessionWarningBadge}>
                              {sessionWarning === 'critical' ? '⚠️' : '⏳'}
                            </Text>
                          )}
                        </View>
                        <View style={styles.sessionBarContainer}>
                          <View
                            style={[
                              styles.sessionBar,
                              {
                                width: `${sessionPercentage}%`,
                                backgroundColor: getBarColor(sessionPercentage)
                              }
                            ]}
                          />
                        </View>
                        <View style={styles.sessionStats}>
                          <Text style={styles.sessionStat}>
                            {formatNumber(sessionTotal)} tokens
                          </Text>
                          <Text style={styles.sessionStatDivider}>•</Text>
                          <Text style={styles.sessionStat}>
                            {sessionPercentage.toFixed(0)}% of session limit
                          </Text>
                        </View>
                      </View>
                    );
                  })
              )}
            </View>

            {/* Info Box */}
            <View style={styles.section}>
              <View style={styles.infoBox}>
                <Text style={styles.infoText}>
                  Token counts are from conversation files. Limits are approximate
                  and may vary based on your plan.
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
  contentContainer: {
    paddingBottom: 40,
  },
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
  },
  warningAmber: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1,
    borderColor: '#f59e0b',
  },
  warningCritical: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  warningIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  warningText: {
    color: '#f3f4f6',
    fontSize: 14,
    fontWeight: '500',
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
  usageCard: {
    backgroundColor: '#1f2937',
    borderRadius: 16,
    padding: 20,
  },
  usageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  usageLabel: {
    fontSize: 14,
    color: '#9ca3af',
  },
  usageValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#f3f4f6',
  },
  progressBarContainer: {
    height: 12,
    backgroundColor: '#374151',
    borderRadius: 6,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: 6,
  },
  limitText: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 8,
    textAlign: 'right',
  },
  tokenBreakdown: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#374151',
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  tokenDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  tokenLabel: {
    flex: 1,
    fontSize: 14,
    color: '#9ca3af',
  },
  tokenValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#f3f4f6',
  },
  sessionCard: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  sessionName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#f3f4f6',
    flex: 1,
    marginRight: 8,
  },
  sessionWarningBadge: {
    fontSize: 14,
  },
  sessionBarContainer: {
    height: 8,
    backgroundColor: '#374151',
    borderRadius: 4,
    overflow: 'hidden',
  },
  sessionBar: {
    height: '100%',
    borderRadius: 4,
  },
  sessionStats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  sessionStat: {
    fontSize: 12,
    color: '#6b7280',
  },
  sessionStatDivider: {
    fontSize: 12,
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
