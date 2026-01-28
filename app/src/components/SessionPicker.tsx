import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { wsService } from '../services/websocket';
import { TmuxSessionInfo, DirectoryEntry } from '../types';
import { sessionGuard } from '../services/sessionGuard';

interface SessionPickerProps {
  currentSessionId?: string;
  onSessionChange?: (sessionId: string) => void;
  isOpen?: boolean;
  onClose?: () => void;
  onNewProject?: () => void;
}

export function SessionPicker({ currentSessionId, onSessionChange, isOpen, onClose, onNewProject }: SessionPickerProps) {
  const [visible, setVisible] = useState(false);

  // Sync with external isOpen prop
  React.useEffect(() => {
    if (isOpen !== undefined) {
      setVisible(isOpen);
    }
  }, [isOpen]);
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<string | undefined>(currentSessionId);
  const [loading, setLoading] = useState(false);
  const [homeDir, setHomeDir] = useState<string>('');

  // Directory browser state
  const [showBrowser, setShowBrowser] = useState(false);
  const [browsePath, setBrowsePath] = useState<string>('');
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    if (!wsService.isConnected()) return;

    setLoading(true);
    try {
      const response = await wsService.sendRequest('list_tmux_sessions', {});
      if (response.success && response.payload) {
        const payload = response.payload as {
          sessions: TmuxSessionInfo[];
          activeSession: string;
          homeDir: string;
        };
        setSessions(payload.sessions);
        // Only use daemon's activeSession if we don't have a currentSessionId from parent
        // This prevents overwriting the session that user clicked on from dashboard
        if (!currentSessionId) {
          setActiveSession(payload.activeSession);
        }
        setHomeDir(payload.homeDir);
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
    } finally {
      setLoading(false);
    }
  }, [currentSessionId]);

  const browseDirectory = useCallback(async (path: string) => {
    setBrowseLoading(true);
    try {
      const response = await wsService.sendRequest('browse_directories', { path });
      if (response.success && response.payload) {
        const payload = response.payload as {
          currentPath: string;
          entries: DirectoryEntry[];
        };
        setBrowsePath(payload.currentPath);
        setDirectories(payload.entries);
      }
    } catch (err) {
      console.error('Failed to browse directory:', err);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      loadSessions();
    }
  }, [visible, loadSessions]);

  const handleSelectSession = async (session: TmuxSessionInfo) => {
    if (session.name === activeSession) {
      setVisible(false);
      return;
    }

    setLoading(true);
    try {
      // Begin switch in sessionGuard BEFORE sending request
      // Use the encoded working dir as session ID (daemon format)
      const expectedSessionId = session.workingDir
        ? session.workingDir.replace(/\//g, '-')
        : session.name;
      const epoch = sessionGuard.beginSwitch(expectedSessionId);
      console.log(`SessionPicker: Switching to ${session.name} (session: ${expectedSessionId}, epoch: ${epoch})`);

      const response = await wsService.sendRequest('switch_tmux_session', {
        sessionName: session.name,
      });
      if (response.success) {
        const payload = response.payload as { conversationSessionId?: string };
        // Use conversationSessionId from response if available (more accurate)
        const actualSessionId = payload?.conversationSessionId || expectedSessionId;

        // If daemon returned a different session ID, update the guard
        if (actualSessionId !== expectedSessionId) {
          sessionGuard.beginSwitch(actualSessionId);
        }

        setActiveSession(session.name);
        setVisible(false);
        onClose?.();
        // Pass the conversation session ID, not tmux name
        onSessionChange?.(actualSessionId);
      } else {
        Alert.alert('Error', response.error || 'Failed to switch session');
      }
    } catch (err) {
      console.error('Failed to switch session:', err);
      Alert.alert('Error', 'Failed to switch session');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSession = async (dirPath: string) => {
    try {
      setLoading(true);

      // Begin switch in sessionGuard - use encoded path as session ID
      const expectedSessionId = dirPath.replace(/\//g, '-');
      const epoch = sessionGuard.beginSwitch(expectedSessionId);
      console.log(`SessionPicker: Creating session for ${dirPath} (session: ${expectedSessionId}, epoch: ${epoch})`);

      const response = await wsService.sendRequest('create_tmux_session', {
        workingDir: dirPath,
        startClaude: true,
      });
      if (response.success && response.payload) {
        const payload = response.payload as { sessionName: string; workingDir?: string };
        setActiveSession(payload.sessionName);
        // Pass the conversation session ID (encoded path)
        onSessionChange?.(expectedSessionId);
        setShowBrowser(false);
        setVisible(false);
        Alert.alert('Success', `Created session in ${dirPath.split('/').pop()}`);
      } else {
        Alert.alert('Error', response.error || 'Failed to create session');
      }
    } catch (err) {
      console.error('Failed to create session:', err);
      Alert.alert('Error', 'Failed to create session');
    } finally {
      setLoading(false);
    }
  };

  const handleKillSession = (session: TmuxSessionInfo) => {
    Alert.alert(
      'Kill Session',
      `Kill "${session.workingDir?.split('/').pop() || session.name}"?\nThis will terminate Claude in this session.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Kill',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await wsService.sendRequest('kill_tmux_session', {
                sessionName: session.name,
              });
              if (response.success) {
                loadSessions();
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
  };

  const formatTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  // Find current session by matching conversation session ID (encoded path) or tmux name
  const currentSession = sessions.find((s) => {
    // Match by encoded working dir (conversation session ID format)
    if (currentSessionId && s.workingDir) {
      const encodedPath = s.workingDir.replace(/\//g, '-');
      if (encodedPath === currentSessionId || `-${encodedPath}` === currentSessionId) {
        return true;
      }
    }
    // Fallback to tmux session name match
    return s.name === activeSession;
  });
  const displayName = currentSession?.workingDir?.split('/').pop() || activeSession || 'Sessions';

  const renderSessionItem = ({ item }: { item: TmuxSessionInfo }) => {
    // Check if this is the active session by name or by encoded working dir
    let isActive = item.name === activeSession;
    if (currentSessionId && item.workingDir) {
      const encodedPath = item.workingDir.replace(/\//g, '-');
      if (encodedPath === currentSessionId || `-${encodedPath}` === currentSessionId) {
        isActive = true;
      }
    }
    const dirName = item.workingDir?.split('/').pop() || item.name;

    return (
      <TouchableOpacity
        style={[styles.sessionItem, isActive && styles.sessionItemActive]}
        onPress={() => handleSelectSession(item)}
        onLongPress={() => handleKillSession(item)}
      >
        <View style={styles.sessionInfo}>
          <Text style={[styles.sessionName, isActive && styles.sessionNameActive]}>
            {dirName}
          </Text>
          <Text style={styles.sessionPath} numberOfLines={1}>
            {item.workingDir || item.name}
          </Text>
        </View>
        <View style={styles.sessionMeta}>
          {item.attached && (
            <View style={styles.attachedBadge}>
              <Text style={styles.attachedText}>•</Text>
            </View>
          )}
          <Text style={styles.sessionTime}>{formatTime(item.created)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderDirectoryItem = ({ item }: { item: DirectoryEntry }) => (
    <TouchableOpacity
      style={styles.directoryItem}
      onPress={() => {
        if (item.isDirectory) {
          browseDirectory(item.path);
        }
      }}
    >
      <Text style={styles.directoryIcon}>{item.name === '..' ? '↑' : '📁'}</Text>
      <Text style={styles.directoryName} numberOfLines={1}>
        {item.name}
      </Text>
    </TouchableOpacity>
  );

  return (
    <>
      <TouchableOpacity style={styles.pickerButton} onPress={() => setVisible(true)}>
        <Text style={styles.pickerButtonText} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={styles.pickerArrow}>▼</Text>
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (showBrowser) {
            setShowBrowser(false);
          } else {
            setVisible(false);
            onClose?.();
          }
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {showBrowser ? 'Select Directory' : 'Claude Sessions'}
              </Text>
              <TouchableOpacity
                style={styles.closeButton}
                onPress={() => {
                  if (showBrowser) {
                    setShowBrowser(false);
                  } else {
                    setVisible(false);
                    onClose?.();
                  }
                }}
              >
                <Text style={styles.closeText}>×</Text>
              </TouchableOpacity>
            </View>

            {showBrowser ? (
              <>
                <View style={styles.pathBar}>
                  <Text style={styles.pathText} numberOfLines={1}>
                    {browsePath}
                  </Text>
                </View>

                {browseLoading ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#3b82f6" />
                  </View>
                ) : (
                  <FlatList
                    data={directories}
                    keyExtractor={(item) => item.path}
                    renderItem={renderDirectoryItem}
                    style={styles.list}
                  />
                )}

                <View style={styles.footer}>
                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => setShowBrowser(false)}
                  >
                    <Text style={styles.cancelButtonText}>Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.createButton, loading && styles.createButtonDisabled]}
                    onPress={() => handleCreateSession(browsePath)}
                    disabled={loading}
                  >
                    {loading ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.createButtonText}>Start Claude Here</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                {loading ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#3b82f6" />
                  </View>
                ) : sessions.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>No active sessions</Text>
                    <Text style={styles.emptySubtext}>
                      Create a new session to start Claude in a directory
                    </Text>
                  </View>
                ) : (
                  <FlatList
                    data={sessions}
                    keyExtractor={(item) => item.name}
                    renderItem={renderSessionItem}
                    style={styles.list}
                  />
                )}

                <View style={styles.footer}>
                  {onNewProject && (
                    <TouchableOpacity
                      style={[styles.newSessionButton, styles.newProjectButton]}
                      onPress={() => {
                        setVisible(false);
                        onClose?.();
                        onNewProject();
                      }}
                    >
                      <Text style={styles.newSessionButtonText}>+ New Project</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={styles.newSessionButton}
                    onPress={() => {
                      setShowBrowser(true);
                      browseDirectory(homeDir || '/');
                    }}
                  >
                    <Text style={styles.newSessionButtonText}>+ New Session</Text>
                  </TouchableOpacity>
                </View>

                {sessions.length > 0 && (
                  <Text style={styles.hint}>Long press a session to kill it</Text>
                )}
              </>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#374151',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    marginTop: 6,
  },
  pickerButtonText: {
    color: '#f3f4f6',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  pickerArrow: {
    color: '#9ca3af',
    fontSize: 8,
    marginLeft: 6,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#1f2937',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#f3f4f6',
  },
  closeButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeText: {
    fontSize: 28,
    color: '#9ca3af',
    lineHeight: 28,
  },
  list: {
    maxHeight: 350,
  },
  sessionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  sessionItemActive: {
    backgroundColor: '#1e3a5f',
  },
  sessionInfo: {
    flex: 1,
    marginRight: 12,
  },
  sessionName: {
    fontSize: 16,
    fontWeight: '500',
    color: '#f3f4f6',
    marginBottom: 4,
  },
  sessionNameActive: {
    color: '#60a5fa',
  },
  sessionPath: {
    fontSize: 12,
    color: '#9ca3af',
  },
  sessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  attachedBadge: {
    marginRight: 8,
  },
  attachedText: {
    color: '#10b981',
    fontSize: 20,
  },
  sessionTime: {
    color: '#6b7280',
    fontSize: 11,
  },
  directoryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  directoryIcon: {
    fontSize: 18,
    marginRight: 12,
  },
  directoryName: {
    flex: 1,
    fontSize: 15,
    color: '#f3f4f6',
  },
  pathBar: {
    backgroundColor: '#111827',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  pathText: {
    fontSize: 12,
    color: '#9ca3af',
    fontFamily: 'monospace',
  },
  loadingContainer: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyContainer: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: '#9ca3af',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: '#374151',
  },
  newSessionButton: {
    flex: 1,
    backgroundColor: '#3b82f6',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  newProjectButton: {
    backgroundColor: '#10b981',
    marginRight: 8,
  },
  newSessionButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    flex: 1,
    backgroundColor: '#374151',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginRight: 12,
  },
  cancelButtonText: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: '600',
  },
  createButton: {
    flex: 2,
    backgroundColor: '#10b981',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  createButtonDisabled: {
    opacity: 0.6,
  },
  createButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    fontSize: 11,
    color: '#6b7280',
    textAlign: 'center',
    paddingBottom: 16,
  },
});
