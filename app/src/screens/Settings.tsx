import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  Alert,
  Linking,
  Platform,
} from 'react-native';
import { getSettings, saveSettings, AppSettings, clearAll, getServers } from '../services/storage';
import { historyService } from '../services/history';
import { registerWithDaemon, unregisterWithDaemon } from '../services/push';
import { wsService } from '../services/websocket';

interface SettingsProps {
  onBack: () => void;
  onOpenNotificationSettings: () => void;
  onOpenUsage: () => void;
  onOpenAgents?: () => void;
  onOpenArchive?: () => void;
}

export function Settings({ onBack, onOpenNotificationSettings, onOpenUsage, onOpenAgents, onOpenArchive }: SettingsProps) {
  const [settings, setSettings] = useState<AppSettings>({
    stayConnected: false,
    pushEnabled: false,
  });
  const [loading, setLoading] = useState(true);
  const [pushAvailable] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const loaded = await getSettings();
    setSettings(loaded);
    setLoading(false);
  };

  const updateSetting = async <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    await saveSettings(newSettings);
  };

  const handleStayConnectedChange = async (value: boolean) => {
    updateSetting('stayConnected', value);
  };

  const handlePushEnabledChange = async (value: boolean) => {
    updateSetting('pushEnabled', value);

    if (value) {
      // Registration happens automatically when connected to a server
      // Just save the setting - useConnection will register when connected
      if (!wsService.isConnected()) {
        Alert.alert(
          'Push Enabled',
          'Push notifications are enabled. You will be registered when you connect to a server.'
        );
      } else {
        const servers = await getServers();
        const connectedServer = servers.find(s => wsService.getServerId() === s.id);
        const deviceId = `${Platform.OS}-${connectedServer?.id || 'default'}`;
        const success = await registerWithDaemon(deviceId);
        if (success) {
          Alert.alert('Push Enabled', 'Push notifications registered successfully.');
        }
      }
    } else {
      // Unregister if connected
      if (wsService.isConnected()) {
        const servers = await getServers();
        const connectedServer = servers.find(s => wsService.getServerId() === s.id);
        const deviceId = `${Platform.OS}-${connectedServer?.id || 'default'}`;
        await unregisterWithDaemon(deviceId);
      }
    }
  };

  const handleClearData = () => {
    Alert.alert(
      'Clear All Data',
      'This will delete all saved servers and settings. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await clearAll();
            setSettings({ stayConnected: false, pushEnabled: false });
            Alert.alert('Done', 'All data has been cleared');
          },
        },
      ]
    );
  };

  const handleRotateToken = () => {
    if (!wsService.isConnected()) {
      Alert.alert('Not Connected', 'You must be connected to a server to rotate the token.');
      return;
    }

    Alert.alert(
      'Rotate Token',
      'This will generate a new authentication token. You will need to update the token in all connected apps. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Rotate',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await wsService.sendRequest('rotate_token');
              if (response.success && response.payload) {
                const { newToken } = response.payload as { newToken: string };
                Alert.alert(
                  'Token Rotated',
                  `New token: ${newToken}\n\nMake sure to update this token in your server configuration and reconnect.`,
                  [{ text: 'OK' }]
                );
              } else {
                Alert.alert('Error', response.error || 'Failed to rotate token');
              }
            } catch (err) {
              Alert.alert('Error', 'Failed to rotate token. Please try again.');
            }
          },
        },
      ]
    );
  };

  const openTermux = () => {
    Linking.openURL('https://play.google.com/store/apps/details?id=com.termux');
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Connection</Text>

          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>Stay Connected</Text>
              <Text style={styles.settingDescription}>
                Keep WebSocket connection active in background
              </Text>
            </View>
            <Switch
              value={settings.stayConnected}
              onValueChange={handleStayConnectedChange}
              trackColor={{ false: '#374151', true: '#3b82f6' }}
            />
          </View>

          <TouchableOpacity style={styles.linkRow} onPress={onOpenNotificationSettings}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>Push Notifications</Text>
              <Text style={styles.settingDescription}>
                Configure alerts and quiet hours
              </Text>
            </View>
            <Text style={styles.linkArrow}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.linkRow} onPress={onOpenUsage}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>Usage Statistics</Text>
              <Text style={styles.settingDescription}>
                View token usage and estimated costs
              </Text>
            </View>
            <Text style={styles.linkArrow}>›</Text>
          </TouchableOpacity>

          {onOpenAgents && (
            <TouchableOpacity style={styles.linkRow} onPress={onOpenAgents}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Sub-Agents</Text>
                <Text style={styles.settingDescription}>
                  View spawned background agents
                </Text>
              </View>
              <Text style={styles.linkArrow}>›</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Terminal Access</Text>

          <TouchableOpacity style={styles.linkRow} onPress={openTermux}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>Get Termux</Text>
              <Text style={styles.settingDescription}>
                For full terminal access via Mosh
              </Text>
            </View>
            <Text style={styles.linkArrow}>›</Text>
          </TouchableOpacity>

          <View style={styles.hintBox}>
            <Text style={styles.hintText}>
              For full terminal access, install Termux and Mosh. You can then
              connect directly to your server&apos;s tmux session.
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Security</Text>

          <TouchableOpacity style={styles.actionRow} onPress={handleRotateToken}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>Regenerate Token</Text>
              <Text style={styles.settingDescription}>
                Generate a new authentication token (disconnects other clients)
              </Text>
            </View>
            <Text style={styles.linkArrow}>›</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Data</Text>

          {onOpenArchive && (
            <TouchableOpacity style={styles.linkRow} onPress={onOpenArchive}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Conversation Archive</Text>
                <Text style={styles.settingDescription}>
                  View saved conversation summaries
                </Text>
              </View>
              <Text style={styles.linkArrow}>&gt;</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.actionRow}
            onPress={() => {
              Alert.alert(
                'Clear History',
                'This will delete all saved session history. Are you sure?',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Clear',
                    style: 'destructive',
                    onPress: async () => {
                      await historyService.clearAll();
                      Alert.alert('Done', 'Session history has been cleared');
                    },
                  },
                ]
              );
            }}
          >
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>Clear History</Text>
              <Text style={styles.settingDescription}>
                Delete all saved session history
              </Text>
            </View>
            <Text style={styles.linkArrow}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.dangerRow} onPress={handleClearData}>
            <Text style={styles.dangerText}>Clear All Data</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <Text style={styles.aboutText}>Claude Companion v1.0.0</Text>
          <Text style={styles.aboutDescription}>
            A companion app for Claude Code that lets you monitor sessions
            and respond to Claude from your mobile device.
          </Text>
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
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#111827',
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
    paddingBottom: 40,
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#9ca3af',
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  settingInfo: {
    flex: 1,
    marginRight: 16,
  },
  settingLabel: {
    fontSize: 16,
    color: '#f3f4f6',
    marginBottom: 4,
  },
  settingDescription: {
    fontSize: 13,
    color: '#9ca3af',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  linkArrow: {
    fontSize: 20,
    color: '#6b7280',
  },
  hintBox: {
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#3b82f6',
  },
  hintText: {
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 18,
  },
  dangerRow: {
    backgroundColor: '#7f1d1d',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  dangerText: {
    fontSize: 16,
    color: '#fecaca',
    fontWeight: '500',
  },
  aboutText: {
    fontSize: 16,
    color: '#f3f4f6',
    marginBottom: 8,
  },
  aboutDescription: {
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 18,
  },
});
