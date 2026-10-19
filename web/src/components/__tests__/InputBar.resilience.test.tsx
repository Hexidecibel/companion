import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { InputBar, type InputSendResult } from '../InputBar';

function deferred() {
  let resolve!: (v: InputSendResult) => void;
  const promise = new Promise<InputSendResult>((r) => { resolve = r; });
  return { promise, resolve };
}

function type(text: string) {
  const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: text } });
  return ta;
}

describe('InputBar on a flaky connection', () => {
  it('never disables typing while a send is in flight', async () => {
    const d = deferred();
    const onSend = vi.fn(() => d.promise);
    render(<InputBar onSend={onSend} />);
    const ta = type('hello');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(ta.disabled).toBe(false);
    type('next message');
    expect(ta.value).toBe('next message');
    await act(async () => { d.resolve(true); });
    expect(ta.value).toBe('next message');
  });

  it('a timeout keeps the text in a "may not have sent" notice, not in the box', async () => {
    const d = deferred();
    const onSend = vi.fn().mockReturnValueOnce(d.promise).mockResolvedValueOnce(true);
    render(<InputBar onSend={onSend} />);
    const ta = type('deploy it');
    fireEvent.keyDown(ta, { key: 'Enter' });
    await act(async () => { d.resolve('uncertain'); });
    expect(ta.value).toBe('');
    expect(screen.getByText('May not have sent:')).toBeInTheDocument();
    expect(screen.getByText('deploy it')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByText('Retry')); });
    expect(onSend).toHaveBeenLastCalledWith('deploy it');
    expect(screen.queryByText('May not have sent:')).toBeNull();
  });

  it('Discard drops the notice', async () => {
    render(<InputBar onSend={() => Promise.resolve('uncertain')} />);
    const ta = type('x');
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }); });
    fireEvent.click(screen.getByText('Discard'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a plain failure restores the text when the box is still empty', async () => {
    render(<InputBar onSend={() => Promise.resolve(false)} />);
    const ta = type('retry me');
    await act(async () => { fireEvent.keyDown(ta, { key: 'Enter' }); });
    expect(ta.value).toBe('retry me');
  });

  it('a failure does not overwrite what was typed meanwhile', async () => {
    const d = deferred();
    render(<InputBar onSend={() => d.promise} />);
    const ta = type('first');
    fireEvent.keyDown(ta, { key: 'Enter' });
    type('second');
    await act(async () => { d.resolve(false); });
    expect(ta.value).toBe('second');
    expect(screen.getByText('Not sent:')).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
  });

  it('offline: says so but stays usable', () => {
    render(<InputBar onSend={() => Promise.resolve(true)} offline />);
    expect(screen.getByText('Offline — will reconnect')).toBeInTheDocument();
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
  });
});
