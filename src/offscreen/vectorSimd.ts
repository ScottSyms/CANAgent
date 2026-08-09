// =============================================================================
// Offscreen-only loader for the Rust/WASM batch dot-product kernel (see
// wasm/vector-simd/). This module is imported only from offscreen.ts — never
// from src/shared/vectorSearch.ts itself, which stays dependency-free and is
// shared with the Office add-in build (word-addin/), a separate environment
// with no guarantee of MV3's 'wasm-unsafe-eval' CSP. vectorSearch.ts exposes
// setSimdBackend() as the one hook this module plugs into; the JS loop
// remains the automatic fallback everywhere else.
// =============================================================================

import init, { dot_product_batch } from './vectorSimdPkg/vector_simd.js';

let ready: Promise<boolean> | null = null;

/** Instantiate the WASM module once. Returns false (never throws) on any failure
 * — an unsupported browser or a build/CSP issue should silently fall back to JS. */
export function initVectorSimd(): Promise<boolean> {
  if (!ready) {
    ready = init()
      .then(() => true)
      .catch((e) => {
        console.warn('[vectorSimd] WASM init failed, staying on the JS fallback:', e);
        return false;
      });
  }
  return ready;
}

/** Score every chunk against a query in one WASM call. Only call after
 * `initVectorSimd()` has resolved `true`. */
export function simdDotBatch(vectors: Int8Array, qw: Float32Array, dim: number, chunkCount: number): Float32Array {
  return dot_product_batch(vectors, qw, dim, chunkCount);
}
