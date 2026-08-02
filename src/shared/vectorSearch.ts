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
 * Score **every** chunk against `queryVector`, returned sorted by score
 * descending. Dot-product over the int8 vectors, with the query-constant factors
 * (the quantized query and the per-dim scale²) folded into one weight vector so
 * the hot loop is a single multiply-add. This is the semantic ranking used both
 * by `searchVectors` (top-k) and by hybrid fusion (which needs the full ranking).
 */
export function scoreVectors(
  params: Pick<SearchParams, 'dim' | 'perDimScale' | 'chunkCount' | 'vectors' | 'queryVector'>,
): Array<{ i: number; score: number }> {
  const { dim, perDimScale, chunkCount, vectors, queryVector } = params;
  if (chunkCount === 0) return [];
  if (queryVector.length !== dim) {
    throw new Error(`Query embedding dimension ${queryVector.length} does not match repo dimension ${dim}.`);
  }
  const q = quantizeVector(normalizeVector(queryVector), perDimScale);
  const qw = new Float32Array(dim);
  for (let d = 0; d < dim; d++) qw[d] = q[d] * perDimScale[d] * perDimScale[d];

  const scored: Array<{ i: number; score: number }> = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const base = i * dim;
    let score = 0;
    for (let d = 0; d < dim; d++) score += vectors[base + d] * qw[d];
    scored[i] = { i, score };
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Return the top-`k` chunks most similar to `queryVector` (pure semantic search).
 */
export function searchVectors(params: SearchParams): SearchHit[] {
  const { chunks, k } = params;
  return scoreVectors(params)
    .slice(0, k)
    .map(({ i, score }) => {
      const c = chunks[i];
      return c ? chunkToHit(c, score) : null;
    })
    .filter((r): r is SearchHit => r !== null);
}
