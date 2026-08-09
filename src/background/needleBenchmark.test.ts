import { describe, expect, it } from 'vitest';
import { generateNeedleCorpus, runSyntheticNeedle } from './needleBenchmark';

describe('generateNeedleCorpus', () => {
  it('plants exactly one needle chunk with a real, computed sentence id', () => {
    const corpus = generateNeedleCorpus(50);
    expect(corpus.chunks).toHaveLength(50);
    expect(corpus.needleIndex).toBeGreaterThanOrEqual(0);
    expect(corpus.needleIndex).toBeLessThan(50);
    expect(corpus.chunks[corpus.needleIndex].text).toContain('Zephyrine-77');
    expect(corpus.needleSentenceId).toMatch(/^needle-doc:c\d+:s\d+#[0-9a-f]{6}$/);
    // Every other chunk should be filler, not a duplicate of the needle.
    corpus.chunks.forEach((c, i) => {
      if (i !== corpus.needleIndex) expect(c.text).not.toContain('Zephyrine-77');
    });
  });
});

describe('runSyntheticNeedle', () => {
  // Regression test: an earlier version placed the needle's synthetic vector
  // at an arbitrary index-keyed noise position (uncorrelated with the query),
  // which could rank it outside hybridSearch's RRF pool by pure bad luck at
  // small corpus sizes, even though raw BM25 ranked it #1 by a wide margin —
  // an artifact of adversarial noise, not a real retrieval failure. The fix
  // aligns the needle's vector with the query's (as a real embedding model
  // would for genuinely relevant content); this must hold at every scale.
  it.each([50, 200, 1000, 5000])('finds the needle at hit@1 with %i chunks in the corpus', (chunkCount) => {
    const result = runSyntheticNeedle(chunkCount);
    expect(result.needleRank).toBe(1);
    expect(result.metrics.hitRateAtK).toBe(1);
  });
});
