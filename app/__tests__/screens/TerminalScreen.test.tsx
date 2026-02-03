import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { TerminalScreen } from '../../src/screens/TerminalScreen';

// Mock expo modules
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(),
}));

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: { children: React.ReactNode }) => {
    const { View } = require('react-native');
    return <View {...props}>{children}</View>;
  },
}));

// Mock websocket service
const mockSendRequest = jest.fn().mockResolvedValue({
  success: true,
  payload: { output: 'test terminal output\n$ ' },
});

jest.mock('../../src/services/websocket', () => ({
  wsService: {
    sendRequest: (...args: unknown[]) => mockSendRequest(...args),
  },
}));

// Mock ANSI parser
jest.mock('../../src/utils/ansiParser', () => ({
  parseAnsiText: (text: string) =>
    text.split('\n').map((line: string) => [{ text: line, color: null, bgColor: null, bold: false, dim: false, underline: false, inverse: false }]),
}));

describe('TerminalScreen', () => {
  const defaultProps = {
    sessionName: 'claude',
    serverHost: 'example.com',
    sshUser: 'user',
    onBack: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockSendRequest.mockResolvedValue({
      success: true,
      payload: { output: 'test terminal output\n$ ' },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders terminal with interactive toggle button', async () => {
    const { getByText } = render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    expect(getByText('Keys')).toBeTruthy();
  });

  it('does not show key bar when interactive mode is off', async () => {
    const { queryByText } = render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    // Virtual keys should not be visible
    expect(queryByText('Esc')).toBeNull();
    expect(queryByText('C-c')).toBeNull();
  });

  it('shows virtual key bar when interactive mode is toggled on', async () => {
    const { getByText } = render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    // Toggle interactive mode on
    fireEvent.press(getByText('Keys'));

    // Virtual keys should be visible
    expect(getByText('Esc')).toBeTruthy();
    expect(getByText('Tab')).toBeTruthy();
    expect(getByText('C-c')).toBeTruthy();
    expect(getByText('C-d')).toBeTruthy();
    expect(getByText('C-z')).toBeTruthy();
    expect(getByText('C-l')).toBeTruthy();
  });

  it('hides virtual key bar when interactive mode is toggled off', async () => {
    const { getByText, queryByText } = render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    // Toggle on
    fireEvent.press(getByText('Keys'));
    expect(getByText('Esc')).toBeTruthy();

    // Toggle off
    fireEvent.press(getByText('Keys'));
    expect(queryByText('Esc')).toBeNull();
  });

  it('sends terminal keys when virtual key is pressed', async () => {
    const { getByText } = render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    // Toggle interactive on
    fireEvent.press(getByText('Keys'));

    // Press C-c virtual key
    fireEvent.press(getByText('C-c'));

    // Wait for debounce (50ms)
    await act(async () => {
      jest.advanceTimersByTime(50);
    });

    expect(mockSendRequest).toHaveBeenCalledWith('send_terminal_keys', {
      sessionName: 'claude',
      keys: ['C-c'],
    });
  });

  it('sends arrow keys via virtual key bar', async () => {
    const { getByText } = render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    fireEvent.press(getByText('Keys'));

    // Press up arrow
    fireEvent.press(getByText('\u2191'));

    await act(async () => {
      jest.advanceTimersByTime(50);
    });

    expect(mockSendRequest).toHaveBeenCalledWith('send_terminal_keys', {
      sessionName: 'claude',
      keys: ['Up'],
    });
  });

  it('batches rapid key presses within debounce window', async () => {
    const { getByText } = render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    fireEvent.press(getByText('Keys'));

    // Press multiple keys rapidly (within 50ms debounce)
    fireEvent.press(getByText('C-c'));
    fireEvent.press(getByText('C-d'));

    // Wait for debounce
    await act(async () => {
      jest.advanceTimersByTime(50);
    });

    // Should be sent as a single batch
    expect(mockSendRequest).toHaveBeenCalledWith('send_terminal_keys', {
      sessionName: 'claude',
      keys: ['C-c', 'C-d'],
    });
  });

  it('polls at normal interval (2000ms) when not interactive', async () => {
    render(<TerminalScreen {...defaultProps} />);

    // Clear initial fetch call
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    mockSendRequest.mockClear();

    // Advance by 2000ms - should trigger one poll
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });

    const terminalFetches = mockSendRequest.mock.calls.filter(
      (call) => call[0] === 'get_terminal_output'
    );
    expect(terminalFetches.length).toBe(1);
  });

  it('polls at faster interval (500ms) when interactive', async () => {
    const { getByText } = render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    // Toggle interactive on
    fireEvent.press(getByText('Keys'));

    mockSendRequest.mockClear();

    // Advance by 1000ms - should trigger two polls at 500ms interval
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const terminalFetches = mockSendRequest.mock.calls.filter(
      (call) => call[0] === 'get_terminal_output'
    );
    expect(terminalFetches.length).toBe(2);
  });

  it('enables auto-refresh when entering interactive mode', async () => {
    const { getByText } = render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    // Turn off auto-refresh
    fireEvent.press(getByText('Auto'));

    mockSendRequest.mockClear();

    // Advance time - should not poll since auto-refresh is off
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    const fetchesBefore = mockSendRequest.mock.calls.filter(
      (call) => call[0] === 'get_terminal_output'
    );
    expect(fetchesBefore.length).toBe(0);

    // Toggle interactive on - should re-enable polling
    fireEvent.press(getByText('Keys'));
    mockSendRequest.mockClear();

    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    const fetchesAfter = mockSendRequest.mock.calls.filter(
      (call) => call[0] === 'get_terminal_output'
    );
    expect(fetchesAfter.length).toBe(1);
  });

  it('displays all expected virtual keys', async () => {
    const { getByText } = render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    fireEvent.press(getByText('Keys'));

    // Navigation keys
    expect(getByText('Esc')).toBeTruthy();
    expect(getByText('Tab')).toBeTruthy();
    expect(getByText('\u2191')).toBeTruthy(); // Up
    expect(getByText('\u2193')).toBeTruthy(); // Down
    expect(getByText('\u2190')).toBeTruthy(); // Left
    expect(getByText('\u2192')).toBeTruthy(); // Right

    // Ctrl combos
    expect(getByText('C-c')).toBeTruthy();
    expect(getByText('C-d')).toBeTruthy();
    expect(getByText('C-z')).toBeTruthy();
    expect(getByText('C-l')).toBeTruthy();
    expect(getByText('C-a')).toBeTruthy();
    expect(getByText('C-e')).toBeTruthy();
    expect(getByText('C-r')).toBeTruthy();
    expect(getByText('C-u')).toBeTruthy();
    expect(getByText('C-k')).toBeTruthy();
    expect(getByText('C-w')).toBeTruthy();
  });

  it('fetches terminal output on mount', async () => {
    render(<TerminalScreen {...defaultProps} />);

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    expect(mockSendRequest).toHaveBeenCalledWith('get_terminal_output', {
      sessionName: 'claude',
      lines: 150,
    });
  });
});
