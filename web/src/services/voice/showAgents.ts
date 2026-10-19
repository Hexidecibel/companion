/**
 * "Show me the agents" (whole utterance, this device only): opens the
 * all-sessions Agents page. Web-only routing; a device phrase ("... on my
 * phone") is not matched here and goes the normal show path.
 */
import { normalizeUtterance, stripAddress } from './voiceCommands';

const FILLERS = new Set(['uh', 'um', 'umm', 'please', 'okay', 'ok', 'just', 'now', 'so', 'can', 'you', 'could']);

const SHOW_AGENTS_RE =
  /^(?:show(?: me)?|open(?: up)?|pull up|bring up|go to|take me to|lets see|let me see)(?: the| my| all(?: the)?| all my)? (?:sub ?)?agents?(?: page| view| list| panel| dashboard| status)?(?: here)?$/;

export function matchShowAgentsCommand(text: string): boolean {
  if (!text || text.length > 80) return false;
  const core = stripAddress(normalizeUtterance(text))
    .split(' ')
    .filter((w) => w && !FILLERS.has(w))
    .join(' ');
  return SHOW_AGENTS_RE.test(core);
}
