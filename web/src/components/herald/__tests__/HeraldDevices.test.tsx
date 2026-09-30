import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HeraldDeviceBar, HeraldDevicesMenu, showDeviceBar } from '../HeraldDevices';
import type { HeraldDeviceControl } from '../../../context/HeraldContext';

function control(over: Partial<HeraldDeviceControl> = {}): HeraldDeviceControl {
  return {
    supported: true,
    selfId: 'me',
    label: 'Chrome on Windows',
    activeDevice: { id: 'mac', label: 'Work Mac', pinned: true, reason: 'claimed' },
    devices: [
      { id: 'me', label: 'Chrome on Windows', handsFree: false },
      { id: 'mac', label: 'Work Mac', handsFree: true },
    ],
    isActive: false,
    controlledElsewhere: true,
    keepPinned: false,
    setKeepPinned: vi.fn(),
    takeControl: vi.fn(),
    switchTo: vi.fn(),
    rename: vi.fn(),
    handoffNote: null,
    ...over,
  };
}

describe('HeraldDeviceBar', () => {
  it('shows who is active and offers Take control when it is another device', () => {
    const d = control();
    render(<HeraldDeviceBar device={d} />);
    expect(screen.getByRole('status').textContent).toContain('Active: Work Mac');
    expect(screen.getByRole('status').textContent).toContain('pinned');
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    expect(d.takeControl).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: /Keep on this device/ }));
    expect(d.setKeepPinned).toHaveBeenCalledWith(true);
  });

  it('this device active: no Take control; the hand-off note replaces the line after losing it', () => {
    const here = control({
      isActive: true,
      controlledElsewhere: false,
      activeDevice: { id: 'me', label: 'Chrome on Windows', pinned: false, reason: 'recent' },
    });
    const { unmount } = render(<HeraldDeviceBar device={here} />);
    expect(screen.getByRole('status').textContent).toContain('Active: This device');
    expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
    unmount();
    render(<HeraldDeviceBar device={control({ handoffNote: 'Now on Work Mac' })} />);
    expect(screen.getByRole('status').textContent).toBe('Now on Work Mac' + 'Keep on this device' + 'Take control');
  });

  it('stays out of the way with a single unpinned device, or on older hubs', () => {
    const single = control({
      isActive: true,
      devices: [{ id: 'me', label: 'Chrome on Windows', handsFree: false }],
      activeDevice: { id: 'me', label: 'Chrome on Windows', pinned: false, reason: 'recent' },
    });
    expect(showDeviceBar(single)).toBe(false);
    expect(showDeviceBar(control({ supported: false }))).toBe(false);
    expect(showDeviceBar(control({ selfId: null }))).toBe(false);
  });
});

describe('HeraldDevicesMenu', () => {
  it('lists devices, switches to one, and renames this device', () => {
    const d = control();
    const onDone = vi.fn();
    render(<HeraldDevicesMenu device={d} onDone={onDone} />);
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(items[1].textContent).toContain('hands-free');
    fireEvent.click(items[0]);
    expect(d.switchTo).toHaveBeenCalledWith('me');
    expect(onDone).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: /Rename this device/ }));
    const input = screen.getByRole('textbox', { name: 'Name for this device' });
    fireEvent.change(input, { target: { value: 'Windows PC' } });
    fireEvent.submit(input.closest('form')!);
    expect(d.rename).toHaveBeenCalledWith('Windows PC');
  });
});
