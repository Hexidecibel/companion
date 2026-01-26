import { PushNotificationService } from '../src/push';

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
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

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    pushService = new PushNotificationService(undefined, 60000);
  });

  afterEach(() => {
    jest.useRealTimers();
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
      // Should not throw
      pushService.updateDeviceLastSeen('device-1');
    });
  });

  describe('instant notify', () => {
    it('should enable instant notify for a device', () => {
      pushService.registerDevice('device-1', 'token-123');
      pushService.setInstantNotify('device-1', true);
      // No assertion needed - just verify it doesn't throw
    });

    it('should disable instant notify for a device', () => {
      pushService.registerDevice('device-1', 'token-123');
      pushService.setInstantNotify('device-1', true);
      pushService.setInstantNotify('device-1', false);
      // No assertion needed - just verify it doesn't throw
    });
  });

  describe('notification scheduling', () => {
    it('should not schedule if no devices registered', () => {
      pushService.scheduleWaitingNotification('Test message');
      // No fetch call should be made
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should send instant notification to instant-enabled devices', async () => {
      pushService.registerDevice('device-1', 'ExponentPushToken[abc123]');
      pushService.setInstantNotify('device-1', true);

      pushService.scheduleWaitingNotification('Test message');

      // Should send immediately for instant devices
      await Promise.resolve(); // Let the async operation complete
      expect(fetch).toHaveBeenCalled();
    });

    it('should batch notifications for non-instant devices', () => {
      pushService.registerDevice('device-1', 'ExponentPushToken[abc123]');
      // Not setting instant notify - should batch

      pushService.scheduleWaitingNotification('Test message');

      // Should not send immediately
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should cancel pending notifications', () => {
      pushService.registerDevice('device-1', 'ExponentPushToken[abc123]');
      pushService.scheduleWaitingNotification('Test message');

      // Cancel should not throw
      pushService.cancelPendingNotification();
    });

    it('should truncate long preview messages', async () => {
      pushService.registerDevice('device-1', 'ExponentPushToken[abc123]');
      pushService.setInstantNotify('device-1', true);

      const longMessage = 'x'.repeat(300);
      pushService.scheduleWaitingNotification(longMessage);

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

  describe('batched notifications', () => {
    it('should send batched notifications after interval', async () => {
      pushService.registerDevice('device-1', 'ExponentPushToken[abc123]');
      // Not instant - will batch

      pushService.scheduleWaitingNotification('Message 1');
      pushService.scheduleWaitingNotification('Message 2');
      pushService.scheduleWaitingNotification('Message 3');

      // Advance time by 4 hours
      jest.advanceTimersByTime(4 * 60 * 60 * 1000);

      await Promise.resolve();

      expect(fetch).toHaveBeenCalled();
    });

    it('should clear batch when user responds', () => {
      pushService.registerDevice('device-1', 'ExponentPushToken[abc123]');

      pushService.scheduleWaitingNotification('Message 1');
      pushService.scheduleWaitingNotification('Message 2');

      pushService.cancelPendingNotification();

      // Advance time - should not send since cancelled
      jest.advanceTimersByTime(4 * 60 * 60 * 1000);

      expect(fetch).not.toHaveBeenCalled();
    });

    it('should include count in batched notification summary', async () => {
      pushService.registerDevice('device-1', 'ExponentPushToken[abc123]');

      pushService.scheduleWaitingNotification('Message 1');
      pushService.scheduleWaitingNotification('Message 2');
      pushService.scheduleWaitingNotification('Message 3');

      jest.advanceTimersByTime(4 * 60 * 60 * 1000);
      await Promise.resolve();

      expect(fetch).toHaveBeenCalled();
      const callArgs = (fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body[0].body).toContain('3 messages');
    });
  });
});
