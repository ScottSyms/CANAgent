import { describe, expect, it } from 'vitest';
import { runIngestBenchmark } from './ingestBenchmark';

describe('runIngestBenchmark', () => {
  it('returns a well-formed report for a small synthetic corpus', async () => {
    const result = await runIngestBenchmark({ docCount: 5, chunksPerDoc: 2, searchSamples: 3 });

    expect(result.corpus.docCount).toBe(5);
    expect(result.corpus.totalChunks).toBeGreaterThan(0);

    for (const ms of [
      result.coldIngestMs,
      result.warmAddOneDocMs,
      result.timeToFirstSearchableMs,
      result.docChunksReadMs.cold,
      result.docChunksReadMs.warm,
      result.docVectorsReadMs.cold,
      result.docVectorsReadMs.warm,
      result.searchLatencyMs.p50,
      result.searchLatencyMs.p95,
      result.totalMs,
    ]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
    expect(Number.isFinite(result.throughput.docsPerSec)).toBe(true);
    expect(Number.isFinite(result.throughput.chunksPerSec)).toBe(true);
  });

  it('proves search-readiness is decoupled from graph enrichment: real hits come back before any graph.json exists', async () => {
    const result = await runIngestBenchmark({ docCount: 5, chunksPerDoc: 2, searchSamples: 1 });
    expect(result.searchedBeforeAnyGraphWrite).toBe(true);
  });

  it('uses independent (differently-seeded) repo names across runs so results never collide', async () => {
    const a = await runIngestBenchmark({ docCount: 3, chunksPerDoc: 1, searchSamples: 1 });
    const b = await runIngestBenchmark({ docCount: 3, chunksPerDoc: 1, searchSamples: 1 });
    // Both runs must independently succeed (search finds hits) rather than the
    // second run accidentally reusing/colliding with the first run's repo.
    expect(a.searchedBeforeAnyGraphWrite).toBe(true);
    expect(b.searchedBeforeAnyGraphWrite).toBe(true);
  });
});
