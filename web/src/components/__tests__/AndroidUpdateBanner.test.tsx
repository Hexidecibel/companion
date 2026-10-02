import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import { AndroidUpdateBanner } from '../AndroidUpdateBanner';
import { setNativeEnv } from '../../test/nativeEnv';

const FEED = {
  versionCode: 1000505,
  versionName: '1.0.505',
  url: 'https://dev.cush.rocks/updates/stable/Companion_1.0.505_android-1000505.apk',
  sha256: 'ab'.repeat(32),
};

function native(installedCode: number, install?: () => unknown) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'plugin:herald-native|app_update_info')
      return { packageName: 'com.hexidecibel.companion', versionCode: installedCode, versionName: '1.0.500', canInstall: false };
    if (cmd === 'plugin:herald-native|app_update_fetch_feed') return { body: JSON.stringify(FEED) };
    if (cmd === 'plugin:herald-native|app_update_install') return install ? install() : { state: 'installer_opened' };
    return null;
  });
}

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
});
afterEach(() => setNativeEnv('browser'));

describe('AndroidUpdateBanner', () => {
  it('renders nothing outside the Android app', () => {
    setNativeEnv('desktop');
    native(1);
    const { container } = render(<AndroidUpdateBanner />);
    expect(container.textContent).toBe('');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('stays hidden when the installed build is current', async () => {
    setNativeEnv('android');
    native(1000505);
    const { container } = render(<AndroidUpdateBanner />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:herald-native|app_update_fetch_feed', expect.anything()));
    expect(container.textContent).toBe('');
  });

  it('offers a newer build; tap downloads with the feed hash and versionCode', async () => {
    setNativeEnv('android');
    native(1000500);
    render(<AndroidUpdateBanner />);
    await screen.findByText('Update available (1.0.505)');
    fireEvent.click(screen.getByText('Update'));
    await screen.findByText('Confirm the update in the installer.');
    expect(invoke).toHaveBeenCalledWith(
      'plugin:herald-native|app_update_install',
      expect.objectContaining({ url: FEED.url, sha256: FEED.sha256, versionCode: FEED.versionCode }),
    );
  });

  it('explains and deep-links when "Install unknown apps" is off', async () => {
    setNativeEnv('android');
    native(1000500, () => {
      throw new Error('install_permission: Install unknown apps is not allowed for Companion');
    });
    render(<AndroidUpdateBanner />);
    fireEvent.click(await screen.findByText('Update'));
    await screen.findByText('Allow Companion to install apps, then tap Install.');
    fireEvent.click(screen.getByText('Open settings'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:herald-native|app_update_open_settings'));
  });

  it('shows a verification failure and never claims success', async () => {
    setNativeEnv('android');
    native(1000500, () => {
      throw new Error('verify_failed: signed with a different certificate');
    });
    render(<AndroidUpdateBanner />);
    fireEvent.click(await screen.findByText('Update'));
    await screen.findByText('Update failed: signed with a different certificate');
  });

  it('dismiss hides it for that build', async () => {
    setNativeEnv('android');
    native(1000500);
    const { container } = render(<AndroidUpdateBanner />);
    await screen.findByText('Update available (1.0.505)');
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(container.textContent).toBe('');
    expect(localStorage.getItem('android_update_dismissed')).toBe('1000505');
  });
});
