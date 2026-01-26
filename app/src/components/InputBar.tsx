import React, { useState } from 'react';
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
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

interface AttachedImage {
  uri: string;
  base64: string;
  mimeType: string;
}

interface InputBarProps {
  onSend: (text: string) => Promise<boolean>;
  onSendImage?: (base64: string, mimeType: string) => Promise<boolean>;
  onUploadImage?: (base64: string, mimeType: string) => Promise<string | null>; // returns filepath
  onSendWithImages?: (imagePaths: string[], message: string) => Promise<boolean>;
  disabled?: boolean;
  placeholder?: string;
}

export function InputBar({ onSend, onSendImage, onUploadImage, onSendWithImages, disabled, placeholder }: InputBarProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);

  const handleSend = async () => {
    if (sending || disabled) return;
    if (!text.trim() && attachedImages.length === 0) return;

    setSending(true);
    try {
      // If we have images AND the new combined endpoint
      if (attachedImages.length > 0 && onUploadImage && onSendWithImages) {
        // Upload all images first (no submit)
        const imagePaths: string[] = [];
        for (const img of attachedImages) {
          const filepath = await onUploadImage(img.base64, img.mimeType);
          if (filepath) {
            imagePaths.push(filepath);
          }
        }

        // Send combined message (images + text) in one submit
        const success = await onSendWithImages(imagePaths, text.trim());
        if (success) {
          setText('');
          setAttachedImages([]);
        }
      } else if (attachedImages.length > 0 && onSendImage) {
        // Fallback: old behavior
        for (const img of attachedImages) {
          await onSendImage(img.base64, img.mimeType);
        }
        if (text.trim()) {
          await onSend(text.trim());
          setText('');
        }
        setAttachedImages([]);
      } else if (text.trim()) {
        // Text only
        const success = await onSend(text.trim());
        if (success) {
          setText('');
        }
      }

      Keyboard.dismiss();
    } catch (e) {
      console.error('Send failed:', e);
      Alert.alert('Error', 'Failed to send message');
    } finally {
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
            encoding: FileSystem.EncodingType.Base64,
          });

          newImages.push({
            uri: asset.uri,
            base64,
            mimeType: asset.mimeType || 'image/jpeg',
          });
        }

        setAttachedImages([...attachedImages, ...newImages]);
      }
    } catch (e: any) {
      console.error('Image pick failed:', e);
      Alert.alert('Error', 'Failed to pick image');
    }
  };

  const removeImage = (index: number) => {
    setAttachedImages(attachedImages.filter((_, i) => i !== index));
  };

  const canSend = text.trim() || attachedImages.length > 0;

  return (
    <View style={styles.container}>
      {/* Attached images preview */}
      {attachedImages.length > 0 && (
        <ScrollView horizontal style={styles.attachmentsRow} showsHorizontalScrollIndicator={false}>
          {attachedImages.map((img, index) => (
            <View key={index} style={styles.attachmentContainer}>
              <Image source={{ uri: img.uri }} style={styles.attachmentThumb} />
              <TouchableOpacity
                style={styles.removeButton}
                onPress={() => removeImage(index)}
              >
                <Text style={styles.removeButtonText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.inputRow}>
        {onSendImage && (
          <TouchableOpacity
            style={[styles.imageButton, (disabled || sending) && styles.imageButtonDisabled]}
            onPress={handlePickImage}
            disabled={disabled || sending}
          >
            <Text style={styles.imageButtonText}>+</Text>
          </TouchableOpacity>
        )}
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
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
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: -2,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
  },
  imageButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  imageButtonDisabled: {
    opacity: 0.5,
  },
  imageButtonText: {
    color: '#9ca3af',
    fontSize: 24,
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
