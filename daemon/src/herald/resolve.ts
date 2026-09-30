/**
 * Fuzzy-but-safe session resolution. PURE.
 *
 * Exactly one match or nothing: 0 or >1 candidates returns an error that tells the
 * model to ask the user which session they mean ("clarify" tier — never guess).
 */

import type { SessionSnapshot } from './session-source';

export type ResolveResult =
  | { ok: true; session: SessionSnapshot }
  | { ok: false; error: string; candidates: string[] };

const FILLER = new Set([
  'the',
  'a',
  'an',
  'session',
  'sessions',
  'one',
  'tab',
  'window',
  'project',
  'repo',
  'in',
  'on',
  'my',
  'that',
  'this',
]);

export function normalizeRef(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !FILLER.has(t))
    .join(' ')
    .trim();
}

function keys(s: SessionSnapshot): string[] {
  return [s.sessionName, s.tmuxName, s.sessionId, s.projectName].map(normalizeRef).filter(Boolean);
}

function uniqueById(list: SessionSnapshot[]): SessionSnapshot[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.serverId}:${s.sessionId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pick(list: SessionSnapshot[]): SessionSnapshot[] {
  const unique = uniqueById(list);
  if (unique.length <= 1) return unique;
  // Prefer live sessions over persisted inactive ones when that disambiguates.
  const live = unique.filter((s) => !s.inactive);
  return live.length >= 1 ? live : unique;
}

export function resolveSession(ref: string, sessions: SessionSnapshot[]): ResolveResult {
  const raw = (ref || '').trim();
  const describe = (list: SessionSnapshot[]) => list.map((s) => s.sessionName);
  if (!raw) {
    return {
      ok: false,
      error: 'No session named. Ask the user which session they mean.',
      candidates: describe(sessions.filter((s) => !s.inactive)),
    };
  }

  // 1. Exact identity match (id / display name / tmux name), case-insensitive.
  const lower = raw.toLowerCase();
  const exact = pick(
    sessions.filter(
      (s) =>
        s.sessionId.toLowerCase() === lower ||
        s.sessionName.toLowerCase() === lower ||
        s.tmuxName.toLowerCase() === lower
    )
  );
  if (exact.length === 1) return { ok: true, session: exact[0] };

  const n = normalizeRef(raw);
  if (!n) {
    return {
      ok: false,
      error: `"${raw}" does not name a session. Ask the user which session they mean.`,
      candidates: describe(sessions),
    };
  }

  // 2. Exact normalized match on any key (name, tmux name, project basename).
  const normExact = pick(sessions.filter((s) => keys(s).includes(n)));
  if (normExact.length === 1) return { ok: true, session: normExact[0] };
  if (normExact.length > 1) return ambiguous(raw, normExact);

  // 3. Containment either way on whole tokens ("companion" ~ "companion-herald").
  const tokenMatch = (key: string) => {
    const kt = key.split(' ');
    const rt = n.split(' ');
    const allRefInKey = rt.every((t) => kt.includes(t));
    const allKeyInRef = kt.every((t) => rt.includes(t));
    return allRefInKey || allKeyInRef;
  };
  const partial = pick(sessions.filter((s) => keys(s).some(tokenMatch)));
  if (partial.length === 1) return { ok: true, session: partial[0] };
  if (partial.length > 1) return ambiguous(raw, partial);

  // 4. Substring as a last resort (min 3 chars to avoid "a" matching everything).
  if (n.replace(/ /g, '').length >= 3) {
    const compact = n.replace(/ /g, '');
    const sub = pick(
      sessions.filter((s) => keys(s).some((k) => k.replace(/ /g, '').includes(compact)))
    );
    if (sub.length === 1) return { ok: true, session: sub[0] };
    if (sub.length > 1) return ambiguous(raw, sub);
  }

  const live = sessions.filter((s) => !s.inactive);
  return {
    ok: false,
    error:
      `No session matches "${raw}". Do not guess — ask the user which session they mean. ` +
      `Live sessions: ${live.length ? live.map((s) => s.sessionName).join(', ') : 'none'}.`,
    candidates: describe(live),
  };
}

function ambiguous(raw: string, list: SessionSnapshot[]): ResolveResult {
  const names = list.map((s) => s.sessionName);
  return {
    ok: false,
    error: `"${raw}" matches ${list.length} sessions (${names.join(', ')}). Do not guess — ask the user which one they mean.`,
    candidates: names,
  };
}

/**
 * Live sessions the user's utterance names outright (whole-token match on the
 * display name or project name, e.g. "where is out4 at?"). PURE. Used to pre-fetch
 * detail for a named session; never used to pick an action target.
 */
export function sessionsMentioned(text: string, sessions: SessionSnapshot[]): SessionSnapshot[] {
  const said = ` ${normalizeRef(text)} `;
  if (!said.trim()) return [];
  return uniqueById(
    sessions.filter((s) => {
      if (s.inactive) return false;
      return [s.sessionName, s.projectName]
        .map(normalizeRef)
        .some((k) => k.replace(/ /g, '').length >= 3 && said.includes(` ${k} `));
    })
  );
}
