/**
 * Concierge path resolution: host installs find <repo>/concierge by walking up
 * from the daemon; the Docker image points COMPANION_CONCIERGE_DIR at a
 * writable copy in the ~/.companion volume and COMPANION_MCP_ENTRY at the
 * baked-in companion-remote MCP. No hardcoded per-user fallback.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveConciergeDir, resolveMcpEntry } from '../src/handlers/concierge';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'concierge-paths-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function conciergeAt(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.mcp.json.template'), '{}');
  return dir;
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('resolveConciergeDir', () => {
  const repo = path.join(tmp, 'repo');
  const repoConcierge = conciergeAt(path.join(repo, 'concierge'));
  const daemonDist = path.join(repo, 'daemon', 'dist', 'handlers');
  fs.mkdirSync(daemonDist, { recursive: true });
  const volume = conciergeAt(path.join(tmp, 'home', '.companion', 'concierge'));
  const image = path.join(tmp, 'app', 'daemon', 'dist', 'handlers');
  fs.mkdirSync(image, { recursive: true });

  it('host install: walks up from the daemon to <repo>/concierge', () => {
    expect(resolveConciergeDir(undefined, {}, daemonDist)).toBe(repoConcierge);
  });

  it('config.concierge_dir wins when it has the template', () => {
    expect(resolveConciergeDir(volume, {}, daemonDist)).toBe(volume);
    expect(resolveConciergeDir(path.join(tmp, 'nope'), {}, daemonDist)).toBe(repoConcierge);
  });

  it('container: COMPANION_CONCIERGE_DIR (absolute, with the template)', () => {
    expect(resolveConciergeDir(undefined, { COMPANION_CONCIERGE_DIR: volume }, image)).toBe(volume);
    expect(resolveConciergeDir(undefined, { COMPANION_CONCIERGE_DIR: 'relative/dir' }, image)).toBeNull();
  });

  it('nothing found: null (never a hardcoded home directory)', () => {
    expect(resolveConciergeDir(undefined, {}, image)).toBeNull();
  });
});

describe('resolveMcpEntry', () => {
  it('COMPANION_MCP_ENTRY wins; otherwise <repo>/mcp/dist/index.js', () => {
    expect(resolveMcpEntry('/r/concierge', { COMPANION_MCP_ENTRY: '/app/mcp/dist/index.js' })).toBe(
      '/app/mcp/dist/index.js'
    );
    expect(resolveMcpEntry('/r/concierge', {})).toBe('/r/mcp/dist/index.js');
    expect(resolveMcpEntry('/r/concierge', { COMPANION_MCP_ENTRY: 'rel.js' })).toBe('/r/mcp/dist/index.js');
  });
});
