import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  Modal,
  Alert,
} from 'react-native';
import { wsService } from '../services/connectionManager';

interface EscalationConfig {
  events: {
    waiting_for_input: boolean;
    error_detected: boolean;
    session_completed: boolean;
  };
  pushDelaySeconds: number;
  rateLimitSeconds: number;
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
  };
}

interface RegisteredDevice {
  deviceId: string;
  token: string;
  registeredAt: number;
  lastSeen: number;
}

interface HistoryEntry {
  id: string;
  timestamp: number;
  eventType: string;
  sessionId?: string;
  sessionName?: string;
  preview: string;
  tier: 'browser' | 'push' | 'both';
  acknowledged: boolean;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  waiting_for_input: 'Waiting',
  error_detected: 'Error',
  session_completed: 'Completed',
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  waiting_for_input: '#f59e0b',
  error_detected: '#ef4444',
  session_completed: '#10b981',
};

const PUSH_DELAY_OPTIONS = [
  { value: 0, label: 'Immediate' },
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 300, label: '5 min' },
  { value: 600, label: '10 min' },
  { value: 1800, label: '30 min' },
];

const RATE_LIMIT_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 30, label: '30s' },
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 900, label: '15 min' },
];

const TIER_COLORS: Record<string, string> = {
  browser: '#3b82f6',
  push: '#f59e0b',
  both: '#10b981',
};

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
                    <Text
                      style={[
                        pickerStyles.optionText,
                        hour === h && pickerStyles.optionTextSelected,
                      ]}
                    >
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
                    <Text
                      style={[
                        pickerStyles.optionText,
                        minute === m && pickerStyles.optionTextSelected,
                      ]}
                    >
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

// Option picker modal
function OptionPicker({
  visible,
  title,
  options,
  value,
  onSelect,
  onCancel,
}: {
  visible: boolean;
  title: string;
  options: { value: number; label: string }[];
  value: number;
  onSelect: (value: number) => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={pickerStyles.overlay}>
        <View style={pickerStyles.container}>
          <Text style={pickerStyles.title}>{title}</Text>
          <View style={pickerStyles.optionList}>
            {options.map((option) => (
              <TouchableOpacity
                key={option.value}
                style={[
                  pickerStyles.listOption,
                  value === option.value && pickerStyles.optionSelected,
                ]}
                onPress={() => onSelect(option.value)}
              >
                <Text
                  style={[
                    pickerStyles.optionText,
                    value === option.value && pickerStyles.optionTextSelected,
                  ]}
                >
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

export function NotificationSettings({ onBack }: NotificationSettingsProps) {
  const [isConnected, setIsConnected] = useState(wsService.isConnected());
  const [config, setConfig] = useState<EscalationConfig | null>(null);
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [showDelayPicker, setShowDelayPicker] = useState(false);
  const [showRatePicker, setShowRatePicker] = useState(false);

  useEffect(() => {
    const unsubscribe = wsService.onStateChange((state) => {
      setIsConnected(state.status === 'connected');
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (isConnected) {
      loadAll();
    } else {
      setLoading(false);
    }
  }, [isConnected]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [configRes, devicesRes, historyRes] = await Promise.all([
        wsService.sendRequest('get_escalation_config'),
        wsService.sendRequest('get_devices'),
        wsService.sendRequest('get_notification_history', { limit: 20 }),
      ]);

      if (configRes.success && configRes.payload) {
        const p = configRes.payload as { config: EscalationConfig };
        setConfig(p.config);
      }
      if (devicesRes.success && devicesRes.payload) {
        const p = devicesRes.payload as { devices: RegisteredDevice[] };
        setDevices(p.devices ?? []);
      }
      if (historyRes.success && historyRes.payload) {
        const p = historyRes.payload as { entries: HistoryEntry[] };
        setHistory(p.entries ?? []);
      }
    } catch (err) {
      console.error('Failed to load notification settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateConfig = useCallback(async (updates: Partial<EscalationConfig>) => {
    try {
      const response = await wsService.sendRequest('update_escalation_config', updates);
      if (response.success && response.payload) {
        const p = response.payload as { config: EscalationConfig };
        setConfig(p.config);
      }
    } catch (err) {
      console.error('Failed to update escalation config:', err);
    }
  }, []);

  const handleEventToggle = (eventType: keyof EscalationConfig['events'], value: boolean) => {
    if (!config) return;
    updateConfig({ events: { ...config.events, [eventType]: value } });
  };

  const handleQuietHoursToggle = (value: boolean) => {
    if (!config) return;
    updateConfig({ quietHours: { ...config.quietHours, enabled: value } });
  };

  const handleTestPush = async () => {
    try {
      await wsService.sendRequest('send_test_notification');
      Alert.alert('Sent', 'Test push notification sent to all devices.');
    } catch {
      Alert.alert('Error', 'Failed to send test notification.');
    }
  };

  const formatTime = (time: string) => {
    const [h, m] = time.split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${hour12}:${m.toString().padStart(2, '0')} ${suffix}`;
  };

  const getDelayLabel = (seconds: number) => {
    const opt = PUSH_DELAY_OPTIONS.find((o) => o.value === seconds);
    return opt?.label || `${seconds}s`;
  };

  const getRateLimitLabel = (seconds: number) => {
    const opt = RATE_LIMIT_OPTIONS.find((o) => o.value === seconds);
    return opt?.label || `${seconds}s`;
  };

  const formatRelative = (timestamp: number) => {
    const delta = Date.now() - timestamp;
    if (delta < 60_000) return 'just now';
    const mins = Math.floor(delta / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} style={styles.backButton}>
            <Text style={styles.backButtonText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Notifications</Text>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.centered}>
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </View>
    );
  }

  if (!isConnected) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} style={styles.backButton}>
            <Text style={styles.backButtonText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Notifications</Text>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.centered}>
          <Text style={styles.emptyText}>Connect to a server to configure notifications.</Text>
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
        {config && (
          <>
            {/* Escalation Config */}
            <Text style={styles.sectionTitle}>Escalation</Text>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Event Types</Text>
              {(['waiting_for_input', 'error_detected', 'session_completed'] as const).map(
                (evt) => (
                  <View key={evt} style={styles.settingRow}>
                    <Text style={styles.settingLabel}>{EVENT_TYPE_LABELS[evt] || evt}</Text>
                    <Switch
                      value={config.events[evt]}
                      onValueChange={(v) => handleEventToggle(evt, v)}
                      trackColor={{ false: '#374151', true: '#3b82f6' }}
                    />
                  </View>
                )
              )}
            </View>

            <TouchableOpacity style={styles.card} onPress={() => setShowDelayPicker(true)}>
              <View style={styles.settingRowNoFlex}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingLabel}>Push Escalation Delay</Text>
                  <Text style={styles.settingDescription}>
                    Wait before sending push if unacknowledged
                  </Text>
                </View>
                <View style={styles.valueButton}>
                  <Text style={styles.valueText}>{getDelayLabel(config.pushDelaySeconds)}</Text>
                  <Text style={styles.valueArrow}>›</Text>
                </View>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.card} onPress={() => setShowRatePicker(true)}>
              <View style={styles.settingRowNoFlex}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingLabel}>Rate Limit</Text>
                  <Text style={styles.settingDescription}>
                    Min time between notifications per session
                  </Text>
                </View>
                <View style={styles.valueButton}>
                  <Text style={styles.valueText}>{getRateLimitLabel(config.rateLimitSeconds)}</Text>
                  <Text style={styles.valueArrow}>›</Text>
                </View>
              </View>
            </TouchableOpacity>

            <View style={styles.card}>
              <View style={styles.settingRow}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingLabel}>Quiet Hours</Text>
                  <Text style={styles.settingDescription}>Suppress push during set hours</Text>
                </View>
                <Switch
                  value={config.quietHours.enabled}
                  onValueChange={handleQuietHoursToggle}
                  trackColor={{ false: '#374151', true: '#3b82f6' }}
                />
              </View>
              {config.quietHours.enabled && (
                <View style={styles.timeRow}>
                  <TouchableOpacity
                    style={styles.timeButton}
                    onPress={() => setShowStartPicker(true)}
                  >
                    <Text style={styles.timeLabel}>From</Text>
                    <Text style={styles.timeValue}>{formatTime(config.quietHours.start)}</Text>
                  </TouchableOpacity>
                  <Text style={styles.timeSeparator}>to</Text>
                  <TouchableOpacity
                    style={styles.timeButton}
                    onPress={() => setShowEndPicker(true)}
                  >
                    <Text style={styles.timeLabel}>Until</Text>
                    <Text style={styles.timeValue}>{formatTime(config.quietHours.end)}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </>
        )}

        {/* Devices */}
        <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Devices ({devices.length})</Text>
        {devices.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.emptyText}>
              Push automatically registered on connect. No devices yet.
            </Text>
          </View>
        ) : (
          devices.map((device) => (
            <View key={device.deviceId} style={styles.card}>
              <Text style={styles.deviceId}>{device.deviceId}</Text>
              <Text style={styles.settingDescription}>
                Registered {new Date(device.registeredAt).toLocaleDateString()} | Last seen{' '}
                {formatRelative(device.lastSeen)}
              </Text>
            </View>
          ))
        )}

        {devices.length > 0 && (
          <TouchableOpacity style={styles.actionButton} onPress={handleTestPush}>
            <Text style={styles.actionButtonText}>Send Test Push</Text>
          </TouchableOpacity>
        )}

        {/* Recent History */}
        <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Recent History</Text>
        {history.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.emptyText}>No notification history yet.</Text>
          </View>
        ) : (
          history.slice(0, 10).map((entry) => (
            <View key={entry.id} style={styles.card}>
              <View style={styles.historyHeader}>
                <View
                  style={[
                    styles.badge,
                    { backgroundColor: EVENT_TYPE_COLORS[entry.eventType] || '#374151' },
                  ]}
                >
                  <Text style={styles.badgeText}>
                    {EVENT_TYPE_LABELS[entry.eventType] || entry.eventType}
                  </Text>
                </View>
                <View
                  style={[styles.badge, { backgroundColor: TIER_COLORS[entry.tier] || '#374151' }]}
                >
                  <Text style={styles.badgeText}>{entry.tier}</Text>
                </View>
                {entry.acknowledged && (
                  <View style={[styles.badge, { backgroundColor: '#10b981' }]}>
                    <Text style={styles.badgeText}>ACK</Text>
                  </View>
                )}
                <Text style={styles.timestampText}>{formatRelative(entry.timestamp)}</Text>
              </View>
              <Text style={styles.previewText} numberOfLines={2}>
                {entry.preview}
              </Text>
            </View>
          ))
        )}

        <View style={styles.helpSection}>
          <Text style={styles.helpTitle}>How it works</Text>
          <Text style={styles.helpText}>1. Event occurs (waiting, error, completed)</Text>
          <Text style={styles.helpText}>2. Browser notification fires immediately</Text>
          <Text style={styles.helpText}>3. If unacknowledged after delay, push sent to phone</Text>
          <Text style={styles.helpText}>4. Viewing session or sending input cancels push</Text>
        </View>
      </ScrollView>

      {config && (
        <>
          <TimePicker
            visible={showStartPicker}
            value={config.quietHours.start}
            onSelect={(time) => {
              setShowStartPicker(false);
              updateConfig({ quietHours: { ...config.quietHours, start: time } });
            }}
            onCancel={() => setShowStartPicker(false)}
            title="Quiet Hours Start"
          />
          <TimePicker
            visible={showEndPicker}
            value={config.quietHours.end}
            onSelect={(time) => {
              setShowEndPicker(false);
              updateConfig({ quietHours: { ...config.quietHours, end: time } });
            }}
            onCancel={() => setShowEndPicker(false)}
            title="Quiet Hours End"
          />
          <OptionPicker
            visible={showDelayPicker}
            title="Push Escalation Delay"
            options={PUSH_DELAY_OPTIONS}
            value={config.pushDelaySeconds}
            onSelect={(value) => {
              setShowDelayPicker(false);
              updateConfig({ pushDelaySeconds: value });
            }}
            onCancel={() => setShowDelayPicker(false)}
          />
          <OptionPicker
            visible={showRatePicker}
            title="Rate Limit"
            options={RATE_LIMIT_OPTIONS}
            value={config.rateLimitSeconds}
            onSelect={(value) => {
              setShowRatePicker(false);
              updateConfig({ rateLimitSeconds: value });
            }}
            onCancel={() => setShowRatePicker(false)}
          />
        </>
      )}
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
    paddingBottom: 40,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#9ca3af',
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  cardTitle: {
    color: '#f3f4f6',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  settingRowNoFlex: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  deviceId: {
    color: '#f3f4f6',
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 4,
  },
  actionButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  timestampText: {
    color: '#6b7280',
    fontSize: 12,
    marginLeft: 'auto',
  },
  previewText: {
    color: '#9ca3af',
    fontSize: 13,
    lineHeight: 18,
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
    marginTop: 16,
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
