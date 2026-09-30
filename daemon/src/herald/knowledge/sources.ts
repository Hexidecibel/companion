/**
 * Herald's read-only knowledge sources: grounded lookups over the user's own
 * documentation, never prompt stuffing. Each search returns at most a bounded
 * set of best-matching sections (with their source path) or an honest
 * "not found" / "unavailable".
 *
 *   search_infra          /mnt/hexinas/apps/INFRASTRUCTURE.md (NAS mount; may be down)
 *   cush_tools_help       cush-tools README / CLAUDE.md / lessons + the cush-tools
 *                         section of the user's global CLAUDE.md
 *   search_project_notes  CLAUDE.md / plan.md / todo.md / FEATURES.md / README.md of
 *                         projects under ~/local/src that have a CLAUDE.md or plan.md
 *   search_memory         Claude Code memory notes (<code_home>/projects/<p>/memory/*.md)
 *
 * All file access goes through redact.safeReadText (denylist + realpath + size cap
 * + redaction), and every result is redacted again on the way out.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Chunk,
  FileChunkCache,
  rankChunks,
  RESULT_BUDGET_CHARS,
  ScoredChunk,
  selectWithinBudget,
  tokenize,
} from './retrieval';
import { redactSecrets } from './redact';
import { normalizeRef } from '../resolve';

const PROJECT_NOTE_FILES = ['CLAUDE.md', 'plan.md', 'todo.md', 'FEATURES.md', 'README.md'];
const DIR_LIST_TTL_MS = 30_000;
/** A hung NFS/mergerfs stat must never hang a turn. */
const MOUNT_PROBE_TIMEOUT_MS = 2000;
const MAX_PROJECTS = 300;
const MAX_MEMORY_FILES = 2000;
export const MAX_QUERY_CHARS = 300;

export interface KnowledgePaths {
  /** The real user's home (not a sandbox HOME). */
  userHome: string;
  infraDoc: string;
  cushToolsDir: string;
  projectsRoot: string;
  /** <code_home>/projects: holds <project>/memory/*.md. */
  memoryRoot: string;
  /** The user's global CLAUDE.md (only its cush-tools section is searched). */
  userClaudeMd: string;
}

/**
 * Derive paths from the daemon's code_home (~/.claude of the real user; the
 * sandbox overrides HOME but keeps code_home). Env vars override each path.
 */
export function resolveKnowledgePaths(codeHome?: string): KnowledgePaths {
  const env = process.env;
  const fromCodeHome =
    codeHome && path.basename(path.resolve(codeHome)) === '.claude'
      ? path.dirname(path.resolve(codeHome))
      : null;
  const userHome = env.HERALD_USER_HOME || fromCodeHome || os.homedir();
  const claudeHome = codeHome ? path.resolve(codeHome) : path.join(userHome, '.claude');
  return {
    userHome,
    infraDoc: env.HERALD_INFRA_DOC || '/mnt/hexinas/apps/INFRASTRUCTURE.md',
    cushToolsDir: env.HERALD_CUSH_TOOLS_DIR || path.join(userHome, 'local', 'src', 'cush-tools'),
    projectsRoot: env.HERALD_PROJECTS_ROOT || path.join(userHome, 'local', 'src'),
    memoryRoot: path.join(claudeHome, 'projects'),
    userClaudeMd: path.join(userHome, '.claude', 'CLAUDE.md'),
  };
}

export interface SearchResult {
  query: string;
  found: boolean;
  results?: Array<{ source: string; section: string; text: string }>;
  truncated?: boolean;
  /** Present when nothing matched or the source is unavailable. */
  note?: string;
  unavailable?: boolean;
  /** Extra fields for specific tools (e.g. which project matched). */
  [k: string]: unknown;
}

function timeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((resolve) => {
      t = setTimeout(() => resolve(fallback), ms);
      t.unref?.();
    }),
  ]);
}

export class KnowledgeBase {
  readonly paths: KnowledgePaths;
  private cache: FileChunkCache;
  private now: () => number;
  private dirLists = new Map<string, { at: number; value: Promise<string[]> }>();
  /** In-flight NAS probe: a stuck one is not stacked on (each would hold a libuv thread). */
  private mountProbe: Promise<boolean> | null = null;

  constructor(paths: KnowledgePaths, opts: { now?: () => number } = {}) {
    this.paths = paths;
    this.now = opts.now || Date.now;
    this.cache = new FileChunkCache({ extraHomes: [paths.userHome] });
  }

  /** "~/local/src/x/CLAUDE.md" instead of the absolute path. */
  display(p: string): string {
    const home = this.paths.userHome;
    return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
  }

  private finish(
    query: string,
    ranked: ScoredChunk[],
    emptyNote: string,
    extra: Record<string, unknown> = {}
  ): SearchResult {
    if (ranked.length === 0) return { query, found: false, note: emptyNote, ...extra };
    const { sections, truncated } = selectWithinBudget(
      ranked,
      query,
      RESULT_BUDGET_CHARS,
      undefined,
      (p) => this.display(p)
    );
    return {
      query,
      found: sections.length > 0,
      results: sections.map((s) => ({ ...s, text: redactSecrets(s.text) })),
      truncated: truncated || undefined,
      ...extra,
    };
  }

  // ------------------------------------------------------------- infra

  private probeMount(file: string): Promise<boolean> {
    if (this.mountProbe) return this.mountProbe;
    const p = fs.promises
      .stat(file)
      .then((st) => st.isFile())
      .catch(() => false);
    this.mountProbe = p;
    void p.finally(() => {
      if (this.mountProbe === p) this.mountProbe = null;
    });
    return timeout(p, MOUNT_PROBE_TIMEOUT_MS, false);
  }

  async searchInfra(query: string): Promise<SearchResult> {
    const file = this.paths.infraDoc;
    const reachable = await this.probeMount(file);
    const chunks = reachable
      ? await timeout(this.cache.get(file, this.now()), MOUNT_PROBE_TIMEOUT_MS * 2, null)
      : null;
    if (!chunks) {
      return {
        query,
        found: false,
        unavailable: true,
        note: "The infrastructure doc on the NAS isn't reachable right now (the mount may be down). Say you can't check it at the moment; don't guess.",
      };
    }
    return this.finish(
      query,
      rankChunks(chunks, query),
      "Nothing in the infrastructure doc matches that. Say you couldn't find it there."
    );
  }

  /** Port-registry rows mentioning `port` (for tunnel warnings). Null when unknown. */
  async infraPortInfo(port: number): Promise<string | null> {
    const file = this.paths.infraDoc;
    if (!(await this.probeMount(file))) return null;
    const chunks = await timeout(this.cache.get(file, this.now()), MOUNT_PROBE_TIMEOUT_MS, null);
    if (!chunks) return null;
    const re = new RegExp(`^\\s*\\|\\s*${port}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'm');
    for (const c of chunks) {
      if (!c.headings.some((h) => /port registry/i.test(h))) continue;
      const m = c.text.match(re);
      if (m) return redactSecrets(m[1].trim());
    }
    return null;
  }

  // ------------------------------------------------------------- cush-tools docs

  async cushToolsHelp(query: string): Promise<SearchResult> {
    const dir = this.paths.cushToolsDir;
    const files = ['README.md', 'CLAUDE.md', 'lessons.md'].map((f) => path.join(dir, f));
    const all: Chunk[] = [];
    for (const f of files) {
      const chunks = await this.cache.get(f, this.now());
      if (chunks) all.push(...chunks);
    }
    const global = await this.cache.get(this.paths.userClaudeMd, this.now());
    if (global) all.push(...global.filter((c) => c.headings.some((h) => /cush-tools/i.test(h))));
    if (all.length === 0) {
      return {
        query,
        found: false,
        unavailable: true,
        note: "The cush-tools docs aren't readable on this machine. Say you can't check them.",
      };
    }
    return this.finish(
      query,
      rankChunks(all, `${query}`),
      "Nothing in the cush-tools docs matches that. Say you couldn't find it."
    );
  }

  // ------------------------------------------------------------- project notes

  private listDir(dir: string, filter: (names: string[], dir: string) => Promise<string[]>) {
    const hit = this.dirLists.get(dir);
    const now = this.now();
    if (hit && now - hit.at < DIR_LIST_TTL_MS) return hit.value;
    const value = fs.promises
      .readdir(dir, { withFileTypes: true })
      .then((ents) =>
        ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
      )
      .then((names) => filter(names.sort(), dir))
      .catch(() => [] as string[]);
    this.dirLists.set(dir, { at: now, value });
    return value;
  }

  /** Project directory names that have a CLAUDE.md or plan.md. */
  listProjects(): Promise<string[]> {
    return this.listDir(this.paths.projectsRoot, async (names, dir) => {
      const out: string[] = [];
      for (const n of names.slice(0, MAX_PROJECTS * 2)) {
        const has = await Promise.all(
          ['CLAUDE.md', 'plan.md'].map((f) =>
            fs.promises
              .access(path.join(dir, n, f))
              .then(() => true)
              .catch(() => false)
          )
        );
        if (has.some(Boolean)) out.push(n);
        if (out.length >= MAX_PROJECTS) break;
      }
      return out;
    });
  }

  /** Best project match for a user reference ("companion", "doc upload site"). */
  matchProject(ref: string, projects: string[]): string | null {
    const n = normalizeRef(ref);
    if (!n) return null;
    const norm = projects.map((p) => ({ p, k: normalizeRef(p) }));
    const exact = norm.find((x) => x.k === n);
    if (exact) return exact.p;
    const compact = n.replace(/\s+/g, '');
    const squashed = norm.find((x) => x.k.replace(/\s+/g, '') === compact);
    if (squashed) return squashed.p;
    const prefix = norm.filter((x) => x.k.startsWith(n));
    if (prefix.length === 1) return prefix[0].p;
    if (prefix.length > 1) return prefix.sort((a, b) => a.k.length - b.k.length)[0].p;
    const contains = norm.filter((x) => x.k.includes(n) || n.includes(x.k));
    if (contains.length) return contains.sort((a, b) => b.k.length - a.k.length)[0].p;
    return null;
  }

  /** Projects whose names appear in free text (whole words), longest first. */
  private projectsMentioned(text: string, projects: string[]): string[] {
    const n = ` ${normalizeRef(text)} `;
    return projects
      .filter((p) => {
        const k = normalizeRef(p);
        return k.length >= 3 && n.includes(` ${k} `);
      })
      .sort((a, b) => b.length - a.length);
  }

  private async projectChunks(project: string): Promise<Chunk[]> {
    const out: Chunk[] = [];
    for (const f of PROJECT_NOTE_FILES) {
      const chunks = await this.cache.get(
        path.join(this.paths.projectsRoot, project, f),
        this.now()
      );
      if (!chunks) continue;
      // The project name is part of every section's heading path so it scores.
      for (const c of chunks) out.push({ ...c, headings: [project, f, ...c.headings] });
    }
    return out;
  }

  async searchProjectNotes(query: string, project?: string): Promise<SearchResult> {
    const projects = await this.listProjects();
    if (projects.length === 0) {
      return {
        query,
        found: false,
        unavailable: true,
        note: "No project notes are readable on this machine. Say you can't check them.",
      };
    }
    let named: string | null = null;
    if (project && project.trim()) {
      named = this.matchProject(project, projects);
      if (!named) {
        return {
          query,
          found: false,
          note: `No project called "${project}" has notes. Known projects include: ${projects.slice(0, 40).join(', ')}. Ask which one they mean, or search without a project.`,
        };
      }
    }
    const boosted = new Set(named ? [named] : this.projectsMentioned(query, projects));
    if (named) {
      const ranked = rankChunks(await this.projectChunks(named), query);
      if (ranked.length) return this.finish(query, ranked, '', { project: named });
    }
    const all: Chunk[] = [];
    for (const p of projects) all.push(...(await this.projectChunks(p)));
    const ranked = rankChunks(all, query)
      .map((c) => (boosted.has(c.headings[0]) ? { ...c, score: c.score * 2.5 } : c))
      .sort((a, b) => b.score - a.score);
    return this.finish(
      query,
      ranked,
      named
        ? `Nothing in ${named}'s notes (or any other project's) matches that. Say you couldn't find it.`
        : "Nothing in the project notes matches that. Say you couldn't find it.",
      named
        ? {
            project: named,
            note: `Nothing matched in ${named}'s own notes; these are from other projects.`,
          }
        : {}
    );
  }

  // ------------------------------------------------------------- memory

  /** "-home-hexi-local-src-companion" -> "companion"; "-home-hexi" -> "home". */
  static memoryProjectLabel(dirName: string): string {
    const m = dirName.match(/-local-src-(.+)$/);
    if (m) return m[1];
    const parts = dirName.split('-').filter(Boolean);
    return parts.length <= 2 ? 'global' : parts.slice(2).join('-');
  }

  private async memoryFiles(): Promise<string[]> {
    const root = this.paths.memoryRoot;
    const dirs = await this.listDir(root, (names) => Promise.resolve(names));
    const files: string[] = [];
    for (const d of dirs) {
      const memDir = path.join(root, d, 'memory');
      let ents: string[];
      try {
        ents = await fs.promises.readdir(memDir);
      } catch {
        continue;
      }
      for (const e of ents) {
        if (e.endsWith('.md')) files.push(path.join(memDir, e));
        if (files.length >= MAX_MEMORY_FILES) return files;
      }
    }
    return files;
  }

  async searchMemory(query: string): Promise<SearchResult> {
    const files = await this.memoryFiles();
    if (files.length === 0) {
      return {
        query,
        found: false,
        unavailable: true,
        note: "No memory notes are readable on this machine. Say you can't check them.",
      };
    }
    const all: Chunk[] = [];
    for (const f of files) {
      const chunks = await this.cache.get(f, this.now());
      if (!chunks || chunks.length === 0) continue;
      const label = KnowledgeBase.memoryProjectLabel(path.basename(path.dirname(path.dirname(f))));
      const isIndex = path.basename(f) === 'MEMORY.md';
      const { name, description, chunks: body } = stripFrontmatter(chunks);
      const title = name || path.basename(f, '.md');
      body.forEach((c, i) =>
        all.push({
          ...c,
          headings: [`${label} memory`, title, ...c.headings],
          text: i === 0 && description ? `${description}\n${c.text}` : c.text,
          // Index files repeat the notes' one-liners; the notes themselves rank first.
          ...(isIndex
            ? { source: c.source, headings: [`${label} memory index`, ...c.headings] }
            : {}),
        })
      );
    }
    const ranked = rankChunks(all, query)
      .map((c) => (c.headings[0].endsWith('index') ? { ...c, score: c.score * 0.6 } : c))
      .sort((a, b) => b.score - a.score);
    return this.finish(
      query,
      ranked,
      "Nothing in the memory notes matches that. Say you couldn't find it."
    );
  }
}

/** Pull name/description out of a leading YAML frontmatter block (first chunk). */
function stripFrontmatter(chunks: Chunk[]): {
  name?: string;
  description?: string;
  chunks: Chunk[];
} {
  const first = chunks[0];
  const m = first.headings.length === 0 ? first.text.match(/^---\n([\s\S]*?)\n---\s*\n?/) : null;
  if (!m) return { chunks };
  const fm = m[1];
  const pick = (k: string) => {
    const r = fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'));
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : undefined;
  };
  const rest = first.text.slice(m[0].length).trim();
  const out = rest ? [{ ...first, text: rest }, ...chunks.slice(1)] : chunks.slice(1);
  // A note that is only frontmatter still carries its description.
  if (out.length === 0) out.push({ ...first, text: '' });
  return { name: pick('name'), description: pick('description'), chunks: out };
}

/** Exposed for tests: keyword tokens used for ranking. */
export const _tokenize = tokenize;
