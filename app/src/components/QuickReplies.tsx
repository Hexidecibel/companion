import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';

interface QuickRepliesProps {
  onSelect: (text: string) => void;
  disabled?: boolean;
}

const QUICK_REPLIES = [
  { label: 'yes', color: '#22c55e' },
  { label: 'continue', color: '#3b82f6' },
  { label: 'approve', color: '#22c55e' },
  { label: 'reject', color: '#ef4444' },
  { label: 'skip', color: '#f59e0b' },
  { label: 'cancel', color: '#ef4444' },
];

export function QuickReplies({ onSelect, disabled }: QuickRepliesProps) {
  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {QUICK_REPLIES.map((reply) => (
          <TouchableOpacity
            key={reply.label}
            style={[styles.chip, { borderColor: reply.color }, disabled && styles.chipDisabled]}
            onPress={() => onSelect(reply.label)}
            disabled={disabled}
            activeOpacity={0.7}
          >
            <Text style={[styles.chipText, { color: reply.color }]}>{reply.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1f2937',
    borderTopWidth: 1,
    borderTopColor: '#374151',
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: '#111827',
    marginRight: 8,
  },
  chipDisabled: {
    opacity: 0.5,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
