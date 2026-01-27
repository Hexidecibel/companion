import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { Server } from '../types';
import { getServers } from '../services/storage';
import {
  NotificationPreferences,
  getNotificationPreferences,
  saveNotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '../services/notificationPrefs';
import { wsService } from '../services/websocket';

interface NotificationSettingsProps {
  onBack: () => void;
}

// Simple time picker modal
function TimePicker({
  visible,
  value,
  onSelect,
  onCancel,
  title,
}: {
  visible: boolean;
  value: string;
  onSelect: (time: string) => void;
  onCancel: () => void;
  title: string;
}) {
  const [hour, setHour] = useState(parseInt(value.split(':')[0], 10));
  const [minute, setMinute] = useState(parseInt(value.split(':')[1], 10));

  useEffect(() => {
    if (visible) {
      setHour(parseInt(value.split(':')[0], 10));
      setMinute(parseInt(value.split(':')[1], 10));
    }
  }, [visible, value]);

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = [0, 15, 30, 45];

  const handleConfirm = () => {
    const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    onSelect(timeStr);
  };

  const formatHour = (h: number) => {
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${hour12} ${suffix}`;
  };

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={pickerStyles.overlay}>
        <View style={pickerStyles.container}>
          <Text style={pickerStyles.title}>{title}</Text>

          <View style={pickerStyles.pickerRow}>
            <View style={pickerStyles.column}>
              <Text style={pickerStyles.columnLabel}>Hour</Text>
              <ScrollView style={pickerStyles.scrollView} showsVerticalScrollIndicator={false}>
                {hours.map((h) => (
                  <TouchableOpacity
                    key={h}
                    style={[pickerStyles.option, hour === h && pickerStyles.optionSelected]}
                    onPress={() => setHour(h)}
                  >
                    <Text style={[pickerStyles.optionText, hour === h && pickerStyles.optionTextSelected]}>
                      {formatHour(h)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <View style={pickerStyles.column}>
              <Text style={pickerStyles.columnLabel}>Minute</Text>
              <ScrollView style={pickerStyles.scrollView} showsVerticalScrollIndicator={false}>
                {minutes.map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[pickerStyles.option, minute === m && pickerStyles.optionSelected]}
                    onPress={() => setMinute(m)}
                  >
                    <Text style={[pickerStyles.optionText, minute === m && pickerStyles.optionTextSelected]}>
                      :{m.toString().padStart(2, '0')}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </View>

          <View style={pickerStyles.buttons}>
            <TouchableOpacity style={pickerStyles.cancelButton} onPress={onCancel}>
              <Text style={pickerStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={pickerStyles.confirmButton} onPress={handleConfirm}>
              <Text style={pickerStyles.confirmText}>Set</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// Throttle picker
const THROTTLE_OPTIONS = [
  { value: 0, label: 'No limit' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
];

function ThrottlePicker({
  visible,
  value,
  onSelect,
  onCancel,
}: {
  visible: boolean;
  value: number;
  onSelect: (minutes: number) => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={pickerStyles.overlay}>
        <View style={pickerStyles.container}>
          <Text style={pickerStyles.title}>Minimum Time Between Notifications</Text>

          <View style={pickerStyles.optionList}>
            {THROTTLE_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.value}
                style={[pickerStyles.listOption, value === option.value && pickerStyles.optionSelected]}
                onPress={() => onSelect(option.value)}
              >
                <Text style={[pickerStyles.optionText, value === option.value && pickerStyles.optionTextSelected]}>
                  {option.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={pickerStyles.fullCancelButton} onPress={onCancel}>
            <Text style={pickerStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

interface ServerNotificationCardProps {
  server: Server;
  prefs: NotificationPreferences;
  onUpdate: (prefs: NotificationPreferences) => void;
  isConnected: boolean;
}

function ServerNotificationCard({
  server,
  prefs,
  onUpdate,
  isConnected,
}: ServerNotificationCardProps) {
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [showThrottlePicker, setShowThrottlePicker] = useState(false);

  const isCurrentServer = isConnected && wsService.getServerId() === server.id;

  const handleToggleEnabled = (value: boolean) => {
    onUpdate({ ...prefs, enabled: value });
  };

  const handleToggleInstant = async (value: boolean) => {
    onUpdate({ ...prefs, instantNotify: value });
    if (isCurrentServer) {
      try {
        await wsService.sendRequest('set_instant_notify', { enabled: value });
      } catch (err) {
        console.error('Failed to update instant notify:', err);
      }
    }
  };

  const handleToggleQuietHours = async (value: boolean) => {
    const newPrefs = { ...prefs, quietHoursEnabled: value };
    onUpdate(newPrefs);
    if (isCurrentServer) {
      try {
        await wsService.sendRequest('set_notification_prefs', {
          quietHoursEnabled: value,
          quietHoursStart: prefs.quietHoursStart,
          quietHoursEnd: prefs.quietHoursEnd,
          throttleMinutes: prefs.throttleMinutes,
        });
      } catch (err) {
        console.error('Failed to update quiet hours:', err);
      }
    }
  };

  const handleSetStartTime = async (time: string) => {
    setShowStartPicker(false);
    const newPrefs = { ...prefs, quietHoursStart: time };
    onUpdate(newPrefs);
    if (isCurrentServer) {
      try {
        await wsService.sendRequest('set_notification_prefs', {
          quietHoursEnabled: prefs.quietHoursEnabled,
          quietHoursStart: time,
          quietHoursEnd: prefs.quietHoursEnd,
          throttleMinutes: prefs.throttleMinutes,
        });
      } catch (err) {
        console.error('Failed to update start time:', err);
      }
    }
  };

  const handleSetEndTime = async (time: string) => {
    setShowEndPicker(false);
    const newPrefs = { ...prefs, quietHoursEnd: time };
    onUpdate(newPrefs);
    if (isCurrentServer) {
      try {
        await wsService.sendRequest('set_notification_prefs', {
          quietHoursEnabled: prefs.quietHoursEnabled,
          quietHoursStart: prefs.quietHoursStart,
          quietHoursEnd: time,
          throttleMinutes: prefs.throttleMinutes,
        });
      } catch (err) {
        console.error('Failed to update end time:', err);
      }
    }
  };

  const handleSetThrottle = async (minutes: number) => {
    setShowThrottlePicker(false);
    const newPrefs = { ...prefs, throttleMinutes: minutes };
    onUpdate(newPrefs);
    if (isCurrentServer) {
      try {
        await wsService.sendRequest('set_notification_prefs', {
          quietHoursEnabled: prefs.quietHoursEnabled,
          quietHoursStart: prefs.quietHoursStart,
          quietHoursEnd: prefs.quietHoursEnd,
          throttleMinutes: minutes,
        });
      } catch (err) {
        console.error('Failed to update throttle:', err);
      }
    }
  };

  const formatTime = (time: string) => {
    const [h, m] = time.split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${hour12}:${m.toString().padStart(2, '0')} ${suffix}`;
  };

  const getThrottleLabel = (minutes: number) => {
    const option = THROTTLE_OPTIONS.find((o) => o.value === minutes);
    return option?.label || `${minutes} min`;
  };

  return (
    <View style={styles.serverCard}>
      <View style={styles.serverHeader}>
        <Text style={styles.serverName}>{server.name}</Text>
        {isCurrentServer && (
          <View style={styles.connectedBadge}>
            <Text style={styles.connectedText}>Connected</Text>
          </View>
        )}
      </View>

      <View style={styles.settingRow}>
        <View style={styles.settingInfo}>
          <Text style={styles.settingLabel}>Notifications</Text>
          <Text style={styles.settingDescription}>
            Receive push notifications from this server
          </Text>
        </View>
        <Switch
          value={prefs.enabled}
          onValueChange={handleToggleEnabled}
          trackColor={{ false: '#374151', true: '#3b82f6' }}
        />
      </View>

      {prefs.enabled && (
        <>
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>Instant Notifications</Text>
              <Text style={styles.settingDescription}>
                Get notified immediately when Claude is waiting
              </Text>
            </View>
            <Switch
              value={prefs.instantNotify}
              onValueChange={handleToggleInstant}
              trackColor={{ false: '#374151', true: '#3b82f6' }}
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>Quiet Hours</Text>
              <Text style={styles.settingDescription}>
                Silence notifications during set hours
              </Text>
            </View>
            <Switch
              value={prefs.quietHoursEnabled}
              onValueChange={handleToggleQuietHours}
              trackColor={{ false: '#374151', true: '#3b82f6' }}
            />
          </View>

          {prefs.quietHoursEnabled && (
            <View style={styles.timeRow}>
              <TouchableOpacity style={styles.timeButton} onPress={() => setShowStartPicker(true)}>
                <Text style={styles.timeLabel}>From</Text>
                <Text style={styles.timeValue}>{formatTime(prefs.quietHoursStart)}</Text>
              </TouchableOpacity>
              <Text style={styles.timeSeparator}>to</Text>
              <TouchableOpacity style={styles.timeButton} onPress={() => setShowEndPicker(true)}>
                <Text style={styles.timeLabel}>Until</Text>
                <Text style={styles.timeValue}>{formatTime(prefs.quietHoursEnd)}</Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.divider} />

          <TouchableOpacity style={styles.settingRow} onPress={() => setShowThrottlePicker(true)}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>Rate Limit</Text>
              <Text style={styles.settingDescription}>
                Minimum time between notifications
              </Text>
            </View>
            <View style={styles.valueButton}>
              <Text style={styles.valueText}>{getThrottleLabel(prefs.throttleMinutes)}</Text>
              <Text style={styles.valueArrow}>›</Text>
            </View>
          </TouchableOpacity>
        </>
      )}

      <TimePicker
        visible={showStartPicker}
        value={prefs.quietHoursStart}
        onSelect={handleSetStartTime}
        onCancel={() => setShowStartPicker(false)}
        title="Quiet Hours Start"
      />
      <TimePicker
        visible={showEndPicker}
        value={prefs.quietHoursEnd}
        onSelect={handleSetEndTime}
        onCancel={() => setShowEndPicker(false)}
        title="Quiet Hours End"
      />
      <ThrottlePicker
        visible={showThrottlePicker}
        value={prefs.throttleMinutes}
        onSelect={handleSetThrottle}
        onCancel={() => setShowThrottlePicker(false)}
      />
    </View>
  );
}

export function NotificationSettings({ onBack }: NotificationSettingsProps) {
  const [servers, setServers] = useState<Server[]>([]);
  const [preferences, setPreferences] = useState<Map<string, NotificationPreferences>>(new Map());
  const [loading, setLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(wsService.isConnected());

  useEffect(() => {
    loadData();

    const unsubscribe = wsService.onStateChange((state) => {
      setIsConnected(state.status === 'connected');
    });

    return unsubscribe;
  }, []);

  const loadData = async () => {
    const loadedServers = await getServers();
    setServers(loadedServers);

    const prefsMap = new Map<string, NotificationPreferences>();
    for (const server of loadedServers) {
      const prefs = await getNotificationPreferences(server.id);
      prefsMap.set(server.id, prefs);
    }
    setPreferences(prefsMap);
    setLoading(false);
  };

  const handleUpdatePrefs = useCallback(
    async (serverId: string, newPrefs: NotificationPreferences) => {
      setPreferences((prev) => {
        const updated = new Map(prev);
        updated.set(serverId, newPrefs);
        return updated;
      });

      await saveNotificationPreferences(serverId, newPrefs);
    },
    []
  );

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={styles.centered}>
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        {servers.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>
              No servers configured. Add a server first to configure notifications.
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionTitle}>Per-Server Settings</Text>
            {servers.map((server) => {
              const prefs = preferences.get(server.id) || DEFAULT_NOTIFICATION_PREFERENCES;
              return (
                <ServerNotificationCard
                  key={server.id}
                  server={server}
                  prefs={prefs}
                  onUpdate={(newPrefs) => handleUpdatePrefs(server.id, newPrefs)}
                  isConnected={isConnected}
                />
              );
            })}

            <View style={styles.helpSection}>
              <Text style={styles.helpTitle}>About Notifications</Text>
              <Text style={styles.helpText}>
                • Instant: Notified immediately when Claude needs input
              </Text>
              <Text style={styles.helpText}>
                • Quiet Hours: No notifications during specified times
              </Text>
              <Text style={styles.helpText}>
                • Rate Limit: Prevents notification spam
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const pickerStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    backgroundColor: '#1f2937',
    borderRadius: 16,
    padding: 20,
    width: '85%',
    maxHeight: '70%',
  },
  title: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 20,
  },
  pickerRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 20,
  },
  column: {
    flex: 1,
    alignItems: 'center',
  },
  columnLabel: {
    color: '#9ca3af',
    fontSize: 12,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  scrollView: {
    height: 200,
  },
  option: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    marginVertical: 2,
  },
  optionSelected: {
    backgroundColor: '#3b82f6',
  },
  optionText: {
    color: '#9ca3af',
    fontSize: 16,
    textAlign: 'center',
  },
  optionTextSelected: {
    color: '#fff',
    fontWeight: '600',
  },
  optionList: {
    marginBottom: 16,
  },
  listOption: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginVertical: 2,
  },
  buttons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: '#374151',
    alignItems: 'center',
  },
  fullCancelButton: {
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: '#374151',
    alignItems: 'center',
  },
  cancelText: {
    color: '#9ca3af',
    fontSize: 16,
    fontWeight: '500',
  },
  confirmButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
  },
  confirmText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});

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
  loadingText: {
    color: '#9ca3af',
    fontSize: 16,
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
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#9ca3af',
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  serverCard: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  serverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  serverName: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: '600',
  },
  connectedBadge: {
    backgroundColor: '#10b981',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  connectedText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  settingInfo: {
    flex: 1,
    marginRight: 16,
  },
  settingLabel: {
    fontSize: 16,
    color: '#f3f4f6',
    marginBottom: 2,
  },
  settingDescription: {
    fontSize: 13,
    color: '#9ca3af',
  },
  divider: {
    height: 1,
    backgroundColor: '#374151',
    marginVertical: 8,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  timeButton: {
    backgroundColor: '#374151',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    minWidth: 100,
  },
  timeLabel: {
    color: '#9ca3af',
    fontSize: 11,
    marginBottom: 4,
  },
  timeValue: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: '500',
  },
  timeSeparator: {
    color: '#6b7280',
    fontSize: 14,
  },
  valueButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#374151',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  valueText: {
    color: '#f3f4f6',
    fontSize: 14,
  },
  valueArrow: {
    color: '#6b7280',
    fontSize: 18,
    marginLeft: 8,
  },
  emptyState: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    color: '#9ca3af',
    fontSize: 14,
    textAlign: 'center',
  },
  helpSection: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginTop: 8,
  },
  helpTitle: {
    color: '#f3f4f6',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  helpText: {
    color: '#9ca3af',
    fontSize: 13,
    lineHeight: 20,
  },
});
