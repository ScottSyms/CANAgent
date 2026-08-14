// Hybrid retrieval: fuse the dense semantic ranking (vectorSearch.scoreVectors)
// with the lexical BM25 ranking (keywordSearch.bm25Rank) using Reciprocal Rank
// Fusion. Pure functions, no chrome.* / OPFS / DOM — shared by the offscreen
// repo store and the Word add-in.
//
// RRF combines lists by *rank*, not raw score, so it sidesteps the fact that
// cosine dot-products and BM25 scores live on entirely different scales — no
// per-query normalization, no tunable blend weight. A chunk's fused score is the
// sum over each list it appears in of 1/(rrfK + rank).

import { bm25Rank, bm25RankIndexed, type KeywordIndex } from './keywordSearch';
import { chunkToHit, scoreVectors, type SearchHit, type SearchParams } from './vectorSearch';

export interface RankedItem {
  i: number;
  score: number;
}

export interface RrfParams {
  /** Ranked lists (each already sorted best-first). */
  lists: RankedItem[][];
  k: number;
  /** RRF constant; larger = flatter contribution from top ranks. Default 60. */
  rrfK?: number;
  /**
   * Per-list candidate cap: only each list's top `pool` entries contribute, so a
   * chunk buried deep in one ranking doesn't earn fusion credit. Default
   * max(k * 10, 50).
   */
  pool?: number;
}

/**
 * Reciprocal Rank Fusion over any number of ranked lists. Returns the top-`k`
 * item indices by fused score, descending. Ties (equal fused score) keep the
 * earlier-discovered item first (stable).
 */
export function fuseRRF(params: RrfParams): RankedItem[] {
  const { lists, k } = params;
  const rrfK = params.rrfK ?? 60;
  const pool = params.pool ?? Math.max(k * 10, 50);
  const acc = new Map<number, number>();
  const order: number[] = [];
  for (const list of lists) {
    const cap = Math.min(list.length, pool);
    for (let rank = 0; rank < cap; rank++) {
      const { i } = list[rank];
      if (!acc.has(i)) order.push(i);
      acc.set(i, (acc.get(i) ?? 0) + 1 / (rrfK + rank + 1));
    }
  }
  return order
    .map((i) => ({ i, score: acc.get(i) as number }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export interface HybridParams extends SearchParams {
  /** Raw query text for the lexical (BM25) ranking. */
  query: string;
  rrfK?: number;
  pool?: number;
  keywordIndex?: KeywordIndex;
  /** Optional pre-ranked chunk lists from grounded retrieval sources such as a knowledge graph. */
  supplementalRankings?: RankedItem[][];
}

export interface MultiHybridParams extends Omit<SearchParams, 'queryVector'> {
  queryVectors: number[][];
  queries?: string[];
  hybrid?: boolean;
  rrfK?: number;
  pool?: number;
  keywordIndex?: KeywordIndex;
  /** Optional pre-ranked chunk lists from grounded retrieval sources such as a knowledge graph. */
  supplementalRankings?: RankedItem[][];
}

/**
 * Top-`k` chunks by hybrid (semantic + BM25, fused with RRF). Falls back to pure
 * semantic ranking when the query has no lexical tokens. The returned `score` is
 * the RRF score, not a cosine similarity — use it only for ordering.
 */
export function hybridSearch(params: HybridParams): SearchHit[] {
  const { chunks, query, k, dim, perDimScale, chunkCount, vectors, queryVector } = params;
  if (chunkCount === 0) return [];
  const pool = params.pool ?? Math.max(k * 10, 50);
  // Fusion only ever consumes each list's top `pool` entries, so the dense
  // ranking only needs its top-`pool` computed, not a full sort of the corpus.
  const semantic = scoreVectors({ dim, perDimScale, chunkCount, vectors, queryVector }, pool);
  const keyword = params.keywordIndex ? bm25RankIndexed({ index: params.keywordIndex, query }) : bm25Rank({ chunks, query });
  // No query terms matched anything lexically: nothing to fuse, just use dense.
  const lists = keyword.length > 0 ? [semantic, keyword] : [semantic];
  for (const ranking of params.supplementalRankings ?? []) if (ranking.length > 0) lists.push(ranking);
  return fuseRRF({ lists, k, rrfK: params.rrfK, pool })
    .map(({ i, score }) => {
      const c = chunks[i];
      return c ? chunkToHit(c, score) : null;
    })
    .filter((r): r is SearchHit => r !== null);
}

export function multiHybridSearch(params: MultiHybridParams): SearchHit[] {
  const { chunks, k, queryVectors, queries = [], hybrid = true } = params;
  if (params.chunkCount === 0 || queryVectors.length === 0) return [];
  const pool = params.pool ?? Math.max(k * 10, 50);
  const lists: RankedItem[][] = [];
  for (let i = 0; i < queryVectors.length; i++) {
    lists.push(scoreVectors({ ...params, queryVector: queryVectors[i] }, pool));
    const q = queries[i];
    if (hybrid && q) {
      const keyword = params.keywordIndex ? bm25RankIndexed({ index: params.keywordIndex, query: q }) : bm25Rank({ chunks, query: q });
      if (keyword.length > 0) lists.push(keyword);
    }
  }
  for (const ranking of params.supplementalRankings ?? []) if (ranking.length > 0) lists.push(ranking);
  return fuseRRF({ lists, k, rrfK: params.rrfK, pool })
    .map(({ i, score }) => {
      const c = chunks[i];
      return c ? chunkToHit(c, score) : null;
    })
    .filter((r): r is SearchHit => r !== null);
}
