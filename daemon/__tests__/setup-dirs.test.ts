/**
 * Directory picker bounds: $HOME only, no traversal, no symlink escape,
 * dot-folders hidden by default, capped listing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listDirs, normalizeRoots, resolveInHome } from '../src/setup/dirs';

describe('setup directory picker', () => {
  let root: string;
  let home: string;
  let outside: string;
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-dirs-')));
    home = path.join(root, 'home');
    outside = path.join(root, 'outside');
    for (const d of ['src/a', 'src/b', '.hidden', 'Documents']) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(home, 'file.txt'), 'x');
    fs.symlinkSync(outside, path.join(home, 'escape'));
    fs.symlinkSync(path.join(home, 'src'), path.join(home, 'src-link'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists folders only, sorted, without dot-folders, files or escaping links', () => {
    const l = listDirs(undefined, home);
    expect(l.path).toBe(home);
    expect(l.parent).toBeNull();
    expect(l.entries.map((e) => e.name)).toEqual(['Documents', 'src', 'src-link']);
    expect(l.truncated).toBe(false);
  });

  it('shows dot-folders only when asked', () => {
    expect(listDirs('~', home, { showHidden: true }).entries.map((e) => e.name)).toContain('.hidden');
  });

  it('subfolders have a parent; ~/ and relative paths resolve inside home', () => {
    const l = listDirs('~/src', home);
    expect(l.parent).toBe(home);
    expect(l.entries.map((e) => e.name)).toEqual(['a', 'b']);
    expect(listDirs('src', home).path).toBe(path.join(home, 'src'));
  });

  it('refuses traversal, absolute paths outside home and symlink escapes', () => {
    expect(() => listDirs('../outside', home)).toThrow(/home directory/);
    expect(() => listDirs('~/src/../../outside', home)).toThrow(/home directory/);
    expect(() => listDirs('/etc', home)).toThrow(/home directory/);
    expect(() => listDirs(outside, home)).toThrow(/home directory/);
    expect(() => listDirs('~/escape', home)).toThrow(/home directory/);
    expect(() => listDirs('~/nope', home)).toThrow(/does not exist/);
    expect(() => listDirs('~/file.txt', home)).toThrow(/not a folder/);
    expect(() => listDirs('a\0b', home)).toThrow(/Bad path/);
  });

  it('caps the listing', () => {
    const many = path.join(home, 'many');
    for (let i = 0; i < 250; i++) fs.mkdirSync(path.join(many, `d${String(i).padStart(3, '0')}`), { recursive: true });
    const l = listDirs('~/many', home);
    expect(l.entries).toHaveLength(200);
    expect(l.truncated).toBe(true);
    expect(listDirs('~/many', home, { limit: 5 }).entries).toHaveLength(5);
  });

  it('project roots: real paths, deduplicated, inside home only', () => {
    expect(normalizeRoots(['~/src', path.join(home, 'src'), '~/src-link'], home)).toEqual([path.join(home, 'src')]);
    expect(() => normalizeRoots(['/tmp'], home)).toThrow();
    expect(() => normalizeRoots('~/src', home)).toThrow(/list/);
    expect(() => normalizeRoots(new Array(21).fill('~/src'), home)).toThrow(/At most/);
    expect(resolveInHome('', home)).toBe(home);
  });
});
