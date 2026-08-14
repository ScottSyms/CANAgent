import { createServer } from 'vite';
import type { RetrievalBenchmarkResult } from '../src/shared/retrievalBenchmark.ts';

// Reuse Vite's resolver so this command follows the extensionless import
// convention used by the browser application without adding another TS runner.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const benchmark = await server.ssrLoadModule('/src/shared/retrievalBenchmark.ts') as {
    runRetrievalBenchmark: () => RetrievalBenchmarkResult;
    RETRIEVAL_BENCHMARK_THRESHOLDS: {
      hybridHitAt1: number;
      graphAssistedHitAt1: number;
      graphAssistedRecallAt3: number;
      graphAssistedMrr: number;
    };
  };
  const result = benchmark.runRetrievalBenchmark();
  const thresholds = benchmark.RETRIEVAL_BENCHMARK_THRESHOLDS;
  const rows = Object.entries(result.variants).map(([name, metrics]) => ({
    Variant: name,
    'Hit@1': metrics.at1.hitRateAtK.toFixed(3),
    'Recall@3': metrics.at3.recallAtK.toFixed(3),
    MRR: metrics.at1.mrr.toFixed(3),
    'Invalid refs': metrics.at3.invalidResultCount,
  }));

  console.log(`Retrieval benchmark v${result.version}`);
  console.table(rows);

  const baseline = result.variants.multiQuery.at1;
  const assisted = result.variants.graphAssisted.at1;
  if (result.variants.hybrid.at1.hitRateAtK < thresholds.hybridHitAt1
      || assisted.hitRateAtK < thresholds.graphAssistedHitAt1
      || result.variants.graphAssisted.at3.recallAtK < thresholds.graphAssistedRecallAt3
      || assisted.mrr < thresholds.graphAssistedMrr) {
    throw new Error('Retrieval quality fell below the deterministic benchmark thresholds.');
  }
  if (assisted.hitRateAtK <= baseline.hitRateAtK || assisted.mrr <= baseline.mrr) {
    throw new Error('Graph-assisted retrieval did not improve the deterministic multi-query baseline.');
  }
  if (Object.values(result.variants).some((variant) => variant.at3.invalidResultCount > 0)) {
    throw new Error('A retrieval variant returned an invalid chunk reference.');
  }
} finally {
  await server.close();
}
