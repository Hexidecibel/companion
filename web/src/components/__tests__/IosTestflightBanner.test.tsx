import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { IosTestflightBanner } from '../IosTestflightBanner';
import { setNativeEnv } from '../../test/nativeEnv';

const FEED = { build: 80, versionName: '1.0.812', publishedAt: '2026-10-18T12:00:00Z', testflightUrl: 'itms-beta://' };

function native(installedBuild: number, opts: { feed?: unknown; openFails?: boolean } = {}) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'plugin:herald-native|app_update_info')
      return { packageName: 'com.hexidecibel.companion', versionCode: installedBuild, versionName: '1.0.0', canInstall: false };
    if (cmd === 'plugin:herald-native|app_update_fetch_feed') return { body: JSON.stringify(opts.feed ?? FEED) };
    if (cmd === 'plugin:opener|open_url' && opts.openFails) throw new Error('not allowed');
    return null;
  });
}

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
});
afterEach(() => setNativeEnv('browser'));

describe('IosTestflightBanner', () => {
  it.each(['browser', 'desktop', 'android'] as const)('renders nothing and never checks on %s', async (env) => {
    setNativeEnv(env);
    native(1);
    const { container } = render(<IosTestflightBanner />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
    expect(invoke).not.toHaveBeenCalledWith('plugin:herald-native|app_update_fetch_feed', expect.anything());
  });

  it('stays hidden when the installed build is current', async () => {
    setNativeEnv('ios');
    native(80);
    const { container } = render(<IosTestflightBanner />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('plugin:herald-native|app_update_fetch_feed', {
        url: 'https://dev.cush.rocks/updates/stable/ios.json',
      })
    );
    expect(container.textContent).toBe('');
  });

  it('shows a newer build on iPad and opens TestFlight', async () => {
    setNativeEnv('ipad');
    native(24);
    render(<IosTestflightBanner />);
    await screen.findByText('Build 80 is on TestFlight');
    fireEvent.click(screen.getByText('Open TestFlight'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', { url: 'itms-beta://' }));
  });

  it("falls back to TestFlight's App Store page when the scheme cannot open", async () => {
    setNativeEnv('ios');
    native(24, { openFails: true });
    render(<IosTestflightBanner />);
    fireEvent.click(await screen.findByText('Open TestFlight'));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
    expect(invoke).toHaveBeenLastCalledWith('plugin:opener|open_url', {
      url: 'https://apps.apple.com/app/testflight/id899247664',
    });
  });

  it('dismissal holds for that build, a newer one shows again', async () => {
    setNativeEnv('ios');
    native(24);
    const first = render(<IosTestflightBanner />);
    fireEvent.click(await screen.findByLabelText('Dismiss'));
    expect(first.container.textContent).toBe('');
    expect(localStorage.getItem('ios_testflight_dismissed')).toBe('80');
    first.unmount();

    native(24);
    const again = render(<IosTestflightBanner />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:herald-native|app_update_fetch_feed', expect.anything()));
    await new Promise((r) => setTimeout(r, 10));
    expect(again.container.textContent).toBe('');
    again.unmount();

    native(24, { feed: { ...FEED, build: 81 } });
    render(<IosTestflightBanner />);
    await screen.findByText('Build 81 is on TestFlight');
  });

  it('ignores a malformed feed or an unknown installed build', async () => {
    setNativeEnv('ios');
    native(0);
    const { container } = render(<IosTestflightBanner />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:herald-native|app_update_fetch_feed', expect.anything()));
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });
});
