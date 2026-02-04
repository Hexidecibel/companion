import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Switch,
  Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Server, ServerStatus, SessionSummary, TaskItem, WorkGroup } from '../types';
import { getServers, updateServer } from '../services/storage';
import { useMultiServerStatus } from '../hooks/useMultiServerStatus';
import { NewSessionModal } from '../components/NewSessionModal';
import { WorkGroupCard } from '../components/WorkGroupCard';

interface DashboardScreenProps {
  onSelectServer: (server: Server, sessionId?: string) => void;
  onAddServer: () => void;
  onEditServer: (server: Server) => void;
  onOpenSetup: () => void;
  onOpenNewProject?: () => void;
  onOpenTaskDetail?: (server: Server, sessionId: string, task: TaskItem) => void;
  sendRequest?: (serverId: string, type: string, payload?: unknown) => Promise<any>;
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

function TaskStatusDot({ status }: { status: TaskItem['status'] }) {
  const color =
    status === 'completed' ? '#10b981' :
    status === 'in_progress' ? '#3b82f6' :
    '#6b7280';
  return <View style={[styles.taskStatusDot, { backgroundColor: color }]} />;
}

// Module-level cache: servers survive unmount/remount so useMultiServerStatus
// doesn't see an empty array on re-navigation and disconnect the WebSocket
let cachedServers: Server[] = [];

function ServerCard({
  server,
  status,
  onPress,
  onLongPress,
  onSessionPress,
  onToggleEnabled,
  onNewProject,
  sendRequest,
  onOpenTaskDetail,
  onRefresh,
}: {
  server: Server;
  status: ServerStatus;
  onPress: () => void;
  onLongPress: () => void;
  onSessionPress: (sessionId: string) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onNewProject?: () => void;
  sendRequest?: (serverId: string, type: string, payload?: unknown) => Promise<any>;
  onOpenTaskDetail?: (task: TaskItem, sessionId: string) => void;
  onRefresh?: () => void;
}) {
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [tasksBySession, setTasksBySession] = useState<Map<string, TaskItem[]>>(new Map());
  const [loadingTasks, setLoadingTasks] = useState<Set<string>>(new Set());
  const [showNewSession, setShowNewSession] = useState(false);
  const [workGroups, setWorkGroups] = useState<WorkGroup[]>([]);

  // Fetch work groups periodically
  useEffect(() => {
    if (!sendRequest || !status.connected) return;
    const fetchGroups = () => {
      sendRequest(server.id, 'get_work_groups').then(response => {
        if (response.success && response.payload) {
          const groups = (response.payload as { groups: WorkGroup[] }).groups || [];
          setWorkGroups(groups.filter(g => g.status === 'active' || g.status === 'merging'));
        }
      }).catch(() => {});
    };
    fetchGroups();
    const timer = setInterval(fetchGroups, 5000);
    return () => clearInterval(timer);
  }, [server.id, sendRequest, status.connected]);

  // Build set of worker session IDs to hide from top-level list
  // and foreman session IDs for labeling
  const workerSessionIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const group of workGroups) {
      for (const worker of group.workers) {
        if (worker.sessionId) ids.add(worker.sessionId);
      }
    }
    return ids;
  }, [workGroups]);

  const foremanSessionIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const group of workGroups) {
      if (group.foremanSessionId) ids.add(group.foremanSessionId);
    }
    return ids;
  }, [workGroups]);

  const handleWorkGroupSendInput = useCallback(async (groupId: string, workerId: string, text: string) => {
    if (!sendRequest) return;
    await sendRequest(server.id, 'send_worker_input', { groupId, workerId, text });
  }, [server.id, sendRequest]);

  const handleWorkGroupMerge = useCallback(async (groupId: string) => {
    if (!sendRequest) return;
    const response = await sendRequest(server.id, 'merge_work_group', { groupId });
    if (!response.success) {
      Alert.alert('Merge Failed', response.error || 'Unknown error');
    }
  }, [server.id, sendRequest]);

  const handleWorkGroupCancel = useCallback(async (groupId: string) => {
    if (!sendRequest) return;
    await sendRequest(server.id, 'cancel_work_group', { groupId });
  }, [server.id, sendRequest]);

  const handleWorkGroupRetry = useCallback(async (groupId: string, workerId: string) => {
    if (!sendRequest) return;
    await sendRequest(server.id, 'retry_worker', { groupId, workerId });
  }, [server.id, sendRequest]);

  const handleCreateSession = useCallback(async (workingDir: string, startSession: boolean) => {
    if (!sendRequest) return;
    const response = await sendRequest(server.id, 'create_tmux_session', { workingDir, startCli: startSession });
    if (!response.success) {
      throw new Error(response.error || 'Failed to create session');
    }
    onRefresh?.();
  }, [server.id, sendRequest, onRefresh]);

  const handleCreateWorktree = useCallback(async (parentDir: string, branch: string, startSession: boolean) => {
    if (!sendRequest) return;
    const response = await sendRequest(server.id, 'create_worktree_session', {
      parentDir,
      branch: branch || undefined,
      startCli: startSession,
    });
    if (!response.success) {
      throw new Error(response.error || 'Failed to create worktree session');
    }
    onRefresh?.();
  }, [server.id, sendRequest, onRefresh]);

  const fetchRecents = useCallback(async () => {
    if (!sendRequest) return [];
    try {
      const response = await sendRequest(server.id, 'list_tmux_sessions');
      if (response.success && response.payload) {
        const payload = response.payload as { sessions: Array<{ name: string; workingDir?: string }> };
        return (payload.sessions || [])
          .filter((s: any) => s.workingDir)
          .map((s: any) => ({ name: s.name, workingDir: s.workingDir }));
      }
    } catch { /* ignore fetch errors */ }
    return [];
  }, [server.id, sendRequest]);

  const fetchTasks = useCallback(async (sessionId: string) => {
    if (!sendRequest) return;
    setLoadingTasks(prev => new Set(prev).add(sessionId));
    try {
      const response = await sendRequest(server.id, 'get_tasks', { sessionId });
      if (response.success && response.payload) {
        const tasks = (response.payload as { tasks: TaskItem[] }).tasks || [];
        setTasksBySession(prev => {
          const next = new Map(prev);
          next.set(sessionId, tasks);
          return next;
        });
      }
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    } finally {
      setLoadingTasks(prev => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  }, [server.id, sendRequest]);

  const handleKillSession = useCallback((sessionName: string) => {
    Alert.alert(
      'Kill Session',
      `Kill session "${sessionName}"? This will terminate the coding process.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Kill',
          style: 'destructive',
          onPress: async () => {
            if (!sendRequest) return;
            try {
              const response = await sendRequest(server.id, 'kill_tmux_session', { sessionName });
              if (response.success) {
                onRefresh?.();
              } else {
                Alert.alert('Error', response.error || 'Failed to kill session');
              }
            } catch (err) {
              Alert.alert('Error', 'Failed to kill session');
            }
          },
        },
      ]
    );
  }, [server.id, sendRequest, onRefresh]);

  const toggleTaskExpansion = useCallback((sessionId: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
        if (!tasksBySession.has(sessionId)) {
          fetchTasks(sessionId);
        }
      }
      return next;
    });
  }, [tasksBySession, fetchTasks]);
  const isEnabled = server.enabled !== false;
  const connectionColor = !isEnabled
    ? '#6b7280'
    : status.connected
    ? '#10b981'
    : status.connecting
    ? '#f59e0b'
    : '#ef4444';

  const hasSessions = (status.summary?.sessions.length ?? 0) > 0;

  return (
    <TouchableOpacity
      style={[styles.serverCard, !isEnabled && styles.serverCardDisabled]}
      onPress={hasSessions ? onPress : undefined}
      onLongPress={onLongPress}
      activeOpacity={hasSessions ? 0.8 : 1}
    >
      <View style={styles.serverHeader}>
        <View style={[styles.connectionDot, { backgroundColor: connectionColor }]} />
        <Text style={[styles.serverName, !isEnabled && styles.serverNameDisabled]}>{server.name}</Text>
        {status.summary && status.summary.waitingCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{status.summary.waitingCount}</Text>
          </View>
        )}
        {status.connected && sendRequest && (
          <TouchableOpacity
            style={styles.serverActionButton}
            onPress={() => setShowNewSession(true)}
          >
            <Text style={styles.serverActionIcon}>+</Text>
          </TouchableOpacity>
        )}
        {onNewProject && status.connected && (
          <TouchableOpacity style={styles.serverActionButton} onPress={onNewProject}>
            <Text style={styles.serverActionIcon}>✦</Text>
          </TouchableOpacity>
        )}
        <Switch
          value={isEnabled}
          onValueChange={onToggleEnabled}
          trackColor={{ false: '#374151', true: '#10b981' }}
          style={styles.enableSwitch}
        />
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
          {/* Work Groups */}
          {workGroups.length > 0 && (
            <View style={styles.workGroupsContainer}>
              {workGroups.map(group => (
                <WorkGroupCard
                  key={group.id}
                  group={group}
                  onViewWorker={(sessionId) => onSessionPress(sessionId)}
                  onSendWorkerInput={handleWorkGroupSendInput}
                  onMerge={handleWorkGroupMerge}
                  onCancel={handleWorkGroupCancel}
                  onRetryWorker={handleWorkGroupRetry}
                />
              ))}
            </View>
          )}

          {status.summary.sessions.length === 0 && workGroups.length === 0 ? (
            <Text style={styles.noSessionsText}>No active sessions</Text>
          ) : (
            sortSessions(status.summary.sessions)
              .filter(s => !workerSessionIds.has(s.id))
              .slice(0, 5).map((session) => (
              <TouchableOpacity
                key={session.id}
                style={[styles.sessionRow, session.status === 'idle' && styles.sessionRowIdle]}
                onPress={() => onSessionPress(session.id)}
                activeOpacity={0.7}
              >
                <SessionStatusIcon status={session.status} />
                <View style={styles.sessionInfo}>
                  <View style={styles.sessionHeader}>
                    <Text style={[styles.sessionName, session.status === 'idle' && styles.sessionNameIdle]} numberOfLines={1}>
                      {session.name}
                      {foremanSessionIds.has(session.id) && (
                        <Text style={styles.foremanLabel}> (foreman)</Text>
                      )}
                    </Text>
                    <Text style={styles.sessionTime}>
                      {formatRelativeTime(session.lastActivity)}
                    </Text>
                    <TouchableOpacity
                      style={styles.killButton}
                      onPress={() => handleKillSession(session.name)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.killButtonText}>x</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.sessionPath} numberOfLines={1}>
                    {session.projectPath}
                  </Text>
                  {session.currentActivity && (
                    <Text style={styles.sessionActivity} numberOfLines={1}>
                      {session.currentActivity}
                    </Text>
                  )}
                  {session.taskSummary && session.taskSummary.total > 0 && (
                    <>
                      <TouchableOpacity
                        style={styles.taskBar}
                        onPress={() => toggleTaskExpansion(session.id)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.taskProgress}>
                          <View style={[styles.taskProgressFill, {
                            flex: session.taskSummary.completed,
                            backgroundColor: '#8b5cf6',
                          }]} />
                          <View style={[styles.taskProgressFill, {
                            flex: session.taskSummary.inProgress,
                            backgroundColor: '#3b82f6',
                          }]} />
                          <View style={[styles.taskProgressFill, {
                            flex: session.taskSummary.pending,
                            backgroundColor: '#374151',
                          }]} />
                        </View>
                        <View style={styles.taskLabelRow}>
                          <Text style={styles.taskLabel}>
                            {session.taskSummary.completed}/{session.taskSummary.total} tasks
                            {session.taskSummary.activeTask ? ` - ${session.taskSummary.activeTask}` : ''}
                          </Text>
                          <Text style={styles.taskChevron}>
                            {expandedSessions.has(session.id) ? '\u25B4' : '\u25BE'}
                          </Text>
                        </View>
                      </TouchableOpacity>
                      {expandedSessions.has(session.id) && (
                        <View style={styles.expandedTasks}>
                          {loadingTasks.has(session.id) ? (
                            <ActivityIndicator size="small" color="#3b82f6" style={{ paddingVertical: 8 }} />
                          ) : (
                            (tasksBySession.get(session.id) || []).map((task) => (
                              <TouchableOpacity
                                key={task.id}
                                style={styles.taskRow}
                                onPress={() => onOpenTaskDetail?.(task, session.id)}
                                activeOpacity={0.7}
                              >
                                <TaskStatusDot status={task.status} />
                                <View style={styles.taskInfo}>
                                  <Text style={styles.taskSubject} numberOfLines={1}>
                                    {task.subject}
                                  </Text>
                                  {task.status === 'in_progress' && task.activeForm && (
                                    <Text style={styles.taskActiveForm} numberOfLines={1}>
                                      {task.activeForm}
                                    </Text>
                                  )}
                                </View>
                                <Text style={styles.taskRowChevron}>{'\u203A'}</Text>
                              </TouchableOpacity>
                            ))
                          )}
                        </View>
                      )}
                    </>
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

      <NewSessionModal
        visible={showNewSession}
        onClose={() => setShowNewSession(false)}
        onCreate={handleCreateSession}
        onCreateWorktree={handleCreateWorktree}
        onFetchRecents={fetchRecents}
      />
    </TouchableOpacity>
  );
}

export function DashboardScreen({
  onSelectServer,
  onAddServer,
  onEditServer,
  onOpenSetup,
  onOpenNewProject,
  onOpenTaskDetail,
  sendRequest,
}: DashboardScreenProps) {
  const [servers, setServers] = useState<Server[]>(cachedServers);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const {
    statuses,
    totalWaiting,
    totalWorking,
    connectedCount,
    refreshAll,
    refreshServer,
    sendRequest: hookSendRequest,
  } = useMultiServerStatus(servers);

  const resolvedSendRequest = sendRequest || hookSendRequest;

  const loadServers = useCallback(async () => {
    const loaded = await getServers();
    cachedServers = loaded;
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
      <LinearGradient colors={['#1a2744', '#1f1a3d']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.header}>
        <Text style={styles.headerTitle}>Companion</Text>
        <TouchableOpacity style={styles.headerButton} onPress={onOpenSetup}>
          <Text style={styles.headerButtonText}>?</Text>
        </TouchableOpacity>
      </LinearGradient>

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
              Add a server to get started monitoring your coding sessions.
            </Text>
            <TouchableOpacity style={styles.addButton} onPress={onAddServer}>
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
                connecting: server.enabled !== false,
                lastUpdated: Date.now(),
              };

              return (
                <ServerCard
                  key={server.id}
                  server={server}
                  status={status}
                  onPress={() => handleServerPress(server)}
                  onLongPress={() => onEditServer(server)}
                  onSessionPress={(sessionId) => handleSessionPress(server, sessionId)}
                  onToggleEnabled={async (enabled) => {
                    const updated = { ...server, enabled };
                    await updateServer(updated);
                    await loadServers();
                  }}
                  onNewProject={onOpenNewProject}
                  sendRequest={resolvedSendRequest}
                  onOpenTaskDetail={onOpenTaskDetail ? (task, sessionId) => onOpenTaskDetail(server, sessionId, task) : undefined}
                  onRefresh={() => refreshServer(server.id)}
                />
              );
            })}
            <TouchableOpacity style={styles.addServerButton} onPress={onAddServer}>
              <Text style={styles.addServerButtonText}>+ Add Server</Text>
            </TouchableOpacity>
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
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  headerTitle: {
    color: '#f3f4f6',
    fontSize: 20,
    fontWeight: '700',
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
    backgroundColor: '#111c33',
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
    paddingBottom: 40,
    gap: 12,
  },
  serverCard: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#3b4f8a',
  },
  serverCardDisabled: {
    opacity: 0.6,
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
  serverNameDisabled: {
    color: '#6b7280',
  },
  enableSwitch: {
    marginLeft: 8,
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
  workGroupsContainer: {
    gap: 8,
    marginBottom: 8,
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
  sessionRowIdle: {
    opacity: 0.55,
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
  sessionNameIdle: {
    color: '#9ca3af',
  },
  foremanLabel: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '400',
  },
  sessionTime: {
    color: '#6b7280',
    fontSize: 11,
    marginLeft: 8,
  },
  killButton: {
    marginLeft: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#4b5563',
    justifyContent: 'center',
    alignItems: 'center',
  },
  killButtonText: {
    color: '#9ca3af',
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
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
    backgroundColor: '#7c3aed',
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
  serverActionButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  serverActionIcon: {
    color: '#10b981',
    fontSize: 16,
  },
  addServerButton: {
    borderWidth: 1,
    borderColor: '#374151',
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  addServerButtonText: {
    color: '#6b7280',
    fontSize: 15,
    fontWeight: '500',
  },
  taskBar: {
    marginTop: 4,
  },
  taskProgress: {
    flexDirection: 'row',
    height: 3,
    borderRadius: 1.5,
    overflow: 'hidden',
    backgroundColor: '#1f2937',
  },
  taskProgressFill: {
    height: '100%',
  },
  taskLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  taskLabel: {
    color: '#9ca3af',
    fontSize: 10,
    flex: 1,
  },
  taskChevron: {
    color: '#6b7280',
    fontSize: 10,
    marginLeft: 4,
  },
  expandedTasks: {
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#4b5563',
    paddingTop: 6,
    gap: 4,
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    backgroundColor: '#1f2937',
    borderRadius: 6,
  },
  taskStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  taskInfo: {
    flex: 1,
  },
  taskSubject: {
    color: '#e5e7eb',
    fontSize: 12,
    fontWeight: '500',
  },
  taskActiveForm: {
    color: '#60a5fa',
    fontSize: 11,
    marginTop: 1,
  },
  taskRowChevron: {
    color: '#6b7280',
    fontSize: 16,
    marginLeft: 4,
  },
});
