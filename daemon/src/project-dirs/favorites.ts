/**
 * Favorite root folders for the New Session panel (config `favorite_dirs`).
 * Read from the config file on every request so edits apply without a
 * restart. No built-in defaults: an absent key means no favorites. Folders that do not exist are skipped in responses, never an error.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readRawConfig, updateConfigFile } from '../config';
import { FavoriteDirGroup, PROJECT_DIRS_LIMITS } from './protocol';
import { dirName } from './recents';

export class FavoriteDirError extends Error {}

export function expandHome(p: string, home: string): string {
  const t = p.trim();
  if (t === '~') return home;
  if (t.startsWith('~/')) return path.join(home, t.slice(2));
  return t;
}

/** Expand + normalize one configured entry; null when unusable. */
function toAbs(p: unknown, home: string): string | null {
  if (typeof p !== 'string') return null;
  const t = expandHome(p, home);
  if (!t || t.length > 4096 || t.includes('\0') || !path.isAbsolute(t)) return null;
  return path.resolve(t);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function dedupe(list: Array<string | null>): string[] {
  const out: string[] = [];
  for (const p of list) if (p && !out.includes(p)) out.push(p);
  return out;
}

/** The configured favorite list (absolute paths, config order); [] when the key is absent. */
export function effectiveFavoriteDirs(raw: Record<string, unknown>, home: string): string[] {
  if (!Array.isArray(raw.favorite_dirs)) return [];
  return dedupe(raw.favorite_dirs.map((p) => toAbs(p, home))).slice(
    0,
    PROJECT_DIRS_LIMITS.maxFavorites
  );
}

/** Immediate subfolders of a root (dirs and links to dirs, no dot-folders). Null if unreadable. */
export async function listFavoriteGroup(
  root: string,
  limit: number = PROJECT_DIRS_LIMITS.maxFavoriteEntries
): Promise<FavoriteDirGroup | null> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const names: string[] = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    if (d.isDirectory()) names.push(d.name);
    else if (d.isSymbolicLink() && (await isDir(path.join(root, d.name)))) names.push(d.name);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const group: FavoriteDirGroup = {
    root,
    name: dirName(root),
    entries: names.slice(0, limit).map((name) => ({ name, path: path.join(root, name) })),
  };
  if (names.length > limit) group.truncated = true;
  return group;
}

/** Groups for every existing favorite root (missing / unreadable ones skipped). */
export async function listFavoriteGroups(roots: string[]): Promise<FavoriteDirGroup[]> {
  const groups = await Promise.all(roots.map((r) => listFavoriteGroup(r)));
  return groups.filter((g): g is FavoriteDirGroup => g !== null);
}

export interface FavoriteConfigOpts {
  configPath: string;
  home: string;
}

/** Add a folder (must exist) to `favorite_dirs`; returns the new list. */
export async function addFavoriteDir(input: unknown, opts: FavoriteConfigOpts): Promise<string[]> {
  const p = toAbs(input, opts.home);
  if (!p) throw new FavoriteDirError('Give an absolute or ~/ folder path');
  if (!(await isDir(p))) throw new FavoriteDirError(`Not a folder: ${p}`);
  const current = effectiveFavoriteDirs(readRawConfig(opts.configPath), opts.home);
  if (current.includes(p)) return current;
  if (current.length >= PROJECT_DIRS_LIMITS.maxFavorites) {
    throw new FavoriteDirError(`At most ${PROJECT_DIRS_LIMITS.maxFavorites} favorite folders`);
  }
  const next = [...current, p];
  updateConfigFile((raw) => {
    raw.favorite_dirs = next;
  }, opts.configPath);
  return next;
}

/** Remove a folder from `favorite_dirs` (it need not exist); returns the new list. */
export function removeFavoriteDir(input: unknown, opts: FavoriteConfigOpts): Promise<string[]> {
  return Promise.resolve().then(() => removeFavoriteDirSync(input, opts));
}

function removeFavoriteDirSync(input: unknown, opts: FavoriteConfigOpts): string[] {
  const p = toAbs(input, opts.home);
  if (!p) throw new FavoriteDirError('Give an absolute or ~/ folder path');
  const current = effectiveFavoriteDirs(readRawConfig(opts.configPath), opts.home);
  const next = current.filter((d) => d !== p);
  if (next.length === current.length) return current;
  updateConfigFile((raw) => {
    raw.favorite_dirs = next;
  }, opts.configPath);
  return next;
}
