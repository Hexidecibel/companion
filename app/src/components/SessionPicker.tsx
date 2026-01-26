import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { wsService } from '../services/websocket';

interface Session {
  id: string;
  name: string;
  projectPath?: string;
  lastActivity: number;
  isWaitingForInput: boolean;
  messageCount: number;
}

interface SessionPickerProps {
  currentSessionId?: string;
  onSessionChange?: (sessionId: string) => void;
}

export function SessionPicker({ currentSessionId, onSessionChange }: SessionPickerProps) {
  const [visible, setVisible] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(currentSessionId);
  const [loading, setLoading] = useState(false);

  const loadSessions = async () => {
    if (!wsService.isConnected()) return;

    setLoading(true);
    try {
      const response = await wsService.sendRequest('get_sessions');
      if (response.success && response.payload) {
        const payload = response.payload as { sessions: Session[]; activeSessionId: string };
        setSessions(payload.sessions);
        setActiveSessionId(payload.activeSessionId);
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible) {
      loadSessions();
    }
  }, [visible]);

  const handleSelectSession = async (sessionId: string) => {
    if (sessionId === activeSessionId) {
      setVisible(false);
      return;
    }

    try {
      const response = await wsService.sendRequest('switch_session', { sessionId });
      if (response.success) {
        setActiveSessionId(sessionId);
        onSessionChange?.(sessionId);
      }
    } catch (err) {
      console.error('Failed to switch session:', err);
    }

    setVisible(false);
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - timestamp;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  };

  const currentSession = sessions.find((s) => s.id === activeSessionId);
  const displayName = currentSession?.name || 'Select Session';

  if (sessions.length <= 1) {
    return null; // Don't show picker if only one session
  }

  return (
    <>
      <TouchableOpacity style={styles.pickerButton} onPress={() => setVisible(true)}>
        <Text style={styles.pickerButtonText} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={styles.pickerArrow}>v</Text>
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setVisible(false)}
        >
          <View style={styles.modalContent} onStartShouldSetResponder={() => true}>
            <Text style={styles.modalTitle}>Switch Session</Text>

            {loading ? (
              <ActivityIndicator size="small" color="#3b82f6" style={styles.loading} />
            ) : (
              <FlatList
                data={sessions}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={[
                      styles.sessionItem,
                      item.id === activeSessionId && styles.sessionItemActive,
                    ]}
                    onPress={() => handleSelectSession(item.id)}
                  >
                    <View style={styles.sessionInfo}>
                      <Text style={styles.sessionName}>{item.name}</Text>
                      {item.projectPath && (
                        <Text style={styles.sessionPath} numberOfLines={1}>
                          {item.projectPath}
                        </Text>
                      )}
                    </View>
                    <View style={styles.sessionMeta}>
                      {item.isWaitingForInput && (
                        <View style={styles.waitingBadge}>
                          <Text style={styles.waitingText}>!</Text>
                        </View>
                      )}
                      <Text style={styles.sessionTime}>{formatTime(item.lastActivity)}</Text>
                    </View>
                  </TouchableOpacity>
                )}
                style={styles.sessionList}
              />
            )}

            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setVisible(false)}
            >
              <Text style={styles.closeButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#374151',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    maxWidth: 160,
  },
  pickerButtonText: {
    color: '#f3f4f6',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  pickerArrow: {
    color: '#9ca3af',
    fontSize: 10,
    marginLeft: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#1f2937',
    borderRadius: 16,
    padding: 20,
    width: '85%',
    maxWidth: 360,
    maxHeight: '70%',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#f3f4f6',
    marginBottom: 16,
    textAlign: 'center',
  },
  loading: {
    marginVertical: 20,
  },
  sessionList: {
    maxHeight: 300,
  },
  sessionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#374151',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  sessionItemActive: {
    borderWidth: 1,
    borderColor: '#3b82f6',
  },
  sessionInfo: {
    flex: 1,
    marginRight: 8,
  },
  sessionName: {
    color: '#f3f4f6',
    fontSize: 14,
    fontWeight: '500',
  },
  sessionPath: {
    color: '#9ca3af',
    fontSize: 11,
    marginTop: 2,
  },
  sessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  waitingBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#f59e0b',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  waitingText: {
    color: '#000',
    fontSize: 12,
    fontWeight: 'bold',
  },
  sessionTime: {
    color: '#6b7280',
    fontSize: 11,
  },
  closeButton: {
    marginTop: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  closeButtonText: {
    color: '#9ca3af',
    fontSize: 16,
  },
});
