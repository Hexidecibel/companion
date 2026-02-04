import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, TextInput, Text, TouchableOpacity, StyleSheet } from 'react-native';

interface SearchBarProps {
  onSearch: (term: string) => void;
  matchCount: number;
  currentMatch: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export function SearchBar({
  onSearch,
  matchCount,
  currentMatch,
  onNext,
  onPrev,
  onClose,
}: SearchBarProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<TextInput>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleChange = useCallback(
    (text: string) => {
      setValue(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onSearch(text.trim());
      }, 150);
    },
    [onSearch]
  );

  const handleSubmit = useCallback(() => {
    onNext();
  }, [onNext]);

  return (
    <View style={styles.container}>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={value}
        onChangeText={handleChange}
        onSubmitEditing={handleSubmit}
        placeholder="Search messages..."
        placeholderTextColor="#6b7280"
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
      />
      {value.trim().length > 0 && (
        <Text style={styles.count}>
          {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : '0'}
        </Text>
      )}
      <TouchableOpacity
        style={[styles.navButton, matchCount === 0 && styles.navButtonDisabled]}
        onPress={onPrev}
        disabled={matchCount === 0}
      >
        <Text style={[styles.navText, matchCount === 0 && styles.navTextDisabled]}>▲</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.navButton, matchCount === 0 && styles.navButtonDisabled]}
        onPress={onNext}
        disabled={matchCount === 0}
      >
        <Text style={[styles.navText, matchCount === 0 && styles.navTextDisabled]}>▼</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.closeButton} onPress={onClose}>
        <Text style={styles.closeText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f2937',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  input: {
    flex: 1,
    backgroundColor: '#111827',
    color: '#f3f4f6',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    fontSize: 14,
    borderWidth: 1,
    borderColor: '#374151',
  },
  count: {
    color: '#9ca3af',
    fontSize: 12,
    marginLeft: 8,
    minWidth: 30,
    textAlign: 'center',
  },
  navButton: {
    padding: 8,
    marginLeft: 2,
  },
  navButtonDisabled: {
    opacity: 0.3,
  },
  navText: {
    color: '#9ca3af',
    fontSize: 14,
  },
  navTextDisabled: {
    color: '#4b5563',
  },
  closeButton: {
    padding: 8,
    marginLeft: 2,
  },
  closeText: {
    color: '#9ca3af',
    fontSize: 14,
  },
});
