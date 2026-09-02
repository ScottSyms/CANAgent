import { createServer } from 'vite';
import type { IngestBenchmarkResult } from '../src/offscreen/ingestBenchmark.ts';

function parseArgs(argv: string[]): { docCount?: number; chunksPerDoc?: number; searchSamples?: number } {
  const out: { docCount?: number; chunksPerDoc?: number; searchSamples?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--docs') out.docCount = Number(argv[++i]);
    else if (argv[i] === '--chunks-per-doc') out.chunksPerDoc = Number(argv[++i]);
    else if (argv[i] === '--search-samples') out.searchSamples = Number(argv[++i]);
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));

// Reuse Vite's resolver so this command follows the extensionless import
// convention used by the browser application without adding another TS runner.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const mod = (await server.ssrLoadModule('/src/offscreen/ingestBenchmark.ts')) as {
    runIngestBenchmark: (opts?: { docCount?: number; chunksPerDoc?: number; searchSamples?: number }) => Promise<IngestBenchmarkResult>;
    INGEST_BENCHMARK_BUDGET_MS: number;
  };

  const result = await mod.runIngestBenchmark(opts);
  const budget = mod.INGEST_BENCHMARK_BUDGET_MS;

  console.log(
    `Synthetic corpus: ${result.corpus.docCount} documents -> ${result.corpus.totalChunks} chunks (embedder: synthetic deterministic hash vectors, dim=384; ingest/store/cache paths: real production code)`,
  );
  console.table({
    'Cold ingest (whole corpus)': { ms: result.coldIngestMs.toFixed(1) },
    'Warm add (1 doc onto populated repo)': { ms: result.warmAddOneDocMs.toFixed(1) },
    'Time to first searchable': { ms: result.timeToFirstSearchableMs.toFixed(1) },
    'docChunks read (cold)': { ms: result.docChunksReadMs.cold.toFixed(2) },
    'docChunks read (warm)': { ms: result.docChunksReadMs.warm.toFixed(2) },
    'docVectors read (cold)': { ms: result.docVectorsReadMs.cold.toFixed(2) },
    'docVectors read (warm)': { ms: result.docVectorsReadMs.warm.toFixed(2) },
    'Search latency p50': { ms: result.searchLatencyMs.p50.toFixed(2) },
    'Search latency p95': { ms: result.searchLatencyMs.p95.toFixed(2) },
    TOTAL: { ms: result.totalMs.toFixed(1) },
  });
  console.log(`Throughput: ${result.throughput.docsPerSec.toFixed(1)} docs/sec, ${result.throughput.chunksPerSec.toFixed(1)} chunks/sec`);
  console.log(`Decoupling: search returned real hits before any graph.json existed for this repo: ${result.searchedBeforeAnyGraphWrite}`);
  console.log(`Budget: ${budget}ms`);

  if (!result.searchedBeforeAnyGraphWrite) {
    throw new Error('Search-readiness decoupling check failed: a graph.json existed before repoSearch returned hits.');
  }
  if (result.totalMs >= budget) {
    throw new Error(`Ingest benchmark total time (${result.totalMs.toFixed(0)}ms) exceeds the ${budget}ms budget.`);
  }
  console.log(`OK: ${(result.totalMs / 1000).toFixed(2)}s, within budget.`);
} finally {
  await server.close();
}
