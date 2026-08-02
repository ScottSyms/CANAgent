import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

// Copy the ONNX Runtime Web wasm binary into dist/ort/ so the on-device
// embedder (transformers.js) loads it from an extension-local URL instead of a
// CDN — keeps local RAG working offline and within the MV3 CSP. The ~20 MB
// binary stays in node_modules (not committed); it's emitted only at build time.
function copyOrtWasm(): Plugin {
  return {
    name: 'copy-ort-wasm',
    apply: 'build',
    writeBundle() {
      const ortDist = join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist');
      const outDir = join('dist', 'ort');
      mkdirSync(outDir, { recursive: true });
      for (const f of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
        try {
          copyFileSync(join(ortDist, f), join(outDir, f));
        } catch {
          // Variant not present in this onnxruntime-web build — skip.
        }
      }
    },
  };
}

// Build-stamp version shown in the header: YYMMDDHHmm — two-digit year, month,
// day, hour (24h), and minute, all zero-padded, in LOCAL time so the stamp
// matches the wall clock of whoever built it. Computed once per build, so it
// identifies the build rather than ticking while the panel is open.
function buildVersion(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(now.getFullYear() % 100)}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}`;
}

// Builds the sidebar page and the background service worker.
// The content script is built separately (vite.content.config.ts) because it
// must be a single self-contained IIFE.
export default defineConfig({
  plugins: [preact(), copyOrtWasm()],
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidebar: 'sidebar.html',
        offscreen: 'offscreen.html',
        microphone: 'microphone.html',
        workspace: 'workspace.html',
        notebooks: 'notebooks.html',
        serviceWorker: 'src/background/serviceWorker.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'serviceWorker' ? 'serviceWorker.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
