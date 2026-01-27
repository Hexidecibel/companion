import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  Alert,
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
  const handleToggleEnabled = (value: boolean) => {
    onUpdate({ ...prefs, enabled: value });
  };

  const handleToggleInstant = async (value: boolean) => {
    onUpdate({ ...prefs, instantNotify: value });

    // Update daemon if connected to this server
    if (isConnected && wsService.getServerId() === server.id) {
      try {
        await wsService.sendRequest('set_instant_notify', {
          enabled: value,
        });
      } catch (err) {
        console.error('Failed to update instant notify:', err);
      }
    }
  };

  return (
    <View style={styles.serverCard}>
      <View style={styles.serverHeader}>
        <Text style={styles.serverName}>{server.name}</Text>
        {isConnected && wsService.getServerId() === server.id && (
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

          {!prefs.instantNotify && (
            <View style={styles.infoBox}>
              <Text style={styles.infoText}>
                Batched mode: Notifications are grouped and sent every few hours
                to reduce interruptions.
              </Text>
            </View>
          )}
        </>
      )}
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
                • Instant: Get notified immediately when Claude needs input
              </Text>
              <Text style={styles.helpText}>
                • Batched: Notifications are grouped to reduce interruptions
              </Text>
              <Text style={styles.helpText}>
                • Changes apply when you connect to each server
              </Text>
            </View>
          </>
        )}
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
  infoBox: {
    backgroundColor: '#374151',
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  infoText: {
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 18,
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
