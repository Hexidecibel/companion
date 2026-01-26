import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { Server } from 'http';

// Mock WebSocket classes
class MockWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  send = jest.fn();
  close = jest.fn();
}

class MockWebSocketServer extends EventEmitter {
  clients = new Set<MockWebSocket>();
  close = jest.fn((cb?: () => void) => cb?.());
}

jest.mock('ws', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => new MockWebSocket()),
    WebSocket: jest.fn().mockImplementation(() => new MockWebSocket()),
    WebSocketServer: jest.fn().mockImplementation(() => new MockWebSocketServer()),
    OPEN: 1,
  };
});

// Mock the dependencies
const mockWatcher = new EventEmitter() as any;
mockWatcher.getMessages = jest.fn().mockReturnValue([]);
mockWatcher.getStatus = jest.fn().mockReturnValue({
  isRunning: true,
  isWaitingForInput: false,
  lastActivity: Date.now(),
});
mockWatcher.getSessions = jest.fn().mockReturnValue([]);
mockWatcher.getActiveSessionId = jest.fn().mockReturnValue('test-session');
mockWatcher.setActiveSession = jest.fn().mockReturnValue(true);

const mockInjector = {
  sendInput: jest.fn().mockResolvedValue(true),
} as any;

const mockPush = {
  registerDevice: jest.fn(),
  unregisterDevice: jest.fn(),
  updateDeviceLastSeen: jest.fn(),
  setInstantNotify: jest.fn(),
  scheduleWaitingNotification: jest.fn(),
  cancelPendingNotification: jest.fn(),
} as any;

const mockServer = new EventEmitter() as unknown as Server;

import { WebSocketHandler } from '../src/websocket';

describe('WebSocketHandler', () => {
  let handler: WebSocketHandler;
  let mockWss: MockWebSocketServer;
  const token = 'test-token';

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new WebSocketHandler(mockServer, token, mockWatcher, mockInjector, mockPush);
    // Access the internal WebSocketServer for testing
    mockWss = (handler as any).wss;
  });

  describe('authentication', () => {
    it('should authenticate with valid token', () => {
      const mockClient = new MockWebSocket();
      mockWss.clients.add(mockClient);

      // Simulate connection
      mockWss.emit('connection', mockClient, {});

      // Clear connection ack
      mockClient.send.mockClear();

      // Simulate auth message
      mockClient.emit(
        'message',
        JSON.stringify({
          type: 'authenticate',
          token: 'test-token',
          requestId: 'req-1',
        })
      );

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"success":true')
      );
    });

    it('should reject invalid token', () => {
      const mockClient = new MockWebSocket();
      mockWss.clients.add(mockClient);

      mockWss.emit('connection', mockClient, {});
      mockClient.send.mockClear();

      mockClient.emit(
        'message',
        JSON.stringify({
          type: 'authenticate',
          token: 'wrong-token',
          requestId: 'req-1',
        })
      );

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"success":false')
      );
    });

    it('should reject messages before authentication', () => {
      const mockClient = new MockWebSocket();
      mockWss.clients.add(mockClient);

      mockWss.emit('connection', mockClient, {});
      mockClient.send.mockClear();

      mockClient.emit(
        'message',
        JSON.stringify({
          type: 'subscribe',
          requestId: 'req-1',
        })
      );

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('Not authenticated')
      );
    });
  });

  describe('message handling', () => {
    let authenticatedClient: MockWebSocket;

    beforeEach(() => {
      authenticatedClient = new MockWebSocket();
      mockWss.clients.add(authenticatedClient);
      mockWss.emit('connection', authenticatedClient, {});

      // Authenticate
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'authenticate',
          token: 'test-token',
          requestId: 'auth-1',
        })
      );

      authenticatedClient.send.mockClear();
    });

    it('should handle subscribe message', () => {
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'subscribe',
          requestId: 'req-1',
        })
      );

      expect(authenticatedClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"success":true')
      );
    });

    it('should handle ping message', () => {
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'ping',
          requestId: 'req-1',
        })
      );

      expect(authenticatedClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"pong"')
      );
    });

    it('should handle get_highlights message', () => {
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'get_highlights',
          requestId: 'req-1',
        })
      );

      expect(authenticatedClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"highlights"')
      );
    });

    it('should handle get_full message', () => {
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'get_full',
          requestId: 'req-1',
        })
      );

      expect(authenticatedClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"full"')
      );
    });

    it('should handle get_status message', () => {
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'get_status',
          requestId: 'req-1',
        })
      );

      expect(authenticatedClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"status"')
      );
    });

    it('should handle get_sessions message', () => {
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'get_sessions',
          requestId: 'req-1',
        })
      );

      expect(authenticatedClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"sessions"')
      );
    });

    it('should handle switch_session message', () => {
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'switch_session',
          payload: { sessionId: 'test-session' },
          requestId: 'req-1',
        })
      );

      expect(mockWatcher.setActiveSession).toHaveBeenCalledWith('test-session');
      expect(authenticatedClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"session_switched"')
      );
    });

    it('should handle send_input message', async () => {
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'send_input',
          payload: { input: 'test input' },
          requestId: 'req-1',
        })
      );

      // Wait for async handling
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockInjector.sendInput).toHaveBeenCalledWith('test input');
      expect(mockPush.cancelPendingNotification).toHaveBeenCalled();
    });

    it('should handle register_push message', () => {
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'register_push',
          payload: { fcmToken: 'test-token-123', deviceId: 'device-1' },
          requestId: 'req-1',
        })
      );

      expect(mockPush.registerDevice).toHaveBeenCalledWith('device-1', 'test-token-123');
      expect(authenticatedClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"push_registered"')
      );
    });

    it('should handle set_instant_notify message', () => {
      // First register push to set deviceId
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'register_push',
          payload: { fcmToken: 'test-token-123', deviceId: 'device-1' },
          requestId: 'req-1',
        })
      );

      authenticatedClient.send.mockClear();

      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'set_instant_notify',
          payload: { enabled: true },
          requestId: 'req-2',
        })
      );

      expect(mockPush.setInstantNotify).toHaveBeenCalledWith('device-1', true);
      expect(authenticatedClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"instant_notify_set"')
      );
    });

    it('should handle unknown message type', () => {
      authenticatedClient.emit(
        'message',
        JSON.stringify({
          type: 'unknown_type',
          requestId: 'req-1',
        })
      );

      expect(authenticatedClient.send).toHaveBeenCalledWith(
        expect.stringContaining('Unknown message type')
      );
    });
  });

  describe('connection management', () => {
    it('should clean up on client close', () => {
      const mockClient = new MockWebSocket();
      mockWss.clients.add(mockClient);

      mockWss.emit('connection', mockClient, {});

      // Authenticate and subscribe
      mockClient.emit(
        'message',
        JSON.stringify({ type: 'authenticate', token: 'test-token' })
      );
      mockClient.emit('message', JSON.stringify({ type: 'subscribe' }));

      // Close connection
      mockClient.emit('close');
      mockWss.clients.delete(mockClient);

      // Handler should still work
      expect(handler.getConnectedClientCount()).toBe(0);
    });

    it('should handle malformed JSON messages', () => {
      const mockClient = new MockWebSocket();
      mockWss.clients.add(mockClient);

      mockWss.emit('connection', mockClient, {});
      mockClient.send.mockClear();

      // Send malformed JSON
      mockClient.emit('message', 'not valid json');

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('Invalid JSON')
      );
    });
  });

  describe('watcher events', () => {
    it('should forward conversation-update to subscribed clients', () => {
      const mockClient = new MockWebSocket();
      mockWss.clients.add(mockClient);
      mockWss.emit('connection', mockClient, {});

      // Authenticate and subscribe
      mockClient.emit(
        'message',
        JSON.stringify({ type: 'authenticate', token: 'test-token' })
      );
      mockClient.emit('message', JSON.stringify({ type: 'subscribe' }));
      mockClient.send.mockClear();

      // Simulate watcher event
      mockWatcher.emit('conversation-update', { messages: [], highlights: [] });

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"conversation_update"')
      );
    });

    it('should forward status-change to subscribed clients', () => {
      const mockClient = new MockWebSocket();
      mockWss.clients.add(mockClient);
      mockWss.emit('connection', mockClient, {});

      // Authenticate and subscribe
      mockClient.emit(
        'message',
        JSON.stringify({ type: 'authenticate', token: 'test-token' })
      );
      mockClient.emit('message', JSON.stringify({ type: 'subscribe' }));
      mockClient.send.mockClear();

      // Simulate watcher status change with waiting for input
      mockWatcher.emit('status-change', {
        isWaitingForInput: true,
        lastMessage: { content: 'What should I do?' },
      });

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"status_change"')
      );
      expect(mockPush.scheduleWaitingNotification).toHaveBeenCalled();
    });

    it('should not forward events to unsubscribed clients', () => {
      const mockClient = new MockWebSocket();
      mockWss.clients.add(mockClient);
      mockWss.emit('connection', mockClient, {});

      // Authenticate but don't subscribe
      mockClient.emit(
        'message',
        JSON.stringify({ type: 'authenticate', token: 'test-token' })
      );
      mockClient.send.mockClear();

      // Simulate watcher event
      mockWatcher.emit('conversation-update', { messages: [], highlights: [] });

      expect(mockClient.send).not.toHaveBeenCalled();
    });
  });

  describe('client counts', () => {
    it('should track connected clients', () => {
      const mockClient1 = new MockWebSocket();
      const mockClient2 = new MockWebSocket();

      mockWss.clients.add(mockClient1);
      mockWss.clients.add(mockClient2);

      mockWss.emit('connection', mockClient1, {});
      mockWss.emit('connection', mockClient2, {});

      expect(handler.getConnectedClientCount()).toBe(2);
    });

    it('should track authenticated clients', () => {
      const mockClient1 = new MockWebSocket();
      const mockClient2 = new MockWebSocket();

      mockWss.clients.add(mockClient1);
      mockWss.clients.add(mockClient2);

      mockWss.emit('connection', mockClient1, {});
      mockWss.emit('connection', mockClient2, {});

      // Only authenticate one
      mockClient1.emit(
        'message',
        JSON.stringify({ type: 'authenticate', token: 'test-token' })
      );

      expect(handler.getAuthenticatedClientCount()).toBe(1);
    });
  });
});
