import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Linking,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Constants from 'expo-constants';
import { getSettings, AppSettings, clearAll } from '../services/storage';
import { historyService } from '../services/history';
import { wsService } from '../services/websocket';
import { fontScaleService } from '../services/fontScale';
import { scaledFont } from '../theme/fonts';

interface SettingsProps {
  onBack: () => void;
  onOpenNotificationSettings: () => void;
  onOpenAgents?: () => void;
  onOpenArchive?: () => void;
}

export function Settings({ onBack, onOpenNotificationSettings, onOpenAgents, onOpenArchive }: SettingsProps) {
  const [settings, setSettings] = useState<AppSettings>({});
  const [loading, setLoading] = useState(true);
  const [currentFontScale, setCurrentFontScale] = useState(fontScaleService.getScale());
  useEffect(() => {
    loadSettings();
    return fontScaleService.subscribe(setCurrentFontScale);
  }, []);

  const loadSettings = async () => {
    const loaded = await getSettings();
    setSettings(loaded);
    setLoading(false);
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
            setSettings({});
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
      <LinearGradient colors={['#1a2744', '#1f1a3d']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.placeholder} />
      </LinearGradient>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Connection</Text>

          <TouchableOpacity style={styles.linkRow} onPress={onOpenNotificationSettings}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingLabel}>Notification Settings</Text>
              <Text style={styles.settingDescription}>
                Configure alerts and quiet hours
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
          <Text style={styles.sectionTitle}>Display</Text>
          <View style={styles.fontScaleRow}>
            <Text style={styles.settingLabel}>Text Size</Text>
            <View style={styles.fontScaleButtons}>
              {([
                { label: 'S', value: 0.85 },
                { label: 'M', value: 1.0 },
                { label: 'L', value: 1.15 },
                { label: 'XL', value: 1.3 },
              ] as const).map((preset) => (
                <TouchableOpacity
                  key={preset.label}
                  style={[
                    styles.fontScaleButton,
                    currentFontScale === preset.value && styles.fontScaleButtonActive,
                  ]}
                  onPress={() => fontScaleService.setScale(preset.value)}
                  activeOpacity={0.7}
                >
                  <Text style={[
                    styles.fontScaleButtonText,
                    currentFontScale === preset.value && styles.fontScaleButtonTextActive,
                  ]}>
                    {preset.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={styles.fontScalePreview}>
            <Text style={[styles.fontScalePreviewText, { fontSize: scaledFont(15, currentFontScale) }]}>
              The quick brown fox jumps over the lazy dog.
            </Text>
          </View>
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
          <Text style={styles.aboutText}>
            Companion v{Constants.expoConfig?.version || '1.0.0'}
          </Text>
          {Constants.expoConfig?.extra?.buildDate && (
            <Text style={styles.aboutBuildDate}>
              Built {new Date(Constants.expoConfig.extra.buildDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
            </Text>
          )}
          <Text style={styles.aboutDescription}>
            A companion app for AI coding sessions that lets you monitor sessions
            and respond from your mobile device.
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
    borderLeftColor: '#8b5cf6',
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
    marginBottom: 4,
  },
  aboutBuildDate: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 8,
  },
  aboutDescription: {
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 18,
  },
  fontScaleRow: {
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  fontScaleButtons: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  fontScaleButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#374151',
    alignItems: 'center',
  },
  fontScaleButtonActive: {
    backgroundColor: '#3b82f6',
  },
  fontScaleButtonText: {
    color: '#9ca3af',
    fontSize: 14,
    fontWeight: '600',
  },
  fontScaleButtonTextActive: {
    color: '#ffffff',
  },
  fontScalePreview: {
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#8b5cf6',
  },
  fontScalePreviewText: {
    color: '#f3f4f6',
    lineHeight: 22,
  },
});
