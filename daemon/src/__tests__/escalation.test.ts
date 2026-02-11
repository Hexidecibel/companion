import { EscalationService, EscalationEvent } from '../escalation';
import { NotificationStore } from '../notification-store';
import { PushNotificationService } from '../push';
import { NotificationEventType, DEFAULT_ESCALATION_CONFIG } from '../types';

// Mock NotificationStore — in-memory, no filesystem
function createMockStore(
  overrides?: Partial<ReturnType<NotificationStore['getEscalation']>>
): NotificationStore {
  const config = { ...DEFAULT_ESCALATION_CONFIG, ...overrides };
  const devices = new Map<
    string,
    { token: string; deviceId: string; registeredAt: number; lastSeen: number }
  >();
  const mutedSessions = new Set<string>();
  const history: unknown[] = [];

  return {
    getEscalation: () => ({ ...config }),
    setEscalation: jest.fn(),
    getDevices: () => Array.from(devices.values()),
    setDevice: (d: { token: string; deviceId: string; registeredAt: number; lastSeen: number }) => {
      devices.set(d.deviceId, d);
    },
    removeDevice: (id: string) => devices.delete(id),
    getDeviceCount: () => devices.size,
    updateDeviceLastSeen: jest.fn(),
    getMutedSessions: () => Array.from(mutedSessions),
    isSessionMuted: (id: string) => mutedSessions.has(id),
    setSessionMuted: (id: string, muted: boolean) => {
      if (muted) mutedSessions.add(id);
      else mutedSessions.delete(id);
    },
    addHistoryEntry: jest.fn((entry) => ({ ...entry, id: 'test-id', timestamp: Date.now() })),
    getHistory: () => ({ entries: history as any[], total: history.length }),
    clearHistory: () => {
      history.length = 0;
    },
    flush: jest.fn(),
    getDevice: jest.fn(),
  } as unknown as NotificationStore;
}

// Mock PushNotificationService
function createMockPush(): PushNotificationService & {
  sendToAllDevicesCalls: Array<{
    preview: string;
    eventType: NotificationEventType;
    sessionId?: string;
    sessionName?: string;
  }>;
  consolidatedCalls: Array<{ title: string; body: string }>;
} {
  const sendToAllDevicesCalls: Array<{
    preview: string;
    eventType: NotificationEventType;
    sessionId?: string;
    sessionName?: string;
  }> = [];
  const consolidatedCalls: Array<{ title: string; body: string }> = [];
  return {
    sendToAllDevicesCalls,
    consolidatedCalls,
    sendToAllDevices: jest.fn((preview, eventType, sessionId, sessionName) => {
      sendToAllDevicesCalls.push({ preview, eventType, sessionId, sessionName });
    }),
    sendConsolidatedNotification: jest.fn((title, body) => {
      consolidatedCalls.push({ title, body });
    }),
    registerDevice: jest.fn(),
    unregisterDevice: jest.fn(),
    isEnabled: () => true,
    getRegisteredDeviceCount: () => 0,
    getStore: jest.fn(),
    sendTestNotification: jest.fn(),
    updateDeviceLastSeen: jest.fn(),
    getTitleForEvent: (eventType: NotificationEventType) => {
      const map: Record<NotificationEventType, string> = {
        waiting_for_input: 'Waiting for input',
        error_detected: 'Error detected',
        session_completed: 'Session completed',
        worker_waiting: 'Worker needs input',
        worker_error: 'Worker error',
        work_group_ready: 'Work group ready to merge',
        usage_warning: 'Usage warning',
      };
      return map[eventType];
    },
  } as unknown as PushNotificationService & {
    sendToAllDevicesCalls: typeof sendToAllDevicesCalls;
    consolidatedCalls: typeof consolidatedCalls;
  };
}

function makeEvent(overrides?: Partial<EscalationEvent>): EscalationEvent {
  return {
    eventType: 'waiting_for_input',
    sessionId: 'session-1',
    sessionName: 'test-session',
    content: 'Claude is waiting for your input',
    ...overrides,
  };
}

describe('EscalationService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('handleEvent', () => {
    it('should broadcast when event type is enabled', () => {
      const store = createMockStore();
      const push = createMockPush();
      const service = new EscalationService(store, push);

      const result = service.handleEvent(makeEvent());

      expect(result.shouldBroadcast).toBe(true);
      expect(result.pendingEvent).toBeDefined();
      expect(result.pendingEvent?.eventType).toBe('waiting_for_input');
      service.destroy();
    });

    it('should not broadcast when event type is disabled', () => {
      const store = createMockStore();
      // Disable waiting_for_input in the config
      (store.getEscalation as jest.Mock) = jest.fn(() => ({
        ...DEFAULT_ESCALATION_CONFIG,
        events: { ...DEFAULT_ESCALATION_CONFIG.events, waiting_for_input: false },
      }));
      const push = createMockPush();
      const service = new EscalationService(store, push);

      const result = service.handleEvent(makeEvent());

      expect(result.shouldBroadcast).toBe(false);
      service.destroy();
    });

    it('should not broadcast when session is muted', () => {
      const store = createMockStore();
      store.setSessionMuted('session-1', true);
      const push = createMockPush();
      const service = new EscalationService(store, push);

      const result = service.handleEvent(makeEvent({ sessionId: 'session-1' }));

      expect(result.shouldBroadcast).toBe(false);
      service.destroy();
    });

    it('should log to history on broadcast', () => {
      const store = createMockStore();
      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent());

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(store.addHistoryEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'waiting_for_input',
          tier: 'browser',
          sessionId: 'session-1',
        })
      );
      service.destroy();
    });
  });

  describe('rate limiting', () => {
    it('should rate-limit repeat events for same session', () => {
      const store = createMockStore({ rateLimitSeconds: 60 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      const result1 = service.handleEvent(makeEvent());
      expect(result1.shouldBroadcast).toBe(true);

      // Second event within rate limit window
      const result2 = service.handleEvent(makeEvent());
      expect(result2.shouldBroadcast).toBe(false);

      service.destroy();
    });

    it('should allow events after rate limit expires', () => {
      const store = createMockStore({ rateLimitSeconds: 60 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      const result1 = service.handleEvent(makeEvent());
      expect(result1.shouldBroadcast).toBe(true);

      // Advance past rate limit
      jest.advanceTimersByTime(61_000);

      const result2 = service.handleEvent(makeEvent());
      expect(result2.shouldBroadcast).toBe(true);

      service.destroy();
    });

    it('should allow events from different sessions within rate limit', () => {
      const store = createMockStore({ rateLimitSeconds: 60 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      const result1 = service.handleEvent(makeEvent({ sessionId: 'session-1' }));
      expect(result1.shouldBroadcast).toBe(true);

      const result2 = service.handleEvent(makeEvent({ sessionId: 'session-2' }));
      expect(result2.shouldBroadcast).toBe(true);

      service.destroy();
    });

    it('should pass through when rate limiting is disabled', () => {
      const store = createMockStore({ rateLimitSeconds: 0 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      const result1 = service.handleEvent(makeEvent());
      const result2 = service.handleEvent(makeEvent());

      expect(result1.shouldBroadcast).toBe(true);
      expect(result2.shouldBroadcast).toBe(true);

      service.destroy();
    });
  });

  describe('push escalation', () => {
    it('should send push after delay', () => {
      const store = createMockStore({ pushDelaySeconds: 300 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent());
      expect(push.consolidatedCalls).toHaveLength(0);

      // Advance to push time
      jest.advanceTimersByTime(300_000);

      expect(push.consolidatedCalls).toHaveLength(1);
      service.destroy();
    });

    it('should send push immediately when pushDelaySeconds is 0', () => {
      const store = createMockStore({ pushDelaySeconds: 0 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent());

      expect(push.consolidatedCalls).toHaveLength(1);
      service.destroy();
    });

    it('should not send push if acknowledged before timer fires', () => {
      const store = createMockStore({ pushDelaySeconds: 300 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent({ sessionId: 'session-1' }));

      // User acknowledges (views session) before push timer
      jest.advanceTimersByTime(100_000);
      service.acknowledgeSession('session-1');

      // Push timer fires but event is acknowledged
      jest.advanceTimersByTime(200_000);

      expect(push.consolidatedCalls).toHaveLength(0);
      service.destroy();
    });
  });

  describe('consolidated notifications', () => {
    it('should consolidate multiple pending events into one push', () => {
      const store = createMockStore({ pushDelaySeconds: 300, rateLimitSeconds: 0 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      // Multiple events from different sessions
      service.handleEvent(makeEvent({ sessionId: 's1', sessionName: 'Project A' }));
      service.handleEvent(makeEvent({ sessionId: 's2', sessionName: 'Project B' }));
      service.handleEvent(
        makeEvent({
          sessionId: 's3',
          sessionName: 'Project C',
          eventType: 'error_detected',
        })
      );

      // First timer fires — should consolidate all pending
      jest.advanceTimersByTime(300_000);

      expect(push.consolidatedCalls).toHaveLength(1);
      const call = push.consolidatedCalls[0];
      expect(call.title).toContain('3 sessions need attention');
      expect(call.body).toContain('2 waiting');
      expect(call.body).toContain('1 error');

      service.destroy();
    });

    it('should send specific message for single event', () => {
      const store = createMockStore({ pushDelaySeconds: 300 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent({ sessionName: 'My Session' }));

      jest.advanceTimersByTime(300_000);

      expect(push.consolidatedCalls).toHaveLength(1);
      const call = push.consolidatedCalls[0];
      expect(call.title).toBe('Waiting for input');
      expect(call.body).toContain('My Session');

      service.destroy();
    });

    it('should not send already-acknowledged events in consolidated push', () => {
      const store = createMockStore({ pushDelaySeconds: 300, rateLimitSeconds: 0 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent({ sessionId: 's1', sessionName: 'Project A' }));
      service.handleEvent(makeEvent({ sessionId: 's2', sessionName: 'Project B' }));

      // Acknowledge s1
      service.acknowledgeSession('s1');

      // Timer fires — only s2 should be in the push
      jest.advanceTimersByTime(300_000);

      expect(push.consolidatedCalls).toHaveLength(1);
      const call = push.consolidatedCalls[0];
      // Single event — specific message
      expect(call.title).toBe('Waiting for input');
      expect(call.body).toContain('Project B');

      service.destroy();
    });
  });

  describe('acknowledgeSession', () => {
    it('should cancel pending push for acknowledged session', () => {
      const store = createMockStore({ pushDelaySeconds: 300 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent({ sessionId: 'session-1' }));
      service.acknowledgeSession('session-1');

      jest.advanceTimersByTime(300_000);

      expect(push.consolidatedCalls).toHaveLength(0);
      service.destroy();
    });

    it('should not affect other sessions when acknowledging one', () => {
      const store = createMockStore({ pushDelaySeconds: 300, rateLimitSeconds: 0 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent({ sessionId: 's1', sessionName: 'Proj A' }));
      service.handleEvent(makeEvent({ sessionId: 's2', sessionName: 'Proj B' }));

      service.acknowledgeSession('s1');

      jest.advanceTimersByTime(300_000);

      // Only s2 should have triggered push
      expect(push.consolidatedCalls).toHaveLength(1);
      expect(push.consolidatedCalls[0].body).toContain('Proj B');
      service.destroy();
    });
  });

  describe('quiet hours', () => {
    it('should suppress push during quiet hours', () => {
      const store = createMockStore({ pushDelaySeconds: 0 });
      // Override getEscalation to enable quiet hours
      const origGet = store.getEscalation.bind(store);
      (store as any).getEscalation = () => ({
        ...origGet(),
        quietHours: { enabled: true, start: '00:00', end: '23:59' },
      });

      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent());

      // Push should not be sent (we're always in quiet hours with 00:00-23:59)
      expect(push.consolidatedCalls).toHaveLength(0);
      service.destroy();
    });

    it('should allow push outside quiet hours', () => {
      const store = createMockStore({ pushDelaySeconds: 0 });
      const origGet = store.getEscalation.bind(store);
      // Quiet hours from 03:00 to 03:01 — almost never active
      (store as any).getEscalation = () => ({
        ...origGet(),
        quietHours: { enabled: false, start: '03:00', end: '03:01' },
      });

      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent());

      expect(push.consolidatedCalls).toHaveLength(1);
      service.destroy();
    });
  });

  describe('getPendingEvents', () => {
    it('should return only unacknowledged, unsent events', () => {
      const store = createMockStore({ pushDelaySeconds: 300, rateLimitSeconds: 0 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent({ sessionId: 's1' }));
      service.handleEvent(makeEvent({ sessionId: 's2' }));

      expect(service.getPendingEvents()).toHaveLength(2);

      service.acknowledgeSession('s1');

      expect(service.getPendingEvents()).toHaveLength(1);
      expect(service.getPendingEvents()[0].sessionId).toBe('s2');

      service.destroy();
    });
  });

  describe('multiple event types', () => {
    it('should handle all enabled event types', () => {
      const store = createMockStore({ rateLimitSeconds: 0 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      // These are enabled by default
      const enabledTypes: NotificationEventType[] = [
        'waiting_for_input',
        'error_detected',
        'worker_waiting',
        'worker_error',
        'work_group_ready',
      ];

      for (const eventType of enabledTypes) {
        const result = service.handleEvent(
          makeEvent({
            eventType,
            sessionId: `session-${eventType}`,
          })
        );
        expect(result.shouldBroadcast).toBe(true);
      }

      // session_completed is disabled by default
      const result = service.handleEvent(
        makeEvent({
          eventType: 'session_completed',
          sessionId: 'session-completed',
        })
      );
      expect(result.shouldBroadcast).toBe(false);

      service.destroy();
    });
  });

  describe('cleanup', () => {
    it('should destroy cleanly with pending timers', () => {
      const store = createMockStore({ pushDelaySeconds: 300 });
      const push = createMockPush();
      const service = new EscalationService(store, push);

      service.handleEvent(makeEvent({ sessionId: 's1' }));
      service.handleEvent(makeEvent({ sessionId: 's2' }));

      // Should not throw
      service.destroy();

      // Timers should be cancelled — advancing should not trigger push
      jest.advanceTimersByTime(300_000);
      expect(push.consolidatedCalls).toHaveLength(0);
    });
  });
});
