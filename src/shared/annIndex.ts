// Approximate-nearest-neighbor candidate generation for embedding vectors, via
// random-hyperplane locality-sensitive hashing (LSH). Pure math, dependency-free
// — same style as docGraph.ts/chunkClusters.ts, which are this module's only
// callers. Both of those used to run an O(n²) all-pairs cosine-similarity scan
// to find near-duplicate/near-neighbor vectors; at "large graph" scale (node or
// chunk counts in the thousands+) that quadratic cost was the single biggest
// risk to a bounded build time. This module turns that into ~O(n) average case:
// vectors are bucketed by a short bit signature (sign of the dot product
// against a fixed set of random hyperplanes), and only vectors sharing a bucket
// (or a bucket one bit-flip away, to catch near-boundary pairs) are ever
// compared directly.
//
// This is approximate — a few true near-duplicates can land in different
// buckets and get missed — but both callers already tolerate some inexactness
// (a 0.9 cosine-similarity floor for entity dedup, a fixed k=5 neighbor cap for
// the chunk-similarity graph), so trading a small amount of recall for a large
// constant-factor speedup is the right tradeoff for this codebase's perf goals.

export interface AnnIndex {
  dim: number;
  bits: number;
  /** Bucket signature -> vector indices landing in that bucket. */
  buckets: Map<number, number[]>;
}

// Deterministic PRNG (mulberry32) so hyperplanes — and therefore bucket
// assignment and candidate pairs — are reproducible run-to-run without a
// dependency. The seed is fixed, not derived from input, since determinism
// across calls (not cryptographic unpredictability) is all that's needed here.
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildHyperplanes(dim: number, bits: number): number[][] {
  const rand = mulberry32(0x9e3779b1);
  const planes: number[][] = [];
  for (let b = 0; b < bits; b++) {
    const plane = new Array<number>(dim);
    for (let d = 0; d < dim; d++) plane[d] = rand() * 2 - 1;
    planes.push(plane);
  }
  return planes;
}

function signatureOf(vector: number[], planes: number[][]): number {
  let sig = 0;
  for (let b = 0; b < planes.length; b++) {
    const plane = planes[b];
    let dot = 0;
    for (let d = 0; d < vector.length && d < plane.length; d++) dot += vector[d] * plane[d];
    if (dot >= 0) sig |= 1 << b;
  }
  return sig >>> 0;
}

/**
 * Pick a bucket-count (as a bit-width) that targets a small, roughly-constant
 * number of vectors per bucket (~8) regardless of corpus size, clamped to a
 * sane range: too few bits degenerates toward brute force (large buckets), too
 * many wastes buckets on tiny inputs and can miss neighbors that should share a
 * bucket. 31 bits is `signatureOf`'s practical ceiling (bit ops are 32-bit).
 *
 * Below `BRUTE_FORCE_CUTOFF`, bucketing buys nothing (n² is already cheap at
 * that scale) and only adds a small chance of missing a true neighbor that
 * happened to land one bit-flip too far away — so this returns 0, which
 * `buildAnnIndex` treats as "one bucket," i.e. exact brute force.
 */
const BRUTE_FORCE_CUTOFF = 64;
export function recommendedBits(n: number): number {
  if (n <= BRUTE_FORCE_CUTOFF) return 0;
  const bits = Math.ceil(Math.log2(n / 8));
  return Math.max(6, Math.min(20, bits));
}

/** Bucket `vectors` (all the same dimension) for approximate-neighbor lookup. */
export function buildAnnIndex(vectors: number[][], opts: { bits?: number } = {}): AnnIndex {
  const dim = vectors[0]?.length ?? 0;
  const bits = dim === 0 ? 0 : (opts.bits ?? recommendedBits(vectors.length));
  const buckets = new Map<number, number[]>();
  if (bits === 0) {
    // No usable dimensions to hash on — every vector falls in one bucket,
    // which correctly (if slowly) degrades to brute force via candidatePairs.
    buckets.set(0, vectors.map((_, i) => i));
    return { dim, bits, buckets };
  }
  const planes = buildHyperplanes(dim, bits);
  for (let i = 0; i < vectors.length; i++) {
    const sig = signatureOf(vectors[i], planes);
    let list = buckets.get(sig);
    if (!list) buckets.set(sig, (list = []));
    list.push(i);
  }
  return { dim, bits, buckets };
}

/**
 * Yield candidate index pairs `[i, j]` (always `i < j`, each pair yielded
 * once) likely to be near neighbors: every pair sharing an exact bucket, plus
 * — when `multiProbe` is true (the default) — pairs one bit-flip apart, to
 * catch vectors that landed just across a bucket boundary. Callers still do
 * the real cosine-similarity check; this only narrows which pairs are worth
 * checking at all.
 */
export function* candidatePairs(index: AnnIndex, opts: { multiProbe?: boolean } = {}): Generator<[number, number]> {
  const multiProbe = (opts.multiProbe ?? true) && index.bits > 0;
  const seenBucketPairs = new Set<number>();

  function* pairsWithin(list: number[]): Generator<[number, number]> {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const a = list[x];
        const b = list[y];
        yield a < b ? [a, b] : [b, a];
      }
    }
  }
  function* pairsAcross(a: number[], b: number[]): Generator<[number, number]> {
    for (const x of a) {
      for (const y of b) {
        if (x === y) continue;
        yield x < y ? [x, y] : [y, x];
      }
    }
  }

  for (const [sig, list] of index.buckets) {
    yield* pairsWithin(list);
    if (!multiProbe) continue;
    for (let b = 0; b < index.bits; b++) {
      const neighborSig = sig ^ (1 << b);
      if (neighborSig <= sig) continue; // each unordered bucket pair visited once
      const bucketPairKey = sig * (2 ** index.bits) + neighborSig;
      if (seenBucketPairs.has(bucketPairKey)) continue;
      seenBucketPairs.add(bucketPairKey);
      const neighborList = index.buckets.get(neighborSig);
      if (neighborList) yield* pairsAcross(list, neighborList);
    }
  }
}

/**
 * Adjacency restricted to `j > i` (one direction only) — the shape a
 * greedy, ascending-order merge pass wants: for each `i` in order, "what
 * higher-index candidates might it absorb."
 */
export function buildForwardAdjacency(index: AnnIndex): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (const [i, j] of candidatePairs(index)) {
    let list = adj.get(i);
    if (!list) adj.set(i, (list = []));
    list.push(j);
  }
  return adj;
}

/** Adjacency in both directions — the shape a symmetric top-k neighbor search wants. */
export function buildSymmetricAdjacency(index: AnnIndex, n: number): number[][] {
  const adj: number[][] = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = [];
  for (const [i, j] of candidatePairs(index)) {
    adj[i].push(j);
    adj[j].push(i);
  }
  return adj;
}
