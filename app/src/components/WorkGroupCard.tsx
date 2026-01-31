import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { WorkGroup, WorkerSession } from '../types';

interface WorkGroupCardProps {
  group: WorkGroup;
  onViewWorker?: (sessionId: string) => void;
  onSendWorkerInput?: (groupId: string, workerId: string, text: string) => Promise<void>;
  onMerge?: (groupId: string) => Promise<void>;
  onCancel?: (groupId: string) => Promise<void>;
  onRetryWorker?: (groupId: string, workerId: string) => Promise<void>;
}

function WorkerStatusDot({ status }: { status: WorkerSession['status'] }) {
  const colors: Record<WorkerSession['status'], string> = {
    spawning: '#6b7280',
    working: '#3b82f6',
    waiting: '#f59e0b',
    completed: '#10b981',
    error: '#ef4444',
  };
  return <View style={[styles.workerDot, { backgroundColor: colors[status] }]} />;
}

function WorkerStatusLabel({ status }: { status: WorkerSession['status'] }) {
  const labels: Record<WorkerSession['status'], string> = {
    spawning: 'Spawning',
    working: 'Working',
    waiting: 'Waiting',
    completed: 'Done',
    error: 'Error',
  };
  const colors: Record<WorkerSession['status'], string> = {
    spawning: '#6b7280',
    working: '#3b82f6',
    waiting: '#f59e0b',
    completed: '#10b981',
    error: '#ef4444',
  };
  return <Text style={[styles.workerStatusText, { color: colors[status] }]}>{labels[status]}</Text>;
}

function InlineQuestionInput({
  worker,
  groupId,
  onSendInput,
}: {
  worker: WorkerSession;
  groupId: string;
  onSendInput?: (groupId: string, workerId: string, text: string) => Promise<void>;
}) {
  const [customText, setCustomText] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async (text: string) => {
    if (!onSendInput || sending) return;
    setSending(true);
    try {
      await onSendInput(groupId, worker.id, text);
      setCustomText('');
    } finally {
      setSending(false);
    }
  }, [onSendInput, groupId, worker.id, sending]);

  if (!worker.lastQuestion) return null;

  return (
    <View style={styles.questionContainer}>
      <Text style={styles.questionText} numberOfLines={3}>
        {worker.lastQuestion.text}
      </Text>
      {worker.lastQuestion.options && worker.lastQuestion.options.length > 0 && (
        <View style={styles.optionRow}>
          {worker.lastQuestion.options.map((opt, i) => (
            <TouchableOpacity
              key={i}
              style={styles.optionButton}
              onPress={() => handleSend(opt.label)}
              disabled={sending}
            >
              <Text style={styles.optionButtonText} numberOfLines={1}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <View style={styles.customInputRow}>
        <TextInput
          style={styles.customInput}
          value={customText}
          onChangeText={setCustomText}
          placeholder="Type response..."
          placeholderTextColor="#6b7280"
          editable={!sending}
        />
        <TouchableOpacity
          style={[styles.sendButton, (!customText.trim() || sending) && styles.sendButtonDisabled]}
          onPress={() => handleSend(customText.trim())}
          disabled={!customText.trim() || sending}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.sendButtonText}>Send</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function WorkerRow({
  worker,
  groupId,
  isLast,
  onView,
  onSendInput,
  onRetry,
}: {
  worker: WorkerSession;
  groupId: string;
  isLast: boolean;
  onView?: (sessionId: string) => void;
  onSendInput?: (groupId: string, workerId: string, text: string) => Promise<void>;
  onRetry?: (groupId: string, workerId: string) => Promise<void>;
}) {
  return (
    <View style={styles.workerRow}>
      <View style={styles.workerTreeLine}>
        <Text style={styles.treeConnector}>{isLast ? '\u2514' : '\u251C'}</Text>
      </View>
      <View style={styles.workerContent}>
        <View style={styles.workerHeader}>
          <WorkerStatusDot status={worker.status} />
          <Text style={styles.workerSlug} numberOfLines={1}>{worker.taskSlug}</Text>
          <WorkerStatusLabel status={worker.status} />
          {onView && worker.sessionId && (
            <TouchableOpacity
              style={styles.viewButton}
              onPress={() => onView(worker.sessionId)}
            >
              <Text style={styles.viewButtonText}>View</Text>
            </TouchableOpacity>
          )}
        </View>
        {worker.lastActivity && worker.status === 'working' && (
          <Text style={styles.workerActivity} numberOfLines={1}>{worker.lastActivity}</Text>
        )}
        {worker.error && worker.status === 'error' && (
          <View style={styles.errorRow}>
            <Text style={styles.workerError} numberOfLines={2}>{worker.error}</Text>
            {onRetry && (
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => onRetry(groupId, worker.id)}
              >
                <Text style={styles.retryButtonText}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {worker.status === 'completed' && worker.commits.length > 0 && (
          <Text style={styles.workerCommits}>
            {worker.commits.length} commit{worker.commits.length !== 1 ? 's' : ''}
          </Text>
        )}
        {worker.status === 'waiting' && (
          <InlineQuestionInput
            worker={worker}
            groupId={groupId}
            onSendInput={onSendInput}
          />
        )}
      </View>
    </View>
  );
}

// Sort workers: waiting first, then working, spawning, error, completed
function sortWorkers(workers: WorkerSession[]): WorkerSession[] {
  const priority: Record<WorkerSession['status'], number> = {
    waiting: 0,
    working: 1,
    spawning: 2,
    error: 3,
    completed: 4,
  };
  return [...workers].sort((a, b) => priority[a.status] - priority[b.status]);
}

export function WorkGroupCard({
  group,
  onViewWorker,
  onSendWorkerInput,
  onMerge,
  onCancel,
  onRetryWorker,
}: WorkGroupCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [merging, setMerging] = useState(false);

  const completedCount = group.workers.filter(w => w.status === 'completed').length;
  const waitingCount = group.workers.filter(w => w.status === 'waiting').length;
  const totalCount = group.workers.length;

  const handleMerge = useCallback(async () => {
    if (!onMerge) return;
    Alert.alert(
      'Merge Work Group',
      `Merge ${completedCount} completed worker branch${completedCount !== 1 ? 'es' : ''} into main?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Merge',
          onPress: async () => {
            setMerging(true);
            try {
              await onMerge(group.id);
            } finally {
              setMerging(false);
            }
          },
        },
      ],
    );
  }, [onMerge, group.id, completedCount]);

  const handleCancel = useCallback(() => {
    if (!onCancel) return;
    Alert.alert(
      'Cancel Work Group',
      'This will kill all workers and remove their worktrees. This cannot be undone.',
      [
        { text: 'Keep Running', style: 'cancel' },
        {
          text: 'Cancel Group',
          style: 'destructive',
          onPress: () => onCancel(group.id),
        },
      ],
    );
  }, [onCancel, group.id]);

  const sorted = sortWorkers(group.workers);

  return (
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.cardHeader}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
      >
        <Text style={styles.chevron}>{expanded ? '\u25BC' : '\u25B6'}</Text>
        <View style={styles.cardTitleArea}>
          <Text style={styles.cardTitle} numberOfLines={1}>{group.name}</Text>
          <View style={styles.cardMeta}>
            <Text style={styles.cardMetaText}>
              {completedCount}/{totalCount} complete
            </Text>
            {waitingCount > 0 && (
              <Text style={styles.cardWaiting}>
                {waitingCount} waiting
              </Text>
            )}
            {group.status === 'merging' && (
              <Text style={styles.cardMerging}>Merging...</Text>
            )}
          </View>
        </View>
      </TouchableOpacity>

      {/* Progress bar */}
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { flex: completedCount || 0 }]} />
        <View style={[styles.progressRemaining, { flex: Math.max(totalCount - completedCount, 0) || 1 }]} />
      </View>

      {expanded && (
        <View style={styles.cardBody}>
          {sorted.map((worker, i) => (
            <WorkerRow
              key={worker.id}
              worker={worker}
              groupId={group.id}
              isLast={i === sorted.length - 1}
              onView={onViewWorker}
              onSendInput={onSendWorkerInput}
              onRetry={onRetryWorker}
            />
          ))}

          {/* Actions */}
          {group.status === 'active' && (
            <View style={styles.actionRow}>
              {completedCount > 0 && onMerge && (
                <TouchableOpacity
                  style={[styles.mergeButton, merging && styles.mergeButtonDisabled]}
                  onPress={handleMerge}
                  disabled={merging}
                >
                  {merging ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.mergeButtonText}>Merge ({completedCount})</Text>
                  )}
                </TouchableOpacity>
              )}
              {onCancel && (
                <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {group.status === 'completed' && group.mergeCommit && (
            <View style={styles.completedBanner}>
              <Text style={styles.completedText}>
                Merged: {group.mergeCommit.substring(0, 8)}
              </Text>
            </View>
          )}

          {group.error && (
            <Text style={styles.groupError}>{group.error}</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1a2332',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2d4a2d',
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
  },
  chevron: {
    color: '#9ca3af',
    fontSize: 10,
    marginRight: 8,
    width: 12,
  },
  cardTitleArea: {
    flex: 1,
  },
  cardTitle: {
    color: '#f3f4f6',
    fontSize: 13,
    fontWeight: '600',
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  cardMetaText: {
    color: '#9ca3af',
    fontSize: 11,
  },
  cardWaiting: {
    color: '#f59e0b',
    fontSize: 11,
    fontWeight: '500',
  },
  cardMerging: {
    color: '#3b82f6',
    fontSize: 11,
    fontWeight: '500',
  },
  progressBar: {
    flexDirection: 'row',
    height: 3,
    backgroundColor: '#374151',
    marginHorizontal: 10,
  },
  progressFill: {
    backgroundColor: '#10b981',
    height: '100%',
  },
  progressRemaining: {
    backgroundColor: '#374151',
    height: '100%',
  },
  cardBody: {
    padding: 10,
    paddingTop: 8,
  },
  workerRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  workerTreeLine: {
    width: 16,
    alignItems: 'center',
  },
  treeConnector: {
    color: '#4b5563',
    fontSize: 12,
    lineHeight: 16,
  },
  workerContent: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 6,
    padding: 8,
  },
  workerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  workerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  workerSlug: {
    color: '#e5e7eb',
    fontSize: 12,
    fontWeight: '500',
    flex: 1,
  },
  workerStatusText: {
    fontSize: 11,
    fontWeight: '500',
    marginLeft: 6,
  },
  viewButton: {
    marginLeft: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: '#374151',
    borderRadius: 4,
  },
  viewButtonText: {
    color: '#60a5fa',
    fontSize: 11,
  },
  workerActivity: {
    color: '#60a5fa',
    fontSize: 11,
    marginTop: 3,
  },
  workerError: {
    color: '#ef4444',
    fontSize: 11,
    flex: 1,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 3,
    gap: 6,
  },
  retryButton: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: '#374151',
    borderRadius: 4,
  },
  retryButtonText: {
    color: '#f59e0b',
    fontSize: 11,
  },
  workerCommits: {
    color: '#10b981',
    fontSize: 11,
    marginTop: 3,
  },
  questionContainer: {
    marginTop: 6,
    padding: 6,
    backgroundColor: '#1f2937',
    borderRadius: 4,
    borderLeftWidth: 2,
    borderLeftColor: '#f59e0b',
  },
  questionText: {
    color: '#e5e7eb',
    fontSize: 12,
    marginBottom: 4,
  },
  optionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 4,
  },
  optionButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#374151',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#4b5563',
  },
  optionButtonText: {
    color: '#f3f4f6',
    fontSize: 11,
  },
  customInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  customInput: {
    flex: 1,
    backgroundColor: '#374151',
    color: '#f3f4f6',
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  sendButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#3b82f6',
    borderRadius: 4,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#374151',
  },
  mergeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#10b981',
    borderRadius: 6,
  },
  mergeButtonDisabled: {
    opacity: 0.6,
  },
  mergeButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  cancelButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#374151',
    borderRadius: 6,
  },
  cancelButtonText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '500',
  },
  completedBanner: {
    marginTop: 8,
    padding: 8,
    backgroundColor: '#0f291f',
    borderRadius: 4,
    alignItems: 'center',
  },
  completedText: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: '500',
  },
  groupError: {
    color: '#ef4444',
    fontSize: 11,
    marginTop: 6,
  },
});
