export class McpRemoteError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = 'McpRemoteError';
  }
}

export class TransportInsecure extends McpRemoteError {
  constructor(host: string) {
    super(
      `Refusing plaintext connection to non-loopback host "${host}". Set useTls:true or trustedNetwork:true in mcp-servers.json.`,
      'transport_insecure'
    );
  }
}

export class CapabilityDisabled extends McpRemoteError {
  constructor(capability: string, server: string) {
    super(`Capability "${capability}" is disabled on daemon "${server}"`, 'capability_disabled');
  }
}

export class DaemonUnreachable extends McpRemoteError {
  constructor(server: string, reason: string) {
    super(`Daemon "${server}" unreachable: ${reason}`, 'daemon_unreachable');
  }
}

export class UnknownServer extends McpRemoteError {
  constructor(name: string) {
    super(`No server named "${name}" in mcp-servers.json`, 'unknown_server');
  }
}

export class DaemonRequestFailed extends McpRemoteError {
  constructor(type: string, error: string) {
    super(`Daemon request "${type}" failed: ${error}`, 'daemon_request_failed');
  }
}

export class OriginNotAllowed extends McpRemoteError {
  public origin: string;
  public server: string;
  constructor(server: string, origin: string) {
    super(
      `Daemon "${server}" rejected origin "${origin}". Add "${origin}" to the daemon's remote_capabilities.allowed_origins list to permit this MCP.`,
      'origin_not_allowed'
    );
    this.origin = origin;
    this.server = server;
  }
}

export class ClaudeNotFound extends McpRemoteError {
  constructor(server: string, searchedPath?: string) {
    const detail = searchedPath ? ` (searched PATH: ${searchedPath})` : '';
    super(
      `Claude binary not found on daemon "${server}"${detail}`,
      'claude_not_found'
    );
  }
}

export class InvalidCwd extends McpRemoteError {
  constructor(server: string, cwd: string, reason?: string) {
    const detail = reason ? `: ${reason}` : '';
    super(
      `Invalid cwd "${cwd}" on daemon "${server}"${detail}`,
      'invalid_cwd'
    );
  }
}

export class RateLimited extends McpRemoteError {
  public retryAfterMs?: number;
  constructor(server: string, retryAfterMs?: number) {
    const detail =
      typeof retryAfterMs === 'number'
        ? ` (retry after ${retryAfterMs}ms)`
        : '';
    super(
      `Rate limited by daemon "${server}"${detail}`,
      'rate_limited'
    );
    this.retryAfterMs = retryAfterMs;
  }
}

export class CommandBlocked extends McpRemoteError {
  public command?: string;
  constructor(server: string, command?: string) {
    const detail = command ? `: ${command}` : '';
    super(
      `Command blocked by daemon "${server}"${detail}`,
      'command_blocked'
    );
    this.command = command;
  }
}

export class InvalidPath extends McpRemoteError {
  public path?: string;
  public reason?: string;
  constructor(server: string, path?: string, reason?: string) {
    const pathPart = path ? ` "${path}"` : '';
    const reasonPart = reason ? `: ${reason}` : '';
    super(
      `Invalid path${pathPart} on daemon "${server}"${reasonPart}`,
      'invalid_path'
    );
    this.path = path;
    this.reason = reason;
  }
}
