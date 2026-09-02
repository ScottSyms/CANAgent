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
    'MEASURED (real, gates the budget)': { ms: result.measuredMs.toFixed(0) },
    [`Bounded LLM enrichment (${result.enrichmentCallCount} calls, PROJECTED — not measured)`]: { ms: result.projectedEnrichmentMs.toFixed(0) },
    'Projected total (informational only)': { ms: result.projectedTotalMs.toFixed(0) },
  });
  console.log(`Budget: ${budget}ms, checked against the real measured stages only — the LLM enrichment figure above is a call-count-based projection, not a measurement.`);

  if (result.measuredMs >= budget) {
    throw new Error(`Measured Quick-build time (${result.measuredMs.toFixed(0)}ms) exceeds the ${budget}ms budget.`);
  }
  console.log(`OK: ${(result.measuredMs / 1000).toFixed(1)}s measured, within budget (projected total incl. LLM enrichment: ${(result.projectedTotalMs / 1000).toFixed(1)}s).`);
} finally {
  await server.close();
}
