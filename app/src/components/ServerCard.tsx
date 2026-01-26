import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Server, ConnectionState } from '../types';

interface ServerCardProps {
  server: Server;
  connectionState?: ConnectionState;
  onPress: () => void;
  onLongPress?: () => void;
}

export function ServerCard({ server, connectionState, onPress, onLongPress }: ServerCardProps) {
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
    <TouchableOpacity
      style={styles.container}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
    >
      <View style={styles.content}>
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
      </View>
      <View style={styles.arrow}>
        <Text style={styles.arrowText}>›</Text>
      </View>
    </TouchableOpacity>
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
  arrow: {
    marginLeft: 12,
  },
  arrowText: {
    fontSize: 24,
    color: '#6b7280',
  },
});
