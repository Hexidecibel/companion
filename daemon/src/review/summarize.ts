/**
 * Free (no LLM) turn summaries. PURE.
 *
 *   gist    — from the last assistant reply: flatten markdown, drop filler
 *             ("Done.", "All set", "Summary:"), "I've fixed X" -> "Fixed X",
 *             first sentence, clipped at a word boundary to 60 chars.
 *             Falls back to the prompt, then to the files ("Edited a.ts and 2 more").
 *   summary — `${gist}: ${n} file(s), +A -D`.
 */

import * as path from 'path';
import { flattenMarkdown, oneLine } from '../herald/text';

export const GIST_MAX = 60;

const FILLER =
  /^(?:done|all\s+(?:set|done|good)|ok(?:ay)?|great|perfect|got\s+it|sure|alright|good\s+news|summary|here(?:'s|\s+is)\s+(?:a\s+)?(?:summary|what\s+(?:i\s+)?(?:did|changed))|changes?(?:\s+made)?|what\s+changed)\s*[.!:,—-]*\s*/i;

/** Clip at a word boundary (adds an ellipsis when cut). */
export function clipWords(s: string, max = GIST_MAX): string {
  const t = oneLine(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—-]+$/, '') + '…';
}

/** "I've fixed the guard" -> "Fixed the guard". */
function firstPersonToImperative(s: string): string {
  const m = s.match(/^(?:I(?:'ve|\s+have)?|We(?:'ve|\s+have)?)\s+(?:also\s+|now\s+|just\s+)?([a-z][a-z-]*)\b\s*(.*)$/i);
  if (!m) return s;
  const verb = m[1];
  // "I think", "I'm", "I can", ... are not reports of work.
  if (/^(think|believe|can|could|will|would|should|might|may|am|need|want|see|noticed|found|was|did|do)$/i.test(verb))
    return s;
  return `${verb[0].toUpperCase()}${verb.slice(1)} ${m[2]}`.trim();
}

function firstSentenceOf(s: string): string {
  const m = s.match(/^(.+?[.!?])(?:\s|$)/);
  return (m ? m[1] : s).replace(/[.!?]+$/, '');
}

/** Gist from a reply, or null when nothing usable remains. */
export function gistFromReply(reply: string): string | null {
  let t = oneLine(flattenMarkdown(reply || ''));
  for (let i = 0; i < 4; i++) {
    const next = t.replace(FILLER, '');
    if (next === t) break;
    t = next;
  }
  t = firstSentenceOf(t.trim());
  t = firstPersonToImperative(t.trim());
  t = t.replace(/^\(code\)\s*/, '').trim();
  if (t.length < 3) return null;
  return clipWords(t.charAt(0).toUpperCase() + t.slice(1));
}

export function gistFromFiles(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const first = path.basename(paths[0]);
  return paths.length === 1 ? `Edited ${first}` : `Edited ${first} and ${paths.length - 1} more`;
}

export function fileCountText(n: number): string {
  return `${n} file${n === 1 ? '' : 's'}`;
}

export interface TurnGistInput {
  reply: string;
  prompt: string;
  /** Distinct files edited in the turn (display or absolute paths). */
  files: string[];
  inProgress: boolean;
  additions: number;
  deletions: number;
}

export function summarizeTurn(t: TurnGistInput): {
  gist: string;
  summary: string;
  summarySource: 'reply' | 'prompt' | 'files';
} {
  let gist: string | null = null;
  let source: 'reply' | 'prompt' | 'files' = 'reply';
  // An in-progress turn's reply is not its outcome yet.
  if (!t.inProgress) gist = gistFromReply(t.reply);
  if (!gist) {
    const p = oneLine(t.prompt);
    if (p && !p.startsWith('(')) {
      gist = clipWords(p.charAt(0).toUpperCase() + p.slice(1));
      source = 'prompt';
    }
  }
  if (!gist) {
    gist = gistFromFiles(t.files) || 'No changes';
    source = 'files';
  }
  return {
    gist,
    summary: `${gist}: ${fileCountText(t.files.length)}, +${t.additions} -${t.deletions}`,
    summarySource: source,
  };
}
