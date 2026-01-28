import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  Modal,
  Switch,
  ScrollView,
  Keyboard,
} from 'react-native';
import { Server, ConversationHighlight } from '../types';
import { useConnection } from '../hooks/useConnection';
import { useConversation } from '../hooks/useConversation';
import { StatusIndicator } from '../components/StatusIndicator';
import { ConversationItem } from '../components/ConversationItem';
import { InputBar } from '../components/InputBar';
import { SessionPicker } from '../components/SessionPicker';
import { FileViewer } from '../components/FileViewer';
import { getSessionSettings, saveSessionSettings, SessionSettings } from '../services/storage';
import { wsService } from '../services/websocket';
import { messageQueue, QueuedMessage } from '../services/messageQueue';

interface SessionViewProps {
  server: Server;
  onBack: () => void;
  initialSessionId?: string | null;
}

export function SessionView({ server, onBack, initialSessionId }: SessionViewProps) {
  const { connectionState, isConnected, isConnecting, reconnect } = useConnection(server);
  const {
    highlights,
    status,
    loading,
    error,
    refresh,
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

  const listRef = useRef<FlatList>(null);
  const data = highlights;
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const initialScrollDone = useRef(false);
  // Simple flag: true = auto-scroll to new messages, false = user is reading history
  const autoScrollEnabled = useRef(true);
  // Track if we're near bottom to decide whether to auto-scroll
  const isNearBottom = useRef(true);
  // Debounce scroll to avoid interrupting animations
  const scrollTimeout = useRef<NodeJS.Timeout | null>(null);
  // Track last content height to only scroll when content grows
  const lastContentHeight = useRef(0);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionSettings, setSessionSettings] = useState<SessionSettings>({ instantNotify: false });
  const [showActivityModal, setShowActivityModal] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);

  // Subscribe to message queue updates
  useEffect(() => {
    const unsubscribe = messageQueue.subscribe((queue) => {
      const forThisServer = queue.filter((m) => m.serverId === server.id);
      setQueuedMessages(forThisServer);
    });
    return unsubscribe;
  }, [server.id]);

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

  // Auto-scroll disabled - was too aggressive and prevented reading history
  // User can tap the scroll-to-bottom button when needed

  const lastSwitchedSessionId = useRef<string | null>(null);

  // Refresh when connection is established and sync settings
  useEffect(() => {
    if (isConnected && wsService.isConnected()) {
      const init = async () => {
        // Switch to initial session if specified and different from last switched
        const isSwitching = initialSessionId && initialSessionId !== lastSwitchedSessionId.current;
        if (isSwitching) {
          lastSwitchedSessionId.current = initialSessionId;
          try {
            await wsService.sendRequest('switch_session', { sessionId: initialSessionId });
          } catch (e) {
            console.error('Failed to switch session:', e);
          }
        }

        // Clear first if switching sessions to avoid showing stale content
        refresh(!!isSwitching);
        // Sync instant notify preference with daemon
        const settings = await getSessionSettings(server.id);
        if (settings.instantNotify) {
          wsService.sendRequest('set_instant_notify', { enabled: true });
        }
        // Only reset scroll state when switching sessions, not on every reconnect
        if (isSwitching) {
          initialScrollDone.current = false;
          lastContentHeight.current = 0;
        }
      };

      init();
    }
  }, [isConnected, refresh, server.id, initialSessionId]);

  // Debug logging helper
  const logScroll = useCallback((event: string, data: Record<string, unknown>) => {
    if (wsService.isConnected()) {
      wsService.sendRequest('scroll_log', { event, ...data, ts: Date.now() }).catch(() => {});
    }
  }, []);

  // Handle content size changes - this is when we should auto-scroll
  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    // Only act if content actually grew (not on shrink or same size)
    const contentGrew = height > lastContentHeight.current + 10;
    const prevHeight = lastContentHeight.current;
    lastContentHeight.current = height;

    logScroll('contentSizeChange', {
      height,
      prevHeight,
      contentGrew,
      autoScroll: autoScrollEnabled.current,
      nearBottom: isNearBottom.current,
      initialDone: initialScrollDone.current
    });

    if (!initialScrollDone.current && height > 0) {
      // First load - scroll to bottom immediately
      initialScrollDone.current = true;
      logScroll('initialScroll', { height });
      listRef.current?.scrollToEnd({ animated: false });
      return;
    }

    // Only scroll if content grew AND auto-scroll is enabled AND we were near bottom
    if (contentGrew && autoScrollEnabled.current && isNearBottom.current) {
      // Debounce: cancel pending scroll and schedule new one
      if (scrollTimeout.current) {
        clearTimeout(scrollTimeout.current);
      }
      scrollTimeout.current = setTimeout(() => {
        logScroll('autoScrollToEnd', { height });
        listRef.current?.scrollToEnd({ animated: false });
        scrollTimeout.current = null;
      }, 100);
    } else if (contentGrew && !autoScrollEnabled.current) {
      // User is reading history - show new message indicator
      logScroll('showNewMessageIndicator', { height });
      setHasNewMessages(true);
    }
  }, [logScroll]);

  const scrollToBottom = useCallback(() => {
    setHasNewMessages(false);
    setShowScrollButton(false);
    autoScrollEnabled.current = true;
    isNearBottom.current = true;
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  const handleSendInput = async (text: string): Promise<boolean> => {
    // Enable auto-scroll when user sends a message
    autoScrollEnabled.current = true;
    isNearBottom.current = true;
    setHasNewMessages(false);
    return sendInput(text);
    // Note: scrollToEnd will be called by onContentSizeChange when new message appears
  };

  const handleSessionChange = useCallback(() => {
    initialScrollDone.current = false;
    autoScrollEnabled.current = true;
    setHasNewMessages(false);
    setShowScrollButton(false);
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

    try {
      const response = await wsService.sendRequest('switch_tmux_session', {
        sessionName: otherSessionActivity.sessionId,
      });
      if (response.success) {
        dismissOtherSessionActivity();
        initialScrollDone.current = false;
        autoScrollEnabled.current = true;
        setHasNewMessages(false);
        setShowScrollButton(false);
        refresh(true);
      }
    } catch (err) {
      console.error('Failed to switch session:', err);
    }
  }, [otherSessionActivity, dismissOtherSessionActivity, refresh]);

  const handleSelectOption = async (option: string) => {
    await handleSendInput(option);
  };

  const handleScroll = useCallback((event: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;

    // Track if we're near the bottom (within 150px)
    const nearBottom = distanceFromBottom < 150;
    const wasNearBottom = isNearBottom.current;
    isNearBottom.current = nearBottom;

    // Log significant scroll events (state changes only to reduce noise)
    if (nearBottom !== wasNearBottom) {
      logScroll('scrollStateChange', {
        distanceFromBottom: Math.round(distanceFromBottom),
        nearBottom,
        contentHeight: Math.round(contentSize.height),
        scrollY: Math.round(contentOffset.y),
        viewHeight: Math.round(layoutMeasurement.height)
      });
    }

    // Show/hide scroll button - only update state if value changed to avoid re-render loop
    const shouldShowButton = distanceFromBottom > 200;
    setShowScrollButton(prev => prev === shouldShowButton ? prev : shouldShowButton);

    // If user scrolled to bottom, re-enable auto-scroll
    if (nearBottom) {
      autoScrollEnabled.current = true;
      // Only clear if there were new messages
      setHasNewMessages(prev => prev ? false : prev);
    } else {
      // User scrolled up - disable auto-scroll
      autoScrollEnabled.current = false;
    }
  }, [logScroll]);

  const handleCancel = () => {
    Alert.alert(
      'Cancel Request',
      'Send interrupt signal to Claude?',
      [
        { text: 'No', style: 'cancel' },
        { text: 'Yes', onPress: () => sendInput('\x03') }, // Ctrl+C
      ]
    );
  };

  const renderItem = ({ item }: { item: ConversationHighlight }) => (
    <ConversationItem
      item={item}
      showToolCalls={true}
      onSelectOption={handleSelectOption}
      onFileTap={setViewingFile}
    />
  );

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
          Start a Claude Code session on your server to see messages here
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
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <View style={styles.headerTitleRow}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {server.name}
            </Text>
            {isConnected && (
              <SessionPicker
                onSessionChange={handleSessionChange}
                isOpen={showSessionPicker}
                onClose={() => setShowSessionPicker(false)}
              />
            )}
          </View>
          {status?.projectPath && (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {status.projectPath}
            </Text>
          )}
        </View>
        <TouchableOpacity
          style={styles.refreshButton}
          onPress={() => refresh()}
          disabled={loading}
        >
          <Text style={[styles.refreshIconText, loading && styles.refreshIconDisabled]}>↻</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.settingsButton}
          onPress={() => setShowSettings(true)}
        >
          <View style={styles.settingsIcon}>
            <Text style={styles.settingsIconText}>⚙</Text>
          </View>
        </TouchableOpacity>
      </View>

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

            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => setShowSettings(false)}
            >
              <Text style={styles.modalCloseButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <StatusIndicator
        connectionState={connectionState}
        isWaitingForInput={status?.isWaitingForInput}
        onReconnect={reconnect}
      />

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
                  : `${otherSessionActivity.newMessageCount} new message${otherSessionActivity.newMessageCount > 1 ? 's' : ''}`}
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

      {/* Activity status bar with cancel button - tappable for full output modal */}
      {isConnected && status?.currentActivity && (
        <TouchableOpacity
          style={styles.activityBar}
          onPress={() => setShowActivityModal(true)}
          activeOpacity={0.8}
        >
          <View style={styles.activityContent}>
            <ActivityIndicator size="small" color="#60a5fa" style={styles.activitySpinner} />
            <Text style={styles.activityText} numberOfLines={1}>
              {status.currentActivity}
            </Text>
          </View>
          <TouchableOpacity style={styles.activityCancelButton} onPress={handleCancel}>
            <Text style={styles.activityCancelText}>Cancel</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      )}

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

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          data.length === 0 && styles.listContentEmpty,
        ]}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={refresh}
            tintColor="#ffffff"
          />
        }
        ListEmptyComponent={renderEmptyContent}
        onScroll={handleScroll}
        onContentSizeChange={handleContentSizeChange}
        scrollEventThrottle={100}
        // Optimize re-renders
        removeClippedSubviews={Platform.OS === 'android'}
        maxToRenderPerBatch={10}
        windowSize={10}
      />

      {/* Floating action buttons */}
      {showScrollButton && (
        <TouchableOpacity
          style={[
            styles.scrollButton,
            hasNewMessages && styles.scrollButtonNew,
          ]}
          onPress={scrollToBottom}
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
      />
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
    backgroundColor: '#1f2937',
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
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  headerTitle: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  headerSubtitle: {
    color: '#9ca3af',
    fontSize: 12,
    marginTop: 2,
  },
  refreshButton: {
    padding: 8,
    marginRight: 4,
  },
  refreshIconText: {
    fontSize: 22,
    color: '#9ca3af',
  },
  refreshIconDisabled: {
    opacity: 0.4,
  },
  settingsButton: {
    padding: 8,
  },
  settingsIcon: {
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsIconText: {
    fontSize: 20,
    color: '#9ca3af',
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
    backgroundColor: '#1e3a5f',
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
    backgroundColor: '#10b981',
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
});
