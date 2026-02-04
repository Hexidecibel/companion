import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ArchivedConversation } from '../types';
import { archiveService } from '../services/archive';

interface ArchiveProps {
  onBack: () => void;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'short' });
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

function ArchiveItem({
  archive,
  onDelete,
}: {
  archive: ArchivedConversation;
  onDelete: () => void;
}) {
  const handleLongPress = () => {
    Alert.alert('Delete Archive', 'Are you sure you want to delete this archived conversation?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
  };

  return (
    <TouchableOpacity style={styles.archiveItem} onLongPress={handleLongPress} activeOpacity={0.8}>
      <View style={styles.archiveHeader}>
        <Text style={styles.archiveName} numberOfLines={1}>
          {archive.sessionName}
        </Text>
        <Text style={styles.archiveTime}>{formatDate(archive.timestamp)}</Text>
      </View>
      <Text style={styles.archivePath} numberOfLines={1}>
        {archive.projectPath}
      </Text>
      <Text style={styles.archiveSummary} numberOfLines={4}>
        {archive.summary}
      </Text>
      <Text style={styles.archiveServer}>{archive.serverName}</Text>
    </TouchableOpacity>
  );
}

export function Archive({ onBack }: ArchiveProps) {
  const [archives, setArchives] = useState<ArchivedConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadArchives = useCallback(async () => {
    const data = await archiveService.getArchives();
    setArchives(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadArchives();
  }, [loadArchives]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadArchives();
    setRefreshing(false);
  }, [loadArchives]);

  const handleDelete = useCallback(async (id: string) => {
    await archiveService.deleteArchive(id);
    setArchives((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleClearAll = useCallback(() => {
    Alert.alert(
      'Clear All Archives',
      'Are you sure you want to delete all archived conversations?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            await archiveService.clearAll();
            setArchives([]);
          },
        },
      ]
    );
  }, []);

  if (loading) {
    return (
      <View style={styles.container}>
        <LinearGradient
          colors={['#1a2744', '#1f1a3d']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.header}
        >
          <TouchableOpacity onPress={onBack} style={styles.backButton}>
            <Text style={styles.backButtonText}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Archive</Text>
          <View style={styles.placeholder} />
        </LinearGradient>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#3b82f6" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['#1a2744', '#1f1a3d']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.header}
      >
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Archive</Text>
        {archives.length > 0 ? (
          <TouchableOpacity onPress={handleClearAll} style={styles.clearButton}>
            <Text style={styles.clearButtonText}>Clear</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.placeholder} />
        )}
      </LinearGradient>

      {archives.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No Archives</Text>
          <Text style={styles.emptyText}>
            Conversation summaries will be saved here when the context is compacted.
          </Text>
        </View>
      ) : (
        <FlatList
          data={archives}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ArchiveItem archive={item} onDelete={() => handleDelete(item.id)} />
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#3b82f6" />
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
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
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
    fontSize: 17,
    fontWeight: '600',
  },
  placeholder: {
    minWidth: 60,
  },
  clearButton: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    minWidth: 60,
    alignItems: 'flex-end',
  },
  clearButtonText: {
    color: '#ef4444',
    fontSize: 16,
  },
  listContent: {
    padding: 16,
    paddingBottom: 40,
  },
  archiveItem: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#3b4f8a',
  },
  archiveHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  archiveName: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  archiveTime: {
    color: '#6b7280',
    fontSize: 13,
    marginLeft: 8,
  },
  archivePath: {
    color: '#6b7280',
    fontSize: 12,
    marginBottom: 8,
  },
  archiveSummary: {
    color: '#d1d5db',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  archiveServer: {
    color: '#9ca3af',
    fontSize: 11,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
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
    lineHeight: 20,
  },
});
