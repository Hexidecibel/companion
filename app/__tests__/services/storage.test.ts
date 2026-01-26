import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getServers,
  saveServers,
  addServer,
  deleteServer,
  getSettings,
  saveSettings,
  AppSettings,
} from '../../src/services/storage';
import { Server } from '../../src/types';

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
  multiRemove: jest.fn(),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

describe('Storage Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getServers', () => {
    it('returns empty array when no servers stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValue(null);

      const servers = await getServers();

      expect(servers).toEqual([]);
      expect(mockAsyncStorage.getItem).toHaveBeenCalledWith('@claude_companion_servers');
    });

    it('returns parsed servers from storage', async () => {
      const storedServers: Server[] = [
        {
          id: 'server-1',
          name: 'Test Server',
          host: 'localhost',
          port: 9877,
          token: 'token',
          useTls: false,
        },
      ];
      mockAsyncStorage.getItem.mockResolvedValue(JSON.stringify(storedServers));

      const servers = await getServers();

      expect(servers).toEqual(storedServers);
    });

    it('returns empty array on parse error', async () => {
      mockAsyncStorage.getItem.mockResolvedValue('invalid json');

      const servers = await getServers();

      expect(servers).toEqual([]);
    });
  });

  describe('saveServers', () => {
    it('saves servers to storage', async () => {
      const servers: Server[] = [
        {
          id: 'server-1',
          name: 'Test Server',
          host: 'localhost',
          port: 9877,
          token: 'token',
          useTls: false,
        },
      ];

      await saveServers(servers);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@claude_companion_servers',
        JSON.stringify(servers)
      );
    });
  });

  describe('addServer', () => {
    it('adds new server to existing servers', async () => {
      const existingServer: Server = {
        id: 'server-1',
        name: 'Existing',
        host: 'localhost',
        port: 9877,
        token: 'token1',
        useTls: false,
      };
      mockAsyncStorage.getItem.mockResolvedValue(JSON.stringify([existingServer]));

      const newServer: Server = {
        id: 'server-2',
        name: 'New Server',
        host: '192.168.1.1',
        port: 9877,
        token: 'token2',
        useTls: true,
      };

      await addServer(newServer);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@claude_companion_servers',
        expect.stringContaining('server-2')
      );
    });

    it('creates servers array when none exists', async () => {
      mockAsyncStorage.getItem.mockResolvedValue(null);

      const newServer: Server = {
        id: 'server-1',
        name: 'New Server',
        host: 'localhost',
        port: 9877,
        token: 'token',
        useTls: false,
      };

      await addServer(newServer);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@claude_companion_servers',
        JSON.stringify([newServer])
      );
    });
  });

  describe('deleteServer', () => {
    it('removes server by id', async () => {
      const servers: Server[] = [
        { id: 'server-1', name: 'Server 1', host: 'a', port: 1, token: 't1', useTls: false },
        { id: 'server-2', name: 'Server 2', host: 'b', port: 2, token: 't2', useTls: false },
      ];
      mockAsyncStorage.getItem.mockResolvedValue(JSON.stringify(servers));

      await deleteServer('server-1');

      const savedData = JSON.parse(mockAsyncStorage.setItem.mock.calls[0][1]);
      expect(savedData).toHaveLength(1);
      expect(savedData[0].id).toBe('server-2');
    });

    it('handles removing non-existent server', async () => {
      const servers: Server[] = [
        { id: 'server-1', name: 'Server 1', host: 'a', port: 1, token: 't1', useTls: false },
      ];
      mockAsyncStorage.getItem.mockResolvedValue(JSON.stringify(servers));

      await deleteServer('non-existent');

      const savedData = JSON.parse(mockAsyncStorage.setItem.mock.calls[0][1]);
      expect(savedData).toHaveLength(1);
    });
  });

  describe('getSettings', () => {
    it('returns default settings when none stored', async () => {
      mockAsyncStorage.getItem.mockResolvedValue(null);

      const settings = await getSettings();

      expect(settings).toEqual({
        stayConnected: false,
        pushEnabled: false,
      });
    });

    it('returns stored settings', async () => {
      const storedSettings: AppSettings = {
        stayConnected: true,
        pushEnabled: true,
        defaultServerId: 'server-1',
      };
      mockAsyncStorage.getItem.mockResolvedValue(JSON.stringify(storedSettings));

      const settings = await getSettings();

      expect(settings).toEqual(storedSettings);
    });

    it('merges stored settings with defaults', async () => {
      mockAsyncStorage.getItem.mockResolvedValue(JSON.stringify({ pushEnabled: true }));

      const settings = await getSettings();

      expect(settings.pushEnabled).toBe(true);
      expect(settings.stayConnected).toBe(false);
    });
  });

  describe('saveSettings', () => {
    it('saves settings to storage', async () => {
      const settings: AppSettings = {
        stayConnected: true,
        pushEnabled: true,
      };

      await saveSettings(settings);

      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
        '@claude_companion_settings',
        JSON.stringify(settings)
      );
    });
  });
});
