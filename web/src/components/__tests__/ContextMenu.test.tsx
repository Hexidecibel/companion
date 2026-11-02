import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ContextMenu } from '../ContextMenu';

describe('ContextMenu', () => {
  afterEach(cleanup);

  function setup() {
    const onClick = vi.fn();
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="pane" style={{ overflow: 'auto' }} />
        <ContextMenu items={[{ label: 'Remove Session', onClick }]} position={{ x: 1, y: 1 }} onClose={onClose} />
      </div>,
    );
    return { onClick, onClose };
  }

  it('stays open when a live pane auto-scrolls, so the click still lands', () => {
    const { onClick, onClose } = setup();
    fireEvent.scroll(screen.getByTestId('pane'));
    fireEvent.scroll(window);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Session' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the user scrolls elsewhere, not when scrolling the menu', () => {
    const { onClose } = setup();
    fireEvent.wheel(screen.getByRole('button', { name: 'Remove Session' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.wheel(screen.getByTestId('pane'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.touchMove(screen.getByTestId('pane'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closes on an outside press and on Esc', () => {
    const { onClose } = setup();
    fireEvent.mouseDown(screen.getByTestId('pane'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
