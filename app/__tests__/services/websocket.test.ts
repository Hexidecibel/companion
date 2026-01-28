import { WebSocketService } from '../../src/services/websocket';
import { Server } from '../../src/types';

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  send = jest.fn();
  close = jest.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: 'Normal closure' });
  });

  // Helper to simulate server messages
  simulateMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateClose(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

// Store instance for test access
let mockWebSocketInstance: MockWebSocket;

const MockWebSocketConstructor = jest.fn().mockImplementation(() => {
  mockWebSocketInstance = new MockWebSocket();
  return mockWebSocketInstance;
}) as jest.Mock & { OPEN: number; CLOSED: number; CONNECTING: number; CLOSING: number };
// Add static constants to match real WebSocket
MockWebSocketConstructor.OPEN = 1;
MockWebSocketConstructor.CLOSED = 3;
MockWebSocketConstructor.CONNECTING = 0;
MockWebSocketConstructor.CLOSING = 2;

(global as any).WebSocket = MockWebSocketConstructor;

describe('WebSocketService', () => {
  let service: WebSocketService;
  const mockServer: Server = {
    id: 'server-1',
    name: 'Test Server',
    host: 'localhost',
    port: 9877,
    token: 'test-token',
    useTls: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    service = new WebSocketService();
  });

  afterEach(() => {
    service.disconnect();
    jest.useRealTimers();
  });

  describe('connect', () => {
    it('creates WebSocket with correct URL', () => {
      service.connect(mockServer);

      expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:9877');
    });

    it('creates secure WebSocket when useTls is true', () => {
      const tlsServer = { ...mockServer, useTls: true };
      service.connect(tlsServer);

      expect(global.WebSocket).toHaveBeenCalledWith('wss://localhost:9877');
    });

    it('updates state to connecting', () => {
      const stateHandler = jest.fn();
      service.onStateChange(stateHandler);

      service.connect(mockServer);

      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'connecting' })
      );
    });
  });

  describe('authentication', () => {
    it('authenticates on connection open', () => {
      service.connect(mockServer);
      mockWebSocketInstance.simulateOpen();
      // Auth is delayed by 50ms in handleOpen
      jest.advanceTimersByTime(100);

      expect(mockWebSocketInstance.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"authenticate"')
      );
      expect(mockWebSocketInstance.send).toHaveBeenCalledWith(
        expect.stringContaining('"token":"test-token"')
      );
    });

    it('updates state to connected on successful auth', async () => {
      const stateHandler = jest.fn();
      service.onStateChange(stateHandler);

      service.connect(mockServer);
      mockWebSocketInstance.simulateOpen();
      // Auth is delayed by 50ms in handleOpen
      jest.advanceTimersByTime(100);

      // Get the requestId from the sent message
      const sentMessage = JSON.parse(mockWebSocketInstance.send.mock.calls[0][0]);
      mockWebSocketInstance.simulateMessage({
        type: 'authenticate',
        success: true,
        requestId: sentMessage.requestId,
      });

      // Wait for async authenticate() to complete
      await Promise.resolve();

      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'connected' })
      );
    });

    it('updates state to error on auth failure', async () => {
      const stateHandler = jest.fn();
      service.onStateChange(stateHandler);

      service.connect(mockServer);
      mockWebSocketInstance.simulateOpen();
      // Auth is delayed by 50ms in handleOpen
      jest.advanceTimersByTime(100);

      const sentMessage = JSON.parse(mockWebSocketInstance.send.mock.calls[0][0]);
      mockWebSocketInstance.simulateMessage({
        type: 'authenticate',
        success: false,
        error: 'Invalid token',
        requestId: sentMessage.requestId,
      });

      // Wait for async authenticate() to complete
      await Promise.resolve();

      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          error: expect.stringContaining('Authentication failed'),
        })
      );
    });
  });

  describe('disconnect', () => {
    it('closes WebSocket connection', () => {
      service.connect(mockServer);
      service.disconnect();

      expect(mockWebSocketInstance.close).toHaveBeenCalled();
    });

    it('updates state to disconnected', () => {
      const stateHandler = jest.fn();
      service.onStateChange(stateHandler);

      service.connect(mockServer);
      service.disconnect();

      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'disconnected' })
      );
    });
  });

  describe('message handling', () => {
    it('notifies message handlers', () => {
      const messageHandler = jest.fn();
      service.onMessage(messageHandler);

      service.connect(mockServer);
      mockWebSocketInstance.simulateOpen();

      mockWebSocketInstance.simulateMessage({
        type: 'update',
        payload: { test: true },
      });

      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'update',
          payload: { test: true },
        })
      );
    });

    it('allows unsubscribing from messages', () => {
      const messageHandler = jest.fn();
      const unsubscribe = service.onMessage(messageHandler);

      service.connect(mockServer);
      mockWebSocketInstance.simulateOpen();

      unsubscribe();

      mockWebSocketInstance.simulateMessage({ type: 'update' });

      // Should only have been called with the auth response callback handling
      expect(messageHandler).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'update' })
      );
    });
  });

  describe('reconnection', () => {
    it('attempts reconnection on disconnect', () => {
      service.connect(mockServer);
      mockWebSocketInstance.simulateOpen();
      // Auth is delayed by 50ms in handleOpen
      jest.advanceTimersByTime(100);

      const sentMessage = JSON.parse(mockWebSocketInstance.send.mock.calls[0][0]);
      mockWebSocketInstance.simulateMessage({
        success: true,
        requestId: sentMessage.requestId,
      });

      // Simulate disconnect
      mockWebSocketInstance.simulateClose(1006, 'Connection lost');

      // Should be in reconnecting state
      expect(service.getState().status).toBe('reconnecting');
    });

    it('gives up after max attempts', () => {
      const stateHandler = jest.fn();
      service.onStateChange(stateHandler);

      service.connect(mockServer);

      // Simulate multiple failed connections
      for (let i = 0; i <= 3; i++) {
        mockWebSocketInstance.simulateClose(1006, 'Connection failed');
        jest.advanceTimersByTime(20000);
      }

      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' })
      );
    });
  });

  describe('sendRequest', () => {
    it('sends message and resolves on response', async () => {
      service.connect(mockServer);
      mockWebSocketInstance.simulateOpen();
      // Auth is delayed by 50ms in handleOpen
      jest.advanceTimersByTime(100);

      // Complete auth first
      const authMessage = JSON.parse(mockWebSocketInstance.send.mock.calls[0][0]);
      mockWebSocketInstance.simulateMessage({
        success: true,
        requestId: authMessage.requestId,
      });

      const responsePromise = service.sendRequest('get_highlights');

      // Get the request ID from the sent message
      const sentMessage = JSON.parse(
        mockWebSocketInstance.send.mock.calls[mockWebSocketInstance.send.mock.calls.length - 1][0]
      );

      mockWebSocketInstance.simulateMessage({
        type: 'highlights',
        success: true,
        payload: [],
        requestId: sentMessage.requestId,
      });

      const response = await responsePromise;

      expect(response.success).toBe(true);
      expect(response.type).toBe('highlights');
    });

    it('rejects on timeout', async () => {
      service.connect(mockServer);
      mockWebSocketInstance.simulateOpen();
      // Auth is delayed by 50ms in handleOpen
      jest.advanceTimersByTime(100);

      // Complete auth first
      const authMessage = JSON.parse(mockWebSocketInstance.send.mock.calls[0][0]);
      mockWebSocketInstance.simulateMessage({
        success: true,
        requestId: authMessage.requestId,
      });

      const responsePromise = service.sendRequest('get_highlights');

      jest.advanceTimersByTime(15000);

      await expect(responsePromise).rejects.toThrow('Request timeout');
    });
  });

  describe('isConnected', () => {
    it('returns true when connected and WebSocket is open', async () => {
      service.connect(mockServer);
      mockWebSocketInstance.simulateOpen();
      // Auth is delayed by 50ms in handleOpen
      jest.advanceTimersByTime(100);

      const authMessage = JSON.parse(mockWebSocketInstance.send.mock.calls[0][0]);
      mockWebSocketInstance.simulateMessage({
        success: true,
        requestId: authMessage.requestId,
      });

      // Wait for async authenticate() to complete
      await Promise.resolve();

      expect(service.isConnected()).toBe(true);
    });

    it('returns false when disconnected', () => {
      expect(service.isConnected()).toBe(false);
    });
  });
});
