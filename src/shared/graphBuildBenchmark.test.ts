import { describe, expect, it } from 'vitest';
import {
  ENRICHMENT_CONCURRENCY,
  GRAPH_BUILD_BENCHMARK_BUDGET_MS,
  MAX_COMMUNITIES,
  MAX_RELATION_TYPING_EDGES,
  runGraphBuildBenchmark,
} from './graphBuildBenchmark';
import {
  COMMUNITY_CONCURRENCY,
  MAX_COMMUNITIES as REAL_MAX_COMMUNITIES,
  MAX_RELATION_TYPING_EDGES as REAL_MAX_RELATION_TYPING_EDGES,
  RELATION_TYPING_CONCURRENCY,
} from '../background/graphExtract';

describe('runGraphBuildBenchmark', () => {
  it('stays under the <30s large-graph target at the default (200 doc x 20 entity) scale', async () => {
    const result = await runGraphBuildBenchmark();
    expect(result.nodeCount).toBeGreaterThan(1000);
    expect(result.edgeCount).toBeGreaterThan(1000);
    // Gate on the real measurement only -- projectedTotalMs folds in a
    // stand-in LLM-latency constant and must never be what CI passes/fails on.
    expect(result.measuredMs).toBeLessThan(GRAPH_BUILD_BENCHMARK_BUDGET_MS);
    expect(result.measuredMs).toBe(result.nerMergeMs + result.dedupMs + result.communityDetectionMs);
  }, 40000);

  it('keeps the projected enrichment call count fixed (capped) even as the corpus grows 5x', async () => {
    const small = await runGraphBuildBenchmark({ docCount: 40, entitiesPerDoc: 10 });
    const large = await runGraphBuildBenchmark({ docCount: 200, entitiesPerDoc: 10 });

    expect(large.nodeCount).toBeGreaterThan(small.nodeCount * 4); // corpus genuinely grew 5x
    // Both scales already exceed the caps (400/4000 edges and 40/200
    // communities, vs a 50-edge/12-community cap), so both land on exactly
    // the same fixed call count -- this is the whole point of the redesign:
    // enrichment cost stops scaling with corpus size once it's large enough
    // to hit the caps at all.
    expect(small.enrichmentCallCount).toBe(MAX_RELATION_TYPING_EDGES + MAX_COMMUNITIES);
    expect(large.enrichmentCallCount).toBe(MAX_RELATION_TYPING_EDGES + MAX_COMMUNITIES);
    expect(large.projectedEnrichmentMs).toBe(small.projectedEnrichmentMs); // same call count -> same projected time
    expect(large.projectedTotalMs).toBe(large.measuredMs + large.projectedEnrichmentMs);
  }, 40000);

  it('local benchmark constants stay in sync with graphExtract.ts (this module intentionally does not import it)', () => {
    expect(MAX_COMMUNITIES).toBe(REAL_MAX_COMMUNITIES);
    expect(MAX_RELATION_TYPING_EDGES).toBe(REAL_MAX_RELATION_TYPING_EDGES);
    expect(ENRICHMENT_CONCURRENCY).toBe(COMMUNITY_CONCURRENCY);
    expect(ENRICHMENT_CONCURRENCY).toBe(RELATION_TYPING_CONCURRENCY);
  });
});
