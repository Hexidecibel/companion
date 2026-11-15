// --- project dirs protocol v1 ---
/**
 * Project switching for the New Session panel: daemon-side recents (shared
 * across devices) and favorite root folders from config `favorite_dirs`.
 * Mirrored byte for byte by web/src/types/projectDirs.ts.
 *
 * Requests: `get_project_dirs` -> ProjectDirsResponse;
 * `add_favorite_dir` / `remove_favorite_dir` (FavoriteDirRequest) ->
 * ProjectDirsResponse (the new state). Response type for all three:
 * `project_dirs`. Older daemons answer "Unknown message type".
 */

export interface RecentProjectDir {
  path: string;
  /** Last path segment. */
  name: string;
  /** Epoch ms. */
  lastUsed: number;
}

export interface FavoriteDirEntry {
  name: string;
  path: string;
}

export interface FavoriteDirGroup {
  /** Absolute path of the favorite root. */
  root: string;
  /** Last path segment of the root. */
  name: string;
  /** Immediate subfolders (no dot-folders), sorted case-insensitively, capped. */
  entries: FavoriteDirEntry[];
  /** True when the listing was cut at the cap. */
  truncated?: boolean;
}

export interface ProjectDirsResponse {
  /** Most recent first. */
  recents: RecentProjectDir[];
  /** Favorite roots that exist on disk, in config order. */
  favorites: FavoriteDirGroup[];
}

export interface FavoriteDirRequest {
  /** Absolute or ~-relative folder path. */
  path: string;
}

export const PROJECT_DIRS_LIMITS = {
  maxRecents: 20,
  maxFavorites: 20,
  maxFavoriteEntries: 200,
} as const;
// --- end project dirs protocol ---
