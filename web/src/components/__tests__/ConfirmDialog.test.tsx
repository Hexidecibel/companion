import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ConfirmDialog } from '../ConfirmDialog';

function setup(over: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<ConfirmDialog title="Remove it?" message="Sure?" confirmLabel="Remove" busyLabel="Removing..." danger onConfirm={onConfirm} onClose={onClose} {...over} />);
  return { onConfirm, onClose };
}

describe('ConfirmDialog', () => {
  afterEach(cleanup);

  it('shows the text as an alert dialog with the focus on Cancel and danger styling', () => {
    setup();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('Remove it?')).toBeTruthy();
    expect(screen.getByText('Sure?')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Remove' }).className).toContain('confirm-dialog-btn-danger');
  });

  it('Esc cancels without reaching other listeners; Cancel and the backdrop cancel too', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    const { onClose, onConfirm } = setup();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(document.querySelector('.confirm-dialog-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('alertdialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Tab stays inside the dialog', () => {
    setup();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const remove = screen.getByRole('button', { name: 'Remove' });
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(remove);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(remove);
  });

  it('confirm closes once the action resolves, and nothing cancels while it runs', async () => {
    let done: () => void = () => undefined;
    const { onClose } = setup({ onConfirm: () => new Promise<void>((r) => { done = r; }) });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Removing...' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(document.querySelector('.confirm-dialog-overlay')!);
    expect(onClose).not.toHaveBeenCalled();
    done();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('a failed action stays open, shows the error and can be retried', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(undefined);
    const { onClose } = setup({ onConfirm });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('nope'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('clicks do not bubble through the portal to the row that opened it', () => {
    const row = vi.fn();
    const onClose = vi.fn();
    render(
      <div onClick={row} onContextMenu={row} onTouchStart={row}>
        <ConfirmDialog title="T" confirmLabel="OK" onConfirm={vi.fn()} onClose={onClose} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.contextMenu(screen.getByRole('alertdialog'));
    fireEvent.touchStart(screen.getByRole('alertdialog'));
    expect(row).not.toHaveBeenCalled();
  });
});
