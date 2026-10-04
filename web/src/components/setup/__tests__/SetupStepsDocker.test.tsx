/**
 * The setup wizard's Docker branches: when the server's status says it runs in
 * the container image, host-install guidance (systemd, npm -g, bin/herald-voice,
 * tailscale up) is replaced by compose commands, and the first device pairs by
 * the code from `docker compose logs`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SetupStatus } from '../../../types/setup';

const setupCall = vi.fn();
vi.mock('../../../services/setupWizard', async (orig) => ({
  ...(await orig<typeof import('../../../services/setupWizard')>()),
  setupCall: (...a: unknown[]) => setupCall(...a),
}));
vi.mock('../../../hooks/useServers', () => ({
  useServers: () => ({ servers: [], addServer: vi.fn(), updateServer: vi.fn(), getServer: () => undefined }),
}));
const hello = vi.fn();
vi.mock('../../../services/pairing', async (orig) => ({
  ...(await orig<typeof import('../../../services/pairing')>()),
  PairingClient: class {
    hello = () => hello();
    close() {}
  },
}));

import { ClaudeStep, DoneStep, MachineStep, PairStep, ProjectsStep, RemoteStep, type StepCtx } from '../SetupSteps';

function status(container: SetupStatus['container']): SetupStatus {
  return {
    setupMode: true,
    setupComplete: false,
    daemonId: 'd',
    serverName: 'Box',
    hostname: 'abc123',
    platform: 'linux',
    version: '1.0.0',
    home: '/home/companion',
    steps: {},
    settings: {
      name: 'Box',
      projectRoots: [],
      tmuxSession: 'main',
      mdnsEnabled: false,
      pairing: 'lan',
      herald: { provider: 'off', baseUrl: '', model: '' },
      notifications: 'browser',
    },
    secrets: [],
    deviceCount: 1,
    restartNeeded: true,
    secretsFile: '/home/companion/.companion/secrets.env',
    container,
  };
}
const DOCKER = { runtime: 'docker' as const, projectsDir: '/home/companion/projects', hostNetwork: false, tailscaleSidecar: true };

function ctx(st: SetupStatus, over: Partial<StepCtx> = {}): StepCtx {
  return {
    serverId: 's1',
    server: { id: 's1', name: 'Box', host: '192.168.1.9', port: 9744, token: 't', useTls: false } as StepCtx['server'],
    status: st,
    setStatus: vi.fn(),
    mode: 'server',
    paired: true,
    marks: {},
    setupError: null,
    registerContinue: vi.fn(),
    onPaired: vi.fn(),
    ...over,
  };
}

const check = (id: string, status: 'ok' | 'warn' | 'fail', extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  status,
  detail: status === 'ok' ? 'fine' : 'Not installed',
  optional: false,
  ...extra,
});

beforeEach(() => {
  setupCall.mockReset();
  hello.mockReset();
});

describe('wizard in a Docker container', () => {
  it('machine: no "start on boot" install; Docker restarts it', async () => {
    setupCall.mockImplementation(async (_s: string, type: string) => {
      if (type === 'setup_checks') return { checks: [check('tmux', 'ok')] };
      if (type === 'setup_services') return { platform: 'linux', services: [] };
      throw new Error(type);
    });
    render(<MachineStep ctx={ctx(status(DOCKER))} />);
    await screen.findByText(/Running in Docker: tmux, git and Node are part of the image/);
    expect(screen.queryByText('Start Companion on boot')).toBeNull();
    expect(setupCall.mock.calls.map((c) => c[1])).not.toContain('setup_services');
  });

  it('claude: install button runs setup_install_claude; compose command shown; npm -g is not', async () => {
    let installed = false;
    setupCall.mockImplementation(async (_s: string, type: string, payload: any) => {
      if (type === 'setup_checks') {
        return {
          checks: installed
            ? [check('claude_installed', 'ok'), check('claude_login', 'warn')]
            : [check('claude_installed', 'fail'), check('claude_login', 'warn')],
        };
      }
      if (type === 'setup_install_claude') {
        expect(payload).toEqual({ confirm: true });
        installed = true;
        return { ok: true, output: '', version: '2.1.289 (Claude Code)' };
      }
      throw new Error(type);
    });
    render(<ClaudeStep ctx={ctx(status(DOCKER))} />);
    const btn = await screen.findByRole('button', { name: 'Install Claude Code' });
    expect(screen.getAllByText('docker compose run --rm companion setup-claude').length).toBeGreaterThan(0);
    expect(screen.queryByText('npm install -g @anthropic-ai/claude-code')).toBeNull();
    fireEvent.click(btn);
    await screen.findByText('Sign in to Claude Code');
    expect(screen.getByText('docker compose exec companion claude')).toBeTruthy();
  });

  it('claude on a host install keeps the npm command', async () => {
    setupCall.mockResolvedValue({ checks: [check('claude_installed', 'fail'), check('claude_login', 'warn')] });
    render(<ClaudeStep ctx={ctx(status(null))} />);
    await screen.findByText('npm install -g @anthropic-ai/claude-code');
    expect(screen.queryByRole('button', { name: 'Install Claude Code' })).toBeNull();
  });

  it('projects: explains the projects mount (and how to add one when missing)', async () => {
    setupCall.mockResolvedValue({ path: '/home/companion/projects', parent: null, entries: [], truncated: false });
    const { unmount } = render(<ProjectsStep ctx={ctx(status(DOCKER))} />);
    await screen.findByText(/Running in Docker: your code is the folder mounted at/);
    expect(screen.getAllByText('~/projects').length).toBeGreaterThan(0);
    unmount();
    render(<ProjectsStep ctx={ctx(status({ ...DOCKER, projectsDir: null }))} />);
    await screen.findByText(/Running in Docker without a projects folder/);
  });

  it('remote: Tailscale sidecar steps instead of installing Tailscale on the host', async () => {
    setupCall.mockResolvedValue({
      tailscale: { installed: false, up: false, dnsName: null, url: null },
      lanUrls: [],
      port: 9877,
      tls: false,
    });
    render(<RemoteStep ctx={ctx(status(DOCKER))} />);
    await screen.findByText('docker compose --profile tailscale up -d');
    expect(screen.queryByText(/tailscale.com\/install.sh/)).toBeNull();
    expect(screen.getByText('http://192.168.1.9:9744/web/')).toBeTruthy();
  });

  it('remote: a connected sidecar shows its HTTPS address', async () => {
    setupCall.mockResolvedValue({
      tailscale: { installed: true, up: true, dnsName: 'companion.tail1.ts.net', url: 'https://companion.tail1.ts.net/web/' },
      lanUrls: [],
      port: 9877,
      tls: false,
    });
    render(<RemoteStep ctx={ctx(status(DOCKER))} />);
    await screen.findByText('Tailscale sidecar is connected');
    expect(screen.getByText('https://companion.tail1.ts.net/web/')).toBeTruthy();
  });

  it('done: the restart hint is the compose command', () => {
    render(<DoneStep ctx={ctx(status(DOCKER))} flow={['welcome', 'done']} />);
    expect(screen.getByText('docker compose restart companion')).toBeTruthy();
  });

  it('pair: code pairing points at docker compose logs; no one-click pairing', async () => {
    hello.mockResolvedValue({
      daemonId: 'd',
      name: 'Box',
      version: '1.0.0',
      pairing: true,
      codePairing: true,
      setupMode: true,
      localAutoPair: false,
      container: true,
    });
    render(<PairStep ctx={ctx(status(DOCKER), { paired: false, serverId: null })} />);
    await screen.findByText('Pair with a code');
    await waitFor(() => expect(screen.getByText('docker compose logs companion')).toBeTruthy());
    expect(screen.getByText(/Companion runs in Docker here/)).toBeTruthy();
    expect(screen.queryByText('Pair this browser')).toBeNull();
  });
});
