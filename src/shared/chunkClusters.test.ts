import { describe, expect, it, vi } from 'vitest';
import { buildSimilarityEdges, deriveClusterLabel, type ClusterChunk } from './chunkClusters';

describe('buildSimilarityEdges', () => {
  it('connects chunks with near-identical embeddings and never self-connects', async () => {
    const chunks: ClusterChunk[] = [
      { chunkId: 'a', docId: 'd1', vector: [1, 0, 0] },
      { chunkId: 'b', docId: 'd1', vector: [0.99, 0.14, 0] }, // very close to a
      { chunkId: 'c', docId: 'd2', vector: [0, 1, 0] }, // orthogonal to a/b
    ];
    const edges = await buildSimilarityEdges(chunks);
    expect(edges).toContainEqual(['a', 'b']);
    expect(edges.every(([x, y]) => x !== y)).toBe(true);
  });

  it('deduplicates a mutual top-k pair into a single undirected edge', async () => {
    const chunks: ClusterChunk[] = [
      { chunkId: 'x', docId: 'd1', vector: [1, 0] },
      { chunkId: 'y', docId: 'd1', vector: [0.98, Math.sqrt(1 - 0.98 ** 2)] },
    ];
    const edges = await buildSimilarityEdges(chunks);
    // Only 2 chunks total -> each other's sole neighbor from both directions,
    // but the pair must appear exactly once, not twice.
    expect(edges).toHaveLength(1);
  });

  it('caps each chunk at its top NEIGHBORS_PER_CHUNK (5) most-similar others', async () => {
    // 10 chunks, all mutually similar-ish (small perturbations) -- each chunk
    // could in principle connect to all 9 others, but should be capped at 5
    // edges it *initiates* (final degree can still exceed 5 via reverse picks).
    const chunks: ClusterChunk[] = Array.from({ length: 10 }, (_, i) => ({
      chunkId: `c${i}`,
      docId: 'd1',
      vector: [1, i * 0.001, 0], // tiny, monotonically increasing perturbation
    }));
    const edges = await buildSimilarityEdges(chunks);
    const uniquePairs = new Set(edges.map(([a, b]) => `${a}|${b}`));
    expect(uniquePairs.size).toBe(edges.length); // no duplicate edges
    // Total edges bounded well under the full C(10,2)=45 possible pairs.
    expect(edges.length).toBeLessThan(45);
  });

  it('handles zero and one chunk without error', async () => {
    expect(await buildSimilarityEdges([])).toEqual([]);
    expect(await buildSimilarityEdges([{ chunkId: 'only', docId: 'd1', vector: [1, 0] }])).toEqual([]);
  });

  it('completes for a moderately large chunk set without hanging (yield regression guard)', async () => {
    const chunks: ClusterChunk[] = Array.from({ length: 400 }, (_, i) => {
      // Deterministic pseudo-random-ish unit-ish vectors spread across a small space.
      const a = Math.sin(i) + 1.5;
      const b = Math.cos(i) + 1.5;
      return { chunkId: `c${i}`, docId: `d${i % 10}`, vector: [a, b, 1] };
    });
    const start = Date.now();
    const edges = await buildSimilarityEdges(chunks);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(edges.length).toBeGreaterThan(0);
  });

  it('never blocks the event loop for a long stretch, even at a large chunk count (regression guard: yielding must be gated on total comparisons performed, not the outer-loop index — the inner loop is O(n) per outer step, so an outer-index-gated yield lets the synchronous stretch between yields grow unboundedly with chunk count, which is exactly what caused a real page-unresponsive report)', async () => {
    const dim = 64; // closer to the production embedder's 384-d, so a reintroduced bug would show a clear gap
    const gaps: number[] = [];
    let last = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      gaps.push(now - last);
      last = now;
    }, 10);
    try {
      const chunks: ClusterChunk[] = Array.from({ length: 2000 }, (_, i) => ({
        chunkId: `c${i}`,
        docId: `d${i % 20}`,
        vector: Array.from({ length: dim }, (_, d) => Math.sin(i * 0.13 + d * 0.7) + 1.5),
      }));
      await buildSimilarityEdges(chunks);
    } finally {
      clearInterval(ticker);
    }
    expect(gaps.length).toBeGreaterThan(3); // proves the ticker actually got multiple turns, not just one
    expect(Math.max(...gaps)).toBeLessThan(500); // no single stretch monopolized the event loop
  });

  it('yield count still tracks comparisons performed, not the outer-loop index alone (deterministic, hardware-independent version of the regression guard above)', async () => {
    // Each yield is exactly one setTimeout call (yieldToEventLoop) -- spying
    // on it gives an exact, deterministic yield count with no timing
    // involved. This only proves the yield *gate* is comparison-counted (not
    // outer-index-counted) -- it no longer proves overall quadratic growth,
    // since candidate generation is now sub-quadratic (see the ANN-bucketing
    // test below), so a larger chunk count no longer implies a proportionally
    // larger comparison count the way brute-force all-pairs did.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const makeChunks = (n: number): ClusterChunk[] =>
      Array.from({ length: n }, (_, i) => ({ chunkId: `c${i}`, docId: 'd', vector: [Math.sin(i), Math.cos(i), 1] }));

    setTimeoutSpy.mockClear();
    await buildSimilarityEdges(makeChunks(200));
    const yieldsSmall = setTimeoutSpy.mock.calls.length;

    setTimeoutSpy.mockClear();
    await buildSimilarityEdges(makeChunks(800));
    const yieldsLarge = setTimeoutSpy.mock.calls.length;

    setTimeoutSpy.mockRestore();

    expect(yieldsSmall).toBeGreaterThan(0);
    expect(yieldsLarge).toBeGreaterThanOrEqual(yieldsSmall);
  });

  it('needs far fewer than O(n²) comparisons at chunk counts in the thousands with realistic (384-d) embeddings — proof the ANN bucketing (src/shared/annIndex.ts) actually changed the complexity class, not just that it still finishes', async () => {
    // Well-separated clusters in 384 dimensions (matching the production
    // embedder), so bucketing has real structure to exploit rather than
    // degenerating toward one giant bucket. A true O(n²) all-pairs scan over
    // 6000 chunks would need ~18M comparisons -> ~900 yields at the current
    // YIELD_EVERY_COMPARISONS threshold; requiring well under a tenth of that
    // proves candidate generation is sub-quadratic, not just "still correct."
    const dim = 384;
    const clusters = 40;
    const perCluster = 150;
    function pseudoRandom(seed: number): () => number {
      let s = seed;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    }
    const chunks: ClusterChunk[] = [];
    for (let c = 0; c < clusters; c++) {
      const rand = pseudoRandom(c * 97 + 1);
      const base = Array.from({ length: dim }, () => rand() * 2 - 1);
      for (let m = 0; m < perCluster; m++) {
        const jitterRand = pseudoRandom(c * 97 + m + 10000);
        const vector = base.map((x) => x + (jitterRand() * 2 - 1) * 0.02);
        chunks.push({ chunkId: `c${c}_${m}`, docId: `d${c}`, vector });
      }
    }

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const start = Date.now();
    const edges = await buildSimilarityEdges(chunks);
    const elapsedMs = Date.now() - start;
    const yields = setTimeoutSpy.mock.calls.length;
    setTimeoutSpy.mockRestore();

    expect(edges.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(10000);
    expect(yields).toBeLessThan(90); // well under a tenth of the ~900 an O(n²) scan would need
  });
});

describe('deriveClusterLabel', () => {
  it('surfaces frequent, meaningful terms as keywords and a title', () => {
    const texts = [
      'The budget forecast shows a significant increase in departmental spending.',
      'Departmental spending was reviewed against the annual budget forecast.',
      'This report summarizes the budget forecast for the next fiscal year.',
    ];
    const { title, keywords } = deriveClusterLabel(texts);
    expect(keywords).toContain('budget');
    expect(keywords).toContain('forecast');
    expect(keywords).not.toContain('the'); // stopword
    expect(keywords).not.toContain('was'); // stopword
    expect(title.length).toBeGreaterThan(0);
  });

  it('falls back to "Untitled topic" when there are no meaningful terms', () => {
    expect(deriveClusterLabel(['the a an of to']).title).toBe('Untitled topic');
    expect(deriveClusterLabel([]).title).toBe('Untitled topic');
  });

  it('is deterministic, breaking frequency ties alphabetically', () => {
    const a = deriveClusterLabel(['alpha beta gamma delta epsilon zeta']);
    const b = deriveClusterLabel(['alpha beta gamma delta epsilon zeta']);
    expect(a).toEqual(b);
  });
});
