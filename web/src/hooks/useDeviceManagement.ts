import { useState, useCallback } from 'react';
import { connectionManager } from '../services/ConnectionManager';

export interface RegisteredDevice {
  token: string;
  deviceId: string;
  registeredAt: number;
  lastSeen: number;
}

interface UseDeviceManagementReturn {
  devices: RegisteredDevice[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  removeDevice: (deviceId: string) => Promise<boolean>;
  sendTestNotification: () => Promise<void>;
}

export function useDeviceManagement(serverId: string | null): UseDeviceManagementReturn {
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    setLoading(true);
    setError(null);
    try {
      const response = await conn.sendRequest('get_devices');
      if (response.success && response.payload) {
        const payload = response.payload as { devices: RegisteredDevice[] };
        setDevices(payload.devices ?? []);
      } else {
        setError(response.error ?? 'Failed to fetch devices');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  const removeDevice = useCallback(async (deviceId: string): Promise<boolean> => {
    if (!serverId) return false;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return false;

    try {
      const response = await conn.sendRequest('remove_device', { deviceId });
      if (response.success) {
        setDevices(prev => prev.filter(d => d.deviceId !== deviceId));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [serverId]);

  const sendTestNotification = useCallback(async () => {
    if (!serverId) return;
    const conn = connectionManager.getConnection(serverId);
    if (!conn || !conn.isConnected()) return;

    try {
      await conn.sendRequest('send_test_notification');
    } catch (err) {
      console.error('Failed to send test notification:', err);
    }
  }, [serverId]);

  return { devices, loading, error, refresh, removeDevice, sendTestNotification };
}
