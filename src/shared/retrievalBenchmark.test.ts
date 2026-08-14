import { describe, expect, it } from 'vitest';
import {
  RETRIEVAL_BENCHMARK_THRESHOLDS,
  RETRIEVAL_BENCHMARK_VERSION,
  runRetrievalBenchmark,
} from './retrievalBenchmark';

describe('retrieval benchmark', () => {
  it('keeps graph-assisted retrieval ahead of the multi-query baseline without invalid references', () => {
    const result = runRetrievalBenchmark();
    const baseline = result.variants.multiQuery;
    const assisted = result.variants.graphAssisted;

    expect(result.version).toBe(RETRIEVAL_BENCHMARK_VERSION);
    expect(result.variants.hybrid.at1.hitRateAtK).toBeGreaterThanOrEqual(RETRIEVAL_BENCHMARK_THRESHOLDS.hybridHitAt1);
    expect(assisted.at1.hitRateAtK).toBeGreaterThanOrEqual(RETRIEVAL_BENCHMARK_THRESHOLDS.graphAssistedHitAt1);
    expect(assisted.at3.recallAtK).toBeGreaterThanOrEqual(RETRIEVAL_BENCHMARK_THRESHOLDS.graphAssistedRecallAt3);
    expect(assisted.at1.mrr).toBeGreaterThanOrEqual(RETRIEVAL_BENCHMARK_THRESHOLDS.graphAssistedMrr);
    expect(assisted.at1.hitRateAtK).toBeGreaterThan(baseline.at1.hitRateAtK);
    expect(assisted.at1.mrr).toBeGreaterThan(baseline.at1.mrr);
    expect(assisted.at3.recallAtK).toBeGreaterThanOrEqual(baseline.at3.recallAtK);
    expect(Object.values(result.variants).every((variant) => variant.at3.invalidResultCount === 0)).toBe(true);
  });
});
