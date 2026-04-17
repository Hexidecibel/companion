import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

const ORIGIN_PREFIX = 'mcp-';

export function getOriginPath(): string {
  const override = process.env.COMPANION_MCP_ORIGIN_FILE;
  if (override) return override;
  return path.join(os.homedir(), '.companion', 'mcp-origin');
}

export function getOrCreateOrigin(): string {
  const originPath = getOriginPath();

  if (fs.existsSync(originPath)) {
    try {
      const raw = fs.readFileSync(originPath, 'utf-8').trim();
      if (raw.length > 0) {
        return raw;
      }
    } catch (err) {
      process.stderr.write(
        `[companion-remote-mcp] Failed to read origin file ${originPath}: ${String(err)}\n`
      );
    }
  }

  const origin = `${ORIGIN_PREFIX}${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(originPath), { recursive: true });
    fs.writeFileSync(originPath, origin, { mode: 0o600 });
  } catch (err) {
    process.stderr.write(
      `[companion-remote-mcp] Failed to persist origin to ${originPath}: ${String(err)}\n`
    );
  }
  process.stderr.write(
    `[companion-remote-mcp] Generated new origin: ${origin}\n`
  );
  return origin;
}
