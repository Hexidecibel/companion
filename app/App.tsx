import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, StyleSheet, StatusBar, AppState } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Server, TaskItem } from './src/types';
import { getServers, getSettings } from './src/services/storage';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { ServerList } from './src/screens/ServerList';
import { SessionView } from './src/screens/SessionView';
import { Settings } from './src/screens/Settings';
import { SetupScreen } from './src/screens/SetupScreen';
import { NotificationSettings } from './src/screens/NotificationSettings';
import { UsageScreen } from './src/screens/UsageScreen';
import { AgentTreeScreen } from './src/screens/AgentTreeScreen';
import { Archive } from './src/screens/Archive';
import { NewProjectScreen } from './src/screens/NewProjectScreen';
import { EditServerScreen } from './src/screens/EditServerScreen';
import { TaskDetailScreen } from './src/screens/TaskDetailScreen';
import { TerminalScreen } from './src/screens/TerminalScreen';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { wsService } from './src/services/websocket';
import { archiveService } from './src/services/archive';
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


type Screen = 'dashboard' | 'servers' | 'session' | 'settings' | 'setup' | 'notificationSettings' | 'usage' | 'agents' | 'archive' | 'newProject' | 'editServer' | 'taskDetail' | 'terminal';

function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('dashboard');
  const [selectedServer, setSelectedServer] = useState<Server | null>(null);
  const [serverToEdit, setServerToEdit] = useState<Server | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);
  const [selectedTaskSessionId, setSelectedTaskSessionId] = useState<string | null>(null);
  const [terminalSessionName, setTerminalSessionName] = useState<string | null>(null);
  const pendingSessionId = useRef<string | null>(null);

  useEffect(() => {
    initializePushNotifications();

    // When app resumes from background, check WebSocket health and clear badge
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        clearBadge();
        // OS may have killed the socket while backgrounded - detect and reconnect
        wsService.checkHealth();
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

    // Listen for compaction events to save archives
    const unsubscribeCompaction = wsService.onMessage((message) => {
      if (message.type === 'compaction' && message.payload) {
        const event = message.payload as {
          sessionId: string;
          sessionName: string;
          projectPath: string;
          summary: string;
          timestamp: number;
        };
        // Save to archive
        const serverId = wsService.getServerId();
        archiveService.addArchive({
          sessionId: event.sessionId,
          sessionName: event.sessionName,
          projectPath: event.projectPath,
          summary: event.summary,
          timestamp: event.timestamp,
          serverId: serverId || 'unknown',
          serverName: selectedServer?.name || 'Unknown Server',
        });
        console.log('Saved compaction to archive:', event.sessionName);
      }
    });

    return () => {
      subscription.remove();
      responseListener.remove();
      unsubscribeCompaction();
    };
  }, [selectedServer]);

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

  const handleOpenUsage = useCallback(() => {
    setCurrentScreen('usage');
  }, []);

  const handleBackFromUsage = useCallback(() => {
    setCurrentScreen('settings');
  }, []);

  const handleOpenAgents = useCallback(() => {
    setCurrentScreen('agents');
  }, []);

  const handleBackFromAgents = useCallback(() => {
    setCurrentScreen('settings');
  }, []);

  const handleOpenArchive = useCallback(() => {
    setCurrentScreen('archive');
  }, []);

  const handleBackFromArchive = useCallback(() => {
    setCurrentScreen('settings');
  }, []);

  const handleOpenNewProject = useCallback(() => {
    setCurrentScreen('newProject');
  }, []);

  const handleBackFromNewProject = useCallback(() => {
    setCurrentScreen('dashboard');
  }, []);

  const handleProjectCreated = useCallback(async (projectPath: string) => {
    console.log('Project created at:', projectPath);

    // Create a tmux session for the new project
    try {
      const sessionName = projectPath.split('/').pop() || 'new-project';
      const response = await wsService.sendRequest('create_tmux_session', {
        name: sessionName,
        workingDir: projectPath,
        startClaude: true,
      });

      if (response.success) {
        console.log('Created tmux session:', sessionName);
        // Navigate to session view - the watcher will pick up the new session
        setCurrentScreen('session');
      } else {
        console.error('Failed to create session:', response.error);
        setCurrentScreen('dashboard');
      }
    } catch (err) {
      console.error('Error creating session:', err);
      setCurrentScreen('dashboard');
    }
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

  const handleAddServer = useCallback(() => {
    setServerToEdit(null); // null means new server
    setCurrentScreen('editServer');
  }, []);

  const handleEditServer = useCallback((server: Server) => {
    setServerToEdit(server);
    setCurrentScreen('editServer');
  }, []);

  const handleBackFromEditServer = useCallback(() => {
    setServerToEdit(null);
    setCurrentScreen('dashboard');
  }, []);

  const handleOpenTaskDetail = useCallback((server: Server, sessionId: string, task: TaskItem) => {
    setSelectedServer(server);
    setSelectedTask(task);
    setSelectedTaskSessionId(sessionId);
    setCurrentScreen('taskDetail');
  }, []);

  const handleBackFromTaskDetail = useCallback(() => {
    setSelectedTask(null);
    setSelectedTaskSessionId(null);
    setCurrentScreen('dashboard');
  }, []);

  const handleOpenTerminal = useCallback((sessionName: string) => {
    setTerminalSessionName(sessionName);
    setCurrentScreen('terminal');
  }, []);

  const handleBackFromTerminal = useCallback(() => {
    setTerminalSessionName(null);
    setCurrentScreen('session');
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
            onAddServer={handleAddServer}
            onEditServer={handleEditServer}
            onOpenSetup={handleOpenSetup}
            onOpenNewProject={handleOpenNewProject}
            onOpenTaskDetail={handleOpenTaskDetail}
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
            onNewProject={handleOpenNewProject}
            onOpenTerminal={handleOpenTerminal}
          />
        );
      case 'settings':
        return (
          <Settings
            onBack={handleBackFromSettings}
            onOpenNotificationSettings={handleOpenNotificationSettings}
            onOpenAgents={handleOpenAgents}
            onOpenArchive={handleOpenArchive}
          />
        );
      case 'usage':
        return <UsageScreen onBack={handleBackFromUsage} />;
      case 'agents':
        return <AgentTreeScreen onBack={handleBackFromAgents} />;
      case 'archive':
        return <Archive onBack={handleBackFromArchive} />;
      case 'notificationSettings':
        return <NotificationSettings onBack={handleBackFromNotificationSettings} />;
      case 'setup':
        return <SetupScreen onBack={handleBackFromSetup} />;
      case 'newProject':
        return (
          <NewProjectScreen
            onBack={handleBackFromNewProject}
            onComplete={handleProjectCreated}
          />
        );
      case 'editServer':
        return (
          <EditServerScreen
            server={serverToEdit}
            onBack={handleBackFromEditServer}
            onSaved={handleBackFromEditServer}
          />
        );
      case 'taskDetail':
        if (!selectedTask) {
          setCurrentScreen('dashboard');
          return null;
        }
        return (
          <TaskDetailScreen
            task={selectedTask}
            onBack={handleBackFromTaskDetail}
          />
        );
      case 'terminal':
        if (!terminalSessionName) {
          setCurrentScreen('session');
          return null;
        }
        return (
          <TerminalScreen
            sessionName={terminalSessionName}
            onBack={handleBackFromTerminal}
          />
        );
      default:
        return (
          <DashboardScreen
            onSelectServer={handleSelectServerFromDashboard}
            onAddServer={handleAddServer}
            onEditServer={handleEditServer}
            onOpenSetup={handleOpenSetup}
            onOpenNewProject={handleOpenNewProject}
            onOpenTaskDetail={handleOpenTaskDetail}
          />
        );
    }
  };

  return (
    <View style={styles.rootContainer}>
      <SafeAreaProvider>
        <ErrorBoundary>
          <StatusBar barStyle="light-content" backgroundColor="#111827" />
          <SafeAreaView style={styles.container} edges={['top']}>
            {renderScreen()}
          </SafeAreaView>
        {currentScreen === 'dashboard' && (
          <View style={styles.settingsButton}>
            <SafeAreaView edges={['bottom']}>
              <View style={styles.settingsButtonInner}>
                <View style={styles.settingsIcon} onTouchEnd={handleOpenSettings}>
                  <Ionicons name="settings-sharp" size={22} color="#9ca3af" />
                </View>
              </View>
            </SafeAreaView>
          </View>
        )}
      </ErrorBoundary>
    </SafeAreaProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  rootContainer: {
    flex: 1,
    backgroundColor: '#111827',
  },
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
});

export default Sentry.wrap(App);
