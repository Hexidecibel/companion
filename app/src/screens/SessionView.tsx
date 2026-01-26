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
} from 'react-native';
import { Server, ConversationHighlight } from '../types';
import { useConnection } from '../hooks/useConnection';
import { useConversation } from '../hooks/useConversation';
import { StatusIndicator } from '../components/StatusIndicator';
import { ConversationItem } from '../components/ConversationItem';
import { InputBar } from '../components/InputBar';
import { QuickReplies } from '../components/QuickReplies';
import { SessionPicker } from '../components/SessionPicker';
import { getSessionSettings, saveSessionSettings, SessionSettings } from '../services/storage';
import { wsService } from '../services/websocket';

interface SessionViewProps {
  server: Server;
  onBack: () => void;
}

export function SessionView({ server, onBack }: SessionViewProps) {
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
  } = useConversation();

  const listRef = useRef<FlatList>(null);
  const data = highlights;
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionSettings, setSessionSettings] = useState<SessionSettings>({ instantNotify: false });
  const [showActivityModal, setShowActivityModal] = useState(false);

  // Load session settings
  useEffect(() => {
    getSessionSettings(server.id).then(setSessionSettings);
  }, [server.id]);

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

  // Refresh when connection is established and sync settings
  useEffect(() => {
    if (isConnected) {
      refresh();
      // Sync instant notify preference with daemon
      getSessionSettings(server.id).then(settings => {
        if (settings.instantNotify) {
          wsService.sendRequest('set_instant_notify', { enabled: true });
        }
      });
    }
  }, [isConnected, refresh, server.id]);

  const scrollToBottom = () => {
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 100);
  };

  const handleSendInput = async (text: string) => {
    await sendInput(text);
    scrollToBottom();
  };

  const handleSelectOption = async (option: string) => {
    await handleSendInput(option);
  };

  const handleScroll = (event: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const paddingToBottom = 50;
    const atBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom;
    setIsAtBottom(atBottom);
  };

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
      onSelectOption={handleSelectOption}
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

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <View style={styles.headerTitleRow}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {server.name}
            </Text>
            {isConnected && <SessionPicker onSessionChange={() => refresh()} />}
          </View>
          {status?.projectPath && (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {status.projectPath}
            </Text>
          )}
        </View>
        <TouchableOpacity
          style={styles.refreshButton}
          onPress={refresh}
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
        scrollEventThrottle={100}
      />

      {/* Floating action buttons */}
      {!isAtBottom && (
        <TouchableOpacity
          style={[
            styles.scrollButton,
            status?.isWaitingForInput && styles.scrollButtonAboveQuickReplies,
          ]}
          onPress={scrollToBottom}
        >
          <Text style={styles.scrollButtonText}>↓</Text>
        </TouchableOpacity>
      )}

      {status?.isWaitingForInput && isConnected && (
        <QuickReplies onSelect={handleSendInput} disabled={!isConnected} />
      )}

      <InputBar
        onSend={handleSendInput}
        onSendImage={sendImage}
        onUploadImage={uploadImage}
        onSendWithImages={sendWithImages}
        disabled={!isConnected}
        placeholder={
          !isConnected
            ? 'Not connected'
            : status?.isWaitingForInput
            ? 'Type a response...'
            : 'Type to queue message...'
        }
      />
    </KeyboardAvoidingView>
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
    marginHorizontal: 12,
  },
  headerTitleRow: {
    flexDirection: 'row',
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
  listContent: {
    paddingVertical: 12,
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
    bottom: 80,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#3b82f6',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  scrollButtonAboveQuickReplies: {
    bottom: 130,
  },
  scrollButtonText: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: 'bold',
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
});
