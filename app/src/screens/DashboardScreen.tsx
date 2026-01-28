import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Server, ServerStatus, SessionSummary } from '../types';
import { getServers } from '../services/storage';
import { useMultiServerStatus } from '../hooks/useMultiServerStatus';

interface DashboardScreenProps {
  onSelectServer: (server: Server, sessionId?: string) => void;
  onManageServers: () => void;
  onOpenSetup: () => void;
}

function SessionStatusIcon({ status }: { status: SessionSummary['status'] }) {
  switch (status) {
    case 'waiting':
      return <Text style={styles.statusIcon}>⏳</Text>;
    case 'working':
      return <Text style={styles.statusIcon}>🔄</Text>;
    case 'idle':
      return <Text style={styles.statusIcon}>✅</Text>;
    case 'error':
      return <Text style={styles.statusIcon}>❌</Text>;
    default:
      return <Text style={styles.statusIcon}>⚪</Text>;
  }
}

// Sort sessions: waiting first, then working, then idle/error
function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  const priority: Record<SessionSummary['status'], number> = {
    waiting: 0,
    working: 1,
    idle: 2,
    error: 3,
  };
  return [...sessions].sort((a, b) => {
    const priorityDiff = priority[a.status] - priority[b.status];
    if (priorityDiff !== 0) return priorityDiff;
    // Within same status, sort by most recent activity
    return b.lastActivity - a.lastActivity;
  });
}

// Format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins}m ago`;
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }
  const days = Math.floor(diff / 86400000);
  return `${days}d ago`;
}

function ServerCard({
  server,
  status,
  onPress,
  onSessionPress,
}: {
  server: Server;
  status: ServerStatus;
  onPress: () => void;
  onSessionPress: (sessionId: string) => void;
}) {
  const connectionColor = status.connected
    ? '#10b981'
    : status.connecting
    ? '#f59e0b'
    : '#ef4444';

  return (
    <TouchableOpacity
      style={styles.serverCard}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <View style={styles.serverHeader}>
        <View style={[styles.connectionDot, { backgroundColor: connectionColor }]} />
        <Text style={styles.serverName}>{server.name}</Text>
        {status.summary && status.summary.waitingCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{status.summary.waitingCount}</Text>
          </View>
        )}
      </View>

      {status.connecting && (
        <View style={styles.statusRow}>
          <ActivityIndicator size="small" color="#60a5fa" />
          <Text style={styles.statusText}>Connecting...</Text>
        </View>
      )}

      {status.error && !status.connecting && (
        <Text style={styles.errorText}>{status.error}</Text>
      )}

      {status.connected && status.summary && (
        <View style={styles.sessionsContainer}>
          {status.summary.sessions.length === 0 ? (
            <Text style={styles.noSessionsText}>No active sessions</Text>
          ) : (
            sortSessions(status.summary.sessions).slice(0, 5).map((session) => (
              <TouchableOpacity
                key={session.id}
                style={styles.sessionRow}
                onPress={() => onSessionPress(session.id)}
                activeOpacity={0.7}
              >
                <SessionStatusIcon status={session.status} />
                <View style={styles.sessionInfo}>
                  <View style={styles.sessionHeader}>
                    <Text style={styles.sessionName} numberOfLines={1}>
                      {session.name}
                    </Text>
                    <Text style={styles.sessionTime}>
                      {formatRelativeTime(session.lastActivity)}
                    </Text>
                  </View>
                  <Text style={styles.sessionPath} numberOfLines={1}>
                    {session.projectPath}
                  </Text>
                  {session.currentActivity && (
                    <Text style={styles.sessionActivity} numberOfLines={1}>
                      {session.currentActivity}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            ))
          )}
          {status.summary.sessions.length > 5 && (
            <Text style={styles.moreText}>
              +{status.summary.sessions.length - 5} more
            </Text>
          )}
        </View>
      )}

      {!status.connected && !status.connecting && !status.error && (
        <Text style={styles.disconnectedText}>Tap to connect</Text>
      )}
    </TouchableOpacity>
  );
}

export function DashboardScreen({
  onSelectServer,
  onManageServers,
  onOpenSetup,
}: DashboardScreenProps) {
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const {
    statuses,
    totalWaiting,
    totalWorking,
    connectedCount,
    refreshAll,
  } = useMultiServerStatus(servers);

  const loadServers = useCallback(async () => {
    const loaded = await getServers();
    setServers(loaded);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadServers();
    refreshAll();
    setRefreshing(false);
  }, [loadServers, refreshAll]);

  const handleServerPress = useCallback(
    (server: Server) => {
      onSelectServer(server);
    },
    [onSelectServer]
  );

  const handleSessionPress = useCallback(
    (server: Server, sessionId: string) => {
      onSelectServer(server, sessionId);
    },
    [onSelectServer]
  );

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#3b82f6" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Claude Companion</Text>
        <View style={styles.headerButtons}>
          <TouchableOpacity style={styles.headerButton} onPress={onOpenSetup}>
            <Text style={styles.headerButtonText}>?</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerButton} onPress={onManageServers}>
            <Text style={styles.headerButtonText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Summary bar */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>{connectedCount}/{servers.length}</Text>
          <Text style={styles.summaryLabel}>Connected</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryValue, totalWaiting > 0 && styles.waitingValue]}>
            {totalWaiting}
          </Text>
          <Text style={styles.summaryLabel}>Waiting</Text>
        </View>
        <View style={styles.summaryDivider} />
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>{totalWorking}</Text>
          <Text style={styles.summaryLabel}>Working</Text>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#3b82f6"
          />
        }
      >
        {servers.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No Servers</Text>
            <Text style={styles.emptyText}>
              Add a server to get started monitoring your Claude sessions.
            </Text>
            <TouchableOpacity style={styles.addButton} onPress={onManageServers}>
              <Text style={styles.addButtonText}>Add Server</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.setupLink} onPress={onOpenSetup}>
              <Text style={styles.setupLinkText}>View Setup Instructions</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {servers.map((server) => {
              const status = statuses.find((s) => s.serverId === server.id) || {
                serverId: server.id,
                serverName: server.name,
                connected: false,
                connecting: true,
                lastUpdated: Date.now(),
              };

              return (
                <ServerCard
                  key={server.id}
                  server={server}
                  status={status}
                  onPress={() => handleServerPress(server)}
                  onSessionPress={(sessionId) => handleSessionPress(server, sessionId)}
                />
              );
            })}
          </>
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
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1f2937',
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  headerTitle: {
    color: '#f3f4f6',
    fontSize: 20,
    fontWeight: '700',
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerButtonText: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: '600',
  },
  summaryBar: {
    flexDirection: 'row',
    backgroundColor: '#1f2937',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  summaryValue: {
    color: '#f3f4f6',
    fontSize: 24,
    fontWeight: '700',
  },
  waitingValue: {
    color: '#f59e0b',
  },
  summaryLabel: {
    color: '#9ca3af',
    fontSize: 12,
    marginTop: 2,
  },
  summaryDivider: {
    width: 1,
    backgroundColor: '#374151',
    marginVertical: 4,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    gap: 12,
  },
  serverCard: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  serverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  connectionDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  serverName: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: '600',
    flex: 1,
  },
  badge: {
    backgroundColor: '#f59e0b',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 20,
    alignItems: 'center',
  },
  badgeText: {
    color: '#000',
    fontSize: 12,
    fontWeight: '700',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    color: '#9ca3af',
    fontSize: 14,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
  },
  disconnectedText: {
    color: '#6b7280',
    fontSize: 14,
    fontStyle: 'italic',
  },
  sessionsContainer: {
    gap: 8,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: '#374151',
    borderRadius: 8,
  },
  statusIcon: {
    fontSize: 16,
    marginRight: 10,
  },
  sessionInfo: {
    flex: 1,
  },
  sessionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sessionName: {
    color: '#f3f4f6',
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  sessionTime: {
    color: '#6b7280',
    fontSize: 11,
    marginLeft: 8,
  },
  sessionPath: {
    color: '#6b7280',
    fontSize: 11,
    marginTop: 1,
  },
  sessionActivity: {
    color: '#60a5fa',
    fontSize: 12,
    marginTop: 2,
  },
  noSessionsText: {
    color: '#6b7280',
    fontSize: 14,
    fontStyle: 'italic',
  },
  moreText: {
    color: '#6b7280',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    color: '#f3f4f6',
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyText: {
    color: '#9ca3af',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
    paddingHorizontal: 32,
  },
  addButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  addButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  setupLink: {
    padding: 8,
  },
  setupLinkText: {
    color: '#60a5fa',
    fontSize: 14,
  },
});
