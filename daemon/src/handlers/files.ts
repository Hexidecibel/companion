import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { HandlerContext, MessageHandler } from '../handler-context';
import {
  MAX_DIRECTORY_LISTING_ENTRIES,
  MAX_IMAGE_FILE_SIZE_BYTES,
  MAX_TEXT_FILE_SIZE_BYTES,
  BINARY_DETECTION_PROBE_SIZE,
  MAX_APK_FILE_SIZE_BYTES,
  MAX_DIRECTORY_TRAVERSAL_DEPTH,
  DEFAULT_FILE_SEARCH_LIMIT,
  FUZZY_SCORE_EXACT_MATCH,
  FUZZY_SCORE_STARTS_WITH,
  FUZZY_SCORE_CONTAINS,
  FUZZY_SCORE_PATH_MATCH,
  FUZZY_SCORE_SUBSEQUENCE_BASE,
  FUZZY_SCORE_CONSECUTIVE_MULTIPLIER,
  FUZZY_SCORE_LENGTH_MULTIPLIER,
} from '../constants';

// --- File tree cache and helpers (moved from WebSocketHandler) ---

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '__pycache__',
  'target',
  '.next',
  '.turbo',
  '.nuxt',
  'build',
  'coverage',
  '.cache',
  '.expo',
  'venv',
  '.venv',
  'env',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
]);

const FILE_TREE_TTL = 30_000; // 30s cache

let fileTreeCache: { files: string[]; projectRoot: string; timestamp: number } | null = null;

function walkDirectory(dir: string, root: string, files: string[], depth: number = 0): void {
  if (depth > MAX_DIRECTORY_TRAVERSAL_DEPTH) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (IGNORE_DIRS.has(entry.name) && entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDirectory(fullPath, root, files, depth + 1);
      } else {
        files.push(fullPath);
      }
    }
  } catch {
    // Permission errors, etc.
  }
}

function getFileTree(projectRoot: string): string[] {
  const now = Date.now();
  if (
    fileTreeCache &&
    fileTreeCache.projectRoot === projectRoot &&
    now - fileTreeCache.timestamp < FILE_TREE_TTL
  ) {
    return fileTreeCache.files;
  }

  const files: string[] = [];
  walkDirectory(projectRoot, projectRoot, files);
  fileTreeCache = { files, projectRoot, timestamp: now };
  return files;
}

function fuzzyScore(query: string, filePath: string, projectRoot: string): number {
  const relativePath = path.relative(projectRoot, filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  const q = query.toLowerCase();

  if (basename === q) return FUZZY_SCORE_EXACT_MATCH;
  if (basename.startsWith(q)) return FUZZY_SCORE_STARTS_WITH + (q.length / basename.length) * FUZZY_SCORE_LENGTH_MULTIPLIER;
  const basenameIdx = basename.indexOf(q);
  if (basenameIdx >= 0) return FUZZY_SCORE_CONTAINS + (q.length / basename.length) * FUZZY_SCORE_LENGTH_MULTIPLIER - basenameIdx;
  const pathIdx = relativePath.indexOf(q);
  if (pathIdx >= 0) return FUZZY_SCORE_PATH_MATCH - pathIdx * 0.1;

  let qi = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  for (let i = 0; i < basename.length && qi < q.length; i++) {
    if (basename[i] === q[qi]) {
      qi++;
      consecutive++;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
    } else {
      consecutive = 0;
    }
  }
  if (qi === q.length) return FUZZY_SCORE_SUBSEQUENCE_BASE + maxConsecutive * FUZZY_SCORE_CONSECUTIVE_MULTIPLIER;

  return -1;
}

export function registerFileHandlers(
  ctx: HandlerContext
): Record<string, MessageHandler> {
  return {
    browse_directories(client, payload, requestId) {
      const browsePayload = payload as { path?: string } | undefined;
      const basePath = browsePayload?.path || ctx.tmux.getHomeDir();

      try {
        const entries: Array<{ name: string; path: string; isDirectory: boolean }> = [];

        if (basePath !== '/') {
          entries.push({
            name: '..',
            path: path.dirname(basePath),
            isDirectory: true,
          });
        }

        const items = fs.readdirSync(basePath, { withFileTypes: true });

        for (const item of items) {
          if (item.name.startsWith('.') && item.name !== '..') continue;
          if (['node_modules', '__pycache__', 'venv', '.git'].includes(item.name)) continue;

          if (item.isDirectory()) {
            entries.push({
              name: item.name,
              path: path.join(basePath, item.name),
              isDirectory: true,
            });
          }
        }

        entries.sort((a, b) => {
          if (a.name === '..') return -1;
          if (b.name === '..') return 1;
          return a.name.localeCompare(b.name);
        });

        ctx.send(client.ws, {
          type: 'directory_listing',
          success: true,
          payload: {
            currentPath: basePath,
            entries: entries.slice(0, MAX_DIRECTORY_LISTING_ENTRIES),
          },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'directory_listing',
          success: false,
          error: `Cannot read directory: ${basePath}`,
          requestId,
        });
      }
    },

    read_file(client, payload, requestId) {
      const readPayload = payload as { path: string } | undefined;
      const filePath = readPayload?.path;

      if (!filePath) {
        ctx.send(client.ws, {
          type: 'file_content',
          success: false,
          error: 'No file path provided',
          requestId,
        });
        return;
      }

      try {
        const homeDir = ctx.tmux.getHomeDir();
        let resolvedPath: string;

        if (filePath.startsWith('~/')) {
          resolvedPath = path.join(homeDir, filePath.slice(2));
        } else if (filePath.startsWith('/')) {
          resolvedPath = filePath;
        } else {
          const activeSessionId = ctx.watcher.getActiveSessionId();
          let workingDir = homeDir;
          if (activeSessionId) {
            const convSession = ctx.watcher.getSessions().find((s) => s.id === activeSessionId);
            if (convSession?.projectPath) {
              workingDir = convSession.projectPath;
            }
          }
          resolvedPath = path.resolve(workingDir, filePath);
        }

        resolvedPath = path.normalize(resolvedPath);

        const configPaths = (ctx.config.allowedPaths || []).map((p) => path.normalize(p));
        const allowedPaths = [homeDir, '/tmp', '/var/tmp', ...configPaths];
        const isAllowed = allowedPaths.some((allowed) => resolvedPath.startsWith(allowed));

        if (!isAllowed) {
          ctx.send(client.ws, {
            type: 'file_content',
            success: false,
            error: `Access denied: file outside allowed directories (resolved: ${resolvedPath})`,
            requestId,
          });
          return;
        }

        const stats = fs.statSync(resolvedPath);

        if (stats.isDirectory()) {
          ctx.send(client.ws, {
            type: 'file_content',
            success: false,
            error: 'Path is a directory, not a file',
            requestId,
          });
          return;
        }

        const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);
        const ext = path.extname(resolvedPath).slice(1).toLowerCase();
        const isImageExt = IMAGE_EXTS.has(ext);
        const maxSize = isImageExt ? MAX_IMAGE_FILE_SIZE_BYTES : MAX_TEXT_FILE_SIZE_BYTES;

        if (stats.size > maxSize) {
          ctx.send(client.ws, {
            type: 'file_content',
            success: false,
            error: `File too large (max ${isImageExt ? '5MB' : '1MB'})`,
            requestId,
          });
          return;
        }

        const MIME_TYPES: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          svg: 'image/svg+xml',
          webp: 'image/webp',
          ico: 'image/x-icon',
          bmp: 'image/bmp',
        };

        if (isImageExt) {
          const buf = fs.readFileSync(resolvedPath);
          const base64 = buf.toString('base64');
          ctx.send(client.ws, {
            type: 'file_content',
            success: true,
            payload: {
              content: base64,
              path: resolvedPath,
              encoding: 'base64',
              mimeType: MIME_TYPES[ext] || 'application/octet-stream',
            },
            requestId,
          });
          return;
        }

        const probe = Buffer.alloc(Math.min(BINARY_DETECTION_PROBE_SIZE, stats.size));
        const fd = fs.openSync(resolvedPath, 'r');
        fs.readSync(fd, probe, 0, probe.length, 0);
        fs.closeSync(fd);
        const isBinary = probe.includes(0);

        if (isBinary) {
          ctx.send(client.ws, {
            type: 'file_content',
            success: true,
            payload: { binary: true, size: stats.size, path: resolvedPath },
            requestId,
          });
          return;
        }

        const content = fs.readFileSync(resolvedPath, 'utf-8');

        ctx.send(client.ws, {
          type: 'file_content',
          success: true,
          payload: { content, path: resolvedPath },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'file_content',
          success: false,
          error: `Cannot read file: ${err instanceof Error ? err.message : 'Unknown error'}`,
          requestId,
        });
      }
    },

    search_files(client, payload, requestId) {
      const searchPayload = payload as { query: string; limit?: number; sessionId?: string } | undefined;
      const query = searchPayload?.query?.trim();
      if (!query) {
        ctx.send(client.ws, {
          type: 'search_files_result',
          success: true,
          payload: { files: [] },
          requestId,
        });
        return;
      }

      const projectRoot = ctx.getProjectRoot(searchPayload?.sessionId);
      if (!projectRoot) {
        ctx.send(client.ws, {
          type: 'search_files_result',
          success: false,
          error: 'No active project',
          requestId,
        });
        return;
      }

      try {
        const allFiles = getFileTree(projectRoot);
        const limit = searchPayload?.limit || DEFAULT_FILE_SEARCH_LIMIT;

        const scored = allFiles
          .map((f) => ({
            path: f,
            relativePath: path.relative(projectRoot, f),
            score: fuzzyScore(query, f, projectRoot),
          }))
          .filter((f) => f.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        ctx.send(client.ws, {
          type: 'search_files_result',
          success: true,
          payload: { files: scored.map((f) => ({ path: f.path, relativePath: f.relativePath })) },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'search_files_result',
          success: false,
          error: `Search failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          requestId,
        });
      }
    },

    check_files_exist(client, payload, requestId) {
      const checkPayload = payload as { paths: string[] } | undefined;
      const paths = checkPayload?.paths;
      if (!paths || !Array.isArray(paths)) {
        ctx.send(client.ws, {
          type: 'files_exist_result',
          success: true,
          payload: { results: {} },
          requestId,
        });
        return;
      }

      const projectRoot = ctx.getProjectRoot();
      const results: Record<string, boolean> = {};

      for (const p of paths) {
        const resolved = projectRoot ? path.resolve(projectRoot, p) : null;
        results[p] = resolved ? fs.existsSync(resolved) : false;
      }

      ctx.send(client.ws, {
        type: 'files_exist_result',
        success: true,
        payload: { results },
        requestId,
      });
    },

    open_in_editor(client, payload, requestId) {
      const openPayload = payload as { path: string } | undefined;
      const filePath = openPayload?.path;

      if (!filePath) {
        ctx.send(client.ws, {
          type: 'open_in_editor',
          success: false,
          error: 'No file path provided',
          requestId,
        });
        return;
      }

      try {
        const homeDir = ctx.tmux.getHomeDir();
        let resolvedPath: string;

        if (filePath.startsWith('~/')) {
          resolvedPath = path.join(homeDir, filePath.slice(2));
        } else if (filePath.startsWith('/')) {
          resolvedPath = filePath;
        } else {
          resolvedPath = path.resolve(homeDir, filePath);
        }

        resolvedPath = path.normalize(resolvedPath);

        const configPaths = (ctx.config.allowedPaths || []).map((p) => path.normalize(p));
        const allowedPaths = [homeDir, '/tmp', '/var/tmp', ...configPaths];
        const isAllowed = allowedPaths.some((allowed) => resolvedPath.startsWith(allowed));

        if (!isAllowed) {
          ctx.send(client.ws, {
            type: 'open_in_editor',
            success: false,
            error: `Access denied: file outside allowed directories`,
            requestId,
          });
          return;
        }

        if (!fs.existsSync(resolvedPath)) {
          ctx.send(client.ws, {
            type: 'open_in_editor',
            success: false,
            error: 'File not found',
            requestId,
          });
          return;
        }

        const editor = process.env.VISUAL || process.env.EDITOR;
        let cmd: string;
        let args: string[];

        if (editor) {
          const parts = editor.split(/\s+/);
          cmd = parts[0];
          args = [...parts.slice(1), resolvedPath];
        } else if (process.platform === 'darwin') {
          cmd = 'open';
          args = [resolvedPath];
        } else {
          cmd = 'xdg-open';
          args = [resolvedPath];
        }

        const child = spawn(cmd, args, {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        console.log(`Open in editor: ${cmd} ${args.join(' ')}`);

        ctx.send(client.ws, {
          type: 'open_in_editor',
          success: true,
          payload: { path: resolvedPath, editor: cmd },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'open_in_editor',
          success: false,
          error: `Failed to open file: ${err instanceof Error ? err.message : 'Unknown error'}`,
          requestId,
        });
      }
    },

    download_file(client, payload, requestId) {
      const dlPayload = payload as { path: string } | undefined;
      const filePath = dlPayload?.path;

      if (!filePath) {
        ctx.send(client.ws, {
          type: 'file_download',
          success: false,
          error: 'No file path provided',
          requestId,
        });
        return;
      }

      try {
        const homeDir = ctx.tmux.getHomeDir();
        let resolvedPath: string;

        if (filePath.startsWith('~/')) {
          resolvedPath = path.join(homeDir, filePath.slice(2));
        } else if (filePath.startsWith('/')) {
          resolvedPath = filePath;
        } else {
          resolvedPath = path.resolve(homeDir, filePath);
        }

        resolvedPath = path.normalize(resolvedPath);

        const configPaths = (ctx.config.allowedPaths || []).map((p) => path.normalize(p));
        const allowedPaths = [homeDir, '/tmp', '/var/tmp', ...configPaths];
        const isAllowed = allowedPaths.some((allowed) => resolvedPath.startsWith(allowed));

        if (!isAllowed) {
          ctx.send(client.ws, {
            type: 'file_download',
            success: false,
            error: `Access denied: file outside allowed directories`,
            requestId,
          });
          return;
        }

        const allowedExtensions = ['.apk', '.ipa', '.zip', '.tar.gz', '.tgz'];
        const ext = path.extname(resolvedPath).toLowerCase();
        const isApkOrZip = allowedExtensions.some((e) => resolvedPath.toLowerCase().endsWith(e));

        if (!isApkOrZip) {
          ctx.send(client.ws, {
            type: 'file_download',
            success: false,
            error: `File type not allowed for download. Allowed: ${allowedExtensions.join(', ')}`,
            requestId,
          });
          return;
        }

        const stats = fs.statSync(resolvedPath);

        if (stats.isDirectory()) {
          ctx.send(client.ws, {
            type: 'file_download',
            success: false,
            error: 'Path is a directory, not a file',
            requestId,
          });
          return;
        }

        const maxSize = MAX_APK_FILE_SIZE_BYTES;
        if (stats.size > maxSize) {
          ctx.send(client.ws, {
            type: 'file_download',
            success: false,
            error: `File too large (max 150MB, file is ${Math.round(stats.size / 1024 / 1024)}MB)`,
            requestId,
          });
          return;
        }

        const content = fs.readFileSync(resolvedPath);
        const base64 = content.toString('base64');
        const fileName = path.basename(resolvedPath);

        console.log(
          `WebSocket: Sending file download: ${fileName} (${Math.round(stats.size / 1024)}KB)`
        );

        ctx.send(client.ws, {
          type: 'file_download',
          success: true,
          payload: {
            fileName,
            size: stats.size,
            mimeType:
              ext === '.apk' ? 'application/vnd.android.package-archive' : 'application/octet-stream',
            data: base64,
          },
          requestId,
        });
      } catch (err) {
        ctx.send(client.ws, {
          type: 'file_download',
          success: false,
          error: `Cannot download file: ${err instanceof Error ? err.message : 'Unknown error'}`,
          requestId,
        });
      }
    },
  };
}
