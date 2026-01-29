import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Switch,
  Alert,
} from 'react-native';

interface RecentProject {
  name: string;
  workingDir: string;
  lastUsed?: number;
}

interface NewSessionModalProps {
  visible: boolean;
  onClose: () => void;
  onCreate: (workingDir: string, startClaude: boolean) => Promise<void>;
  onFetchRecents: () => Promise<RecentProject[]>;
}

export function NewSessionModal({ visible, onClose, onCreate, onFetchRecents }: NewSessionModalProps) {
  const [path, setPath] = useState('');
  const [startClaude, setStartClaude] = useState(true);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [loadingRecents, setLoadingRecents] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (visible) {
      setPath('');
      setCreating(false);
      loadRecents();
    }
  }, [visible]);

  const loadRecents = useCallback(async () => {
    setLoadingRecents(true);
    try {
      const projects = await onFetchRecents();
      setRecents(projects);
    } catch {
      setRecents([]);
    } finally {
      setLoadingRecents(false);
    }
  }, [onFetchRecents]);

  const handleCreate = useCallback(async () => {
    const trimmed = path.trim();
    if (!trimmed) {
      Alert.alert('Missing Path', 'Enter a project directory path.');
      return;
    }
    setCreating(true);
    try {
      await onCreate(trimmed, startClaude);
      onClose();
    } catch (err) {
      Alert.alert('Error', 'Failed to create session');
    } finally {
      setCreating(false);
    }
  }, [path, startClaude, onCreate, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>New Session</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.closeButton}>Cancel</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Project Path</Text>
            <TextInput
              style={styles.input}
              value={path}
              onChangeText={setPath}
              placeholder="/home/user/projects/my-project"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Start Claude</Text>
            <Switch
              value={startClaude}
              onValueChange={setStartClaude}
              trackColor={{ false: '#374151', true: '#3b82f6' }}
            />
          </View>

          {recents.length > 0 && (
            <View style={styles.recentsSection}>
              <Text style={styles.recentsTitle}>Recent Projects</Text>
              <ScrollView style={styles.recentsList} nestedScrollEnabled>
                {recents.map((project, index) => (
                  <TouchableOpacity
                    key={`${project.workingDir}-${index}`}
                    style={styles.recentItem}
                    onPress={() => setPath(project.workingDir)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.recentName} numberOfLines={1}>{project.name}</Text>
                    <Text style={styles.recentPath} numberOfLines={1}>{project.workingDir}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {loadingRecents && recents.length === 0 && (
            <ActivityIndicator size="small" color="#3b82f6" style={{ marginVertical: 16 }} />
          )}

          <TouchableOpacity
            style={[styles.createButton, creating && styles.createButtonDisabled]}
            onPress={handleCreate}
            disabled={creating}
          >
            {creating ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.createButtonText}>Create Session</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#1f2937',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: '600',
  },
  closeButton: {
    color: '#3b82f6',
    fontSize: 16,
  },
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#374151',
    borderRadius: 8,
    padding: 12,
    color: '#f3f4f6',
    fontSize: 15,
    fontFamily: 'monospace',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingVertical: 4,
  },
  toggleLabel: {
    color: '#f3f4f6',
    fontSize: 15,
  },
  recentsSection: {
    marginBottom: 16,
  },
  recentsTitle: {
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  recentsList: {
    maxHeight: 200,
  },
  recentItem: {
    backgroundColor: '#374151',
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
  },
  recentName: {
    color: '#f3f4f6',
    fontSize: 14,
    fontWeight: '500',
  },
  recentPath: {
    color: '#6b7280',
    fontSize: 12,
    marginTop: 2,
    fontFamily: 'monospace',
  },
  createButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  createButtonDisabled: {
    opacity: 0.6,
  },
  createButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
