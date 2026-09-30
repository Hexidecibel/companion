/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import pkg from './package.json';

/**
 * Herald's voice activity detection (Silero via @ricky0123/vad-web) loads a
 * worklet, an ONNX model and the onnxruntime-web WASM at runtime. Ship them
 * from our own origin under <base>vad/ (never a CDN): emitted into the build,
 * served from node_modules in dev.
 */
const VAD_ASSETS: Record<string, string> = {
  'vad/vad.worklet.bundle.min.js': 'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
  'vad/silero_vad_v5.onnx': 'node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx',
  'vad/ort-wasm-simd-threaded.wasm': 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'vad/ort-wasm-simd-threaded.mjs': 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
};

const VAD_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

function heraldVadAssets(): Plugin {
  return {
    name: 'herald-vad-assets',
    generateBundle() {
      for (const [fileName, src] of Object.entries(VAD_ASSETS)) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(resolve(__dirname, src)) });
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0];
        const hit = Object.keys(VAD_ASSETS).find((k) => path.endsWith('/' + k));
        if (!hit) return next();
        const file = resolve(__dirname, VAD_ASSETS[hit]);
        const ext = hit.slice(hit.lastIndexOf('.'));
        res.setHeader('Content-Type', VAD_TYPES[ext] || 'application/octet-stream');
        res.setHeader('Content-Length', String(statSync(file).size));
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), heraldVadAssets()],
  resolve: {
    alias: [
      // The "bundle" ORT build references its 14 MB wasm via import.meta.url,
      // which Vite would emit a second time; this build loads it only from
      // env.wasm.wasmPaths (our <base>vad/ copy).
      { find: /^onnxruntime-web\/wasm$/, replacement: resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs') },
    ],
  },
  base: '/web/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:9877',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // This machine exports NODE_ENV=production globally, which loads React's
    // production build (no act()) and breaks hook/component tests.
    env: { NODE_ENV: 'test' },
  },
});
