import { createServer } from 'vite';
import type { GraphBuildBenchmarkResult } from '../src/shared/graphBuildBenchmark.ts';

function parseArgs(argv: string[]): { docCount?: number; entitiesPerDoc?: number; enrichmentLatencyMs?: number } {
  const out: { docCount?: number; entitiesPerDoc?: number; enrichmentLatencyMs?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--docs') out.docCount = Number(argv[++i]);
    else if (argv[i] === '--entities-per-doc') out.entitiesPerDoc = Number(argv[++i]);
    else if (argv[i] === '--enrichment-latency-ms') out.enrichmentLatencyMs = Number(argv[++i]);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));

// Reuse Vite's resolver so this command follows the extensionless import
// convention used by the browser application without adding another TS runner.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const mod = (await server.ssrLoadModule('/src/shared/graphBuildBenchmark.ts')) as {
    runGraphBuildBenchmark: (opts?: { docCount?: number; entitiesPerDoc?: number; enrichmentLatencyMs?: number }) => Promise<GraphBuildBenchmarkResult>;
    GRAPH_BUILD_BENCHMARK_BUDGET_MS: number;
  };

  const result = await mod.runGraphBuildBenchmark(opts);
  const budget = mod.GRAPH_BUILD_BENCHMARK_BUDGET_MS;

  console.log(`Synthetic corpus: ${result.docCount} documents -> ${result.nodeCount} entities, ${result.edgeCount} edges, ${result.communityCount} communities`);
  console.table({
    'NER merge (docs -> graph)': { ms: result.nerMergeMs.toFixed(0) },
    'Embedding dedup (ANN-bucketed)': { ms: result.dedupMs.toFixed(0) },
    'Community detection': { ms: result.communityDetectionMs.toFixed(0) },
    [`Bounded LLM enrichment (${result.enrichmentCallCount} calls, projected)`]: { ms: result.projectedEnrichmentMs.toFixed(0) },
    'TOTAL': { ms: result.totalMs.toFixed(0) },
  });
  console.log(`Budget: ${budget}ms (the plan's <30s large-graph target on an embedded, single local-model setup)`);

  if (result.totalMs >= budget) {
    throw new Error(`Projected Quick-build time (${result.totalMs.toFixed(0)}ms) exceeds the ${budget}ms budget.`);
  }
  console.log(`OK: ${(result.totalMs / 1000).toFixed(1)}s, within budget.`);
} finally {
  await server.close();
}
