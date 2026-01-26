import { EventEmitter } from 'events';
import WebSocket from 'ws';

// Mock ws module
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

import { WebSocketHandler } from '../src/websocket';
import { DaemonConfig } from '../src/types';

describe('WebSocketHandler', () => {
  let handler: WebSocketHandler;
  let mockServer: MockWebSocketServer;
  const config: DaemonConfig = {
    port: 9877,
    token: 'test-token',
    tls: false,
    tmuxSession: 'claude',
    claudeHome: '/home/user/.claude',
    mdnsEnabled: false,
    pushDelayMs: 60000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new WebSocketHandler(config);
    mockServer = (handler as any).wss;
  });

  afterEach(() => {
    handler.stop();
  });

  describe('authentication', () => {
    it('should authenticate with valid token', () => {
      const mockClient = new MockWebSocket();
      mockServer.clients.add(mockClient);

      // Simulate connection
      mockServer.emit('connection', mockClient);

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
      mockServer.clients.add(mockClient);

      mockServer.emit('connection', mockClient);

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
      mockServer.clients.add(mockClient);

      mockServer.emit('connection', mockClient);

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
      mockServer.clients.add(authenticatedClient);
      mockServer.emit('connection', authenticatedClient);

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
        expect.stringContaining('"type":"full_conversation"')
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

  describe('broadcasting', () => {
    it('should broadcast to subscribed clients only', () => {
      const subscribedClient = new MockWebSocket();
      const unsubscribedClient = new MockWebSocket();

      mockServer.clients.add(subscribedClient);
      mockServer.clients.add(unsubscribedClient);

      // Connect both
      mockServer.emit('connection', subscribedClient);
      mockServer.emit('connection', unsubscribedClient);

      // Authenticate both
      subscribedClient.emit(
        'message',
        JSON.stringify({ type: 'authenticate', token: 'test-token' })
      );
      unsubscribedClient.emit(
        'message',
        JSON.stringify({ type: 'authenticate', token: 'test-token' })
      );

      // Subscribe only one
      subscribedClient.emit(
        'message',
        JSON.stringify({ type: 'subscribe' })
      );

      subscribedClient.send.mockClear();
      unsubscribedClient.send.mockClear();

      // Broadcast
      handler.broadcast({ type: 'update', payload: { test: true } });

      expect(subscribedClient.send).toHaveBeenCalled();
      expect(unsubscribedClient.send).not.toHaveBeenCalled();
    });
  });

  describe('connection management', () => {
    it('should clean up on client close', () => {
      const mockClient = new MockWebSocket();
      mockServer.clients.add(mockClient);

      mockServer.emit('connection', mockClient);

      // Authenticate and subscribe
      mockClient.emit(
        'message',
        JSON.stringify({ type: 'authenticate', token: 'test-token' })
      );
      mockClient.emit('message', JSON.stringify({ type: 'subscribe' }));

      // Close connection
      mockClient.emit('close');
      mockServer.clients.delete(mockClient);

      // Broadcast should not fail
      expect(() => handler.broadcast({ type: 'test' })).not.toThrow();
    });

    it('should handle malformed JSON messages', () => {
      const mockClient = new MockWebSocket();
      mockServer.clients.add(mockClient);

      mockServer.emit('connection', mockClient);

      // Send malformed JSON
      mockClient.emit('message', 'not valid json');

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.stringContaining('Invalid message format')
      );
    });
  });
});
