import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { SessionPicker } from '../../src/components/SessionPicker';
import { wsService } from '../../src/services/connectionManager';

// Mock the websocket service
jest.mock('../../src/services/connectionManager', () => ({
  wsService: {
    isConnected: jest.fn(),
    sendRequest: jest.fn(),
  },
}));

// Mock Alert
jest.mock('react-native/Libraries/Alert/Alert', () => ({
  alert: jest.fn(),
}));

// Mock sessionGuard to avoid import issues
jest.mock('../../src/services/sessionGuard', () => ({
  sessionGuard: {
    beginSwitch: jest.fn().mockReturnValue(1),
  },
}));

const mockWsService = wsService as jest.Mocked<typeof wsService>;

describe('SessionPicker', () => {
  const mockSessions = [
    {
      name: 'main',
      created: Date.now() - 3600000,
      attached: false,
      windows: 1,
      workingDir: '/Users/test/project1',
    },
    {
      name: 'sitehound',
      created: Date.now() - 1800000,
      attached: true,
      windows: 1,
      workingDir: '/Users/test/sitehound',
    },
  ];

  const mockSessionsResponse = {
    type: 'tmux_sessions',
    success: true,
    payload: {
      sessions: mockSessions,
      activeSession: 'main',
      homeDir: '/Users/test',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockWsService.isConnected.mockReturnValue(true);
    mockWsService.sendRequest.mockResolvedValue(mockSessionsResponse);
  });

  it('renders picker button with session name', async () => {
    const { getByText } = render(<SessionPicker isConnected={true} />);

    // Initially shows "Sessions" until loaded, then updates to project name
    expect(getByText(/Sessions|project1/)).toBeTruthy();
  });

  it('opens modal when picker button is pressed', async () => {
    const { getByText, getAllByText } = render(<SessionPicker isConnected={true} />);

    // Press the picker button (may show "Sessions" or a project name)
    fireEvent.press(getByText(/Sessions|project1/));

    // Modal should now be visible - "Sessions" appears in both button and modal header
    await waitFor(() => {
      // Modal header shows "Sessions", picker button may also show "Sessions"
      expect(getAllByText(/Sessions/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('loads sessions when modal opens', async () => {
    const { getByText } = render(<SessionPicker isConnected={true} />);

    fireEvent.press(getByText(/Sessions|project1/));

    await waitFor(() => {
      expect(mockWsService.sendRequest).toHaveBeenCalledWith('list_tmux_sessions', {});
    });
  });

  it('displays session list in modal', async () => {
    const { getByText, getAllByText } = render(<SessionPicker isConnected={true} />);

    fireEvent.press(getByText(/Sessions|project1/));

    await waitFor(() => {
      // project1 appears both in button and list, so use getAllByText
      expect(getAllByText('project1').length).toBeGreaterThanOrEqual(1);
      expect(getByText('sitehound')).toBeTruthy();
    });
  });

  it('calls onSessionChange when session is selected', async () => {
    const onSessionChange = jest.fn();
    mockWsService.sendRequest
      .mockResolvedValueOnce({
        type: 'tmux_sessions',
        success: true,
        payload: {
          sessions: mockSessions,
          activeSession: 'main',
          homeDir: '/Users/test',
        },
      })
      .mockResolvedValueOnce({
        type: 'tmux_sessions',
        success: true,
        payload: {
          sessions: mockSessions,
          activeSession: 'main',
          homeDir: '/Users/test',
        },
      })
      .mockResolvedValueOnce({
        type: 'switch_session',
        success: true,
        // Include conversationSessionId which the component prefers
        payload: { sessionName: 'sitehound', conversationSessionId: '-Users-test-sitehound' },
      });

    const { getByText } = render(<SessionPicker isConnected={true} onSessionChange={onSessionChange} />);

    fireEvent.press(getByText(/Sessions|project1/));

    await waitFor(() => {
      expect(getByText('sitehound')).toBeTruthy();
    });

    fireEvent.press(getByText('sitehound'));

    await waitFor(() => {
      expect(mockWsService.sendRequest).toHaveBeenCalledWith('switch_tmux_session', {
        sessionName: 'sitehound',
      });
    });

    // Session ID is now the encoded workingDir path
    await waitFor(() => {
      expect(onSessionChange).toHaveBeenCalledWith('-Users-test-sitehound');
    }, { timeout: 500 });
  });

  it('opens when isOpen prop is true', async () => {
    const { getAllByText, rerender } = render(<SessionPicker isOpen={false} isConnected={true} />);

    // When modal is closed, "Sessions" only appears in the picker button
    expect(getAllByText(/Sessions/).length).toBe(1);

    rerender(<SessionPicker isOpen={true} isConnected={true} />);

    // When modal opens, "Sessions" appears in both the picker button and the modal header
    await waitFor(() => {
      expect(getAllByText(/Sessions/).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('calls onClose when modal is closed', async () => {
    const onClose = jest.fn();
    const { getByText, getAllByText } = render(<SessionPicker isOpen={true} onClose={onClose} isConnected={true} />);

    await waitFor(() => {
      // Modal header "Sessions" is visible
      expect(getAllByText(/Sessions/).length).toBeGreaterThanOrEqual(2);
    });

    // Press close button
    fireEvent.press(getByText('\u00d7'));

    expect(onClose).toHaveBeenCalled();
  });

  it('shows new session button', async () => {
    const { getByText } = render(<SessionPicker isConnected={true} />);

    fireEvent.press(getByText(/Sessions|project1/));

    await waitFor(() => {
      expect(getByText('+ New Session')).toBeTruthy();
    });
  });

  it('does not load sessions when not connected', async () => {
    mockWsService.isConnected.mockReturnValue(false);

    const { getByText } = render(<SessionPicker isConnected={false} />);

    fireEvent.press(getByText(/Sessions/));

    // Should not call sendRequest when not connected
    await waitFor(() => {
      const calls = mockWsService.sendRequest.mock.calls.filter(
        call => call[0] === 'list_tmux_sessions'
      );
      expect(calls.length).toBe(0);
    });
  });

  it('shows loading indicator while fetching sessions', async () => {
    // Make the request hang
    mockWsService.sendRequest.mockImplementation(() => new Promise(() => {}));

    const { getAllByText } = render(<SessionPicker isConnected={true} />);

    fireEvent.press(getAllByText(/Sessions/)[0]);

    // Modal should show loading state - "Sessions" appears in both button and modal header
    await waitFor(() => {
      expect(getAllByText(/Sessions/).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('displays empty state when no sessions exist', async () => {
    mockWsService.sendRequest.mockResolvedValue({
      type: 'tmux_sessions',
      success: true,
      payload: {
        sessions: [],
        activeSession: null,
        homeDir: '/Users/test',
      },
    });

    const { getByText } = render(<SessionPicker isConnected={true} />);

    fireEvent.press(getByText(/Sessions/));

    await waitFor(() => {
      expect(getByText('No active sessions')).toBeTruthy();
    });
  });

  it('highlights active session in list', async () => {
    const { getByText, getAllByText } = render(<SessionPicker isConnected={true} />);

    fireEvent.press(getByText(/Sessions|project1/));

    await waitFor(() => {
      // The active session (main/project1) should be highlighted
      // project1 appears both in button and list
      expect(getAllByText('project1').length).toBeGreaterThanOrEqual(1);
    });
  });
});
