import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Clipboard,
  Alert,
} from 'react-native';

interface SetupScreenProps {
  onBack: () => void;
}

const INSTALL_SCRIPT = `git clone https://github.com/Hexidecibel/claude-companion.git
cd claude-companion/daemon
bash scripts/install.sh`;

const MANUAL_STEPS = `# The installer automatically:
# - Detects your OS (macOS, Ubuntu, Fedora, Arch, etc.)
# - Installs Node.js, tmux, and other dependencies
# - Builds the daemon
# - Generates a secure auth token
# - Sets up auto-start service (systemd/launchd)

# For macOS:
#   Installs to ~/.companion
#   Uses launchd for auto-start

# For Linux with sudo:
#   Installs to /opt/companion
#   Uses systemd for auto-start

# For Linux without sudo:
#   Installs to ~/.companion
#   Uses user-level systemd

# After install, save your token and use it in the app!

# --- Alternative: Manual steps ---

# 1. Install prerequisites
# macOS: brew install node tmux
# Ubuntu: sudo apt install nodejs npm tmux
# Fedora: sudo dnf install nodejs tmux

# 2. Clone and build
git clone https://github.com/Hexidecibel/claude-companion.git
cd claude-companion/daemon
npm install && npm run build

# 3. Run the installer
bash scripts/install.sh`;

export function SetupScreen({ onBack }: SetupScreenProps) {
  const copyToClipboard = (text: string) => {
    Clipboard.setString(text);
    Alert.alert('Copied', 'Command copied to clipboard');
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Daemon Setup</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <Text style={styles.sectionTitle}>Quick Install</Text>
        <Text style={styles.description}>
          Run these commands on your server (macOS, Ubuntu, Fedora, Arch, or Alpine):
        </Text>
        <TouchableOpacity
          style={styles.codeBlock}
          onPress={() => copyToClipboard(INSTALL_SCRIPT)}
        >
          <Text style={styles.code}>{INSTALL_SCRIPT}</Text>
          <Text style={styles.copyHint}>Tap to copy</Text>
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>Manual Installation</Text>
        <Text style={styles.description}>
          If the quick install doesn&apos;t work, follow these steps:
        </Text>
        <TouchableOpacity
          style={styles.codeBlock}
          onPress={() => copyToClipboard(MANUAL_STEPS)}
        >
          <Text style={styles.code}>{MANUAL_STEPS}</Text>
          <Text style={styles.copyHint}>Tap to copy</Text>
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>What Gets Installed</Text>
        <View style={styles.listItem}>
          <Text style={styles.bullet}>-</Text>
          <Text style={styles.listText}>Node.js 20 (if not present)</Text>
        </View>
        <View style={styles.listItem}>
          <Text style={styles.bullet}>-</Text>
          <Text style={styles.listText}>tmux (for coding sessions)</Text>
        </View>
        <View style={styles.listItem}>
          <Text style={styles.bullet}>-</Text>
          <Text style={styles.listText}>Daemon with auto-start service</Text>
        </View>
        <View style={styles.listItem}>
          <Text style={styles.bullet}>-</Text>
          <Text style={styles.listText}>TLS certificates (auto-generated)</Text>
        </View>

        <Text style={styles.sectionTitle}>Connecting from the App</Text>
        <View style={styles.listItem}>
          <Text style={styles.bullet}>1.</Text>
          <Text style={styles.listText}>Get your server&apos;s IP address or hostname</Text>
        </View>
        <View style={styles.listItem}>
          <Text style={styles.bullet}>2.</Text>
          <Text style={styles.listText}>Add a new server in the app with that address</Text>
        </View>
        <View style={styles.listItem}>
          <Text style={styles.bullet}>3.</Text>
          <Text style={styles.listText}>Enter the token from your config.json</Text>
        </View>
        <View style={styles.listItem}>
          <Text style={styles.bullet}>4.</Text>
          <Text style={styles.listText}>If using TLS, enable the TLS toggle</Text>
        </View>

        <Text style={styles.sectionTitle}>Troubleshooting</Text>
        <Text style={styles.troubleItem}>
          <Text style={styles.troubleLabel}>Connection timeout:</Text> Make sure the daemon is running and the port is not blocked by firewall
        </Text>
        <Text style={styles.troubleItem}>
          <Text style={styles.troubleLabel}>Invalid token:</Text> Check that the token in the app matches your config.json exactly
        </Text>
        <Text style={styles.troubleItem}>
          <Text style={styles.troubleLabel}>No messages:</Text> Ensure a coding session is running in the tmux session specified in config
        </Text>

        <View style={styles.bottomPadding} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1f2937',
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  backButton: {
    width: 60,
  },
  backButtonText: {
    color: '#3b82f6',
    fontSize: 16,
  },
  title: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  sectionTitle: {
    color: '#f3f4f6',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 24,
    marginBottom: 8,
  },
  description: {
    color: '#9ca3af',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  codeBlock: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  code: {
    color: '#10b981',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  copyHint: {
    color: '#6b7280',
    fontSize: 11,
    marginTop: 8,
    textAlign: 'right',
  },
  listItem: {
    flexDirection: 'row',
    marginBottom: 8,
    paddingLeft: 8,
  },
  bullet: {
    color: '#3b82f6',
    fontSize: 14,
    width: 20,
  },
  listText: {
    color: '#d1d5db',
    fontSize: 14,
    flex: 1,
    lineHeight: 20,
  },
  troubleItem: {
    color: '#d1d5db',
    fontSize: 14,
    marginBottom: 12,
    lineHeight: 20,
  },
  troubleLabel: {
    color: '#f59e0b',
    fontWeight: '600',
  },
  bottomPadding: {
    height: 40,
  },
});
