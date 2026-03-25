/**
 * Shared URL detection patterns and helpers.
 *
 * Matches:
 *  - Full URLs with protocol: https://example.com, http://foo.bar/path
 *  - Bare IPv4 addresses (with optional port and path): 192.168.1.1, 10.0.0.1:8080/api
 *  - localhost with port (and optional path): localhost:3000, localhost:9877/ws
 *  - Hostnames with port (must contain a dot): myserver.local:8080, foo.example.com:3000/path
 *
 * Does NOT match:
 *  - Bare domains without port (too many false positives)
 *  - File paths like src/foo.ts
 */

// Individual pattern components (no capturing groups inside)
const PROTOCOL_URL = 'https?:\\/\\/[^\\s<>]+';
const BARE_IP = '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(?::\\d{1,5})?(?:\\/[^\\s<>]*)?';
const LOCALHOST_PORT = 'localhost:\\d{1,5}(?:\\/[^\\s<>]*)?';
const HOST_PORT = '[\\w.-]+\\.\\w+:\\d{1,5}(?:\\/[^\\s<>]*)?';

// Combined pattern as a single string (for embedding in larger regexes)
export const URL_PATTERN_SOURCE = `(?:${PROTOCOL_URL}|${BARE_IP}|${LOCALHOST_PORT}|${HOST_PORT})`;

// Standalone regex for finding URLs in text (global)
export const URL_RE = new RegExp(URL_PATTERN_SOURCE, 'g');

// Trailing punctuation to strip from matched URLs
export const TRAILING_PUNCT_RE = /[.,;:!?\])]+$/;

/**
 * Prepend http:// if the URL has no protocol.
 */
export function ensureProtocol(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return `http://${url}`;
}

/**
 * Format a URL for display as a short domain label.
 * Handles URLs with or without protocol.
 */
export function formatLinkDomain(url: string): string {
  try {
    const u = new URL(ensureProtocol(url));
    const domain = u.hostname.replace(/^www\./, '');
    const hasPath = u.pathname !== '/' || u.search || u.hash;
    return hasPath ? `${domain}/\u2026` : domain;
  } catch {
    return url;
  }
}

/**
 * Extract all URLs from a text string.
 * Returns the raw matched URLs (before protocol normalization).
 */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const re = new RegExp(URL_PATTERN_SOURCE, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    let url = match[0];
    const trailing = TRAILING_PUNCT_RE.exec(url);
    if (trailing) {
      url = url.slice(0, -trailing[0].length);
    }
    if (url.length > 0) {
      urls.push(url);
    }
  }
  return urls;
}
