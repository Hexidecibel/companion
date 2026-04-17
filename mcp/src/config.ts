import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ServerConfig {
  name: string;
  host: string;
  port: number;
  token: string;
  useTls: boolean;
  trustedNetwork?: boolean;
}

export interface McpConfig {
  version: number;
  servers: ServerConfig[];
}

export function getConfigPath(): string {
  const override = process.env.COMPANION_MCP_CONFIG;
  if (override) return override;
  return path.join(os.homedir(), '.companion', 'mcp-servers.json');
}

export function loadConfig(): McpConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    process.stderr.write(
      `[companion-remote-mcp] No config at ${configPath} — starting with empty server list. ` +
        `Create the file with a "servers" array to expose daemons.\n`
    );
    return { version: 1, servers: [] };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<McpConfig>;
    const servers = Array.isArray(parsed.servers) ? parsed.servers : [];

    for (const s of servers) {
      if (!s.name || !s.host || typeof s.port !== 'number' || !s.token) {
        process.stderr.write(
          `[companion-remote-mcp] Skipping malformed server entry: ${JSON.stringify(s)}\n`
        );
      }
    }

    return {
      version: parsed.version ?? 1,
      servers: servers.filter(
        (s): s is ServerConfig =>
          !!s.name && !!s.host && typeof s.port === 'number' && !!s.token
      ),
    };
  } catch (err) {
    process.stderr.write(
      `[companion-remote-mcp] Failed to parse ${configPath}: ${String(err)}\n`
    );
    return { version: 1, servers: [] };
  }
}
