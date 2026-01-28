import React, { Component, ErrorInfo, ReactNode } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { wsService } from '../services/websocket';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  sent: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      sent: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });

    // Send to daemon for logging
    this.sendErrorToDaemon(error, errorInfo);
  }

  private async sendErrorToDaemon(error: Error, errorInfo: ErrorInfo) {
    try {
      if (wsService.isConnected()) {
        await wsService.sendRequest('client_error', {
          message: error.message,
          stack: error.stack,
          componentStack: errorInfo.componentStack,
          timestamp: Date.now(),
        });
        this.setState({ sent: true });
      }
    } catch (e) {
      // Ignore - we're already in an error state
      console.error('Failed to send error to daemon:', e);
    }
  }

  private getErrorText(): string {
    const { error, errorInfo } = this.state;
    let text = `Error: ${error?.message || 'Unknown error'}\n\n`;

    if (error?.stack) {
      text += `Stack:\n${error.stack}\n\n`;
    }

    if (errorInfo?.componentStack) {
      text += `Component Stack:\n${errorInfo.componentStack}`;
    }

    return text;
  }

  private async copyError() {
    const text = this.getErrorText();
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Error details copied to clipboard');
  }

  private reload() {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      sent: false,
    });
  }

  render() {
    if (this.state.hasError) {
      const { error, errorInfo, sent } = this.state;

      return (
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.headerIcon}>!</Text>
            <Text style={styles.headerTitle}>Something went wrong</Text>
          </View>

          <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
            <Text style={styles.errorMessage}>{error?.message || 'Unknown error'}</Text>

            {error?.stack && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Stack Trace</Text>
                <Text style={styles.codeText}>{error.stack}</Text>
              </View>
            )}

            {errorInfo?.componentStack && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Component Stack</Text>
                <Text style={styles.codeText}>{errorInfo.componentStack}</Text>
              </View>
            )}
          </ScrollView>

          <View style={styles.footer}>
            {sent && (
              <Text style={styles.sentText}>Error sent to daemon</Text>
            )}

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.button, styles.copyButton]}
                onPress={() => this.copyError()}
              >
                <Text style={styles.buttonText}>Copy Error</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.button, styles.reloadButton]}
                onPress={() => this.reload()}
              >
                <Text style={styles.buttonText}>Try Again</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    paddingHorizontal: 16,
    backgroundColor: '#7f1d1d',
    gap: 12,
  },
  headerIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#ef4444',
    color: '#ffffff',
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    lineHeight: 32,
  },
  headerTitle: {
    color: '#fecaca',
    fontSize: 18,
    fontWeight: '600',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  errorMessage: {
    color: '#f87171',
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 16,
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    color: '#9ca3af',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  codeText: {
    color: '#d1d5db',
    fontSize: 11,
    fontFamily: 'monospace',
    backgroundColor: '#1f2937',
    padding: 12,
    borderRadius: 8,
  },
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#374151',
  },
  sentText: {
    color: '#10b981',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  copyButton: {
    backgroundColor: '#374151',
  },
  reloadButton: {
    backgroundColor: '#3b82f6',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
