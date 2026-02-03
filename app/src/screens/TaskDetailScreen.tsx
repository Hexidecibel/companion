import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { TaskItem } from '../types';

interface TaskDetailScreenProps {
  task: TaskItem;
  sessionName?: string;
  onBack: () => void;
}

function StatusBadge({ status }: { status: TaskItem['status'] }) {
  const color =
    status === 'completed' ? '#10b981' :
    status === 'in_progress' ? '#6366f1' :
    '#6b7280';
  const label =
    status === 'completed' ? 'Completed' :
    status === 'in_progress' ? 'In Progress' :
    'Pending';

  return (
    <View style={[styles.statusBadge, { backgroundColor: color + '20', borderColor: color }]}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <Text style={[styles.statusLabel, { color }]}>{label}</Text>
    </View>
  );
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;

  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function TaskDetailScreen({ task, sessionName, onBack }: TaskDetailScreenProps) {
  return (
    <View style={styles.container}>
      <LinearGradient colors={['#1a2744', '#1f1a3d']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>&#8249; Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Task</Text>
        <View style={styles.placeholder} />
      </LinearGradient>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <View style={styles.card}>
          <StatusBadge status={task.status} />
          <Text style={styles.subject}>{task.subject}</Text>
          {task.status === 'in_progress' && task.activeForm && (
            <Text style={styles.activeForm}>{task.activeForm}</Text>
          )}
        </View>

        {task.description ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Description</Text>
            <Text style={styles.description}>{task.description}</Text>
          </View>
        ) : null}

        {task.owner && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Owner</Text>
            <Text style={styles.metaValue}>{task.owner}</Text>
          </View>
        )}

        {((task.blockedBy && task.blockedBy.length > 0) || (task.blocks && task.blocks.length > 0)) && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Dependencies</Text>
            {task.blockedBy && task.blockedBy.length > 0 && (
              <View style={styles.depRow}>
                <Text style={styles.depLabel}>Blocked by:</Text>
                <Text style={styles.depValue}>
                  {task.blockedBy.map(id => `#${id}`).join(', ')}
                </Text>
              </View>
            )}
            {task.blocks && task.blocks.length > 0 && (
              <View style={styles.depRow}>
                <Text style={styles.depLabel}>Blocks:</Text>
                <Text style={styles.depValue}>
                  {task.blocks.map(id => `#${id}`).join(', ')}
                </Text>
              </View>
            )}
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Timestamps</Text>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Created</Text>
            <Text style={styles.metaValue}>{formatTimestamp(task.createdAt)}</Text>
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Updated</Text>
            <Text style={styles.metaValue}>{formatTimestamp(task.updatedAt)}</Text>
          </View>
          {sessionName && (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Session</Text>
              <Text style={styles.metaValue}>{sessionName}</Text>
            </View>
          )}
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Task ID</Text>
            <Text style={styles.metaValue}>#{task.id}</Text>
          </View>
        </View>
      </ScrollView>
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
    padding: 16,
    gap: 12,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  subject: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 24,
  },
  activeForm: {
    color: '#60a5fa',
    fontSize: 14,
    marginTop: 6,
  },
  sectionTitle: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  description: {
    color: '#d1d5db',
    fontSize: 14,
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  metaLabel: {
    color: '#9ca3af',
    fontSize: 14,
  },
  metaValue: {
    color: '#f3f4f6',
    fontSize: 14,
  },
  depRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  depLabel: {
    color: '#9ca3af',
    fontSize: 13,
    marginRight: 8,
  },
  depValue: {
    color: '#f3f4f6',
    fontSize: 13,
  },
});
