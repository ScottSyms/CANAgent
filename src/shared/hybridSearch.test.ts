import { describe, expect, it } from 'vitest';
import { fuseRRF, hybridSearch, multiHybridSearch } from './hybridSearch';
import { quantizeVector, normalizeVector } from './vectorSearch';

describe('fuseRRF', () => {
  it('rewards items ranked highly across both lists', () => {
    // item 5 is rank 0 in list A and rank 1 in list B → should win.
    const a = [
      { i: 5, score: 0.9 },
      { i: 1, score: 0.8 },
      { i: 2, score: 0.7 },
    ];
    const b = [
      { i: 9, score: 12 },
      { i: 5, score: 11 },
      { i: 3, score: 5 },
    ];
    const out = fuseRRF({ lists: [a, b], k: 3 });
    expect(out[0].i).toBe(5);
  });

  it('caps each list to the candidate pool', () => {
    const a = [
      { i: 0, score: 3 },
      { i: 1, score: 2 },
      { i: 2, score: 1 },
    ];
    // pool=1 → only rank-0 of each list contributes; i=2 (rank 2) is excluded.
    const out = fuseRRF({ lists: [a], k: 5, pool: 1 });
    expect(out.map((r) => r.i)).toEqual([0]);
  });

  it('returns at most k items', () => {
    const a = [0, 1, 2, 3].map((i) => ({ i, score: 4 - i }));
    expect(fuseRRF({ lists: [a], k: 2 })).toHaveLength(2);
  });
});

describe('hybridSearch', () => {
  // Build a tiny 2-D repo by hand. Vectors are int8-quantized like the store.
  const dim = 2;
  const perDimScale = [1, 1];
  const raw = [
    [1, 0], // chunk 0: aligned with query direction (semantic winner)
    [0, 1], // chunk 1: orthogonal, but holds the exact keyword
    [0.7, 0.7], // chunk 2: in-between
  ];
  const chunks = [
    { name: 'a', url: 'u0', text: 'general semantic content about topics' },
    { name: 'b', url: 'u1', text: 'reference to widget XJ-9000 part number' },
    { name: 'c', url: 'u2', text: 'some middling text' },
  ];
  const packed = new Int8Array(raw.length * dim);
  raw.forEach((v, i) => packed.set(quantizeVector(normalizeVector(v), perDimScale), i * dim));
  const base = {
    dim,
    perDimScale,
    chunkCount: raw.length,
    vectors: packed,
    chunks,
    queryVector: [1, 0],
    k: 3,
  };

  it('surfaces an exact-keyword chunk that pure semantic would rank low', () => {
    // Query vector points at chunk 0; chunk 1 is orthogonal (semantic ~0) but
    // contains the exact token. Hybrid should pull chunk 1 up via BM25.
    const hits = hybridSearch({ ...base, query: 'XJ-9000' });
    const ids = hits.map((h) => h.name);
    expect(ids).toContain('b'); // keyword chunk present
    // And it should outrank the semantically-irrelevant middling chunk via fusion.
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });

  it('falls back to pure semantic ordering when the query has no lexical match', () => {
    const hits = hybridSearch({ ...base, query: 'zzznomatch qqqunknown' });
    // No BM25 hits → semantic order: chunk 0 (aligned) first.
    expect(hits[0].name).toBe('a');
  });

  it('fuses a supplemental graph ranking with semantic and lexical rankings', () => {
    const hits = hybridSearch({
      ...base,
      query: 'no lexical match',
      k: 1,
      supplementalRankings: [[{ i: 1, score: 100 }]],
    });
    expect(hits[0].name).toBe('b');
  });

  it('returns [] for an empty repo', () => {
    expect(hybridSearch({ ...base, chunkCount: 0, query: 'anything' })).toEqual([]);
  });

  it('fuses lexical matches from paraphrase queries', () => {
    const hits = multiHybridSearch({
      ...base,
      queryVectors: [[1, 0], [1, 0]],
      queries: ['budget overrun', 'XJ-9000'],
      hybrid: true,
      k: 3,
    });
    expect(hits.map((h) => h.name)).toContain('b');
  });

  it('fuses graph rankings alongside multiple query variants', () => {
    const hits = multiHybridSearch({
      ...base,
      queryVectors: [[1, 0]],
      queries: ['no lexical match'],
      supplementalRankings: [[{ i: 1, score: 100 }]],
      k: 1,
    });
    expect(hits[0].name).toBe('b');
  });
});
