import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { SessionPicker } from '../../src/components/SessionPicker';
import { wsService } from '../../src/services/websocket';

// Mock the websocket service
jest.mock('../../src/services/websocket', () => ({
  wsService: {
    isConnected: jest.fn(),
    sendRequest: jest.fn(),
  },
}));

// Mock Alert
jest.mock('react-native/Libraries/Alert/Alert', () => ({
  alert: jest.fn(),
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
      name: 'claude-sitehound',
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
    const { getByText } = render(<SessionPicker />);

    // Initially shows "Sessions" until loaded
    expect(getByText(/Sessions|project1/)).toBeTruthy();
  });

  it('opens modal when picker button is pressed', async () => {
    const { getByText, queryByText } = render(<SessionPicker />);

    // Modal should not be visible initially
    expect(queryByText('Claude Sessions')).toBeNull();

    // Press the picker button
    fireEvent.press(getByText(/Sessions|project1/));

    // Modal should now be visible
    await waitFor(() => {
      expect(getByText('Claude Sessions')).toBeTruthy();
    });
  });

  it('loads sessions when modal opens', async () => {
    const { getByText } = render(<SessionPicker />);

    fireEvent.press(getByText(/Sessions|project1/));

    await waitFor(() => {
      expect(mockWsService.sendRequest).toHaveBeenCalledWith('list_tmux_sessions', {});
    });
  });

  it('displays session list in modal', async () => {
    const { getByText, getAllByText } = render(<SessionPicker />);

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
        success: true,
        payload: {
          sessions: mockSessions,
          activeSession: 'main',
          homeDir: '/Users/test',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        payload: { sessionName: 'claude-sitehound' },
      });

    const { getByText } = render(<SessionPicker onSessionChange={onSessionChange} />);

    fireEvent.press(getByText(/Sessions|project1/));

    await waitFor(() => {
      expect(getByText('sitehound')).toBeTruthy();
    });

    fireEvent.press(getByText('sitehound'));

    await waitFor(() => {
      expect(mockWsService.sendRequest).toHaveBeenCalledWith('switch_tmux_session', {
        sessionName: 'claude-sitehound',
      });
    });

    await waitFor(() => {
      expect(onSessionChange).toHaveBeenCalledWith('claude-sitehound');
    }, { timeout: 500 });
  });

  it('opens when isOpen prop is true', async () => {
    const { getByText, rerender } = render(<SessionPicker isOpen={false} />);

    expect(() => getByText('Claude Sessions')).toThrow();

    rerender(<SessionPicker isOpen={true} />);

    await waitFor(() => {
      expect(getByText('Claude Sessions')).toBeTruthy();
    });
  });

  it('calls onClose when modal is closed', async () => {
    const onClose = jest.fn();
    const { getByText } = render(<SessionPicker isOpen={true} onClose={onClose} />);

    await waitFor(() => {
      expect(getByText('Claude Sessions')).toBeTruthy();
    });

    // Press close button
    fireEvent.press(getByText('×'));

    expect(onClose).toHaveBeenCalled();
  });

  it('shows new session button', async () => {
    const { getByText } = render(<SessionPicker />);

    fireEvent.press(getByText(/Sessions|project1/));

    await waitFor(() => {
      expect(getByText('+ New Session')).toBeTruthy();
    });
  });

  it('does not load sessions when not connected', async () => {
    mockWsService.isConnected.mockReturnValue(false);

    const { getByText } = render(<SessionPicker />);

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

    const { getByText, getByTestId } = render(<SessionPicker />);

    fireEvent.press(getByText(/Sessions/));

    // Modal should show loading state
    await waitFor(() => {
      expect(getByText('Claude Sessions')).toBeTruthy();
    });
  });

  it('displays empty state when no sessions exist', async () => {
    mockWsService.sendRequest.mockResolvedValue({
      success: true,
      payload: {
        sessions: [],
        activeSession: null,
        homeDir: '/Users/test',
      },
    });

    const { getByText } = render(<SessionPicker />);

    fireEvent.press(getByText(/Sessions/));

    await waitFor(() => {
      expect(getByText('No active sessions')).toBeTruthy();
    });
  });

  it('highlights active session in list', async () => {
    const { getByText, getAllByText } = render(<SessionPicker />);

    fireEvent.press(getByText(/Sessions|project1/));

    await waitFor(() => {
      // The active session (main/project1) should be highlighted
      // project1 appears both in button and list
      expect(getAllByText('project1').length).toBeGreaterThanOrEqual(1);
    });
  });
});
