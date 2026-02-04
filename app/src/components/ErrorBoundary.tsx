import React, { Component, ErrorInfo, ReactNode } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
  Platform,
} from 'react-native';
import Constants from 'expo-constants';
import * as Sentry from '@sentry/react-native';
import { wsService } from '../services/websocket';

const GITHUB_REPO = 'Hexidecibel/companion';
const APP_VERSION = Constants.expoConfig?.version || '0.1.0';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  sentToDaemon: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      sentToDaemon: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });

    // Capture in Sentry
    Sentry.withScope((scope) => {
      scope.setExtra('componentStack', errorInfo.componentStack || 'N/A');
      scope.setTag('source', 'error_boundary');
      scope.setTag('platform', Platform.OS);
      scope.setTag('appVersion', APP_VERSION);
      Sentry.captureException(error);
    });

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
        this.setState({ sentToDaemon: true });
      }
    } catch (e) {
      // Ignore - we're already in an error state
      console.error('Failed to send error to daemon:', e);
    }
  }

  private buildGitHubIssueUrl(): string {
    const { error, errorInfo } = this.state;
    const errorMessage = error?.message || 'Unknown error';

    // Truncate title to 80 chars
    const titleMessage =
      errorMessage.length > 80 ? errorMessage.substring(0, 77) + '...' : errorMessage;
    const title = `Bug Report: ${titleMessage}`;

    // Build component stack excerpt (truncated)
    const componentStack = errorInfo?.componentStack
      ? errorInfo.componentStack.trim().substring(0, 500)
      : 'N/A';

    const osVersion = Platform.Version ? `${Platform.OS} ${Platform.Version}` : Platform.OS;

    const body = `## Error
\`\`\`
${errorMessage}
\`\`\`

## Component Stack
\`\`\`
${componentStack}
\`\`\`

## Environment
- **App Version:** ${APP_VERSION}
- **Platform:** ${Platform.OS}
- **OS Version:** ${osVersion}
- **Client:** React Native / Expo

## Steps to Reproduce
1.
2.
3.

## Additional Context
<!-- Add any other context about the problem here -->
`;

    const params = new URLSearchParams({
      title,
      body,
      labels: 'bug',
    });

    return `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`;
  }

  private openGitHubIssue() {
    const url = this.buildGitHubIssueUrl();
    Linking.openURL(url).catch((err) => {
      console.error('Failed to open GitHub issue URL:', err);
    });
  }

  private retry() {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      sentToDaemon: false,
    });
  }

  render() {
    if (this.state.hasError) {
      const { error, sentToDaemon } = this.state;

      return (
        <View style={styles.container}>
          <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
            {/* Error icon */}
            <View style={styles.iconContainer}>
              <View style={styles.iconCircle}>
                <Text style={styles.iconText}>!</Text>
              </View>
            </View>

            {/* Heading */}
            <Text style={styles.heading}>Something went wrong</Text>
            <Text style={styles.subheading}>The app encountered an unexpected error.</Text>

            {/* Error message card */}
            <View style={styles.errorCard}>
              <Text style={styles.errorLabel}>Error</Text>
              <Text style={styles.errorMessage}>{error?.message || 'Unknown error'}</Text>
            </View>

            {sentToDaemon && (
              <Text style={styles.sentText}>Error report sent to daemon automatically.</Text>
            )}

            {/* Buttons */}
            <View style={styles.buttonContainer}>
              <TouchableOpacity
                style={[styles.button, styles.reportButton]}
                onPress={() => this.openGitHubIssue()}
                activeOpacity={0.7}
              >
                <Text style={styles.buttonText}>Report Bug</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.button, styles.retryButton]}
                onPress={() => this.retry()}
                activeOpacity={0.7}
              >
                <Text style={styles.buttonText}>Try Again</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
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
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  iconContainer: {
    marginBottom: 24,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#ef4444',
  },
  iconText: {
    color: '#ef4444',
    fontSize: 32,
    fontWeight: '700',
    lineHeight: 36,
  },
  heading: {
    color: '#f3f4f6',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  subheading: {
    color: '#9ca3af',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 24,
  },
  errorCard: {
    width: '100%',
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#374151',
    marginBottom: 16,
  },
  errorLabel: {
    color: '#ef4444',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  errorMessage: {
    color: '#f3f4f6',
    fontSize: 14,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  sentText: {
    color: '#10b981',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 16,
  },
  buttonContainer: {
    width: '100%',
    gap: 12,
    marginTop: 8,
  },
  button: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  reportButton: {
    backgroundColor: '#3b82f6',
  },
  retryButton: {
    backgroundColor: '#10b981',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
