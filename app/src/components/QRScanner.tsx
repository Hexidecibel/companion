import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

export interface QRConfig {
  host: string;
  port: number;
  token?: string;
  tls: boolean;
}

interface QRScannerProps {
  onScan: (config: QRConfig) => void;
  onClose: () => void;
}

export function QRScanner({ onScan, onClose }: QRScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (!permission?.granted && permission?.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);

    try {
      const config = JSON.parse(data) as QRConfig;

      // Validate required fields
      if (!config.host || !config.port) {
        Alert.alert('Invalid QR Code', 'The QR code does not contain valid server configuration.', [
          { text: 'Try Again', onPress: () => setScanned(false) },
          { text: 'Cancel', onPress: onClose },
        ]);
        return;
      }

      onScan(config);
    } catch {
      Alert.alert('Invalid QR Code', 'Could not parse the QR code. Make sure you are scanning a Companion setup QR code.', [
        { text: 'Try Again', onPress: () => setScanned(false) },
        { text: 'Cancel', onPress: onClose },
      ]);
    }
  };

  if (!permission) {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>Requesting camera permission...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Camera Permission Required</Text>
        <Text style={styles.message}>
          To scan QR codes, please grant camera access.
        </Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant Permission</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        barcodeScannerSettings={{
          barcodeTypes: ['qr'],
        }}
        onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
      >
        <View style={styles.overlay}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.scanArea}>
            <View style={styles.corner} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>

          <View style={styles.footer}>
            <Text style={styles.instruction}>
              Point the camera at the QR code on your server
            </Text>
            <Text style={styles.hint}>
              Visit http://your-server:9877 to see the QR code
            </Text>
          </View>
        </View>
      </CameraView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
  },
  camera: {
    flex: 1,
    width: '100%',
  },
  overlay: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: 20,
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  closeButton: {
    padding: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 8,
  },
  closeButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '500',
  },
  scanArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 40,
  },
  corner: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderColor: '#3b82f6',
    borderTopWidth: 4,
    borderLeftWidth: 4,
    top: '25%',
    left: '15%',
  },
  cornerTR: {
    borderTopWidth: 4,
    borderLeftWidth: 0,
    borderRightWidth: 4,
    left: undefined,
    right: '15%',
  },
  cornerBL: {
    borderTopWidth: 0,
    borderBottomWidth: 4,
    top: undefined,
    bottom: '25%',
  },
  cornerBR: {
    borderTopWidth: 0,
    borderLeftWidth: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    left: undefined,
    right: '15%',
    top: undefined,
    bottom: '25%',
  },
  footer: {
    paddingBottom: 60,
    paddingHorizontal: 40,
    alignItems: 'center',
  },
  instruction: {
    color: '#ffffff',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 8,
    fontWeight: '500',
  },
  hint: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    textAlign: 'center',
  },
  title: {
    color: '#f3f4f6',
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 12,
  },
  message: {
    color: '#9ca3af',
    fontSize: 15,
    textAlign: 'center',
    paddingHorizontal: 40,
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 10,
    marginBottom: 12,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    paddingHorizontal: 32,
    paddingVertical: 14,
  },
  cancelButtonText: {
    color: '#9ca3af',
    fontSize: 16,
  },
});
