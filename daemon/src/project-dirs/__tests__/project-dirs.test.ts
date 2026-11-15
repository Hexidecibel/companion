import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RecentDirsStore } from '../recents';
import {
  addFavoriteDir,
  effectiveFavoriteDirs,
  listFavoriteGroup,
  removeFavoriteDir,
} from '../favorites';
import { registerProjectDirHandlers } from '../../handlers/project-dirs';
import type { HandlerContext } from '../../handler-context';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'projdirs-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mkdirs(...rel: string[]): void {
  for (const r of rel) fs.mkdirSync(path.join(tmp, r), { recursive: true });
}

describe('RecentDirsStore', () => {
  it('reads a missing file as empty', async () => {
    const s = new RecentDirsStore(path.join(tmp, 'none', 'recent-dirs.json'));
    expect(await s.list()).toEqual([]);
  });

  it('tolerates a corrupt file and overwrites it on record', async () => {
    const file = path.join(tmp, 'recent-dirs.json');
    fs.writeFileSync(file, '{not json');
    const s = new RecentDirsStore(file, { now: () => 5 });
    expect(await s.list()).toEqual([]);
    await s.record('/a/b');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).recents).toEqual([
      { path: '/a/b', name: 'b', lastUsed: 5 },
    ]);
  });

  it('dedupes by path, newest first, capped, and persists across instances', async () => {
    const file = path.join(tmp, 'sub', 'recent-dirs.json');
    let t = 0;
    const s = new RecentDirsStore(file, { max: 3, now: () => ++t });
    await Promise.all([s.record('/x/one'), s.record('/x/two/'), s.record('/x/three')]);
    await s.record('/x/one');
    await s.record('/x/four');
    await s.record('relative/ignored');
    const list = await new RecentDirsStore(file, { max: 3 }).list();
    expect(list.map((e) => e.path)).toEqual(['/x/four', '/x/one', '/x/three']);
    expect(list[0]).toEqual({ path: '/x/four', name: 'four', lastUsed: 5 });
  });

  it('drops invalid entries from the file', async () => {
    const file = path.join(tmp, 'recent-dirs.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        recents: [
          { path: '/ok', lastUsed: 2 },
          { path: 'rel' },
          null,
          { path: '/ok', lastUsed: 1 },
        ],
      })
    );
    expect(await new RecentDirsStore(file).list()).toEqual([
      { path: '/ok', name: 'ok', lastUsed: 2 },
    ]);
  });
});

describe('favorites', () => {
  it('explicit favorite_dirs: expands ~ and dedupes', async () => {
    const home = path.join(tmp, 'home');
    expect(
      effectiveFavoriteDirs({ favorite_dirs: ['~/src', `${home}/src/`, '/srv', 3] }, home)
    ).toEqual([path.join(home, 'src'), '/srv']);
  });

  it('absent key: no favorites (no built-in defaults, project_roots not used)', () => {
    const home = path.join(tmp, 'home');
    mkdirs('home/local/src', 'home/proj');
    expect(effectiveFavoriteDirs({ project_roots: [path.join(home, 'proj')] }, home)).toEqual([]);
    expect(effectiveFavoriteDirs({ favorite_dirs: 'nope' }, home)).toEqual([]);
  });

  it('lists immediate subfolders: no dotdirs/files, case-insensitive sort, capped', async () => {
    mkdirs('root/beta', 'root/Alpha', 'root/.hidden', 'root/gamma/deep', 'other');
    fs.writeFileSync(path.join(tmp, 'root', 'file.txt'), '');
    fs.symlinkSync(path.join(tmp, 'other'), path.join(tmp, 'root', 'link'));
    const g = await listFavoriteGroup(path.join(tmp, 'root'));
    expect(g!.name).toBe('root');
    expect(g!.entries.map((e) => e.name)).toEqual(['Alpha', 'beta', 'gamma', 'link']);
    expect(g!.truncated).toBeUndefined();
    const capped = await listFavoriteGroup(path.join(tmp, 'root'), 2);
    expect(capped!.entries).toHaveLength(2);
    expect(capped!.truncated).toBe(true);
    expect(await listFavoriteGroup(path.join(tmp, 'missing'))).toBeNull();
  });

  it('add/remove persist atomically and keep other config keys', async () => {
    const home = path.join(tmp, 'home');
    mkdirs('home/a', 'home/b');
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ port: 1, favorite_dirs: ['~/a'] }));
    const opts = { configPath, home };

    expect(await addFavoriteDir('~/b', opts)).toEqual([path.join(home, 'a'), path.join(home, 'b')]);
    expect(await addFavoriteDir(path.join(home, 'b'), opts)).toHaveLength(2);
    await expect(addFavoriteDir('~/missing', opts)).rejects.toThrow('Not a folder');
    await expect(addFavoriteDir('relative', opts)).rejects.toThrow('absolute');

    expect(await removeFavoriteDir('~/a', opts)).toEqual([path.join(home, 'b')]);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw).toEqual({ port: 1, favorite_dirs: [path.join(home, 'b')] });
  });

  it('adding to a config without the key creates it; removing an unknown path is a no-op', async () => {
    const home = path.join(tmp, 'home');
    mkdirs('home/a');
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ port: 1 }));
    expect(await removeFavoriteDir('~/a', { configPath, home })).toEqual([]);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({ port: 1 });
    expect(await addFavoriteDir('~/a', { configPath, home })).toEqual([path.join(home, 'a')]);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).favorite_dirs).toEqual([
      path.join(home, 'a'),
    ]);
  });

  it('refuses to replace an unparseable config', async () => {
    mkdirs('home/a');
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, '{broken');
    await expect(
      addFavoriteDir('~/a', { configPath, home: path.join(tmp, 'home') })
    ).rejects.toThrow();
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{broken');
  });
});

describe('project dir handlers', () => {
  function setup(clientOver: Record<string, unknown> = {}) {
    const home = path.join(tmp, 'home');
    mkdirs('home/src/app', 'home/src/lib');
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ favorite_dirs: ['~/src', '/does/not/exist'] }));
    const sent: Array<Record<string, any>> = [];
    const ctx = {
      send: (_ws: unknown, msg: Record<string, unknown>) => sent.push(msg),
      tmux: { getHomeDir: () => home },
      requireRemoteCapability: () => 'capability_disabled',
    } as unknown as HandlerContext;
    const recents = new RecentDirsStore(path.join(tmp, 'recent-dirs.json'), { now: () => 9 });
    const h = registerProjectDirHandlers(ctx, { recents, configPath: () => configPath });
    const client = { ws: {}, ...clientOver } as any;
    return { h, sent, client, home, recents, configPath };
  }

  it('get_project_dirs returns recents + existing favorites with entries', async () => {
    const { h, sent, client, home, recents } = setup();
    await recents.record('/w/proj');
    await h.get_project_dirs(client, undefined, 'r1');
    expect(sent[0]).toMatchObject({ type: 'project_dirs', success: true, requestId: 'r1' });
    expect(sent[0].payload).toEqual({
      recents: [{ path: '/w/proj', name: 'proj', lastUsed: 9 }],
      favorites: [
        {
          root: path.join(home, 'src'),
          name: 'src',
          entries: [
            { name: 'app', path: path.join(home, 'src/app') },
            { name: 'lib', path: path.join(home, 'src/lib') },
          ],
        },
      ],
    });
  });

  it('add/remove favorite answer with the new snapshot', async () => {
    const { h, sent, client, home } = setup();
    await h.remove_favorite_dir(client, { path: '~/src' }, 'r2');
    expect(sent[0]).toMatchObject({ success: true, payload: { favorites: [] } });
    await h.add_favorite_dir(client, { path: path.join(home, 'src') }, 'r3');
    expect(sent[1].payload.favorites).toHaveLength(1);
    await h.add_favorite_dir(client, { path: '~/nope' }, 'r4');
    expect(sent[2]).toMatchObject({
      success: false,
      error: expect.stringContaining('Not a folder'),
    });
  });

  it('remote-origin clients without dispatch cannot change favorites', async () => {
    const { h, sent, client, configPath } = setup({ originCredential: { id: 'x' } });
    const before = fs.readFileSync(configPath, 'utf-8');
    await h.add_favorite_dir(client, { path: '~/src/app' }, 'r5');
    expect(sent[0]).toMatchObject({ success: false, error: 'capability_disabled' });
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });
});
