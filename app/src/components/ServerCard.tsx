import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Server, ConnectionState } from '../types';

interface ServerCardProps {
  server: Server;
  connectionState?: ConnectionState;
  onPress: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function ServerCard({ server, connectionState, onPress, onEdit, onDelete }: ServerCardProps) {
  const getStatusColor = () => {
    if (!connectionState) return '#6b7280';

    switch (connectionState.status) {
      case 'connected':
        return '#22c55e';
      case 'connecting':
      case 'reconnecting':
        return '#f97316';
      case 'error':
        return '#ef4444';
      default:
        return '#6b7280';
    }
  };

  const getStatusText = () => {
    if (!connectionState) return 'Not connected';

    switch (connectionState.status) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting...';
      case 'reconnecting':
        return `Reconnecting...`;
      case 'error':
        return connectionState.error || 'Error';
      default:
        return 'Disconnected';
    }
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.content}
        onPress={onPress}
        activeOpacity={0.7}
      >
        <View style={styles.header}>
          <Text style={styles.name} numberOfLines={1}>
            {server.name}
          </Text>
          {server.isDefault && (
            <View style={styles.defaultBadge}>
              <Text style={styles.defaultText}>Default</Text>
            </View>
          )}
        </View>
        <Text style={styles.address} numberOfLines={1}>
          {server.useTls ? 'wss' : 'ws'}://{server.host}:{server.port}
        </Text>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: getStatusColor() }]} />
          <Text style={styles.statusText} numberOfLines={1}>
            {getStatusText()}
          </Text>
        </View>
      </TouchableOpacity>
      <View style={styles.actions}>
        <TouchableOpacity style={styles.actionButton} onPress={onEdit}>
          <Text style={styles.editIcon}>✎</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionButton} onPress={onDelete}>
          <Text style={styles.deleteIcon}>✕</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 6,
    borderLeftWidth: 3,
    borderLeftColor: '#3b4f8a',
  },
  content: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  name: {
    fontSize: 17,
    fontWeight: '600',
    color: '#f3f4f6',
    flex: 1,
  },
  defaultBadge: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
  },
  defaultText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '600',
  },
  address: {
    fontSize: 13,
    color: '#9ca3af',
    marginBottom: 8,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 13,
    color: '#d1d5db',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
  },
  actionButton: {
    padding: 8,
    marginLeft: 4,
  },
  editIcon: {
    fontSize: 18,
    color: '#9ca3af',
  },
  deleteIcon: {
    fontSize: 18,
    color: '#ef4444',
  },
});
