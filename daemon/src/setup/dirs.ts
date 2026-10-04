/**
 * Directory picker for the setup wizard's Projects step. Lists folders under
 * $HOME only: the request is resolved and its REAL path (symlinks followed)
 * must be $HOME or inside it. Dot-folders are hidden unless asked for, the
 * listing is capped, and only directory names are returned (never file names
 * or contents).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { DirListing } from './protocol';
import { SETUP_LIMITS } from './protocol';

export class DirError extends Error {
  constructor(
    readonly code: 'bad_request' | 'forbidden' | 'not_found',
    message: string
  ) {
    super(message);
  }
}

export function insideDir(real: string, root: string): boolean {
  return real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Resolve a user path ("~", "~/src", absolute, or relative to $HOME) to its real path inside $HOME. */
export function resolveInHome(requested: unknown, home: string): string {
  const realHome = fs.realpathSync(home);
  let raw = typeof requested === 'string' ? requested.trim() : '';
  if (raw.length > 4096 || raw.includes('\0')) throw new DirError('bad_request', 'Bad path');
  if (!raw || raw === '~') raw = realHome;
  else if (raw.startsWith('~/')) raw = path.join(realHome, raw.slice(2));
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(realHome, raw);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new DirError('not_found', 'That folder does not exist');
  }
  if (!insideDir(real, realHome)) {
    throw new DirError('forbidden', 'Only folders inside your home directory can be chosen');
  }
  if (!fs.statSync(real).isDirectory()) throw new DirError('bad_request', 'That is not a folder');
  return real;
}

export function listDirs(
  requested: unknown,
  home: string,
  opts: { showHidden?: boolean; limit?: number } = {}
): DirListing {
  const realHome = fs.realpathSync(home);
  const dir = resolveInHome(requested, home);
  const limit = Math.max(1, Math.min(opts.limit ?? SETUP_LIMITS.maxDirEntries, SETUP_LIMITS.maxDirEntries));
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new DirError('forbidden', 'That folder cannot be read');
  }
  const names: string[] = [];
  for (const d of dirents) {
    if (!opts.showHidden && d.name.startsWith('.')) continue;
    if (d.isDirectory()) {
      names.push(d.name);
    } else if (d.isSymbolicLink()) {
      // A link counts only when it points at a folder that is still inside $HOME.
      try {
        const target = fs.realpathSync(path.join(dir, d.name));
        if (insideDir(target, realHome) && fs.statSync(target).isDirectory()) names.push(d.name);
      } catch {
        /* dangling */
      }
    }
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const truncated = names.length > limit;
  return {
    path: dir,
    parent: dir === realHome ? null : path.dirname(dir),
    entries: names.slice(0, limit).map((name) => ({ name, path: path.join(dir, name) })),
    truncated,
  };
}

/** Validate a list of project roots: each must resolve inside $HOME; duplicates dropped. */
export function normalizeRoots(roots: unknown, home: string): string[] {
  if (!Array.isArray(roots)) throw new DirError('bad_request', 'projectRoots must be a list');
  if (roots.length > SETUP_LIMITS.maxProjectRoots) {
    throw new DirError('bad_request', `At most ${SETUP_LIMITS.maxProjectRoots} folders`);
  }
  const out: string[] = [];
  for (const r of roots) {
    const real = resolveInHome(r, home);
    if (!out.includes(real)) out.push(real);
  }
  return out;
}
