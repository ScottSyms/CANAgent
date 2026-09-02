import { describe, expect, it } from 'vitest';
import { dequantizeVector, normalizeVector, quantizeVector, scoreVectors, searchVectors } from './vectorSearch';

describe('normalizeVector', () => {
  it('returns a unit vector', () => {
    const n = normalizeVector([3, 4]);
    expect(Math.hypot(...n)).toBeCloseTo(1, 6);
    expect(n).toEqual([0.6, 0.8]);
  });
  it('leaves a zero vector unchanged', () => {
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });
});

describe('quantizeVector', () => {
  it('maps to the int8 range using the per-dim scale', () => {
    expect(Array.from(quantizeVector([1, 0], [1, 1]))).toEqual([127, 0]);
    expect(Array.from(quantizeVector([2, -2], [1, 1]))).toEqual([127, -127]); // clamped
  });
});

describe('dequantizeVector', () => {
  it('approximately inverts quantizeVector', () => {
    const original = normalizeVector([3, -4, 1]);
    const scale = [1, 1, 1];
    const q = quantizeVector(original, scale);
    const back = dequantizeVector(q, scale);
    for (let i = 0; i < original.length; i++) expect(back[i]).toBeCloseTo(original[i], 1);
  });

  it('applies the per-dimension scale', () => {
    const q = new Int8Array([127, -127]);
    expect(dequantizeVector(q, [2, 0.5])).toEqual([2, -0.5]);
  });

  it('treats a zero scale entry as 1 (matching quantizeVector\'s guard)', () => {
    const q = new Int8Array([127]);
    expect(dequantizeVector(q, [0])).toEqual([1]);
  });
});

describe('searchVectors', () => {
  const dim = 2;
  const perDimScale = [1, 1];
  const raw = [
    [1, 0], // A
    [0, 1], // B
    [1, 1], // C — 45°, between A and B
  ];
  const chunks = [
    { name: 'A', url: 'http://a', text: 'alpha' },
    { name: 'B', url: 'http://b', text: 'beta' },
    { name: 'C', url: 'http://c', text: 'gamma' },
  ];
  // Pack the int8 vectors exactly as repoAdd does (normalize → quantize).
  const vectors = new Int8Array(raw.length * dim);
  raw.forEach((v, i) => vectors.set(quantizeVector(normalizeVector(v), perDimScale), i * dim));

  it('ranks the closest chunks first', () => {
    const hits = searchVectors({ dim, perDimScale, chunkCount: raw.length, vectors, chunks, queryVector: [1, 0], k: 2 });
    expect(hits.map((h) => h.name)).toEqual(['A', 'C']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].text).toBe('alpha');
  });

  it('returns [] for an empty repo', () => {
    expect(
      searchVectors({ dim, perDimScale, chunkCount: 0, vectors: new Int8Array(0), chunks: [], queryVector: [1, 0], k: 3 }),
    ).toEqual([]);
  });

  it('throws on a dimension mismatch', () => {
    expect(() =>
      searchVectors({ dim, perDimScale, chunkCount: raw.length, vectors, chunks, queryVector: [1, 0, 0], k: 1 }),
    ).toThrow(/dimension/);
  });

  describe('queryAlreadyNormalized', () => {
    it('is a no-op for a truly unit-norm query: identical scores with the flag set or omitted', () => {
      const unitQuery = normalizeVector([3, 4]); // already unit-norm
      const withFlag = scoreVectors({ dim, perDimScale, chunkCount: raw.length, vectors, queryVector: unitQuery, queryAlreadyNormalized: true });
      const withoutFlag = scoreVectors({ dim, perDimScale, chunkCount: raw.length, vectors, queryVector: unitQuery });
      expect(withFlag).toEqual(withoutFlag);
    });

    it('actually skips normalization: a non-unit query scores differently depending on the flag', () => {
      // Magnitude clearly != 1, but each component stays under the int8
      // quantizer's per-dim clamp (|v[d]| > scale[d] would saturate both the
      // normalized and un-normalized quantization to the same clamped value
      // and hide the effect this test is checking for).
      const nonUnitQuery = [0.9, 0.9];
      const magnitude = Math.sqrt(0.9 ** 2 + 0.9 ** 2);
      const normalizedResult = scoreVectors({ dim, perDimScale, chunkCount: raw.length, vectors, queryVector: nonUnitQuery, queryAlreadyNormalized: false });
      const skippedResult = scoreVectors({ dim, perDimScale, chunkCount: raw.length, vectors, queryVector: nonUnitQuery, queryAlreadyNormalized: true });
      // Same ranking (normalization doesn't change relative order for a
      // fixed query), but different raw scores -- proves the flag genuinely
      // changed what was computed, not just a no-op parameter.
      expect(skippedResult.map((r) => r.i)).toEqual(normalizedResult.map((r) => r.i));
      expect(skippedResult[0].score).not.toBeCloseTo(normalizedResult[0].score, 5);
      // Skipping normalization on a magnitude-`magnitude` query should scale
      // scores by roughly that same factor relative to the normalized computation.
      expect(skippedResult[0].score / normalizedResult[0].score).toBeCloseTo(magnitude, 1);
    });
  });
});
