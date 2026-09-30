import { isReadonlySharedState, isSandbox } from '../src/sandbox';
import { PushNotificationService } from '../src/push';

describe('sandbox switches', () => {
  it('COMPANION_SANDBOX implies read-only shared state', () => {
    expect(isSandbox({ COMPANION_SANDBOX: '1' })).toBe(true);
    expect(isReadonlySharedState({ COMPANION_SANDBOX: '1' })).toBe(true);
    expect(isReadonlySharedState({ COMPANION_READONLY_SHARED_STATE: '1' })).toBe(true);
    expect(isSandbox({ COMPANION_READONLY_SHARED_STATE: '1' })).toBe(false);
    expect(isReadonlySharedState({})).toBe(false);
    expect(isSandbox({ COMPANION_SANDBOX: 'true' })).toBe(false);
  });
});

describe('PushNotificationService in sandbox mode', () => {
  function fakeStore() {
    return {
      setDevice: jest.fn(),
      removeDevice: jest.fn(),
      updateDeviceLastSeen: jest.fn(),
      getDevices: jest.fn(() => [{ token: 'fcm-token', deviceId: 'phone', registeredAt: 1, lastSeen: 1 }]),
    };
  }

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('never registers devices or sends pushes when disabled', async () => {
    const store = fakeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const push = new PushNotificationService('/nonexistent/creds.json', 0, store as any, { disabled: true });
    expect(push.isDisabled).toBe(true);
    push.registerDevice('phone', 'fcm-token');
    expect(store.setDevice).not.toHaveBeenCalled();
    push.sendToAllDevices('hi', 'waiting_for_input', 's', 's');
    push.sendConsolidatedNotification('t', 'b');
    expect(await push.sendTestNotification()).toEqual({ sent: 0, failed: 0 });
    expect(store.getDevices).not.toHaveBeenCalled();
  });

  it('registers devices normally when enabled', () => {
    const store = fakeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const push = new PushNotificationService(undefined, 0, store as any);
    push.registerDevice('phone', 'fcm-token');
    expect(store.setDevice).toHaveBeenCalledTimes(1);
  });
});
