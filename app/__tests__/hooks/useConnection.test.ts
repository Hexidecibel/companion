import { renderHook, act } from '@testing-library/react-native';
import { useConnection } from '../../src/hooks/useConnection';
import { wsService } from '../../src/services/websocket';
import { Server, ConnectionState } from '../../src/types';

// Mock the websocket service
jest.mock('../../src/services/websocket', () => ({
  wsService: {
    getState: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    reconnect: jest.fn(),
    onStateChange: jest.fn(),
  },
}));

// Mock push service
jest.mock('../../src/services/push', () => ({
  registerWithDaemon: jest.fn(),
  getToken: jest.fn(() => null),
}));

// Mock storage service
jest.mock('../../src/services/storage', () => ({
  getSettings: jest.fn(() => Promise.resolve({ pushEnabled: false })),
}));

const mockWsService = wsService as jest.Mocked<typeof wsService>;

describe('useConnection', () => {
  const mockServer: Server = {
    id: 'server-1',
    name: 'Test Server',
    host: 'localhost',
    port: 9877,
    token: 'test-token',
    useTls: false,
  };

  const initialState: ConnectionState = {
    status: 'disconnected',
    reconnectAttempts: 0,
  };

  let stateChangeCallback: ((state: ConnectionState) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    stateChangeCallback = null;

    mockWsService.getState.mockReturnValue(initialState);
    mockWsService.onStateChange.mockImplementation((callback) => {
      stateChangeCallback = callback;
      callback(initialState);
      return () => {
        stateChangeCallback = null;
      };
    });
  });

  it('returns initial disconnected state when no server provided', () => {
    const { result } = renderHook(() => useConnection(null));

    expect(result.current.connectionState.status).toBe('disconnected');
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isConnecting).toBe(false);
    expect(result.current.hasError).toBe(false);
  });

  it('connects when server is provided', () => {
    renderHook(() => useConnection(mockServer));

    expect(mockWsService.connect).toHaveBeenCalledWith(mockServer);
  });

  it('disconnects when server becomes null', () => {
    const { rerender } = renderHook(
      ({ server }) => useConnection(server),
      { initialProps: { server: mockServer as Server | null } }
    );

    rerender({ server: null });

    expect(mockWsService.disconnect).toHaveBeenCalled();
  });

  it('reconnects when server properties change', () => {
    const { rerender } = renderHook(
      ({ server }) => useConnection(server),
      { initialProps: { server: mockServer } }
    );

    const newServer = { ...mockServer, host: 'newhost' };
    rerender({ server: newServer });

    expect(mockWsService.connect).toHaveBeenCalledWith(newServer);
  });

  it('updates state on state change', () => {
    const { result } = renderHook(() => useConnection(mockServer));

    act(() => {
      stateChangeCallback?.({
        status: 'connected',
        reconnectAttempts: 0,
        lastConnected: Date.now(),
      });
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.connectionState.status).toBe('connected');
  });

  it('shows connecting state', () => {
    const { result } = renderHook(() => useConnection(mockServer));

    act(() => {
      stateChangeCallback?.({
        status: 'connecting',
        reconnectAttempts: 0,
      });
    });

    expect(result.current.isConnecting).toBe(true);
    expect(result.current.isConnected).toBe(false);
  });

  it('shows reconnecting state', () => {
    const { result } = renderHook(() => useConnection(mockServer));

    act(() => {
      stateChangeCallback?.({
        status: 'reconnecting',
        reconnectAttempts: 1,
      });
    });

    expect(result.current.isConnecting).toBe(true);
    expect(result.current.reconnectAttempts).toBe(1);
  });

  it('shows error state', () => {
    const { result } = renderHook(() => useConnection(mockServer));

    act(() => {
      stateChangeCallback?.({
        status: 'error',
        error: 'Connection failed',
        reconnectAttempts: 3,
      });
    });

    expect(result.current.hasError).toBe(true);
    expect(result.current.error).toBe('Connection failed');
  });

  it('provides reconnect function', () => {
    const { result } = renderHook(() => useConnection(mockServer));

    act(() => {
      result.current.reconnect();
    });

    expect(mockWsService.reconnect).toHaveBeenCalled();
  });

  it('provides disconnect function', () => {
    const { result } = renderHook(() => useConnection(mockServer));

    act(() => {
      result.current.disconnect();
    });

    expect(mockWsService.disconnect).toHaveBeenCalled();
  });
});
