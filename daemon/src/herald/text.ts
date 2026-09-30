/** Small, pure text helpers shared by Herald modules. */

export function clip(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** Keep the END of a string (most recent content), prefixing an ellipsis when cut. */
export function clipTail(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - (max - 1)).trimStart();
}

export function oneLine(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** FNV-1a 32-bit -> base36. Deterministic, compact, no crypto dependency. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Light markdown flattening for deterministic headlines / snapshot lines. Not a
 * renderer: strips code fences, inline code ticks, emphasis, headings, links, and
 * list/table markup so a one-liner is readable (and speakable).
 */
export function flattenMarkdown(s: string): string {
  if (!s) return '';
  return s
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** First sentence (or first line) of a text, flattened and clipped. */
export function firstSentence(s: string, max = 140): string {
  const flat = oneLine(flattenMarkdown(s));
  if (!flat) return '';
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  return clip(m ? m[1] : flat, max);
}

/**
 * If the text ends by asking the user something, return that trailing question
 * (flattened, clipped). Deterministic: the last sentence must end with '?' and sit
 * within the final ~400 chars of the message.
 */
export function trailingQuestion(s: string, max = 240): string | null {
  const flat = oneLine(flattenMarkdown(s));
  if (!flat) return null;
  const tail = flat.slice(-400).trim();
  if (!tail.endsWith('?')) return null;
  // Walk back to the start of the final sentence.
  const body = tail.slice(0, -1);
  const lastStop = Math.max(
    body.lastIndexOf('. '),
    body.lastIndexOf('! '),
    body.lastIndexOf('? '),
    body.lastIndexOf(': ')
  );
  const q = (lastStop >= 0 ? tail.slice(lastStop + 2) : tail).trim();
  return q ? clip(q, max) : null;
}

export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return rm ? `${h}h ${rm}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const TOOL_PHRASES: Record<string, string> = {
  Bash: 'run a shell command',
  Edit: 'edit a file',
  MultiEdit: 'edit a file',
  Write: 'write a file',
  NotebookEdit: 'edit a notebook',
  Read: 'read a file',
  WebFetch: 'fetch a web page',
  WebSearch: 'search the web',
  Task: 'start a sub-agent',
  Agent: 'start a sub-agent',
  ExitPlanMode: 'go ahead with its plan',
};

/** Spoken-friendly phrase for what a pending tool approval would do ("run a shell command"). */
export function plainToolAction(tool: string): string {
  if (TOOL_PHRASES[tool]) return TOOL_PHRASES[tool];
  if (tool.startsWith('mcp__'))
    return `use the ${tool.split('__').slice(-1)[0].replace(/_/g, ' ')} tool`;
  return `use ${tool}`;
}

/**
 * Streaming filter that removes markdown syntax from spoken output: emphasis and
 * code markers anywhere, and heading / bullet markers at the start of a line.
 * Stateful, so markers split across stream deltas are still caught.
 */
export class SpokenTextFilter {
  private atLineStart = true;
  /** Leading whitespace / markers held back at the start of the current line. */
  private lead = '';

  push(delta: string): string {
    let out = '';
    for (const ch of delta) {
      if (ch === '*' || ch === '`') continue;
      if (this.atLineStart) {
        if (ch === ' ' || ch === '\t' || ch === '#' || ch === '-' || ch === '\u2022') {
          this.lead += ch;
          continue;
        }
        this.atLineStart = false;
        // Keep plain indentation; drop anything that contained a marker.
        if (/^[ \t]*$/.test(this.lead)) out += this.lead;
        this.lead = '';
      }
      out += ch;
      if (ch === '\n') this.atLineStart = true;
    }
    return out;
  }
}
