// Portable similarity-search math for the on-device RAG store. Pure functions,
// no chrome.* / OPFS / DOM — so both the extension's offscreen repo store
// (src/offscreen/repoStore.ts) and the Word add-in (word-addin/) share one
// implementation of how query vectors are normalized, quantized, and scored
// against the stored int8 vectors.

import type { CitableSentence } from './sentenceSplit';

export const QUANT = 127;

/**
 * A chunk as seen by the search functions. `chunkId`/`sentences` carry
 * sentence-level provenance (see src/shared/sentenceSplit.ts) when the store
 * supplies it; both are optional so legacy call sites and tests still type-check.
 */
export interface ChunkInput {
  name: string;
  url: string;
  text: string;
  chunkId?: string;
  sentences?: CitableSentence[];
}

export interface SearchHit {
  text: string;
  name: string;
  url: string;
  score: number;
  /** Stable chunk identifier (`${docId}:c${localChunkIdx}`), when known. */
  chunkId?: string;
  /** Citable sentence spans within `text`, when the store carries provenance. */
  sentences?: CitableSentence[];
}

/** Project a scored chunk into a SearchHit, carrying provenance fields through. */
export function chunkToHit(c: ChunkInput, score: number): SearchHit {
  return { text: c.text, name: c.name, url: c.url, score, chunkId: c.chunkId, sentences: c.sentences };
}

/** L2-normalize a vector (zero vectors are left as-is via the `|| 1` guard). */
export function normalizeVector(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** Quantize a (normalized) vector to int8 using the repo's per-dimension scale. */
export function quantizeVector(v: number[], scale: number[]): Int8Array {
  const out = new Int8Array(v.length);
  for (let d = 0; d < v.length; d++) {
    const s = scale[d] || 1;
    out[d] = Math.max(-QUANT, Math.min(QUANT, Math.round((v[d] / s) * QUANT)));
  }
  return out;
}

/** Inverse of `quantizeVector`: reconstruct an approximate float vector from a stored int8 row, so an already-computed embedding can be reused (e.g. as a similarity-search query) without re-embedding. */
export function dequantizeVector(v: Int8Array | ArrayLike<number>, scale: number[]): number[] {
  const out = new Array(v.length);
  for (let d = 0; d < v.length; d++) out[d] = (v[d] / QUANT) * (scale[d] || 1);
  return out;
}

export interface SearchParams {
  dim: number;
  perDimScale: number[];
  chunkCount: number;
  /** Packed int8 vectors: chunkCount × dim, row i at [i*dim, (i+1)*dim). */
  vectors: Int8Array;
  /** Chunk records aligned to the vector rows. */
  chunks: ChunkInput[];
  queryVector: number[];
  k: number;
}

/**
 * Select the top-`limit` `{i, score}` pairs out of `n` candidates by score
 * descending, using a fixed-size min-heap so the full candidate set is never
 * sorted: O(n log limit) instead of O(n log n). Callers of `scoreVectors` only
 * ever consume a small prefix (search top-k, or RRF fusion's `pool`), so this
 * is a pure win with no change in the results returned.
 */
function topKByScore(n: number, limit: number, scoreFn: (i: number) => number): Array<{ i: number; score: number }> {
  const heapI = new Int32Array(limit);
  const heapS = new Float64Array(limit);
  let size = 0;

  const swap = (a: number, b: number) => {
    const ts = heapS[a]; heapS[a] = heapS[b]; heapS[b] = ts;
    const ti = heapI[a]; heapI[a] = heapI[b]; heapI[b] = ti;
  };
  const siftDown = (start: number) => {
    let pos = start;
    for (;;) {
      let smallest = pos;
      const l = 2 * pos + 1;
      const r = 2 * pos + 2;
      if (l < size && heapS[l] < heapS[smallest]) smallest = l;
      if (r < size && heapS[r] < heapS[smallest]) smallest = r;
      if (smallest === pos) break;
      swap(pos, smallest);
      pos = smallest;
    }
  };
  const siftUp = (start: number) => {
    let pos = start;
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (heapS[parent] <= heapS[pos]) break;
      swap(pos, parent);
      pos = parent;
    }
  };

  for (let i = 0; i < n; i++) {
    const score = scoreFn(i);
    if (size < limit) {
      heapS[size] = score;
      heapI[size] = i;
      siftUp(size);
      size++;
    } else if (score > heapS[0]) {
      heapS[0] = score;
      heapI[0] = i;
      siftDown(0);
    }
  }

  const out: Array<{ i: number; score: number }> = new Array(size);
  for (let k = 0; k < size; k++) out[k] = { i: heapI[k], score: heapS[k] };
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Optional WASM-accelerated batch scorer for the hot loop below, injected by
 * the Chrome-extension offscreen document only (src/offscreen/vectorSimd.ts) —
 * never loaded by this file itself. This module is shared with the Office
 * add-in build (word-addin/), a separate environment with no guarantee of
 * MV3's 'wasm-unsafe-eval' CSP, so it must stay dependency-free; callers that
 * never call `setSimdBackend` (e.g. the add-in) get byte-for-byte the same JS
 * behavior as before this existed.
 */
type SimdBackend = (vectors: Int8Array, qw: Float32Array, dim: number, chunkCount: number) => Float32Array;
let simdBackend: SimdBackend | null = null;
/** Below this many chunks, the JS↔WASM call/marshaling overhead isn't worth it. */
const SIMD_MIN_CHUNKS = 300;

/** Register (or clear, passing null) a batch scorer used by `scoreVectors` for
 * corpora at or above `SIMD_MIN_CHUNKS`. See the type doc above for scope. */
export function setSimdBackend(fn: SimdBackend | null): void {
  simdBackend = fn;
}

/**
 * Score chunks against `queryVector`, returned sorted by score descending.
 * Dot-product over the int8 vectors, with the query-constant factors (the
 * quantized query and the per-dim scale²) folded into one weight vector so the
 * hot loop is a single multiply-add. This is the semantic ranking used both by
 * `searchVectors` (top-k) and by hybrid fusion.
 *
 * When `limit` is given and smaller than `chunkCount`, only the top-`limit`
 * results are computed and returned (via a bounded min-heap) instead of fully
 * sorting every chunk in the corpus — callers that only need a top-k or a
 * fusion pool should always pass it. Omit `limit` to get the full ranking.
 */
export function scoreVectors(
  params: Pick<SearchParams, 'dim' | 'perDimScale' | 'chunkCount' | 'vectors' | 'queryVector'>,
  limit?: number,
): Array<{ i: number; score: number }> {
  const { dim, perDimScale, chunkCount, vectors, queryVector } = params;
  if (chunkCount === 0) return [];
  if (queryVector.length !== dim) {
    throw new Error(`Query embedding dimension ${queryVector.length} does not match repo dimension ${dim}.`);
  }
  const q = quantizeVector(normalizeVector(queryVector), perDimScale);
  const qw = new Float32Array(dim);
  for (let d = 0; d < dim; d++) qw[d] = q[d] * perDimScale[d] * perDimScale[d];

  let scoreAt: (i: number) => number;
  if (simdBackend && chunkCount >= SIMD_MIN_CHUNKS) {
    const scores = simdBackend(vectors, qw, dim, chunkCount);
    scoreAt = (i) => scores[i];
  } else {
    scoreAt = (i) => {
      const base = i * dim;
      let score = 0;
      for (let d = 0; d < dim; d++) score += vectors[base + d] * qw[d];
      return score;
    };
  }

  if (limit !== undefined && limit > 0 && limit < chunkCount) {
    return topKByScore(chunkCount, limit, scoreAt);
  }

  const scored: Array<{ i: number; score: number }> = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) scored[i] = { i, score: scoreAt(i) };
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Return the top-`k` chunks most similar to `queryVector` (pure semantic search).
 */
export function searchVectors(params: SearchParams): SearchHit[] {
  const { chunks, k } = params;
  return scoreVectors(params, k)
    .slice(0, k)
    .map(({ i, score }) => {
      const c = chunks[i];
      return c ? chunkToHit(c, score) : null;
    })
    .filter((r): r is SearchHit => r !== null);
}
