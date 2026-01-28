import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
  Modal,
  TextInput,
  Switch,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Server, ConnectionState } from '../types';
import { getServers, addServer, updateServer, deleteServer } from '../services/storage';
import { ServerCard } from '../components/ServerCard';
import { wsService } from '../services/websocket';
import { QRScanner, QRConfig } from '../components/QRScanner';

interface ServerListProps {
  onSelectServer: (server: Server) => void;
  onOpenSetup?: () => void;
  onBack?: () => void;
}

export function ServerList({ onSelectServer, onOpenSetup, onBack }: ServerListProps) {
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingServer, setEditingServer] = useState<Server | null>(null);
  const [connectionStates, setConnectionStates] = useState<Map<string, ConnectionState>>(new Map());

  // Form state
  const [formName, setFormName] = useState('');
  const [formHost, setFormHost] = useState('');
  const [formPort, setFormPort] = useState('9877');
  const [formToken, setFormToken] = useState('');
  const [formUseTls, setFormUseTls] = useState(false);
  const [formIsDefault, setFormIsDefault] = useState(false);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formAutoApproveEnabled, setFormAutoApproveEnabled] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);

  const loadServers = useCallback(async () => {
    const loaded = await getServers();
    setServers(loaded);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  useEffect(() => {
    const unsubscribe = wsService.onStateChange((state) => {
      // Update connection state for the connected server
      setConnectionStates((prev) => {
        const newMap = new Map(prev);
        const connectedServer = servers.find(
          () => wsService.getState().status !== 'disconnected'
        );
        if (connectedServer) {
          newMap.set(connectedServer.id, state);
        }
        return newMap;
      });
    });

    return unsubscribe;
  }, [servers]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadServers();
    setRefreshing(false);
  };

  const openAddModal = () => {
    setEditingServer(null);
    setFormName('');
    setFormHost('');
    setFormPort('9877');
    setFormToken('');
    setFormUseTls(false);
    setFormIsDefault(servers.length === 0);
    setFormEnabled(true);
    setFormAutoApproveEnabled(false);
    setModalVisible(true);
  };

  const openEditModal = (server: Server) => {
    setEditingServer(server);
    setFormName(server.name);
    setFormHost(server.host);
    setFormPort(String(server.port));
    setFormToken(server.token);
    setFormUseTls(server.useTls);
    setFormIsDefault(server.isDefault || false);
    setFormEnabled(server.enabled !== false); // default true
    setFormAutoApproveEnabled(server.autoApproveEnabled || false);
    setModalVisible(true);
  };

  const [saving, setSaving] = useState(false);

  const validateConnection = async (server: Server): Promise<{ success: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const protocol = server.useTls ? 'wss' : 'ws';
      const url = `${protocol}://${server.host}:${server.port}`;
      let authSent = false;

      const timeout = setTimeout(() => {
        ws.close();
        resolve({ success: false, error: 'Connection timed out' });
      }, 5000);

      const ws = new WebSocket(url);

      ws.onopen = () => {
        // Wait for 'connected' message before sending auth
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // First message is 'connected', then we send auth
          if (data.type === 'connected' && !authSent) {
            authSent = true;
            ws.send(JSON.stringify({ type: 'authenticate', token: server.token }));
            return;
          }

          // After auth, expect 'authenticated' response
          if (data.type === 'authenticated') {
            clearTimeout(timeout);
            ws.close();
            if (data.success) {
              resolve({ success: true });
            } else {
              resolve({ success: false, error: data.error || 'Invalid token' });
            }
            return;
          }

          if (data.type === 'error') {
            clearTimeout(timeout);
            ws.close();
            resolve({ success: false, error: data.error || 'Authentication failed' });
            return;
          }
        } catch {
          clearTimeout(timeout);
          ws.close();
          resolve({ success: false, error: 'Invalid response from server' });
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        resolve({ success: false, error: 'Could not connect to server' });
      };

      ws.onclose = () => {
        clearTimeout(timeout);
      };
    });
  };

  const handleSave = async () => {
    if (!formName.trim() || !formHost.trim() || !formToken.trim()) {
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    const port = parseInt(formPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      Alert.alert('Error', 'Please enter a valid port number');
      return;
    }

    const serverData: Server = {
      id: editingServer?.id || `server_${Date.now()}`,
      name: formName.trim(),
      host: formHost.trim(),
      port,
      token: formToken.trim(),
      useTls: formUseTls,
      isDefault: formIsDefault,
      enabled: formEnabled,
      autoApproveEnabled: formAutoApproveEnabled,
    };

    // Validate connection before saving
    setSaving(true);
    const validation = await validateConnection(serverData);
    setSaving(false);

    if (!validation.success) {
      Alert.alert('Connection Failed', validation.error || 'Could not connect to server. Please check your settings.');
      return;
    }

    if (editingServer) {
      await updateServer(serverData);
    } else {
      await addServer(serverData);
    }

    // If this is the default, unset others
    if (formIsDefault) {
      const allServers = await getServers();
      for (const s of allServers) {
        if (s.id !== serverData.id && s.isDefault) {
          await updateServer({ ...s, isDefault: false });
        }
      }
    }

    setModalVisible(false);
    loadServers();
  };

  const handleDelete = (server: Server) => {
    Alert.alert(
      'Delete Server',
      `Are you sure you want to delete "${server.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteServer(server.id);
            loadServers();
          },
        },
      ]
    );
  };

  const handleServerPress = (server: Server) => {
    onSelectServer(server);
  };

  const handleQRScan = (config: QRConfig) => {
    setShowQRScanner(false);
    // Auto-fill the form with scanned data
    setFormHost(config.host);
    setFormPort(String(config.port));
    setFormToken(config.token);
    setFormUseTls(config.tls);
    // Suggest a name based on host
    if (!formName) {
      setFormName(config.host.includes('.local') ? config.host.replace('.local', '') : `Server ${config.host}`);
    }
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
      {onBack && (
        <View style={styles.header}>
          <TouchableOpacity onPress={onBack} style={styles.backButton}>
            <Text style={styles.backButtonText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Manage Servers</Text>
          <View style={styles.backButton} />
        </View>
      )}
      <FlatList
        data={servers}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ServerCard
            server={item}
            connectionState={connectionStates.get(item.id)}
            onPress={() => handleServerPress(item)}
            onEdit={() => openEditModal(item)}
            onDelete={() => handleDelete(item)}
          />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#ffffff" />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>No Servers</Text>
            <Text style={styles.emptyText}>
              Add a server to connect to your Claude Code sessions
            </Text>
            {onOpenSetup && (
              <TouchableOpacity style={styles.setupButton} onPress={onOpenSetup}>
                <Text style={styles.setupButtonText}>View Setup Guide</Text>
              </TouchableOpacity>
            )}
          </View>
        }
        ListHeaderComponent={
          servers.length > 0 && onOpenSetup ? (
            <TouchableOpacity style={styles.setupLink} onPress={onOpenSetup}>
              <Text style={styles.setupLinkText}>Need help? View setup instructions</Text>
            </TouchableOpacity>
          ) : null
        }
      />

      <TouchableOpacity style={styles.addButton} onPress={openAddModal}>
        <Text style={styles.addButtonText}>+ Add Server</Text>
      </TouchableOpacity>

      <Modal
        visible={modalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer} edges={['top']}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Text style={styles.cancelButton}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>
              {editingServer ? 'Edit Server' : 'Add Server'}
            </Text>
            <TouchableOpacity onPress={handleSave} disabled={saving}>
              <Text style={[styles.saveButton, saving && styles.saveButtonDisabled]}>
                {saving ? 'Validating...' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.form}>
            <TouchableOpacity
              style={styles.qrButton}
              onPress={() => setShowQRScanner(true)}
            >
              <Text style={styles.qrButtonText}>Scan QR Code</Text>
            </TouchableOpacity>

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or enter manually</Text>
              <View style={styles.dividerLine} />
            </View>

            <Text style={styles.label}>Name *</Text>
            <TextInput
              style={styles.input}
              value={formName}
              onChangeText={setFormName}
              placeholder="My Server"
              placeholderTextColor="#6b7280"
            />

            <Text style={styles.label}>Host *</Text>
            <TextInput
              style={styles.input}
              value={formHost}
              onChangeText={setFormHost}
              placeholder="192.168.1.100 or server.local"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.label}>Port</Text>
            <TextInput
              style={styles.input}
              value={formPort}
              onChangeText={setFormPort}
              placeholder="9877"
              placeholderTextColor="#6b7280"
              keyboardType="number-pad"
            />

            <Text style={styles.label}>Token *</Text>
            <TextInput
              style={styles.input}
              value={formToken}
              onChangeText={setFormToken}
              placeholder="Authentication token from daemon"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />

            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Use TLS (HTTPS)</Text>
              <Switch
                value={formUseTls}
                onValueChange={setFormUseTls}
                trackColor={{ false: '#374151', true: '#3b82f6' }}
              />
            </View>

            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Default Server</Text>
              <Switch
                value={formIsDefault}
                onValueChange={setFormIsDefault}
                trackColor={{ false: '#374151', true: '#3b82f6' }}
              />
            </View>

            <View style={styles.switchRow}>
              <View style={styles.switchInfo}>
                <Text style={styles.switchLabel}>Connection Enabled</Text>
                <Text style={styles.switchHint}>Disable to skip connecting to this server</Text>
              </View>
              <Switch
                value={formEnabled}
                onValueChange={setFormEnabled}
                trackColor={{ false: '#374151', true: '#10b981' }}
              />
            </View>

            <View style={styles.switchRow}>
              <View style={styles.switchInfo}>
                <Text style={styles.switchLabel}>Auto-Approve Mode</Text>
                <Text style={styles.switchHint}>Enable if Claude has dangerously-skip-permissions</Text>
              </View>
              <Switch
                value={formAutoApproveEnabled}
                onValueChange={setFormAutoApproveEnabled}
                trackColor={{ false: '#374151', true: '#f59e0b' }}
              />
            </View>

            <Text style={styles.hint}>
              Tip: Visit http://your-server:9877 in a browser to see a QR code for easy setup.
              The token can also be found in /etc/claude-companion/config.json
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal
        visible={showQRScanner}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowQRScanner(false)}
      >
        <QRScanner
          onScan={handleQRScan}
          onClose={() => setShowQRScanner(false)}
        />
      </Modal>
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
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1f2937',
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  backButton: {
    width: 60,
  },
  backButtonText: {
    color: '#3b82f6',
    fontSize: 16,
  },
  headerTitle: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: '600',
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
  listContent: {
    paddingVertical: 12,
    paddingBottom: 40,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingTop: 100,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#f3f4f6',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 15,
    color: '#9ca3af',
    textAlign: 'center',
  },
  addButton: {
    backgroundColor: '#3b82f6',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  addButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#111827',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#f3f4f6',
  },
  cancelButton: {
    color: '#9ca3af',
    fontSize: 16,
  },
  saveButton: {
    color: '#3b82f6',
    fontSize: 16,
    fontWeight: '600',
  },
  saveButtonDisabled: {
    color: '#6b7280',
  },
  form: {
    padding: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: '#d1d5db',
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#374151',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 20,
    paddingVertical: 8,
  },
  switchLabel: {
    fontSize: 16,
    color: '#d1d5db',
  },
  switchInfo: {
    flex: 1,
  },
  switchHint: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  hint: {
    fontSize: 13,
    color: '#6b7280',
    marginTop: 24,
    lineHeight: 18,
  },
  setupButton: {
    marginTop: 20,
    backgroundColor: '#374151',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  setupButtonText: {
    color: '#60a5fa',
    fontSize: 14,
    fontWeight: '500',
  },
  setupLink: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginBottom: 8,
  },
  setupLinkText: {
    color: '#6b7280',
    fontSize: 13,
    textAlign: 'center',
  },
  qrButton: {
    backgroundColor: '#374151',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#4b5563',
    borderStyle: 'dashed',
  },
  qrButtonText: {
    color: '#60a5fa',
    fontSize: 16,
    fontWeight: '600',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 8,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#374151',
  },
  dividerText: {
    color: '#6b7280',
    fontSize: 13,
    marginHorizontal: 12,
  },
});
