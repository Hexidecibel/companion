import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { ConversationItem } from '../../src/components/ConversationItem';
import { ConversationMessage, ConversationHighlight } from '../../src/types';

// Mock @ronradtke/react-native-markdown-display
jest.mock('@ronradtke/react-native-markdown-display', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children: string }) => <Text>{children}</Text>,
  };
});

describe('ConversationItem', () => {
  const mockUserMessage: ConversationMessage = {
    id: 'msg-1',
    type: 'user',
    content: 'Hello there!',
    timestamp: Date.now(),
  };

  const mockAssistantMessage: ConversationMessage = {
    id: 'msg-2',
    type: 'assistant',
    content: 'Hello! How can I help you today?',
    timestamp: Date.now(),
  };

  it('renders user message correctly', () => {
    const { getByText } = render(<ConversationItem item={mockUserMessage} />);

    expect(getByText('You')).toBeTruthy();
    expect(getByText('Hello there!')).toBeTruthy();
  });

  it('renders assistant message correctly', () => {
    const { getByText } = render(<ConversationItem item={mockAssistantMessage} />);

    expect(getByText('Assistant')).toBeTruthy();
    expect(getByText('Hello! How can I help you today?')).toBeTruthy();
  });

  it('displays formatted time', () => {
    const timestamp = new Date('2024-01-15T14:30:00').getTime();
    const message: ConversationMessage = {
      ...mockUserMessage,
      timestamp,
    };

    const { getByText } = render(<ConversationItem item={message} />);

    // Should show time in HH:MM format
    expect(getByText(/\d{1,2}:\d{2}/)).toBeTruthy();
  });

  it('renders options when present', () => {
    const messageWithOptions: ConversationMessage = {
      ...mockAssistantMessage,
      options: [
        { label: 'Option A', description: 'First option' },
        { label: 'Option B', description: 'Second option' },
      ],
      isWaitingForChoice: true,
    };

    const { getByText } = render(<ConversationItem item={messageWithOptions} />);

    expect(getByText('Option A')).toBeTruthy();
    expect(getByText('First option')).toBeTruthy();
    expect(getByText('Option B')).toBeTruthy();
    expect(getByText('Second option')).toBeTruthy();
  });

  it('calls onSelectOption when option is pressed', () => {
    const onSelectOption = jest.fn();
    const messageWithOptions: ConversationMessage = {
      ...mockAssistantMessage,
      options: [{ label: 'Yes', description: 'Confirm action' }],
      isWaitingForChoice: true,
    };

    const { getByText } = render(
      <ConversationItem item={messageWithOptions} onSelectOption={onSelectOption} />
    );

    fireEvent.press(getByText('Yes'));

    expect(onSelectOption).toHaveBeenCalledWith('Yes');
  });

  it('renders tool calls when showToolCalls is true', () => {
    const messageWithTools: ConversationMessage = {
      ...mockAssistantMessage,
      toolCalls: [
        { id: 't1', name: 'Read', input: { file_path: '/test.ts' }, status: 'completed' },
      ],
    };

    const { getByText } = render(
      <ConversationItem item={messageWithTools} showToolCalls={true} />
    );

    expect(getByText('Read')).toBeTruthy();
  });

  it('does not render tool calls when showToolCalls is false', () => {
    const messageWithTools: ConversationMessage = {
      ...mockAssistantMessage,
      toolCalls: [
        { id: 't1', name: 'Read', input: { file_path: '/test.ts' }, status: 'completed' },
      ],
    };

    const { queryByText } = render(
      <ConversationItem item={messageWithTools} showToolCalls={false} />
    );

    expect(queryByText('Read')).toBeNull();
  });

  it('renders highlight message without tool calls', () => {
    const highlight: ConversationHighlight = {
      id: 'hl-1',
      type: 'assistant',
      content: 'Highlight content',
      timestamp: Date.now(),
    };

    const { getByText } = render(<ConversationItem item={highlight} />);

    expect(getByText('Highlight content')).toBeTruthy();
  });

  it('renders tool output when present', () => {
    const messageWithToolOutput: ConversationMessage = {
      ...mockAssistantMessage,
      toolCalls: [
        {
          id: 't1',
          name: 'Bash',
          input: { command: 'echo hello' },
          output: 'hello',
          status: 'completed',
        },
      ],
    };

    const { getByText } = render(
      <ConversationItem item={messageWithToolOutput} showToolCalls={true} />
    );

    expect(getByText('hello')).toBeTruthy();
  });
});
