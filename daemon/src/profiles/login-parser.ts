/**
 * Reads what a login command printed (pure). Terminal text is untrusted and
 * this link is opened automatically, so only https links on known hosts pass.
 * Nothing here logs; the result holds only the link, the code and flags.
 */
import type { ProfileAgent } from './protocol';

export const ALLOWED_LOGIN_HOSTS = [
  'claude.com',
  'claude.ai',
  'anthropic.com',
  'openai.com',
  'chatgpt.com',
];

/** A physical line this long may have been hard-wrapped by the program itself. */
const WRAP_MIN_COLUMNS = 60;
const URL_CHARS_ONLY = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CLAUDE_PROMPT = /paste\s+(?:the\s+|your\s+)?code\s+here/i;
const DEVICE_CODE = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$|^[A-Z0-9]{6,12}$/;

export interface ParsedLoginOutput {
  /** The newest allowed sign-in link. */
  url?: string;
  /** A link was printed, but none on an allowed https host. */
  blockedLink: boolean;
  /** Codex: the one-time code for the website. */
  deviceCode?: string;
  /** Claude: the paste-code prompt is on screen. */
  codePrompt: boolean;
  /** Claude: the last line is that prompt with nothing typed after it. */
  codePromptEmpty: boolean;
}

export function isAllowedLoginUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_LOGIN_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

function findLinks(lines: string[]): string[] {
  const links: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].search(/https?:\/\//i);
    if (at < 0) continue;
    const m = /^\S+/.exec(lines[i].slice(at));
    if (!m) continue;
    let link = m[0];
    // Only when the link runs to the end of a full-width line can it continue.
    const endsLine = at + link.length >= lines[i].trimEnd().length;
    if (endsLine) {
      let prevLength = lines[i].trimEnd().length;
      for (let j = i + 1; j < lines.length && prevLength >= WRAP_MIN_COLUMNS; j++) {
        const next = lines[j].trim();
        if (!next || !URL_CHARS_ONLY.test(next)) break;
        link += next;
        prevLength = lines[j].trimEnd().length;
      }
    }
    links.push(link.replace(/[.,;:!)\]'"]+$/, ''));
  }
  return links;
}

function findDeviceCode(lines: string[]): string | undefined {
  let code: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!/one[- ]time code|device code|enter (?:this|the) code/i.test(lines[i])) continue;
    const sameLine = /:\s*([A-Z0-9-]{4,24})\s*$/.exec(lines[i]);
    if (sameLine && DEVICE_CODE.test(sameLine[1])) {
      code = sameLine[1];
      continue;
    }
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (DEVICE_CODE.test(t)) code = t;
      break;
    }
  }
  return code;
}

export function parseLoginOutput(agent: ProfileAgent, pane: string): ParsedLoginOutput {
  const lines = (pane || '').replace(ANSI, '').split('\n');
  const links = findLinks(lines);
  const allowed = links.filter(isAllowedLoginUrl);
  const out: ParsedLoginOutput = {
    blockedLink: links.length > 0 && allowed.length === 0,
    codePrompt: false,
    codePromptEmpty: false,
  };
  if (allowed.length) out.url = allowed[allowed.length - 1];
  if (agent === 'codex') {
    const code = findDeviceCode(lines);
    if (code) out.deviceCode = code;
    return out;
  }
  out.codePrompt = lines.some((l) => CLAUDE_PROMPT.test(l));
  const last = [...lines].reverse().find((l) => l.trim());
  out.codePromptEmpty = !!last && CLAUDE_PROMPT.test(last) && /[>:]\s*$/.test(last);
  return out;
}
