import React, { useState, useEffect, useCallback } from 'react';
import { View, StyleSheet, StatusBar, AppState } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Server } from './src/types';
import { getServers, getSettings } from './src/services/storage';
import { ServerList } from './src/screens/ServerList';
import { SessionView } from './src/screens/SessionView';
import { Settings } from './src/screens/Settings';
import { SetupScreen } from './src/screens/SetupScreen';
import {
  registerForPushNotifications,
  setupNotificationChannel,
  addNotificationResponseReceivedListener,
  clearBadge,
} from './src/services/push';

type Screen = 'servers' | 'session' | 'settings' | 'setup';

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('servers');
  const [selectedServer, setSelectedServer] = useState<Server | null>(null);

  useEffect(() => {
    loadDefaultServer();
    initializePushNotifications();

    // Clear badge when app becomes active
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        clearBadge();
      }
    });

    // Handle notification taps
    const responseListener = addNotificationResponseReceivedListener((response) => {
      // Navigate to session when notification tapped
      const data = response.notification.request.content.data;
      if (data?.type === 'waiting_for_input') {
        setCurrentScreen('session');
      }
    });

    return () => {
      subscription.remove();
      responseListener.remove();
    };
  }, []);

  const initializePushNotifications = async () => {
    await setupNotificationChannel();
    await registerForPushNotifications();
  };

  const loadDefaultServer = async () => {
    const servers = await getServers();
    const settings = await getSettings();
    const defaultServer =
      servers.find((s) => s.id === settings.defaultServerId) ||
      servers.find((s) => s.isDefault) ||
      (servers.length === 1 ? servers[0] : null);
    if (defaultServer) {
      setSelectedServer(defaultServer);
    }
  };

  const handleSelectServer = useCallback((server: Server) => {
    setSelectedServer(server);
    setCurrentScreen('session');
  }, []);

  const handleBackFromSession = useCallback(() => {
    setCurrentScreen('servers');
  }, []);

  const handleBackFromSettings = useCallback(() => {
    setCurrentScreen('servers');
  }, []);

  const handleOpenSettings = useCallback(() => {
    setCurrentScreen('settings');
  }, []);

  const handleOpenSetup = useCallback(() => {
    setCurrentScreen('setup');
  }, []);

  const handleBackFromSetup = useCallback(() => {
    setCurrentScreen('servers');
  }, []);

  const renderScreen = () => {
    switch (currentScreen) {
      case 'session':
        if (!selectedServer) {
          setCurrentScreen('servers');
          return null;
        }
        return <SessionView server={selectedServer} onBack={handleBackFromSession} />;
      case 'settings':
        return <Settings onBack={handleBackFromSettings} />;
      case 'setup':
        return <SetupScreen onBack={handleBackFromSetup} />;
      default:
        return <ServerList onSelectServer={handleSelectServer} onOpenSetup={handleOpenSetup} />;
    }
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#111827" />
      <SafeAreaView style={styles.container} edges={['top']}>
        {renderScreen()}
      </SafeAreaView>
      {currentScreen === 'servers' && (
        <View style={styles.settingsButton}>
          <SafeAreaView edges={['bottom']}>
            <View style={styles.settingsButtonInner}>
              <View style={styles.settingsIcon} onTouchEnd={handleOpenSettings}>
                <View style={styles.settingsGear} />
              </View>
            </View>
          </SafeAreaView>
        </View>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
  },
  settingsButton: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    left: 0,
  },
  settingsButtonInner: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  settingsIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsGear: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 3,
    borderColor: '#9ca3af',
  },
});
