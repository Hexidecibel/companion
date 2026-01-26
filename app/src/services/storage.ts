import AsyncStorage from '@react-native-async-storage/async-storage';
import { Server } from '../types';

const SERVERS_KEY = '@claude_companion_servers';
const SETTINGS_KEY = '@claude_companion_settings';
const SESSION_SETTINGS_KEY = '@claude_companion_session_settings';

export interface AppSettings {
  stayConnected: boolean;
  pushEnabled: boolean;
  defaultServerId?: string;
}

export interface SessionSettings {
  instantNotify: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  stayConnected: false,
  pushEnabled: false,
};

export async function getServers(): Promise<Server[]> {
  try {
    const json = await AsyncStorage.getItem(SERVERS_KEY);
    if (json) {
      return JSON.parse(json);
    }
  } catch (error) {
    console.error('Error loading servers:', error);
  }
  return [];
}

export async function saveServers(servers: Server[]): Promise<void> {
  try {
    await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(servers));
  } catch (error) {
    console.error('Error saving servers:', error);
  }
}

export async function addServer(server: Server): Promise<void> {
  const servers = await getServers();
  servers.push(server);
  await saveServers(servers);
}

export async function updateServer(server: Server): Promise<void> {
  const servers = await getServers();
  const index = servers.findIndex((s) => s.id === server.id);
  if (index !== -1) {
    servers[index] = server;
    await saveServers(servers);
  }
}

export async function deleteServer(id: string): Promise<void> {
  const servers = await getServers();
  const filtered = servers.filter((s) => s.id !== id);
  await saveServers(filtered);
}

export async function getSettings(): Promise<AppSettings> {
  try {
    const json = await AsyncStorage.getItem(SETTINGS_KEY);
    if (json) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(json) };
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
  return DEFAULT_SETTINGS;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('Error saving settings:', error);
  }
}

export async function clearAll(): Promise<void> {
  await AsyncStorage.multiRemove([SERVERS_KEY, SETTINGS_KEY, SESSION_SETTINGS_KEY]);
}

const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  instantNotify: false,
};

export async function getSessionSettings(serverId: string): Promise<SessionSettings> {
  try {
    const json = await AsyncStorage.getItem(SESSION_SETTINGS_KEY);
    if (json) {
      const all = JSON.parse(json);
      return { ...DEFAULT_SESSION_SETTINGS, ...all[serverId] };
    }
  } catch (error) {
    console.error('Error loading session settings:', error);
  }
  return DEFAULT_SESSION_SETTINGS;
}

export async function saveSessionSettings(serverId: string, settings: SessionSettings): Promise<void> {
  try {
    const json = await AsyncStorage.getItem(SESSION_SETTINGS_KEY);
    const all = json ? JSON.parse(json) : {};
    all[serverId] = settings;
    await AsyncStorage.setItem(SESSION_SETTINGS_KEY, JSON.stringify(all));
  } catch (error) {
    console.error('Error saving session settings:', error);
  }
}
