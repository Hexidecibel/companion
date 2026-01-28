import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { historyService, HistorySession } from '../services/history';
import { ConversationItem } from '../components/ConversationItem';
import { ConversationHighlight } from '../types';

interface HistoryScreenProps {
  onBack: () => void;
}

export function HistoryScreen({ onBack }: HistoryScreenProps) {
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [selectedSession, setSelectedSession] = useState<HistorySession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    setLoading(true);
    const loaded = await historyService.getSessions();
    setSessions(loaded);
    setLoading(false);
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatDuration = (start: number, end: number) => {
    const minutes = Math.round((end - start) / 60000);
    if (minutes < 1) return '< 1 min';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  };

  const handleDeleteSession = (session: HistorySession) => {
    Alert.alert('Delete Session', 'Are you sure you want to delete this session?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await historyService.deleteSession(session.id);
          setSessions(sessions.filter((s) => s.id !== session.id));
          if (selectedSession?.id === session.id) {
            setSelectedSession(null);
          }
        },
      },
    ]);
  };

  const renderSessionItem = ({ item }: { item: HistorySession }) => (
    <TouchableOpacity
      style={[styles.sessionItem, selectedSession?.id === item.id && styles.sessionItemSelected]}
      onPress={() => setSelectedSession(item)}
      onLongPress={() => handleDeleteSession(item)}
    >
      <View style={styles.sessionHeader}>
        <Text style={styles.sessionServer}>{item.serverName}</Text>
        <Text style={styles.sessionDate}>{formatDate(item.startTime)}</Text>
      </View>
      {item.projectPath && (
        <Text style={styles.sessionProject} numberOfLines={1}>
          {item.projectPath}
        </Text>
      )}
      <View style={styles.sessionFooter}>
        <Text style={styles.sessionStats}>
          {item.messages.length} messages
        </Text>
        <Text style={styles.sessionDuration}>
          {formatDuration(item.startTime, item.endTime)}
        </Text>
      </View>
    </TouchableOpacity>
  );

  const renderMessageItem = ({ item }: { item: ConversationHighlight }) => (
    <ConversationItem item={item} />
  );

  if (selectedSession) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setSelectedSession(null)} style={styles.backButton}>
            <Text style={styles.backButtonText}>‹ Sessions</Text>
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {selectedSession.serverName}
            </Text>
            <Text style={styles.headerSubtitle}>{formatDate(selectedSession.startTime)}</Text>
          </View>
          <View style={styles.placeholder} />
        </View>

        <FlatList
          data={selectedSession.messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessageItem}
          contentContainerStyle={styles.messageList}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No messages in this session</Text>
            </View>
          }
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>History</Text>
        <View style={styles.placeholder} />
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#3b82f6" />
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          renderItem={renderSessionItem}
          contentContainerStyle={styles.sessionList}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyTitle}>No History</Text>
              <Text style={styles.emptyText}>
                Past sessions will appear here when you connect to a server
              </Text>
            </View>
          }
        />
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
    minWidth: 80,
  },
  backButtonText: {
    color: '#3b82f6',
    fontSize: 17,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    color: '#f3f4f6',
    fontSize: 17,
    fontWeight: '600',
  },
  headerSubtitle: {
    color: '#9ca3af',
    fontSize: 12,
    marginTop: 2,
  },
  placeholder: {
    minWidth: 80,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sessionList: {
    padding: 12,
    paddingBottom: 40,
  },
  sessionItem: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  sessionItemSelected: {
    borderWidth: 1,
    borderColor: '#3b82f6',
  },
  sessionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  sessionServer: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: '600',
  },
  sessionDate: {
    color: '#9ca3af',
    fontSize: 12,
  },
  sessionProject: {
    color: '#9ca3af',
    fontSize: 13,
    marginBottom: 8,
  },
  sessionFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sessionStats: {
    color: '#6b7280',
    fontSize: 12,
  },
  sessionDuration: {
    color: '#6b7280',
    fontSize: 12,
  },
  messageList: {
    paddingVertical: 12,
    paddingBottom: 40,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingTop: 100,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#f3f4f6',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#9ca3af',
    textAlign: 'center',
    lineHeight: 20,
  },
});
