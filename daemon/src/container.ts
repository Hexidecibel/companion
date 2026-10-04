/**
 * Container awareness. The Docker image sets COMPANION_CONTAINER=docker; a
 * plain `/.dockerenv` also counts. Inside a container the setup wizard swaps
 * host-install guidance (systemd units, apt, npm -g) for compose commands,
 * the folder picker is rooted at the projects bind mount, and Tailscale is a
 * sidecar reached through its LocalAPI socket.
 *
 * Nothing here is secret: the info goes to paired setup clients only.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ContainerInfo {
  runtime: 'docker';
  /** The projects bind mount (COMPANION_PROJECTS_DIR), when it exists. */
  projectsDir: string | null;
  /** network_mode: host (docker-compose.host.yml sets COMPANION_NETWORK=host). */
  hostNetwork: boolean;
  /** The Tailscale sidecar's LocalAPI socket (COMPANION_TAILSCALE_SOCKET), when configured. */
  tailscaleSocket: string | null;
  /** Host port the web UI is published on (COMPANION_PUBLISHED_PORT), for messages only. */
  publishedPort: number | null;
}

export function detectContainer(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync
): ContainerInfo | null {
  const flag = (env.COMPANION_CONTAINER || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') return null;
  const inContainer = flag !== '' || exists('/.dockerenv');
  if (!inContainer) return null;
  const projects = (env.COMPANION_PROJECTS_DIR || '').trim();
  const sock = (env.COMPANION_TAILSCALE_SOCKET || '').trim();
  const port = Number(env.COMPANION_PUBLISHED_PORT);
  return {
    runtime: 'docker',
    projectsDir:
      projects && path.isAbsolute(projects) && exists(projects) ? path.resolve(projects) : null,
    hostNetwork: (env.COMPANION_NETWORK || '').trim().toLowerCase() === 'host',
    tailscaleSocket: sock && path.isAbsolute(sock) ? sock : null,
    publishedPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
  };
}

let cached: ContainerInfo | null | undefined;

/** Process-wide container info (computed once). */
export function containerInfo(): ContainerInfo | null {
  if (cached === undefined) cached = detectContainer();
  return cached;
}

/** Tests only. */
export function resetContainerInfoForTests(): void {
  cached = undefined;
}

/** The compose commands the wizard and logs show inside a container. */
export const DOCKER_COMMANDS = {
  setupClaude: 'docker compose run --rm companion setup-claude',
  claude: 'docker compose exec companion claude',
  logs: 'docker compose logs companion',
  pairCode: 'bin/docker pair-code',
  restart: 'docker compose restart companion',
  voiceUp: 'docker compose --profile voice up -d',
  tailscaleUp: 'docker compose --profile tailscale up -d',
  tmuxAttach: (session: string) => `docker compose exec companion tmux attach -t ${session}`,
} as const;

/** A boxed, easy-to-spot pairing code for `docker compose logs`. */
export function pairingCodeBanner(code: string, deviceName: string): string[] {
  const spaced = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  const who = deviceName.replace(/[^\x20-\x7e]/g, '?').slice(0, 36);
  const rows = [`PAIRING CODE:  ${spaced}`, `for "${who}" (expires in 2 minutes)`];
  const w = Math.max(...rows.map((r) => r.length)) + 4;
  const bar = '+' + '-'.repeat(w) + '+';
  return [bar, ...rows.map((r) => `|  ${r.padEnd(w - 2)}|`), bar];
}
