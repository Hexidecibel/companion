import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { PromptDialog } from '../PromptDialog';

function setup(over: Partial<React.ComponentProps<typeof PromptDialog>> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(<PromptDialog title="Rename" label="Name" initialValue="old name" submitLabel="Save" busyLabel="Saving..." onSubmit={onSubmit} onClose={onClose} {...over} />);
  return { onSubmit, onClose, input: screen.getByLabelText('Name') as HTMLInputElement };
}

describe('PromptDialog', () => {
  afterEach(cleanup);

  it('focuses the field with the current text selected', () => {
    const { input } = setup();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('old name');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
  });

  it('submitting the form (Enter) passes the typed value and closes', async () => {
    const { input, onSubmit, onClose } = setup();
    fireEvent.change(input, { target: { value: 'new name' } });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalledWith('new name');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Esc cancels without reaching other listeners; Cancel and the backdrop cancel too', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    const { onClose, onSubmit, input } = setup();
    fireEvent.keyDown(input, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(document.querySelector('.confirm-dialog-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Tab stays inside the dialog', () => {
    const { input } = setup();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);
  });

  it('a failed submit stays open, shows the error and can be retried; Esc is ignored while busy', async () => {
    let reject!: (e: Error) => void;
    const onSubmit = vi.fn(() => new Promise<void>((_, r) => { reject = r; }));
    const { input, onClose } = setup({ onSubmit });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving...' })).toBeTruthy());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    reject(new Error('nope'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('nope'));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a click inside does not reach the row it was opened from', () => {
    const row = vi.fn();
    render(<div onClick={row}><PromptDialog title="T" label="L" submitLabel="S" onSubmit={vi.fn()} onClose={vi.fn()} /></div>);
    fireEvent.click(screen.getByLabelText('L'));
    fireEvent.click(document.querySelector('.confirm-dialog-overlay')!);
    expect(row).not.toHaveBeenCalled();
  });
});
