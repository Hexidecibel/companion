// @vitest-environment node
/**
 * Every runtime asset the bundle loads by URL (the VAD worklet, Silero model,
 * onnxruntime WASM + glue, the AEC worklet + WASM, the capture / PCM worklets,
 * lazy chunks) must resolve under BOTH bases: `/web/` (web/dist, served by the
 * daemon) and `/` (web/dist-desktop, the Tauri apps). A path hardcoded to one
 * base would break voice in only one of them (e.g. hands-free only in the
 * desktop apps), so both bundles are built here and every URL is checked.
 */
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WEB = resolve(__dirname, '../../..');

/** Files the VAD / ORT runtime fetch from `<base>vad/` by name (not visible as full URLs in the bundle). */
const VAD_RUNTIME = ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Absolute URLs under `base` referenced from the built JS / HTML. */
export function referencedUrls(dist: string, base: string): string[] {
  const esc = base.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = new RegExp(`["'\`](${esc}(?:assets|vad)/[^"'\`?#\\s]+)`, 'g');
  const out = new Set<string>();
  for (const f of walk(dist)) {
    if (!/\.(js|mjs|html)$/.test(f)) continue;
    for (const m of readFileSync(f, 'utf-8').matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

async function buildWith(base: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'herald-assets-'));
  await build({
    root: WEB,
    configFile: join(WEB, 'vite.config.ts'),
    base,
    logLevel: 'silent',
    build: { outDir, emptyOutDir: true, reportCompressedSize: false },
  });
  return outDir;
}

describe.each([
  { base: '/web/', other: '/' },
  { base: '/', other: '/web/' },
])('runtime asset URLs with base $base', ({ base }) => {
  it('every referenced asset exists, the VAD files ship under <base>vad/, and nothing points at the other base', async () => {
    const dist = await buildWith(base);
    try {
      const urls = referencedUrls(dist, base);
      // The worklets and WASM really are referenced (guards the regex itself).
      expect(urls.some((u) => /aecWorklet-.*\.js$/.test(u))).toBe(true);
      expect(urls.some((u) => /webrtcaec3-.*\.wasm$/.test(u))).toBe(true);
      expect(urls.some((u) => /captureWorklet-.*\.js$/.test(u))).toBe(true);
      const missing = urls.filter((u) => !existsSync(join(dist, u.slice(base.length))));
      expect(missing).toEqual([]);
      for (const f of VAD_RUNTIME) expect(existsSync(join(dist, 'vad', f))).toBe(true);
      // The base the VAD loader prefixes (import.meta.env.BASE_URL) is this build's.
      const js = walk(join(dist, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf-8')).join('\n');
      if (base === '/') {
        expect(js).not.toMatch(/["'`]\/web\/(assets|vad)\//);
      }
      const html = readFileSync(join(dist, 'index.html'), 'utf-8');
      for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        if (m[1].startsWith('http') || m[1].startsWith('data:')) continue;
        expect(m[1].startsWith(base)).toBe(true);
        expect(existsSync(join(dist, m[1].slice(base.length)))).toBe(true);
      }
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }, 180_000);
});
