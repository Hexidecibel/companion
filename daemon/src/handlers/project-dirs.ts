import { AuthenticatedClient, HandlerContext, MessageHandler } from '../handler-context';
import { resolveConfigPath, readRawConfig } from '../config';
import { RecentDirsStore, getRecentDirsStore } from '../project-dirs/recents';
import {
  FavoriteDirError,
  addFavoriteDir,
  effectiveFavoriteDirs,
  listFavoriteGroups,
  removeFavoriteDir,
} from '../project-dirs/favorites';
import type { FavoriteDirRequest, ProjectDirsResponse } from '../project-dirs/protocol';

const RESPONSE_TYPE = 'project_dirs';

export interface ProjectDirDeps {
  recents?: RecentDirsStore;
  configPath?: () => string;
}

export function registerProjectDirHandlers(
  ctx: HandlerContext,
  deps: ProjectDirDeps = {}
): Record<string, MessageHandler> {
  const recents = () => deps.recents ?? getRecentDirsStore();
  const configPath = () => (deps.configPath ?? resolveConfigPath)();
  const home = () => ctx.tmux.getHomeDir();

  const snapshot = async (): Promise<ProjectDirsResponse> => {
    const roots = effectiveFavoriteDirs(readRawConfig(configPath()), home());
    const [recentList, favorites] = await Promise.all([
      recents().list(),
      listFavoriteGroups(roots),
    ]);
    return { recents: recentList, favorites };
  };

  // Changing favorites rewrites config.json: same gate as starting a session
  // from a remote origin / a device without dispatch.
  const writeDenied = (client: AuthenticatedClient): string | null => {
    if (client.deviceCapabilities?.dispatch === false) return 'capability_disabled';
    return client.originCredential ? ctx.requireRemoteCapability(client, 'dispatch') : null;
  };

  const mutate =
    (op: typeof addFavoriteDir): MessageHandler =>
    async (client, payload, requestId) => {
      const denied = writeDenied(client);
      if (denied) {
        ctx.send(client.ws, { type: RESPONSE_TYPE, success: false, error: denied, requestId });
        return;
      }
      try {
        await op((payload as FavoriteDirRequest | undefined)?.path, {
          configPath: configPath(),
          home: home(),
        });
        ctx.send(client.ws, {
          type: RESPONSE_TYPE,
          success: true,
          payload: await snapshot(),
          requestId,
        });
      } catch (err) {
        if (!(err instanceof FavoriteDirError))
          console.error('ProjectDirs: config write failed', err);
        ctx.send(client.ws, {
          type: RESPONSE_TYPE,
          success: false,
          error: err instanceof FavoriteDirError ? err.message : 'Could not update favorites',
          requestId,
        });
      }
    };

  return {
    async get_project_dirs(client, _payload, requestId) {
      try {
        ctx.send(client.ws, {
          type: RESPONSE_TYPE,
          success: true,
          payload: await snapshot(),
          requestId,
        });
      } catch (err) {
        console.error('ProjectDirs: listing failed', err);
        ctx.send(client.ws, {
          type: RESPONSE_TYPE,
          success: false,
          error: 'Could not list project folders',
          requestId,
        });
      }
    },
    add_favorite_dir: mutate(addFavoriteDir),
    remove_favorite_dir: mutate(removeFavoriteDir),
  };
}
