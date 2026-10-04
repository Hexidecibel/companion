import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  addPluginListener: vi.fn(async () => ({ unregister: async () => {} })),
}));

const servers: any[] = [];
const addServer = vi.fn();
const updateServer = vi.fn();
vi.mock('../../hooks/useServers', () => ({
  useServers: () => ({
    servers,
    addServer,
    updateServer,
    getServer: (id: string) => servers.find((s) => s.id === id),
  }),
}));

// A fake ConnectionManager with one connected server.
type Handler = (m: any) => void;
const handlers = new Set<Handler>();
const changeHandlers = new Set<() => void>();
const sendRequest = vi.fn();
const fakeConn = {
  authKind: 'legacy' as 'legacy' | 'device' | null,
  getServer: () => ({ id: 's1', name: 'Box', host: '10.0.0.2', port: 9877, token: 't', useTls: false }),
  onMessage: (h: Handler) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  sendRequest: (...a: unknown[]) => sendRequest(...a),
};
vi.mock('../../services/ConnectionManager', () => ({
  connectionManager: {
    getSnapshots: () => [{ serverId: 's1', serverName: 'Box', state: { status: 'connected', reconnectAttempts: 0 } }],
    getConnection: (id: string) => (id === 's1' ? fakeConn : undefined),
    onChange: (h: () => void) => {
      changeHandlers.add(h);
      return () => changeHandlers.delete(h);
    },
  },
}));

import { AddServerFlow } from '../AddServerFlow';
import { PairApprovalPrompt } from '../PairingHost';
import { DevicesCard } from '../DevicesSettings';
import { FakeDaemonSocket } from '../../test/fakePairingDaemon';
import { setNativeEnv } from '../../test/nativeEnv';

const pending = (over: Partial<Record<string, unknown>> = {}) => ({
  pairingId: 'p1',
  deviceName: "Chris's iPad",
  platform: 'ios',
  code: '123456',
  addr: '192.168.1.40',
  network: 'lan',
  createdAt: Date.now(),
  expiresAt: Date.now() + 120_000,
  ...over,
});

beforeEach(() => {
  invoke.mockReset();
  sendRequest.mockReset();
  addServer.mockReset();
  updateServer.mockReset();
  handlers.clear();
  servers.length = 0;
  FakeDaemonSocket.reset();
  vi.stubGlobal('WebSocket', FakeDaemonSocket);
});
afterEach(() => {
  setNativeEnv('browser');
  vi.unstubAllGlobals();
});

describe('AddServerFlow', () => {
  it('lists nearby daemons in the apps with a Paired badge', async () => {
    setNativeEnv('android');
    servers.push({ id: 'x', name: 'Box', host: '10.0.0.2', port: 9877, token: 't', useTls: false, daemonId: 'a'.repeat(32) });
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'plugin:herald-native|discover_daemons'
        ? {
            daemons: [
              { name: 'Box', host: 'box.local', addresses: ['10.0.0.2'], port: 9877, txt: { id: 'a'.repeat(32), name: 'Box', pairing: '1', version: '1.0.0' } },
              { name: 'Laptop', host: 'lap.local', addresses: ['10.0.0.3'], port: 9877, txt: { id: 'b'.repeat(32), name: 'Laptop', pairing: '1' } },
            ],
          }
        : null,
    );
    render(<AddServerFlow onClose={() => {}} />);
    expect(await screen.findByText('Laptop')).toBeTruthy();
    expect(screen.getByText('Box')).toBeTruthy();
    expect(screen.getAllByText('Paired')).toHaveLength(1);
  });

  it('browser: no nearby section; pair by address with the code, then saves the device token', async () => {
    render(<AddServerFlow onClose={() => {}} />);
    expect(screen.queryByText('Nearby')).toBeNull();
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.0.0.9' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '9877' } });
    fireEvent.click(screen.getByText('Pair with a code'));
    expect(await screen.findByText(/Enter the 6-digit code shown on your server/)).toBeTruthy();
    const input = screen.getByLabelText('Pairing code');
    fireEvent.change(input, { target: { value: '000000' } });
    fireEvent.click(screen.getByText('Pair'));
    expect(await screen.findByText(/Wrong code/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: '424242' } });
    fireEvent.click(screen.getByText('Pair'));
    expect(await screen.findByText(/Paired with Companion on box/)).toBeTruthy();
    expect(addServer).toHaveBeenCalledWith(
      expect.objectContaining({ host: '10.0.0.9', port: 9877, authKind: 'device', token: expect.stringMatching(/^cdt1\./) }),
    );
  });

  it('completes when another device approves', async () => {
    render(<AddServerFlow onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '10.0.0.9' } });
    fireEvent.click(screen.getByText('Pair with a code'));
    await screen.findByText(/Waiting for approval/);
    act(() => FakeDaemonSocket.last.approve());
    expect(await screen.findByText(/Paired with/)).toBeTruthy();
  });

  it('a pasted pairing link pairs without a code', async () => {
    render(<AddServerFlow onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/paste a companion/), {
      target: { value: `companion://pair?host=10.0.0.5&port=9877&tls=0&name=Box&otp=${'o'.repeat(43)}` },
    });
    fireEvent.click(screen.getByText('Use link'));
    fireEvent.click(await screen.findByText('Pair this device'));
    expect(await screen.findByText(/Paired with/)).toBeTruthy();
    expect(FakeDaemonSocket.last.sent.some((m) => m.type === 'pair_redeem_qr')).toBe(true);
  });

  it('rejects a link that is not a pairing link', () => {
    render(<AddServerFlow onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/paste a companion/), { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByText('Use link'));
    expect(screen.getByText(/not a Companion pairing link/)).toBeTruthy();
  });

  it('keeps the manual token form as Advanced', () => {
    render(<AddServerFlow onClose={() => {}} />);
    fireEvent.click(screen.getByText(/Advanced: enter the server token manually/));
    expect(screen.getByText('Enter token manually')).toBeTruthy();
    expect(screen.getByLabelText('Token')).toBeTruthy();
  });
});

describe('PairApprovalPrompt', () => {
  it('shows the request with its code and approves it', async () => {
    sendRequest.mockImplementation(async (type: string) =>
      type === 'pair_pending_list' ? { success: true, payload: { pending: [pending()] } } : { success: true },
    );
    render(<PairApprovalPrompt />);
    expect(await screen.findByText('Approve new device?')).toBeTruthy();
    expect(screen.getByText("Chris's iPad")).toBeTruthy();
    expect(screen.getByLabelText('Pairing code').textContent).toBe('123456');
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(sendRequest).toHaveBeenCalledWith('pair_approve', { pairingId: 'p1' }));
    await waitFor(() => expect(screen.queryByText('Approve new device?')).toBeNull());
  });

  it('appears on a live pair_pending event and can be denied', async () => {
    sendRequest.mockImplementation(async (type: string) =>
      type === 'pair_pending_list' ? { success: true, payload: { pending: [] } } : { success: true },
    );
    render(<PairApprovalPrompt />);
    await waitFor(() => expect(handlers.size).toBe(1));
    act(() => handlers.forEach((h) => h({ type: 'pair_pending', payload: { pending: [pending({ pairingId: 'p2' })] } })));
    fireEvent.click(await screen.findByText('Deny'));
    await waitFor(() => expect(sendRequest).toHaveBeenCalledWith('pair_deny', { pairingId: 'p2' }));
  });

  it('ignores expired requests', async () => {
    sendRequest.mockResolvedValue({ success: true, payload: { pending: [pending({ expiresAt: Date.now() - 1 })] } });
    render(<PairApprovalPrompt />);
    await waitFor(() => expect(sendRequest).toHaveBeenCalled());
    expect(screen.queryByText('Approve new device?')).toBeNull();
  });
});

describe('DevicesCard', () => {
  const devices = [
    { id: 'aaaa000000000001', name: 'Pixel', platform: 'android', createdAt: Date.now() - 86400_000, lastSeenAt: Date.now(), via: 'code' },
    { id: 'aaaa000000000002', name: 'Laptop', platform: 'desktop', createdAt: Date.now(), lastSeenAt: null, via: 'qr' },
  ];

  beforeEach(() => {
    servers.push({ id: 's1', name: 'Box', host: '10.0.0.2', port: 9877, token: 't', useTls: false });
    sendRequest.mockImplementation(async (type: string) => {
      if (type === 'devices_list') return { success: true, payload: { devices, currentDeviceId: 'aaaa000000000001' } };
      if (type === 'pair_qr_create')
        return { success: true, payload: { link: 'companion://pair?x', qrDataUrl: 'data:image/png;base64,AA', expiresAt: Date.now() + 600_000 } };
      if (type === 'device_upgrade')
        return { success: true, payload: { token: 'cdt1.new', deviceId: 'dev9', daemonId: 'd'.repeat(32) } };
      return { success: true };
    });
  });

  it('lists devices with a This device marker; rename and revoke', async () => {
    render(<DevicesCard serverId="s1" serverName="Box" />);
    expect(await screen.findByText('Laptop')).toBeTruthy();
    expect(screen.getByText('This device')).toBeTruthy();
    expect(screen.getByText(/last seen never/)).toBeTruthy();

    fireEvent.click(screen.getAllByText('Rename')[1]);
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Work laptop' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(sendRequest).toHaveBeenCalledWith('device_rename', { deviceId: 'aaaa000000000002', name: 'Work laptop' }),
    );

    fireEvent.click(screen.getAllByText('Revoke')[1]);
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(sendRequest).toHaveBeenCalledWith('device_revoke', { deviceId: 'aaaa000000000002' }));
  });

  it('revoking this device asks to sign out', async () => {
    render(<DevicesCard serverId="s1" serverName="Box" />);
    await screen.findByText('Pixel');
    fireEvent.click(screen.getAllByText('Revoke')[0]);
    expect(screen.getByText('Sign this app out?')).toBeTruthy();
  });

  it('shows a pairing QR for the address this app uses', async () => {
    render(<DevicesCard serverId="s1" serverName="Box" />);
    await screen.findByText('Pixel');
    fireEvent.click(screen.getByText('Show pairing QR'));
    expect(await screen.findByAltText('Pairing QR code')).toBeTruthy();
    expect(sendRequest).toHaveBeenCalledWith('pair_qr_create', { host: '10.0.0.2', port: 9877, tls: false });
  });

  it('upgrades a legacy-token server to a device token', async () => {
    fakeConn.authKind = 'legacy';
    render(<DevicesCard serverId="s1" serverName="Box" />);
    await screen.findByText('Pixel');
    fireEvent.click(screen.getByText('Upgrade to a device token'));
    await waitFor(() =>
      expect(updateServer).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', token: 'cdt1.new', authKind: 'device', deviceId: 'dev9' })),
    );
  });

  it('an older daemon says pairing is not supported', async () => {
    sendRequest.mockResolvedValue({ success: false, error: 'Unknown message type: devices_list' });
    render(<DevicesCard serverId="s1" serverName="Box" />);
    expect(await screen.findByText(/does not support device pairing yet/)).toBeTruthy();
  });
});
