import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const invoke = vi.fn();
const listen = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));

import { UpdateBanner } from '../UpdateBanner';
import type { AppUpdateStatus } from '../../hooks/useAppUpdater';
import { setNativeEnv } from '../../test/nativeEnv';

function status(over: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
  return {
    currentVersion: '1.0.470',
    state: 'idle',
    version: null,
    notes: null,
    error: null,
    autoInstallOnQuit: true,
    lastCheck: null,
    ...over,
  };
}

let emit: (s: AppUpdateStatus) => void = () => {};

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  listen.mockImplementation(async (_name: string, cb: (e: { payload: AppUpdateStatus }) => void) => {
    emit = (s) => cb({ payload: s });
    return () => {};
  });
});
afterEach(() => setNativeEnv('browser'));

describe('UpdateBanner', () => {
  it('renders nothing in a browser tab', () => {
    setNativeEnv('browser');
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe('');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stays hidden until an update is ready, then installs on click', async () => {
    setNativeEnv('desktop');
    invoke.mockImplementation(async (cmd: string) => (cmd === 'updater_status' ? status() : undefined));
    render(<UpdateBanner />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('updater_status'));
    expect(screen.queryByText(/Restart to update/)).toBeNull();

    act(() => emit(status({ state: 'downloading', version: '1.0.475' })));
    expect(screen.queryByText(/Restart to update/)).toBeNull();

    act(() => emit(status({ state: 'ready', version: '1.0.475' })));
    expect(screen.getByText('Update 1.0.475 available')).toBeTruthy();
    fireEvent.click(screen.getByText('Restart to update'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('updater_install'));
  });

  it('dismiss hides it for that version only', async () => {
    setNativeEnv('desktop');
    invoke.mockResolvedValue(status({ state: 'ready', version: '1.0.475' }));
    render(<UpdateBanner />);
    await screen.findByText('Update 1.0.475 available');
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByText(/available/)).toBeNull();
    act(() => emit(status({ state: 'ready', version: '1.0.480' })));
    expect(screen.getByText('Update 1.0.480 available')).toBeTruthy();
  });
});
