import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, StyleSheet, StatusBar, AppState } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { Server } from './src/types';
import { getServers, getSettings } from './src/services/storage';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { ServerList } from './src/screens/ServerList';
import { SessionView } from './src/screens/SessionView';
import { Settings } from './src/screens/Settings';
import { SetupScreen } from './src/screens/SetupScreen';
import { NotificationSettings } from './src/screens/NotificationSettings';
import { wsService } from './src/services/websocket';
import {
  registerForPushNotifications,
  setupNotificationChannel,
  addNotificationResponseReceivedListener,
  clearBadge,
} from './src/services/push';

// Initialize Sentry error tracking
const sentryDsn = Constants.expoConfig?.extra?.sentryDsn;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    debug: __DEV__,
    enableAutoSessionTracking: true,
    attachScreenshot: true,
    attachViewHierarchy: true,
  });
}


type Screen = 'dashboard' | 'servers' | 'session' | 'settings' | 'setup' | 'notificationSettings';

function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('dashboard');
  const [selectedServer, setSelectedServer] = useState<Server | null>(null);
  const pendingSessionId = useRef<string | null>(null);

  useEffect(() => {
    initializePushNotifications();

    // Clear badge when app becomes active
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        clearBadge();
      }
    });

    // Handle notification taps
    const responseListener = addNotificationResponseReceivedListener((response: unknown) => {
      // Navigate to session when notification tapped
      const msg = response as { data?: { type?: string } };
      if (msg.data?.type === 'waiting_for_input') {
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

  // Handle selecting a server from dashboard (with optional session ID)
  const handleSelectServerFromDashboard = useCallback((server: Server, sessionId?: string) => {
    setSelectedServer(server);
    pendingSessionId.current = sessionId || null;

    // Only reconnect if switching to a different server
    const currentServerId = wsService.getServerId();
    if (currentServerId !== server.id) {
      // Disconnect from old server if connected to a different one
      if (currentServerId) {
        wsService.disconnect();
      }
      wsService.connect(server);
    }

    // SessionView will handle switching to the session via initialSessionId prop
    setCurrentScreen('session');
  }, []);

  // Handle selecting a server from manage servers screen
  const handleSelectServer = useCallback((server: Server) => {
    setSelectedServer(server);

    // Only reconnect if switching to a different server
    const currentServerId = wsService.getServerId();
    if (currentServerId !== server.id) {
      if (currentServerId) {
        wsService.disconnect();
      }
      wsService.connect(server);
    }

    setCurrentScreen('session');
  }, []);

  const handleBackFromSession = useCallback(() => {
    // Don't disconnect - keep connection alive for quick return
    setCurrentScreen('dashboard');
  }, []);

  const handleBackFromSettings = useCallback(() => {
    setCurrentScreen('dashboard');
  }, []);

  const handleOpenNotificationSettings = useCallback(() => {
    setCurrentScreen('notificationSettings');
  }, []);

  const handleBackFromNotificationSettings = useCallback(() => {
    setCurrentScreen('settings');
  }, []);

  const handleOpenSettings = useCallback(() => {
    setCurrentScreen('settings');
  }, []);

  const handleOpenSetup = useCallback(() => {
    setCurrentScreen('setup');
  }, []);

  const handleBackFromSetup = useCallback(() => {
    setCurrentScreen('dashboard');
  }, []);

  const handleManageServers = useCallback(() => {
    setCurrentScreen('servers');
  }, []);

  const handleBackFromServers = useCallback(() => {
    setCurrentScreen('dashboard');
  }, []);

  const renderScreen = () => {
    switch (currentScreen) {
      case 'dashboard':
        return (
          <DashboardScreen
            onSelectServer={handleSelectServerFromDashboard}
            onManageServers={handleManageServers}
            onOpenSetup={handleOpenSetup}
          />
        );
      case 'servers':
        return (
          <ServerList
            onSelectServer={handleSelectServer}
            onOpenSetup={handleOpenSetup}
            onBack={handleBackFromServers}
          />
        );
      case 'session':
        if (!selectedServer) {
          setCurrentScreen('dashboard');
          return null;
        }
        return (
          <SessionView
            server={selectedServer}
            onBack={handleBackFromSession}
            initialSessionId={pendingSessionId.current}
          />
        );
      case 'settings':
        return (
          <Settings
            onBack={handleBackFromSettings}
            onOpenNotificationSettings={handleOpenNotificationSettings}
          />
        );
      case 'notificationSettings':
        return <NotificationSettings onBack={handleBackFromNotificationSettings} />;
      case 'setup':
        return <SetupScreen onBack={handleBackFromSetup} />;
      default:
        return (
          <DashboardScreen
            onSelectServer={handleSelectServerFromDashboard}
            onManageServers={handleManageServers}
            onOpenSetup={handleOpenSetup}
          />
        );
    }
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#111827" />
      <SafeAreaView style={styles.container} edges={['top']}>
        {renderScreen()}
      </SafeAreaView>
      {currentScreen === 'dashboard' && (
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

export default Sentry.wrap(App);
