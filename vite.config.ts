import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

// Copy LiteRT.js's wasm runtime into dist/litert/ so the on-device embedder
// loads it from an extension-local URL instead of a CDN — keeps local RAG
// working offline and within the MV3 CSP. Only the base (non-threaded,
// non-JSPI) variant is bundled: localEmbed.ts points loadLiteRt() directly at
// its .js file rather than the wasm/ directory, so the threaded/JSPI variants
// (which need cross-origin isolation / an origin trial the offscreen document
// doesn't have) are never auto-selected — same single-threaded-CPU-fallback
// stability tradeoff the old ONNX Runtime setup made, while still allowing
// the WebGPU delegate (a separate acceleration path, not the wasm threading
// this avoids). The ~9 MB binary stays in node_modules (not committed); it's
// emitted only at build time.
function copyLiteRtWasm(): Plugin {
  return {
    name: 'copy-litert-wasm',
    apply: 'build',
    writeBundle() {
      const litertDist = join(process.cwd(), 'node_modules', '@litertjs', 'core', 'wasm');
      const outDir = join('dist', 'litert');
      mkdirSync(outDir, { recursive: true });
      for (const f of ['litert_wasm_internal.js', 'litert_wasm_internal.wasm']) {
        copyFileSync(join(litertDist, f), join(outDir, f));
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
  plugins: [preact(), copyLiteRtWasm()],
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
