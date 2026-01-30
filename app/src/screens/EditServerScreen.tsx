import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Switch,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Server } from '../types';
import { getServers, addServer, updateServer, deleteServer } from '../services/storage';
import { QRScanner, QRConfig } from '../components/QRScanner';
import Ionicons from '@expo/vector-icons/Ionicons';

interface EditServerScreenProps {
  server: Server | null; // null = add new
  onBack: () => void;
  onSaved: () => void;
}

export function EditServerScreen({ server, onBack, onSaved }: EditServerScreenProps) {
  const [formName, setFormName] = useState(server?.name || '');
  const [formHost, setFormHost] = useState(server?.host || '');
  const [formPort, setFormPort] = useState(server?.port?.toString() || '9877');
  const [formToken, setFormToken] = useState(server?.token || '');
  const [formUseTls, setFormUseTls] = useState(server?.useTls || false);
  const [formIsDefault, setFormIsDefault] = useState(server?.isDefault || false);
  const [formEnabled, setFormEnabled] = useState(server?.enabled !== false);
  const [formAutoApproveEnabled, setFormAutoApproveEnabled] = useState(server?.autoApproveEnabled || false);
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);

  const isEditing = server !== null;

  const handleQRScan = (config: QRConfig) => {
    setFormName(`Server ${config.host}`);
    setFormHost(config.host);
    setFormPort(config.port.toString());
    if (config.token) setFormToken(config.token);
    setFormUseTls(config.tls);
    setShowQRScanner(false);
  };

  const validateConnection = async (testServer: Server): Promise<{ success: boolean; error?: string }> => {
    return new Promise((resolve) => {
      const protocol = testServer.useTls ? 'wss' : 'ws';
      const url = `${protocol}://${testServer.host}:${testServer.port}`;
      let authSent = false;

      const timeout = setTimeout(() => {
        ws.close();
        resolve({ success: false, error: 'Connection timed out' });
      }, 5000);

      const ws = new WebSocket(url);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'connected' && !authSent) {
            authSent = true;
            ws.send(JSON.stringify({ type: 'authenticate', token: testServer.token }));
            return;
          }
          if (data.type === 'authenticated') {
            clearTimeout(timeout);
            ws.close();
            resolve({ success: data.success, error: data.success ? undefined : (data.error || 'Invalid token') });
            return;
          }
          if (data.type === 'error') {
            clearTimeout(timeout);
            ws.close();
            resolve({ success: false, error: data.error || 'Authentication failed' });
          }
        } catch {
          clearTimeout(timeout);
          ws.close();
          resolve({ success: false, error: 'Invalid response' });
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        resolve({ success: false, error: 'Could not connect' });
      };

      ws.onclose = () => clearTimeout(timeout);
    });
  };

  const handleSave = async () => {
    if (!formName.trim() || !formHost.trim() || !formToken.trim()) {
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    const port = parseInt(formPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      Alert.alert('Error', 'Invalid port number');
      return;
    }

    setSaving(true);

    const serverData: Server = {
      id: server?.id || `server_${Date.now()}`,
      name: formName.trim(),
      host: formHost.trim(),
      port,
      token: formToken.trim(),
      useTls: formUseTls,
      isDefault: formIsDefault,
      enabled: formEnabled,
      autoApproveEnabled: formAutoApproveEnabled,
    };

    // Validate connection
    const validation = await validateConnection(serverData);
    if (!validation.success) {
      setSaving(false);
      Alert.alert('Connection Failed', validation.error || 'Could not connect to server');
      return;
    }

    try {
      if (isEditing) {
        await updateServer(serverData);
      } else {
        await addServer(serverData);
      }
      onSaved();
    } catch (err) {
      Alert.alert('Error', 'Failed to save server');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!server) return;
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
            onSaved();
          },
        },
      ]
    );
  };

  if (showQRScanner) {
    return (
      <QRScanner
        onScan={handleQRScan}
        onClose={() => setShowQRScanner(false)}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isEditing ? 'Edit Server' : 'Add Server'}</Text>
        <TouchableOpacity onPress={handleSave} style={styles.saveButton} disabled={saving}>
          {saving ? (
            <ActivityIndicator size="small" color="#3b82f6" />
          ) : (
            <Text style={styles.saveButtonText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        {!isEditing && (
          <TouchableOpacity style={styles.qrButton} onPress={() => setShowQRScanner(true)}>
            <Text style={styles.qrButtonText}>Scan QR Code</Text>
          </TouchableOpacity>
        )}

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Name *</Text>
          <TextInput
            style={styles.input}
            value={formName}
            onChangeText={setFormName}
            placeholder="My Server"
            placeholderTextColor="#6b7280"
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Host *</Text>
          <TextInput
            style={styles.input}
            value={formHost}
            onChangeText={setFormHost}
            placeholder="192.168.1.100"
            placeholderTextColor="#6b7280"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Port</Text>
          <TextInput
            style={styles.input}
            value={formPort}
            onChangeText={setFormPort}
            placeholder="9877"
            placeholderTextColor="#6b7280"
            keyboardType="number-pad"
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Token *</Text>
          <View style={styles.tokenRow}>
            <TextInput
              style={[styles.input, styles.tokenInput]}
              value={formToken}
              onChangeText={setFormToken}
              placeholder="Authentication token"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!showToken}
            />
            <TouchableOpacity
              style={styles.tokenToggle}
              onPress={() => setShowToken(!showToken)}
            >
              <Ionicons
                name={showToken ? 'eye-off-outline' : 'eye-outline'}
                size={22}
                color="#9ca3af"
              />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Use TLS (wss://)</Text>
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

        {isEditing && (
          <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
            <Text style={styles.deleteButtonText}>Delete Server</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
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
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#1f2937',
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  backButton: {
    minWidth: 60,
  },
  backButtonText: {
    color: '#9ca3af',
    fontSize: 16,
  },
  headerTitle: {
    color: '#f3f4f6',
    fontSize: 17,
    fontWeight: '600',
  },
  saveButton: {
    minWidth: 60,
    alignItems: 'flex-end',
  },
  saveButtonText: {
    color: '#3b82f6',
    fontSize: 16,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  qrButton: {
    backgroundColor: '#3b82f6',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 20,
  },
  qrButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    color: '#9ca3af',
    fontSize: 14,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#374151',
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tokenInput: {
    flex: 1,
  },
  tokenToggle: {
    padding: 10,
    marginLeft: 8,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  switchLabel: {
    color: '#f3f4f6',
    fontSize: 16,
  },
  switchHint: {
    color: '#6b7280',
    fontSize: 12,
    marginTop: 4,
    marginBottom: 16,
  },
  deleteButton: {
    backgroundColor: '#7f1d1d',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 24,
  },
  deleteButtonText: {
    color: '#fecaca',
    fontSize: 16,
    fontWeight: '600',
  },
});
