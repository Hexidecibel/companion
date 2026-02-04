import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { ConnectionState } from '../types';

interface StatusIndicatorProps {
  connectionState: ConnectionState;
  isWaitingForInput?: boolean;
  onReconnect?: () => void;
}

export function StatusIndicator({
  connectionState,
  isWaitingForInput,
  onReconnect,
}: StatusIndicatorProps) {
  const getStatusColor = () => {
    switch (connectionState.status) {
      case 'connected':
        return isWaitingForInput ? '#eab308' : '#22c55e'; // yellow if waiting, green if connected
      case 'connecting':
      case 'reconnecting':
        return '#f97316'; // orange
      case 'error':
        return '#ef4444'; // red
      default:
        return '#6b7280'; // gray
    }
  };

  const getStatusText = () => {
    switch (connectionState.status) {
      case 'connected':
        return isWaitingForInput ? 'Waiting for input' : 'Connected';
      case 'connecting':
        return 'Connecting...';
      case 'reconnecting':
        return `Reconnecting (${connectionState.reconnectAttempts})...`;
      case 'error':
        return connectionState.error || 'Connection error';
      default:
        return 'Disconnected';
    }
  };

  const showReconnectButton =
    connectionState.status === 'error' || connectionState.status === 'disconnected';

  return (
    <View style={styles.container}>
      <View style={[styles.dot, { backgroundColor: getStatusColor() }]} />
      <Text style={styles.text} numberOfLines={1}>
        {getStatusText()}
      </Text>
      {showReconnectButton && onReconnect && (
        <TouchableOpacity onPress={onReconnect} style={styles.reconnectButton}>
          <Text style={styles.reconnectText}>Retry</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1f2937',
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  text: {
    color: '#d1d5db',
    fontSize: 14,
    flex: 1,
  },
  reconnectButton: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: '#3b82f6',
    borderRadius: 4,
  },
  reconnectText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
});
