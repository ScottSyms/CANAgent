import { describe, expect, it } from 'vitest';
import { buildAnnIndex, buildForwardAdjacency, buildSymmetricAdjacency, candidatePairs, recommendedBits } from './annIndex';

function normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function randomVector(dim: number, seed: number): number[] {
  // Simple deterministic pseudo-random generator local to the test, distinct
  // from the module's internal one, so tests don't depend on its internals.
  let a = seed;
  const rand = () => {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    return a / 0x7fffffff;
  };
  return normalize(Array.from({ length: dim }, () => rand() * 2 - 1));
}

/** Build `count` clusters of `perCluster` near-duplicate vectors (cosine > 0.97 within a cluster) plus `noise` unrelated vectors, all in `dim` dimensions. */
function buildClusteredVectors(dim: number, clusters: number, perCluster: number, noise: number) {
  const vectors: number[][] = [];
  const trueDuplicatePairs = new Set<string>();
  for (let c = 0; c < clusters; c++) {
    const base = randomVector(dim, c * 97 + 1);
    const startIdx = vectors.length;
    for (let m = 0; m < perCluster; m++) {
      const jitter = randomVector(dim, c * 97 + m + 1000).map((x) => x * 0.03);
      vectors.push(normalize(base.map((x, d) => x + jitter[d])));
    }
    for (let x = startIdx; x < startIdx + perCluster; x++) {
      for (let y = x + 1; y < startIdx + perCluster; y++) {
        trueDuplicatePairs.add(`${x}|${y}`);
      }
    }
  }
  for (let i = 0; i < noise; i++) vectors.push(randomVector(dim, i * 733 + 5));
  return { vectors, trueDuplicatePairs };
}

describe('buildAnnIndex / candidatePairs', () => {
  it('finds most true near-duplicate pairs while checking far fewer than n^2 candidates', () => {
    const dim = 64;
    const { vectors, trueDuplicatePairs } = buildClusteredVectors(dim, 20, 6, 800);
    const n = vectors.length;

    const index = buildAnnIndex(vectors);
    const candidates = new Set<string>();
    for (const [i, j] of candidatePairs(index)) candidates.add(`${i}|${j}`);

    let found = 0;
    for (const key of trueDuplicatePairs) {
      const [i, j] = key.split('|').map(Number);
      if (cosine(vectors[i], vectors[j]) >= 0.9 && candidates.has(key)) found++;
    }
    const totalTrue = [...trueDuplicatePairs].filter((key) => {
      const [i, j] = key.split('|').map(Number);
      return cosine(vectors[i], vectors[j]) >= 0.9;
    }).length;

    expect(totalTrue).toBeGreaterThan(0);
    expect(found / totalTrue).toBeGreaterThanOrEqual(0.95);

    const maxPairs = (n * (n - 1)) / 2;
    expect(candidates.size).toBeLessThan(maxPairs * 0.1);
  });

  it('is deterministic across repeated calls on the same input', () => {
    const { vectors } = buildClusteredVectors(32, 5, 4, 100);
    const a = [...candidatePairs(buildAnnIndex(vectors))].map(([i, j]) => `${i}|${j}`).sort();
    const b = [...candidatePairs(buildAnnIndex(vectors))].map(([i, j]) => `${i}|${j}`).sort();
    expect(a).toEqual(b);
  });

  it('never yields a pair against itself or a duplicate pair', () => {
    const { vectors } = buildClusteredVectors(16, 4, 5, 40);
    const index = buildAnnIndex(vectors);
    const seen = new Set<string>();
    for (const [i, j] of candidatePairs(index)) {
      expect(i).toBeLessThan(j);
      const key = `${i}|${j}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('degrades gracefully to brute force for zero-dimensional vectors', () => {
    const vectors: number[][] = [[], [], []];
    const index = buildAnnIndex(vectors);
    const pairs = [...candidatePairs(index)];
    expect(pairs.sort()).toEqual([[0, 1], [0, 2], [1, 2]]);
  });
});

describe('buildForwardAdjacency', () => {
  it('only lists higher-index candidates for each lower index', () => {
    const { vectors } = buildClusteredVectors(24, 6, 5, 60);
    const index = buildAnnIndex(vectors);
    const adj = buildForwardAdjacency(index);
    for (const [i, list] of adj) {
      for (const j of list) expect(j).toBeGreaterThan(i);
    }
  });
});

describe('buildSymmetricAdjacency', () => {
  it('lists each candidate pair in both directions', () => {
    const { vectors } = buildClusteredVectors(24, 6, 5, 60);
    const index = buildAnnIndex(vectors);
    const adj = buildSymmetricAdjacency(index, vectors.length);
    for (const [i, j] of candidatePairs(index)) {
      expect(adj[i]).toContain(j);
      expect(adj[j]).toContain(i);
    }
  });
});

describe('recommendedBits', () => {
  it('is 0 (brute force) at small n, and grows with n within a sane range beyond that', () => {
    expect(recommendedBits(10)).toBe(0);
    expect(recommendedBits(64)).toBe(0);
    expect(recommendedBits(100000)).toBeLessThanOrEqual(20);
    expect(recommendedBits(1000)).toBeLessThan(recommendedBits(100000));
  });
});
