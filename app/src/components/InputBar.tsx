import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
  ActivityIndicator,
  Text,
  Alert,
  Image,
  ScrollView,
  FlatList,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

interface AttachedImage {
  uri: string;
  base64: string;
  mimeType: string;
}

interface SlashCommand {
  command: string;
  label: string;
  description: string;
  action: 'send' | 'callback';
}

const SLASH_COMMANDS: SlashCommand[] = [
  { command: '/yes', label: 'yes', description: 'Send "yes"', action: 'send' },
  { command: '/no', label: 'no', description: 'Send "no"', action: 'send' },
  { command: '/continue', label: 'continue', description: 'Send "continue"', action: 'send' },
  { command: '/approve', label: 'approve', description: 'Send "approve"', action: 'send' },
  { command: '/reject', label: 'reject', description: 'Send "reject"', action: 'send' },
  { command: '/skip', label: 'skip', description: 'Send "skip"', action: 'send' },
  { command: '/cancel', label: 'cancel', description: 'Send interrupt (Ctrl+C)', action: 'send' },
  { command: '/switch', label: 'switch', description: 'Switch session', action: 'callback' },
  {
    command: '/refresh',
    label: 'refresh',
    description: 'Refresh conversation',
    action: 'callback',
  },
];

interface InputBarProps {
  onSend: (text: string) => Promise<boolean>;
  onSendImage?: (base64: string, mimeType: string) => Promise<boolean>;
  onUploadImage?: (base64: string, mimeType: string) => Promise<string | null>;
  onSendWithImages?: (imagePaths: string[], message: string) => Promise<boolean>;
  onSlashCommand?: (command: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputBar({
  onSend,
  onSendImage,
  onUploadImage,
  onSendWithImages,
  onSlashCommand,
  disabled,
  placeholder,
}: InputBarProps) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>(SLASH_COMMANDS);
  const sendingRef = useRef(false); // Ref to prevent double-sends

  const handleTextChange = useCallback((newText: string) => {
    setText(newText);

    // Show slash menu when typing "/" at start
    if (newText.startsWith('/')) {
      const query = newText.toLowerCase();
      const filtered = SLASH_COMMANDS.filter(
        (cmd) =>
          cmd.command.toLowerCase().startsWith(query) ||
          cmd.label.toLowerCase().includes(query.slice(1))
      );
      setFilteredCommands(filtered);
      setShowSlashMenu(filtered.length > 0);
    } else {
      setShowSlashMenu(false);
    }
  }, []);

  const handleSelectCommand = useCallback(
    async (cmd: SlashCommand) => {
      setShowSlashMenu(false);
      setText('');

      if (cmd.action === 'send') {
        const message = cmd.command === '/cancel' ? '\x03' : cmd.label;
        await onSend(message);
      } else if (cmd.action === 'callback' && onSlashCommand) {
        onSlashCommand(cmd.command);
      }
    },
    [onSend, onSlashCommand]
  );

  const handleSend = async () => {
    // Use ref for synchronous check to prevent double-sends
    if (sendingRef.current || sending || disabled) return;
    if (!text.trim() && attachedImages.length === 0) return;

    sendingRef.current = true;
    setSending(true);

    const textToSend = text.trim();
    // Clear text immediately to prevent double-send UI issues
    setText('');

    try {
      if (attachedImages.length > 0 && onUploadImage && onSendWithImages) {
        const imagePaths: string[] = [];
        for (const img of attachedImages) {
          const filepath = await onUploadImage(img.base64, img.mimeType);
          if (filepath) {
            imagePaths.push(filepath);
          }
        }

        await onSendWithImages(imagePaths, textToSend);
        setAttachedImages([]);
      } else if (attachedImages.length > 0 && onSendImage) {
        for (const img of attachedImages) {
          await onSendImage(img.base64, img.mimeType);
        }
        if (textToSend) {
          await onSend(textToSend);
        }
        setAttachedImages([]);
      } else if (textToSend) {
        await onSend(textToSend);
      }

      Keyboard.dismiss();
    } catch (e) {
      console.error('Send failed:', e);
      // Restore text on error
      setText(textToSend);
      Alert.alert('Error', 'Failed to send message');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const handlePickImage = async () => {
    if (sending || disabled || !onSendImage) return;

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'image/*',
        copyToCacheDirectory: true,
        multiple: true,
      });

      if (!result.canceled && result.assets) {
        const newImages: AttachedImage[] = [];

        for (const asset of result.assets) {
          const base64 = await FileSystem.readAsStringAsync(asset.uri, {
            encoding: 'base64',
          });

          newImages.push({
            uri: asset.uri,
            base64,
            mimeType: asset.mimeType || 'image/jpeg',
          });
        }

        setAttachedImages([...attachedImages, ...newImages]);
      }
    } catch (e: unknown) {
      console.error('Image pick failed:', e);
      Alert.alert('Error', 'Failed to pick image');
    }
  };

  const removeImage = (index: number) => {
    setAttachedImages(attachedImages.filter((_, i) => i !== index));
  };

  const canSend = text.trim() || attachedImages.length > 0;

  const renderCommandItem = ({ item }: { item: SlashCommand }) => (
    <TouchableOpacity style={styles.commandItem} onPress={() => handleSelectCommand(item)}>
      <Text style={styles.commandName}>{item.command}</Text>
      <Text style={styles.commandDesc}>{item.description}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {/* Slash command menu */}
      {showSlashMenu && (
        <View style={styles.slashMenu}>
          <FlatList
            data={filteredCommands}
            keyExtractor={(item) => item.command}
            renderItem={renderCommandItem}
            keyboardShouldPersistTaps="handled"
            style={styles.commandList}
          />
        </View>
      )}

      {attachedImages.length > 0 && (
        <ScrollView horizontal style={styles.attachmentsRow} showsHorizontalScrollIndicator={false}>
          {attachedImages.map((img, index) => (
            <View key={index} style={styles.attachmentContainer}>
              <Image source={{ uri: img.uri }} style={styles.attachmentThumb} />
              <TouchableOpacity style={styles.removeButton} onPress={() => removeImage(index)}>
                <Text style={styles.removeButtonText}>x</Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.inputRow}>
        {onSendImage && (
          <TouchableOpacity
            style={[styles.iconButton, (disabled || sending) && styles.iconButtonDisabled]}
            onPress={handlePickImage}
            disabled={disabled || sending}
          >
            <Text style={styles.iconButtonText}>+</Text>
          </TouchableOpacity>
        )}
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={handleTextChange}
          placeholder={placeholder || 'Type a message...'}
          placeholderTextColor="#6b7280"
          multiline
          maxLength={10000}
          editable={!disabled && !sending}
        />
        <TouchableOpacity
          style={[
            styles.sendButton,
            (!canSend || disabled || sending) && styles.sendButtonDisabled,
          ]}
          onPress={handleSend}
          disabled={!canSend || disabled || sending}
        >
          {sending ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <Text style={styles.sendButtonText}>Send</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1f2937',
    borderTopWidth: 1,
    borderTopColor: '#374151',
  },
  slashMenu: {
    backgroundColor: '#111827',
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
    maxHeight: 200,
  },
  commandList: {
    flexGrow: 0,
  },
  commandItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1f2937',
  },
  commandName: {
    color: '#60a5fa',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  commandDesc: {
    color: '#9ca3af',
    fontSize: 13,
  },
  attachmentsRow: {
    paddingHorizontal: 8,
    paddingTop: 8,
    maxHeight: 80,
  },
  attachmentContainer: {
    marginRight: 8,
    position: 'relative',
  },
  attachmentThumb: {
    width: 60,
    height: 60,
    borderRadius: 8,
    backgroundColor: '#374151',
  },
  removeButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 6,
  },
  iconButtonDisabled: {
    opacity: 0.5,
  },
  iconButtonText: {
    color: '#9ca3af',
    fontSize: 22,
    fontWeight: '300',
    marginTop: -2,
  },
  input: {
    flex: 1,
    backgroundColor: '#374151',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
    color: '#f3f4f6',
    maxHeight: 120,
    marginRight: 8,
  },
  sendButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 60,
  },
  sendButtonDisabled: {
    backgroundColor: '#4b5563',
  },
  sendButtonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 14,
  },
});
