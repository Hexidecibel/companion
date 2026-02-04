import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Platform,
  Alert,
  ActivityIndicator,
  Modal,
  Switch,
  ScrollView,
  Keyboard,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Server, ConversationHighlight, AgentTree, SubAgent } from '../types';
import { SubAgentDetailScreen } from './SubAgentDetailScreen';
import { useConnection } from '../hooks/useConnection';
import { useConversation } from '../hooks/useConversation';
// StatusIndicator replaced by inline connection dot in header
import { ConversationItem } from '../components/ConversationItem';
import { InputBar } from '../components/InputBar';
import { SessionPicker } from '../components/SessionPicker';
import { FileViewer } from '../components/FileViewer';
import { MessageViewer } from '../components/MessageViewer';
import { getSessionSettings, saveSessionSettings, SessionSettings } from '../services/storage';
import { wsService } from '../services/websocket';
import { messageQueue, QueuedMessage } from '../services/messageQueue';
import { sessionGuard } from '../services/sessionGuard';
import { useFontScale } from '../hooks/useFontScale';
import Ionicons from '@expo/vector-icons/Ionicons';

interface SessionViewProps {
  server: Server;
  onBack: () => void;
  initialSessionId?: string | null;
  onNewProject?: () => void;
  onOpenTerminal?: (sessionName: string) => void;
}

export function SessionView({ server, onBack, initialSessionId, onNewProject, onOpenTerminal }: SessionViewProps) {
  const { connectionState, isConnected, isConnecting, reconnect } = useConnection(server);
  const {
    highlights,
    status,
    loading,
    loadingMore,
    hasMore,
    error,
    refresh,
    loadMore,
    sendInput,
    sendImage,
    uploadImage,
    sendWithImages,
    otherSessionActivity,
    dismissOtherSessionActivity,
    tmuxSessionMissing,
    dismissTmuxSessionMissing,
    recreateTmuxSession,
  } = useConversation();

  const data = highlights;
  const fontScale = useFontScale();

  // Simple scroll state - no complex auto-scroll logic
  const scrollViewRef = useRef<ScrollView>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [terminalLoading, setTerminalLoading] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isNearBottom = useRef(true);
  const contentHeight = useRef(0);
  const scrollViewHeight = useRef(0);
  const lastDataLength = useRef(0);
  const shouldScrollOnLoad = useRef(true); // Scroll to bottom on session enter

  // Track content height for scroll position preservation after prepending
  const prevContentHeight = useRef(0);
  const isLoadingMoreRef = useRef(false);

  // Track scroll position to show/hide scroll button and trigger load-more
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    isNearBottom.current = distanceFromBottom < 100;
    setShowScrollButton(distanceFromBottom > 150);
    if (isNearBottom.current) {
      setHasNewMessages(false);
    }

    // Detect scroll near top to trigger load-more
    if (contentOffset.y < 200 && hasMore && !isLoadingMoreRef.current) {
      isLoadingMoreRef.current = true;
      prevContentHeight.current = contentSize.height;
      loadMore().finally(() => {
        isLoadingMoreRef.current = false;
      });
    }
  }, [hasMore, loadMore]);

  // Scroll to bottom helper
  const scrollToBottom = useCallback((animated = true) => {
    scrollViewRef.current?.scrollToEnd({ animated });
    setHasNewMessages(false);
    setShowScrollButton(false);
  }, []);

  // Preserve scroll position after prepending older items
  const handleContentSizeChange = useCallback((_w: number, h: number) => {
    contentHeight.current = h;
    if (prevContentHeight.current > 0 && h > prevContentHeight.current) {
      const heightDiff = h - prevContentHeight.current;
      // Scroll down by the amount of content that was prepended
      scrollViewRef.current?.scrollTo({ y: heightDiff, animated: false });
      prevContentHeight.current = 0;
    }
  }, []);

  // When data changes, mark new messages if not at bottom
  useEffect(() => {
    if (data.length > lastDataLength.current && !isNearBottom.current) {
      setHasNewMessages(true);
    }
    lastDataLength.current = data.length;
  }, [data.length]);

  // Scroll to bottom on session enter/switch
  useEffect(() => {
    if (data.length > 0 && shouldScrollOnLoad.current) {
      shouldScrollOnLoad.current = false;
      setTimeout(() => scrollToBottom(false), 100);
    }
  }, [data.length, scrollToBottom]);

  // Session mute state (synced with daemon)
  const [mutedSessions, setMutedSessions] = useState<Set<string>>(new Set());

  const [showSettings, setShowSettings] = useState(false);
  const [sessionSettings, setSessionSettings] = useState<SessionSettings>({ instantNotify: false, autoApproveEnabled: false, showAgentsBar: false });
  const [showActivityModal, setShowActivityModal] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [viewingMessage, setViewingMessage] = useState<{ content: string; timestamp: number } | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [agentTree, setAgentTree] = useState<AgentTree | null>(null);
  const [showAgentsModal, setShowAgentsModal] = useState(false);
  const [viewingAgentDetail, setViewingAgentDetail] = useState<{ agentId: string; agent?: SubAgent } | null>(null);
  const [showCompletedAgents, setShowCompletedAgents] = useState(false);

  // Subscribe to message queue updates
  useEffect(() => {
    const unsubscribe = messageQueue.subscribe((queue) => {
      const forThisServer = queue.filter((m) => m.serverId === server.id);
      setQueuedMessages(forThisServer);
    });
    return unsubscribe;
  }, [server.id]);

  // Poll for sub-agent activity
  useEffect(() => {
    if (!isConnected) {
      setAgentTree(null);
      return;
    }

    const fetchAgentTree = async () => {
      try {
        // Extract session ID from conversation path (filename without .jsonl)
        let sessionId: string | undefined;
        if (status?.conversationId) {
          const filename = status.conversationId.split('/').pop() || '';
          sessionId = filename.replace('.jsonl', '');
        }

        const response = await wsService.sendRequest('get_agent_tree', { sessionId });
        if (response.success && response.payload) {
          setAgentTree(response.payload as AgentTree);
        }
      } catch {
        // Silent fail on poll
      }
    };

    // Initial fetch
    fetchAgentTree();

    // Poll every 5 seconds
    const interval = setInterval(fetchAgentTree, 5000);
    return () => clearInterval(interval);
  }, [isConnected, status?.conversationId]);

  const cancelQueuedMessage = useCallback(async (id: string) => {
    await messageQueue.dequeue(id);
  }, []);

  // Handle keyboard on Android
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Load session settings
  useEffect(() => {
    getSessionSettings(server.id).then(setSessionSettings);
  }, [server.id]);

  // Fetch muted sessions from daemon and listen for changes
  useEffect(() => {
    if (!isConnected || !wsService.isConnected()) return;

    // Fetch initial mute state
    wsService.sendRequest('get_muted_sessions').then((response) => {
      if (response.success && response.payload) {
        const payload = response.payload as { sessionIds: string[] };
        setMutedSessions(new Set(payload.sessionIds ?? []));
      }
    });

    // Listen for mute changes from other clients (web, etc.)
    const unsubscribe = wsService.onMessage((msg) => {
      if (msg.type === 'session_mute_changed' && msg.payload) {
        const payload = msg.payload as { sessionId: string; muted: boolean };
        setMutedSessions(prev => {
          const next = new Set(prev);
          if (payload.muted) {
            next.add(payload.sessionId);
          } else {
            next.delete(payload.sessionId);
          }
          return next;
        });
      }
    });

    return unsubscribe;
  }, [isConnected]);

  const handleToggleMute = useCallback(async (sessionId: string) => {
    const currentlyMuted = mutedSessions.has(sessionId);
    const newMuted = !currentlyMuted;

    // Optimistic update
    setMutedSessions(prev => {
      const next = new Set(prev);
      if (newMuted) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });

    if (wsService.isConnected()) {
      const response = await wsService.sendRequest('set_session_muted', {
        sessionId,
        muted: newMuted,
      });

      if (!response.success) {
        // Revert on failure
        setMutedSessions(prev => {
          const next = new Set(prev);
          if (currentlyMuted) next.add(sessionId);
          else next.delete(sessionId);
          return next;
        });
      }
    }
  }, [mutedSessions]);

  // Show alert when tmux session is missing
  useEffect(() => {
    if (tmuxSessionMissing) {
      const { sessionName, canRecreate, savedConfig } = tmuxSessionMissing;

      if (canRecreate && savedConfig) {
        Alert.alert(
          'Tmux Session Missing',
          `The tmux session "${sessionName}" was deleted.\n\nRecreate it in:\n${savedConfig.workingDir}?`,
          [
            {
              text: 'Cancel',
              style: 'cancel',
              onPress: dismissTmuxSessionMissing,
            },
            {
              text: 'Recreate',
              onPress: async () => {
                const success = await recreateTmuxSession();
                if (!success) {
                  Alert.alert('Error', 'Failed to recreate the tmux session');
                }
              },
            },
          ]
        );
      } else {
        Alert.alert(
          'Tmux Session Missing',
          `The tmux session "${sessionName}" does not exist and cannot be automatically recreated.\n\nPlease create a new tmux session on the server.`,
          [{ text: 'OK', onPress: dismissTmuxSessionMissing }]
        );
      }
    }
  }, [tmuxSessionMissing, dismissTmuxSessionMissing, recreateTmuxSession]);

  const handleInstantNotifyChange = useCallback(async (value: boolean) => {
    const newSettings = { ...sessionSettings, instantNotify: value };
    setSessionSettings(newSettings);
    await saveSessionSettings(server.id, newSettings);

    // Tell daemon about the preference
    if (wsService.isConnected()) {
      wsService.sendRequest('set_instant_notify', { enabled: value });
    }
  }, [server.id, sessionSettings]);

  const handleAutoApproveChange = useCallback(async (value: boolean) => {
    const newSettings = { ...sessionSettings, autoApproveEnabled: value };
    setSessionSettings(newSettings);
    await saveSessionSettings(server.id, newSettings);

    // Tell daemon to enable/disable auto-approve
    if (wsService.isConnected()) {
      wsService.sendRequest('set_auto_approve', { enabled: value });
    }
  }, [server.id, sessionSettings]);

  // Auto-scroll disabled - was too aggressive and prevented reading history
  // User can tap the scroll-to-bottom button when needed

  const lastSwitchedSessionId = useRef<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(initialSessionId || undefined);

  // Reset switch tracking when connection drops so we re-switch on reconnect
  useEffect(() => {
    if (!isConnected) {
      lastSwitchedSessionId.current = null;
    }
  }, [isConnected]);

  // Refresh when connection is established and sync settings
  useEffect(() => {
    if (isConnected && wsService.isConnected()) {
      const init = async () => {
        // Switch to initial session if specified and different from last switched
        const isSwitching = initialSessionId && initialSessionId !== lastSwitchedSessionId.current;
        if (isSwitching) {
          lastSwitchedSessionId.current = initialSessionId;
          setCurrentSessionId(initialSessionId);

          // CRITICAL: Begin switch in sessionGuard BEFORE sending request
          // This invalidates any in-flight requests from previous session
          const epoch = sessionGuard.beginSwitch(initialSessionId);

          // Fire switch_session without awaiting - the daemon sets the active
          // session synchronously before yielding for tmux lookup, so by the
          // time get_highlights is processed the session is already switched.
          wsService.sendRequest('switch_session', {
            sessionId: initialSessionId,
            epoch,
          }).catch(e => console.error('Failed to switch session:', e));
        } else if (initialSessionId && !sessionGuard.getCurrentSessionId()) {
          // First load - set session in guard without incrementing epoch
          sessionGuard.beginSwitch(initialSessionId);
          setCurrentSessionId(initialSessionId);
        }

        // Fetch data immediately - don't wait for switch_session response
        refresh(!!isSwitching);
        // Sync session preferences with daemon (fire-and-forget)
        getSessionSettings(server.id).then(settings => {
          if (settings.instantNotify) {
            wsService.sendRequest('set_instant_notify', { enabled: true });
          }
          if (settings.autoApproveEnabled) {
            wsService.sendRequest('set_auto_approve', { enabled: true });
          }
        });
        // Only reset scroll state when switching sessions, not on every reconnect
        if (isSwitching) {
          lastDataLength.current = 0;
          shouldScrollOnLoad.current = true;
          setShowScrollButton(false);
          setHasNewMessages(false);
        }
      };

      init();
    }
  }, [isConnected, refresh, server.id, initialSessionId]);

  const handleSendInput = async (text: string): Promise<boolean> => {
    // Don't auto-scroll - let user control scroll position
    // They can tap the scroll button if they want to go to bottom
    return sendInput(text);
  };

  const handleSessionChange = useCallback((newSessionId?: string) => {
    // If a new session ID is provided, update the guard
    if (newSessionId) {
      const epoch = sessionGuard.beginSwitch(newSessionId);
      console.log(`SessionView: Session changed to ${newSessionId} (epoch ${epoch})`);
      lastSwitchedSessionId.current = newSessionId;
      setCurrentSessionId(newSessionId);
    }
    lastDataLength.current = 0;
    shouldScrollOnLoad.current = true;
    setShowScrollButton(false);
    setHasNewMessages(false);
    refresh(true);
  }, [refresh]);

  const handleSlashCommand = useCallback((command: string) => {
    switch (command) {
      case '/switch':
        setShowSessionPicker(true);
        break;
      case '/refresh':
        refresh(true);
        break;
    }
  }, [refresh]);

  const handleSwitchToOtherSession = useCallback(async () => {
    if (!otherSessionActivity) return;

    // Get the conversation session ID from the activity
    const newSessionId = otherSessionActivity.sessionId;

    // Begin switch in guard BEFORE sending request
    const epoch = sessionGuard.beginSwitch(newSessionId);
    console.log(`SessionView: Switching to other session ${newSessionId} (epoch ${epoch})`);

    try {
      // Use switch_session (not switch_tmux_session) - it accepts conversation
      // session IDs and handles the tmux mapping internally
      const response = await wsService.sendRequest('switch_session', {
        sessionId: newSessionId,
        epoch,
      });
      if (response.success) {
        lastSwitchedSessionId.current = newSessionId;
        setCurrentSessionId(newSessionId);
        dismissOtherSessionActivity();
        lastDataLength.current = 0;
        shouldScrollOnLoad.current = true;
        setShowScrollButton(false);
        setHasNewMessages(false);
        refresh(true);
      }
    } catch (err) {
      console.error('Failed to switch session:', err);
    }
  }, [otherSessionActivity, dismissOtherSessionActivity, refresh]);

  const handleSelectOption = async (option: string) => {
    await handleSendInput(option);
  };

  const handleCancel = () => {
    Alert.alert(
      'Cancel Request',
      'Send interrupt signal to session?',
      [
        { text: 'No', style: 'cancel' },
        { text: 'Yes', onPress: () => sendInput('\x03') }, // Ctrl+C
      ]
    );
  };

  const formatDuration = (start: number, end?: number): string => {
    const endTime = end || Date.now();
    const seconds = Math.floor((endTime - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  };

  const renderEmptyContent = () => {
    if (isConnecting) {
      return (
        <View style={styles.emptyContainer}>
          <ActivityIndicator size="large" color="#3b82f6" />
          <Text style={styles.emptyTitle}>Connecting...</Text>
          <Text style={styles.emptyText}>
            Establishing connection to {server.name}
          </Text>
        </View>
      );
    }

    if (!isConnected) {
      return (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>Not Connected</Text>
          <Text style={styles.emptyText}>
            {connectionState.error || 'Unable to connect to server'}
          </Text>
          <TouchableOpacity style={styles.retryButton} onPress={reconnect}>
            <Text style={styles.retryButtonText}>Retry Connection</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (loading) {
      return (
        <View style={styles.emptyContainer}>
          <ActivityIndicator size="large" color="#3b82f6" />
          <Text style={styles.emptyTitle}>Loading Messages...</Text>
          <Text style={styles.emptyText}>Fetching conversation history</Text>
        </View>
      );
    }

    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle}>No Messages</Text>
        <Text style={styles.emptyText}>
          Start a coding session on your server to see messages here
        </Text>
      </View>
    );
  };

  // On Android, use manual keyboard padding
  const androidPadding = Platform.OS === 'android'
    ? keyboardHeight > 0
      ? keyboardHeight + 30  // When keyboard open
      : 20                    // When keyboard closed
    : 0;
  const containerStyle = Platform.OS === 'android'
    ? [styles.container, { paddingBottom: androidPadding }]
    : styles.container;

  return (
    <View style={containerStyle}>
      <LinearGradient colors={['#1a2744', '#1f1a3d']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.connectionDot}
          onPress={() => {
            if (connectionState.status === 'error' || connectionState.status === 'disconnected') {
              reconnect();
            }
          }}
        >
          <View style={[styles.connectionDotInner, {
            backgroundColor:
              connectionState.status === 'connected'
                ? (status?.isWaitingForInput ? '#eab308' : '#22c55e')
                : connectionState.status === 'connecting' || connectionState.status === 'reconnecting'
                  ? '#f97316'
                  : connectionState.status === 'error'
                    ? '#ef4444'
                    : '#6b7280',
          }]} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {server.name}
          </Text>
          {isConnected && (
            <SessionPicker
              currentSessionId={currentSessionId}
              onSessionChange={handleSessionChange}
              isOpen={showSessionPicker}
              onClose={() => setShowSessionPicker(false)}
              onNewProject={onNewProject}
              isConnected={isConnected}
            />
          )}
        </View>
        {onOpenTerminal && (
          <TouchableOpacity
            style={styles.headerIconButton}
            onPress={async () => {
              if (terminalLoading) return;
              setTerminalLoading(true);
              try {
                const response = await wsService.sendRequest('list_tmux_sessions', {});
                if (response.success && response.payload) {
                  const payload = response.payload as { activeSession: string };
                  if (payload.activeSession) {
                    onOpenTerminal(payload.activeSession);
                  }
                }
              } catch {
                // Ignore errors
              } finally {
                setTerminalLoading(false);
              }
            }}
            onLongPress={() => Alert.alert('Terminal', 'Open tmux terminal view')}
            disabled={terminalLoading}
          >
            {terminalLoading ? (
              <ActivityIndicator size="small" color="#9ca3af" />
            ) : (
              <Ionicons name="terminal-outline" size={20} color="#9ca3af" />
            )}
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={() => refresh()}
          onLongPress={() => Alert.alert('Refresh', 'Reload conversation')}
          disabled={loading}
        >
          <Ionicons name="refresh" size={20} color={loading ? '#4b5563' : '#9ca3af'} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.autoApproveButton,
            sessionSettings.autoApproveEnabled && styles.autoApproveButtonActive,
          ]}
          onPress={() => handleAutoApproveChange(!sessionSettings.autoApproveEnabled)}
          onLongPress={() => Alert.alert('Auto-Approve', sessionSettings.autoApproveEnabled ? 'Tool calls are auto-approved. Tap to disable.' : 'Tool calls require manual approval. Tap to enable auto-approve.')}
        >
          <Ionicons
            name={sessionSettings.autoApproveEnabled ? 'shield-checkmark' : 'shield-outline'}
            size={18}
            color={sessionSettings.autoApproveEnabled ? '#fbbf24' : '#6b7280'}
          />
        </TouchableOpacity>
        {currentSessionId && (
          <TouchableOpacity
            style={[
              styles.muteButton,
              mutedSessions.has(currentSessionId) && styles.muteButtonActive,
            ]}
            onPress={() => handleToggleMute(currentSessionId)}
            onLongPress={() => Alert.alert(
              'Mute',
              mutedSessions.has(currentSessionId)
                ? 'Notifications are muted for this session. Tap to unmute.'
                : 'Notifications are enabled for this session. Tap to mute.'
            )}
          >
            <Ionicons
              name={mutedSessions.has(currentSessionId) ? 'notifications-off' : 'notifications-outline'}
              size={18}
              color={mutedSessions.has(currentSessionId) ? '#ef4444' : '#9ca3af'}
            />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={() => setShowSettings(true)}
          onLongPress={() => Alert.alert('Settings', 'Session settings')}
        >
          <Ionicons name="settings-outline" size={20} color="#9ca3af" />
        </TouchableOpacity>
      </LinearGradient>

      {/* Session Settings Modal */}
      <Modal
        visible={showSettings}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSettings(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowSettings(false)}
        >
          <View style={styles.modalContent} onStartShouldSetResponder={() => true}>
            <Text style={styles.modalTitle}>Session Settings</Text>

            {currentSessionId && (
              <View style={styles.modalRow}>
                <View style={styles.modalRowInfo}>
                  <Text style={styles.modalRowLabel}>Mute Session</Text>
                  <Text style={styles.modalRowDescription}>
                    Suppress all notifications for this session
                  </Text>
                </View>
                <Switch
                  value={mutedSessions.has(currentSessionId)}
                  onValueChange={() => handleToggleMute(currentSessionId)}
                  trackColor={{ false: '#374151', true: '#ef4444' }}
                />
              </View>
            )}

            <View style={styles.modalRow}>
              <View style={styles.modalRowInfo}>
                <Text style={styles.modalRowLabel}>Instant Notify</Text>
                <Text style={styles.modalRowDescription}>
                  Get notified immediately instead of waiting 1 minute
                </Text>
              </View>
              <Switch
                value={sessionSettings.instantNotify}
                onValueChange={handleInstantNotifyChange}
                trackColor={{ false: '#374151', true: '#3b82f6' }}
              />
            </View>

            <View style={styles.modalRow}>
              <View style={styles.modalRowInfo}>
                <Text style={styles.modalRowLabel}>Show Agents Bar</Text>
                <Text style={styles.modalRowDescription}>
                  Show sub-agent activity below the header
                </Text>
              </View>
              <Switch
                value={sessionSettings.showAgentsBar}
                onValueChange={(value) => {
                  const updated = { ...sessionSettings, showAgentsBar: value };
                  setSessionSettings(updated);
                  saveSessionSettings(server.id, updated);
                }}
                trackColor={{ false: '#374151', true: '#3b82f6' }}
              />
            </View>

            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => setShowSettings(false)}
            >
              <Text style={styles.modalCloseButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Connection issue banner - only show when NOT connected */}
      {data.length > 0 && connectionState.status !== 'connected' && (
        <TouchableOpacity
          style={styles.connectionBanner}
          onPress={reconnect}
          activeOpacity={0.8}
        >
          <View style={[styles.connectionBannerDot, {
            backgroundColor:
              connectionState.status === 'connecting' || connectionState.status === 'reconnecting'
                ? '#f97316' : '#ef4444',
          }]} />
          <Text style={styles.connectionBannerText}>
            {connectionState.status === 'connecting' ? 'Connecting...'
              : connectionState.status === 'reconnecting' ? `Reconnecting (${connectionState.reconnectAttempts})...`
              : connectionState.status === 'error' ? (connectionState.error || 'Connection error')
              : 'Disconnected'}
          </Text>
          {(connectionState.status === 'error' || connectionState.status === 'disconnected') && (
            <Text style={styles.connectionBannerRetry}>Retry</Text>
          )}
        </TouchableOpacity>
      )}

      {/* Other session activity notification */}
      {otherSessionActivity && (
        <TouchableOpacity
          style={styles.otherSessionBanner}
          onPress={handleSwitchToOtherSession}
          activeOpacity={0.8}
        >
          <View style={styles.otherSessionContent}>
            <Text style={styles.otherSessionBadge}>
              {otherSessionActivity.isWaitingForInput ? '⏳' : '💬'}
            </Text>
            <View style={styles.otherSessionInfo}>
              <Text style={styles.otherSessionName}>
                {otherSessionActivity.sessionName}
              </Text>
              <Text style={styles.otherSessionMessage} numberOfLines={1}>
                {otherSessionActivity.isWaitingForInput
                  ? 'Waiting for input'
                  : otherSessionActivity.newMessageCount > 0
                    ? `${otherSessionActivity.newMessageCount} new message${otherSessionActivity.newMessageCount > 1 ? 's' : ''}`
                    : 'New activity'}
              </Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.otherSessionDismiss}
            onPress={(e) => {
              e.stopPropagation();
              dismissOtherSessionActivity();
            }}
          >
            <Text style={styles.otherSessionDismissText}>×</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* Unified activity bar - combines processing status and agents */}
      {(() => {
        const hasActivity = isConnected && status?.currentActivity;
        const runningAgents = agentTree?.agents.filter(a => a.status === 'running') || [];
        const hasAgents = isConnected && runningAgents.length > 0 && sessionSettings.showAgentsBar;
        if (!hasActivity && !hasAgents) return null;

        return (
          <View style={styles.unifiedActivityBar}>
            {/* Processing row */}
            {hasActivity && (
              <TouchableOpacity
                style={[styles.activityRow, hasAgents && styles.activityRowWithAgents]}
                onPress={() => setShowActivityModal(true)}
                activeOpacity={0.8}
              >
                <ActivityIndicator size="small" color="#60a5fa" style={styles.activitySpinner} />
                <Text style={styles.activityText} numberOfLines={1}>
                  {status!.currentActivity}
                </Text>
                <TouchableOpacity style={styles.activityCancelButton} onPress={handleCancel}>
                  <Text style={styles.activityCancelText}>Cancel</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            )}
            {/* Agents row */}
            {hasAgents && (
              <TouchableOpacity
                style={styles.agentsRow}
                onPress={() => setShowAgentsModal(true)}
                activeOpacity={0.8}
              >
                <View style={styles.subAgentsDot} />
                <Text style={styles.subAgentsText} numberOfLines={1}>
                  {runningAgents.length === 1
                    ? (runningAgents[0].currentActivity || runningAgents[0].description || runningAgents[0].slug || 'Sub-agent running')
                    : `${runningAgents.length} agents` + (runningAgents[0].currentActivity ? ` · ${runningAgents[0].currentActivity}` : '')}
                </Text>
                <Ionicons name="chevron-forward" size={14} color="#86efac" />
              </TouchableOpacity>
            )}
          </View>
        );
      })()}

      {/* Activity Output Modal */}
      <Modal
        visible={showActivityModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowActivityModal(false)}
      >
        <View style={styles.activityModalOverlay}>
          <View style={styles.activityModalContent}>
            <View style={styles.activityModalHeader}>
              <Text style={styles.activityModalTitle}>Recent Activity</Text>
              <TouchableOpacity
                style={styles.activityModalClose}
                onPress={() => setShowActivityModal(false)}
              >
                <Text style={styles.activityModalCloseText}>×</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.activityModalScroll}>
              {/* Current activity */}
              {status?.currentActivity && (
                <View style={styles.activityItem}>
                  <View style={styles.activityItemHeader}>
                    <ActivityIndicator size="small" color="#60a5fa" />
                    <Text style={styles.activityItemTitle}>Now</Text>
                  </View>
                  <Text style={styles.activityItemSummary}>{status.currentActivity}</Text>
                </View>
              )}

              {/* Recent activity history */}
              {status?.recentActivity && status.recentActivity.length > 0 ? (
                status.recentActivity.map((activity, idx) => (
                  <View key={idx} style={styles.activityItem}>
                    <View style={styles.activityItemHeader}>
                      <Text style={styles.activityItemTool}>{activity.toolName || 'Action'}</Text>
                    </View>
                    {activity.input && (
                      <Text style={styles.activityItemInput} numberOfLines={2}>
                        {activity.input}
                      </Text>
                    )}
                    {activity.output && (
                      <View style={styles.activityOutputBox}>
                        <Text style={styles.activityOutputText}>
                          {activity.output}
                        </Text>
                      </View>
                    )}
                  </View>
                ))
              ) : (
                <Text style={styles.activityModalText}>No recent activity</Text>
              )}
            </ScrollView>
            <TouchableOpacity
              style={styles.activityModalCancelButton}
              onPress={() => {
                handleCancel();
                setShowActivityModal(false);
              }}
            >
              <Text style={styles.activityModalCancelText}>Cancel Process</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Sub-Agents Modal */}
      <Modal
        visible={showAgentsModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAgentsModal(false)}
      >
        <View style={styles.agentsModalOverlay}>
          <View style={styles.agentsModalContent}>
            <View style={styles.agentsModalHeader}>
              <Text style={styles.agentsModalTitle}>Sub-Agents</Text>
              <TouchableOpacity
                style={styles.agentsModalClose}
                onPress={() => setShowAgentsModal(false)}
              >
                <Text style={styles.agentsModalCloseText}>x</Text>
              </TouchableOpacity>
            </View>

            {/* Summary */}
            {agentTree && (
              <View style={styles.agentsSummaryBar}>
                <View style={styles.agentsSummaryItem}>
                  <Text style={styles.agentsSummaryValue}>{agentTree.totalAgents}</Text>
                  <Text style={styles.agentsSummaryLabel}>Total</Text>
                </View>
                <View style={styles.agentsSummaryDivider} />
                <View style={styles.agentsSummaryItem}>
                  <Text style={[styles.agentsSummaryValue, { color: '#22c55e' }]}>
                    {agentTree.runningCount}
                  </Text>
                  <Text style={styles.agentsSummaryLabel}>Running</Text>
                </View>
                <View style={styles.agentsSummaryDivider} />
                <View style={styles.agentsSummaryItem}>
                  <Text style={[styles.agentsSummaryValue, { color: '#3b82f6' }]}>
                    {agentTree.completedCount}
                  </Text>
                  <Text style={styles.agentsSummaryLabel}>Done</Text>
                </View>
              </View>
            )}

            <ScrollView style={styles.agentsModalScroll}>
              {agentTree && agentTree.agents.length > 0 ? (
                <>
                  {/* Running agents section */}
                  {agentTree.agents.filter(a => a.status === 'running').length > 0 && (
                    <>
                      <Text style={styles.agentSectionTitle}>Running</Text>
                      {agentTree.agents.filter(a => a.status === 'running').map((agent) => (
                        <TouchableOpacity
                          key={agent.agentId}
                          style={styles.agentCard}
                          onPress={() => {
                            setViewingAgentDetail({ agentId: agent.agentId, agent });
                            setShowAgentsModal(false);
                          }}
                          activeOpacity={0.7}
                        >
                          <View style={styles.agentCardHeader}>
                            <Text style={[styles.agentStatusDot, { color: '#22c55e' }]}>
                              {'●'}
                            </Text>
                            <View style={styles.agentCardInfo}>
                              <Text style={styles.agentSlug} numberOfLines={1}>
                                {agent.slug || agent.agentId.slice(0, 8)}
                              </Text>
                              <Text style={styles.agentMeta}>
                                Running for {formatDuration(agent.startedAt)}
                                {' '}{agent.messageCount} msgs
                              </Text>
                            </View>
                            <Ionicons name="chevron-forward" size={16} color="#6b7280" />
                          </View>
                          {agent.description && (
                            <Text style={styles.agentDescription} numberOfLines={3}>
                              {agent.description}
                            </Text>
                          )}
                          {agent.currentActivity && (
                            <Text style={styles.agentActivity} numberOfLines={1}>
                              {agent.currentActivity}
                            </Text>
                          )}
                        </TouchableOpacity>
                      ))}
                    </>
                  )}

                  {/* Completed agents section */}
                  {agentTree.agents.filter(a => a.status !== 'running').length > 0 && (
                    <>
                      <TouchableOpacity
                        style={styles.agentSectionHeader}
                        onPress={() => setShowCompletedAgents(!showCompletedAgents)}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.agentSectionTitle}>
                          Completed ({agentTree.agents.filter(a => a.status !== 'running').length})
                        </Text>
                        <Ionicons
                          name={showCompletedAgents ? 'chevron-down' : 'chevron-forward'}
                          size={16}
                          color="#6b7280"
                        />
                      </TouchableOpacity>
                      {showCompletedAgents && agentTree.agents.filter(a => a.status !== 'running').map((agent) => (
                        <TouchableOpacity
                          key={agent.agentId}
                          style={[styles.agentCard, styles.agentCardCompleted]}
                          onPress={() => {
                            setViewingAgentDetail({ agentId: agent.agentId, agent });
                            setShowAgentsModal(false);
                          }}
                          activeOpacity={0.7}
                        >
                          <View style={styles.agentCardHeader}>
                            <Text style={[styles.agentStatusDot, { color: '#3b82f6' }]}>
                              {'✓'}
                            </Text>
                            <View style={styles.agentCardInfo}>
                              <Text style={[styles.agentSlug, { color: '#9ca3af' }]} numberOfLines={1}>
                                {agent.slug || agent.agentId.slice(0, 8)}
                              </Text>
                              <Text style={styles.agentMeta}>
                                Completed in {formatDuration(agent.startedAt, agent.completedAt)}
                                {' '}{agent.messageCount} msgs
                              </Text>
                            </View>
                            <Ionicons name="chevron-forward" size={16} color="#6b7280" />
                          </View>
                          {agent.description && (
                            <Text style={styles.agentDescription} numberOfLines={2}>
                              {agent.description}
                            </Text>
                          )}
                        </TouchableOpacity>
                      ))}
                    </>
                  )}
                </>
              ) : (
                <Text style={styles.agentsEmptyText}>No sub-agents found</Text>
              )}
            </ScrollView>

            <TouchableOpacity
              style={styles.agentsModalDoneButton}
              onPress={() => setShowAgentsModal(false)}
            >
              <Text style={styles.agentsModalDoneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <ScrollView
        ref={scrollViewRef}
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          data.length === 0 && styles.listContentEmpty,
        ]}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={async () => {
              setIsRefreshing(true);
              try { await refresh(); } finally { setIsRefreshing(false); }
            }}
            tintColor="#ffffff"
          />
        }
        onScroll={handleScroll}
        onContentSizeChange={handleContentSizeChange}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
      >
        {/* Loading indicator at top when fetching older highlights */}
        {loadingMore && (
          <View style={styles.loadMoreIndicator}>
            <ActivityIndicator size="small" color="#3b82f6" />
            <Text style={styles.loadMoreText}>Loading older messages...</Text>
          </View>
        )}
        {data.length === 0 ? (
          renderEmptyContent()
        ) : (
          data.map((item) => (
            <ConversationItem
              key={item.id}
              item={item}
              showToolCalls={true}
              onSelectOption={handleSelectOption}
              onFileTap={setViewingFile}
              onMessageTap={item.type === 'assistant' ? () => setViewingMessage({ content: item.content, timestamp: item.timestamp }) : undefined}
              fontScale={fontScale}
            />
          ))
        )}
      </ScrollView>

      {/* Floating action buttons */}
      {showScrollButton && (
        <TouchableOpacity
          style={[
            styles.scrollButton,
            hasNewMessages && styles.scrollButtonNew,
          ]}
          onPress={() => scrollToBottom()}
        >
          <Text style={styles.scrollButtonText}>↓</Text>
          {hasNewMessages && <View style={styles.newMessageBadge} />}
        </TouchableOpacity>
      )}

      {queuedMessages.length > 0 && (
        <View style={styles.queuedBanner}>
          <Text style={styles.queuedText}>
            📤 {queuedMessages.length} queued: {queuedMessages[0].content.substring(0, 30)}
            {queuedMessages[0].content.length > 30 ? '...' : ''}
          </Text>
          <TouchableOpacity
            style={styles.queuedCancel}
            onPress={() => cancelQueuedMessage(queuedMessages[0].id)}
          >
            <Text style={styles.queuedCancelText}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      <InputBar
        onSend={handleSendInput}
        onSendImage={sendImage}
        onUploadImage={uploadImage}
        onSendWithImages={sendWithImages}
        onSlashCommand={handleSlashCommand}
        disabled={!isConnected}
        placeholder={
          !isConnected
            ? 'Not connected'
            : status?.isWaitingForInput
            ? 'Type a response...'
            : 'Type to queue message...'
        }
      />

      <FileViewer
        filePath={viewingFile}
        onClose={() => setViewingFile(null)}
        onFileTap={(path) => setViewingFile(path)}
      />

      <MessageViewer
        content={viewingMessage?.content || null}
        timestamp={viewingMessage?.timestamp}
        onClose={() => setViewingMessage(null)}
        fontScale={fontScale}
      />

      {/* Sub-Agent Detail Screen (overlays everything - must be last) */}
      {viewingAgentDetail && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#111827', zIndex: 999 }]}>
          <SubAgentDetailScreen
            agentId={viewingAgentDetail.agentId}
            initialAgent={viewingAgentDetail.agent}
            onBack={() => {
              setViewingAgentDetail(null);
              setShowAgentsModal(true);
            }}
          />
        </View>
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
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  backButton: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  backButtonText: {
    color: '#3b82f6',
    fontSize: 17,
  },
  headerCenter: {
    flex: 1,
    marginHorizontal: 8,
    minWidth: 0,
  },
  headerTitle: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  headerIconButton: {
    padding: 8,
  },
  autoApproveButton: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#374151',
  },
  autoApproveButtonActive: {
    backgroundColor: '#78350f',
  },
  muteButton: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#374151',
  },
  muteButtonActive: {
    backgroundColor: '#7f1d1d',
  },
  connectionDot: {
    padding: 6,
    marginLeft: 2,
  },
  connectionDotInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  connectionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#7f1d1d',
    borderBottomWidth: 1,
    borderBottomColor: '#991b1b',
  },
  connectionBannerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  connectionBannerText: {
    flex: 1,
    color: '#fecaca',
    fontSize: 13,
  },
  connectionBannerRetry: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 10,
    paddingVertical: 3,
    backgroundColor: '#3b82f6',
    borderRadius: 10,
    marginLeft: 8,
    overflow: 'hidden',
  },
  unifiedActivityBar: {
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1f4d',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  activityRowWithAgents: {
    borderBottomWidth: 1,
    borderBottomColor: '#1a4731',
  },
  agentsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#14532d',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#111c33',
    borderRadius: 16,
    padding: 20,
    width: '85%',
    maxWidth: 340,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#f3f4f6',
    marginBottom: 20,
    textAlign: 'center',
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  modalRowInfo: {
    flex: 1,
    marginRight: 16,
  },
  modalRowLabel: {
    fontSize: 16,
    color: '#f3f4f6',
    marginBottom: 4,
  },
  modalRowDescription: {
    fontSize: 13,
    color: '#9ca3af',
  },
  modalCloseButton: {
    marginTop: 20,
    backgroundColor: '#3b82f6',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalCloseButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  activityBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1f4d',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#2563eb',
  },
  activityContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  activitySpinner: {
    marginRight: 8,
  },
  activityText: {
    flex: 1,
    color: '#93c5fd',
    fontSize: 13,
  },
  activityModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'flex-end',
  },
  activityModalContent: {
    backgroundColor: '#1f2937',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
  },
  activityModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  activityModalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#f3f4f6',
  },
  activityModalClose: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  activityModalCloseText: {
    fontSize: 28,
    color: '#9ca3af',
    lineHeight: 28,
  },
  activityModalScroll: {
    padding: 20,
    flexGrow: 1,
  },
  activityModalText: {
    fontSize: 14,
    color: '#9ca3af',
    lineHeight: 22,
  },
  activityItem: {
    marginBottom: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  activityItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  activityItemTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#60a5fa',
    marginLeft: 8,
  },
  activityItemTool: {
    fontSize: 12,
    fontWeight: '600',
    color: '#a78bfa',
    backgroundColor: '#374151',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  activityItemSummary: {
    fontSize: 14,
    color: '#e5e7eb',
    lineHeight: 20,
  },
  activityItemInput: {
    fontSize: 13,
    color: '#9ca3af',
    fontFamily: 'monospace',
    marginTop: 4,
  },
  activityOutputBox: {
    backgroundColor: '#111827',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
    maxHeight: 200,
  },
  activityOutputText: {
    fontSize: 12,
    color: '#d1d5db',
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  activityModalCancelButton: {
    margin: 20,
    marginTop: 0,
    backgroundColor: '#ef4444',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  activityModalCancelText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  activityCancelButton: {
    marginLeft: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: '#ef4444',
    borderRadius: 12,
  },
  activityCancelText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: '#7f1d1d',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  errorText: {
    color: '#fecaca',
    fontSize: 13,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingTop: 12,
    paddingBottom: 100,  // Extra space for InputBar
  },
  loadMoreIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  loadMoreText: {
    color: '#9ca3af',
    fontSize: 13,
    marginLeft: 8,
  },
  listContentEmpty: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
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
  retryButton: {
    marginTop: 20,
    backgroundColor: '#3b82f6',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  scrollButton: {
    position: 'absolute',
    right: 16,
    bottom: 120,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  scrollButtonNew: {
    backgroundColor: '#7c3aed',
  },
  scrollButtonText: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  newMessageBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#ef4444',
    borderWidth: 2,
    borderColor: '#111827',
  },
  cancelButton: {
    position: 'absolute',
    left: 16,
    bottom: 80,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: '#ef4444',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  cancelButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  otherSessionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#065f46',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#047857',
  },
  otherSessionContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  otherSessionBadge: {
    fontSize: 18,
    marginRight: 10,
  },
  otherSessionInfo: {
    flex: 1,
  },
  otherSessionName: {
    color: '#ecfdf5',
    fontSize: 14,
    fontWeight: '600',
  },
  otherSessionMessage: {
    color: '#a7f3d0',
    fontSize: 12,
    marginTop: 2,
  },
  otherSessionDismiss: {
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  otherSessionDismissText: {
    fontSize: 22,
    color: '#a7f3d0',
    lineHeight: 22,
  },
  queuedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e3a5f',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#3b82f6',
  },
  queuedText: {
    flex: 1,
    color: '#93c5fd',
    fontSize: 13,
  },
  queuedCancel: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  queuedCancelText: {
    color: '#9ca3af',
    fontSize: 14,
    fontWeight: '600',
  },
  // Sub-agents bar styles
  subAgentsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#14532d',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#22c55e',
  },
  subAgentsContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  subAgentsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22c55e',
    marginRight: 8,
  },
  subAgentsText: {
    color: '#bbf7d0',
    fontSize: 13,
    fontWeight: '500',
  },
  subAgentsArrow: {
    color: '#86efac',
    fontSize: 14,
  },
  // Sub-agents modal styles
  agentsModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'flex-end',
  },
  agentsModalContent: {
    backgroundColor: '#1f2937',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  agentsModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  agentsModalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#f3f4f6',
  },
  agentsModalClose: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  agentsModalCloseText: {
    fontSize: 24,
    color: '#9ca3af',
    lineHeight: 24,
  },
  agentsSummaryBar: {
    flexDirection: 'row',
    backgroundColor: '#111827',
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
    padding: 12,
  },
  agentsSummaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  agentsSummaryValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f3f4f6',
  },
  agentsSummaryLabel: {
    fontSize: 11,
    color: '#6b7280',
    marginTop: 2,
  },
  agentsSummaryDivider: {
    width: 1,
    backgroundColor: '#374151',
  },
  agentsModalScroll: {
    padding: 16,
    flexGrow: 1,
  },
  agentCard: {
    backgroundColor: '#111827',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  agentCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  agentStatusDot: {
    fontSize: 14,
    marginRight: 10,
    width: 16,
    textAlign: 'center',
  },
  agentCardInfo: {
    flex: 1,
  },
  agentSlug: {
    fontSize: 14,
    fontWeight: '600',
    color: '#f3f4f6',
  },
  agentMeta: {
    fontSize: 11,
    color: '#6b7280',
    marginTop: 2,
  },
  agentDescription: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 8,
    marginLeft: 26,
  },
  agentActivity: {
    fontSize: 11,
    color: '#60a5fa',
    marginTop: 4,
    marginLeft: 26,
    fontStyle: 'italic',
  },
  agentSectionTitle: {
    color: '#9ca3af',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  agentSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    marginBottom: 8,
    paddingRight: 4,
  },
  agentCardCompleted: {
    opacity: 0.7,
  },
  agentsEmptyText: {
    color: '#6b7280',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 20,
  },
  agentsModalDoneButton: {
    margin: 16,
    marginTop: 8,
    backgroundColor: '#3b82f6',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  agentsModalDoneText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
