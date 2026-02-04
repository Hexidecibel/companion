import { PushNotificationService } from '../src/push';
import { NotificationStore } from '../src/notification-store';

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// Mock firebase-admin
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: {
    cert: jest.fn(),
  },
  messaging: jest.fn(() => ({
    sendEachForMulticast: jest.fn().mockResolvedValue({
      successCount: 1,
      responses: [{ success: true }],
    }),
  })),
}));

// Mock fetch for Expo push
global.fetch = jest.fn().mockResolvedValue({
  json: () => Promise.resolve({ data: [{ status: 'ok' }] }),
});

describe('PushNotificationService', () => {
  let pushService: PushNotificationService;
  let store: NotificationStore;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new NotificationStore();
    pushService = new PushNotificationService(undefined, 60000, store);
  });

  describe('device registration', () => {
    it('should register a device', () => {
      pushService.registerDevice('device-1', 'token-123');
      expect(pushService.getRegisteredDeviceCount()).toBe(1);
    });

    it('should unregister a device', () => {
      pushService.registerDevice('device-1', 'token-123');
      pushService.unregisterDevice('device-1');
      expect(pushService.getRegisteredDeviceCount()).toBe(0);
    });

    it('should update device last seen', () => {
      pushService.registerDevice('device-1', 'token-123');
      pushService.updateDeviceLastSeen('device-1');
    });
  });

  describe('sendToAllDevices', () => {
    it('should not send if no devices registered', () => {
      pushService.sendToAllDevices('Test message', 'waiting_for_input');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should send to registered Expo device', async () => {
      pushService.registerDevice('device-1', 'ExponentPushToken[abc123]');
      pushService.sendToAllDevices('Test message', 'waiting_for_input');
      await Promise.resolve();
      expect(fetch).toHaveBeenCalled();
    });

    it('should truncate long preview messages', async () => {
      pushService.registerDevice('device-1', 'ExponentPushToken[abc123]');
      const longMessage = 'x'.repeat(300);
      pushService.sendToAllDevices(longMessage, 'waiting_for_input');
      await Promise.resolve();
      expect(fetch).toHaveBeenCalled();
      const callArgs = (fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body[0].body.length).toBeLessThanOrEqual(200);
    });
  });

  describe('isEnabled', () => {
    it('should return true', () => {
      expect(pushService.isEnabled()).toBe(true);
    });
  });
});
