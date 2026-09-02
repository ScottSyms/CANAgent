// Node-runnable projection of the "Quick" knowledge-graph build's wall-clock
// at large-corpus scale, for scripts/graph-build-benchmark.ts (same
// ssrLoadModule pattern src/background/latencyBenchmark.ts already uses).
// Times the real, on-device stages against a synthetic corpus — merging
// NER-shaped co-occurrence extractions (src/shared/nerAggregate.ts), the
// ANN-bucketed embedding dedup (mergeSimilarNodes, src/shared/docGraph.ts),
// and community detection (src/shared/graphCommunities.ts) — with
// performance.now(). `measuredMs` (the CI-gated figure) is the sum of ONLY
// those three real measurements.
//
// The one stage this can't measure for real is the bounded LLM enrichment
// pass (community summaries + typed-relation upgrades), which needs a live
// model server. Its call *count* is exact (mirrors buildRepoGraphQuick's own
// selection logic) and IS load-bearing (see the "stays fixed as corpus grows"
// test) — but its *latency* is necessarily a stand-in constant
// (`enrichmentLatencyMs`), so `projectedEnrichmentMs`/`projectedTotalMs` are
// reported separately and clearly labeled as projections, never folded into
// `measuredMs` or the pass/fail budget check. An earlier version of this file
// summed the stand-in into one undifferentiated "TOTAL" ms figure, which
// looked like a measurement but wasn't — don't reintroduce that.
//
// Deliberately avoids importing src/background/graphExtract.ts (or anything
// under src/background/offscreenClient.ts) — same reasoning
// latencyBenchmark.ts documents for staying out of the chrome-dependent
// orchestrator: this module only needs graphExtract.ts's pure algorithmic
// pieces, all of which already live in src/shared/.

import { emptyDocGraph, mergeExtraction, mergeSimilarNodes, type DocGraph } from './docGraph';
import { detectCommunities } from './graphCommunities';
import { buildCoOccurrenceExtraction, type NerSentenceSpan, type NerSpan } from './nerAggregate';

// Mirrors MAX_COMMUNITIES / MAX_RELATION_TYPING_EDGES / (COMMUNITY|RELATION_TYPING)_CONCURRENCY
// in src/background/graphExtract.ts — kept as local constants (not imported)
// for the reason above; graphExtract.ts also exports these so a test can
// assert they haven't drifted apart (see graphBuildBenchmark.test.ts).
export const MAX_COMMUNITIES = 12;
export const MAX_RELATION_TYPING_EDGES = 50;
export const ENRICHMENT_CONCURRENCY = 4;

export interface GraphBuildBenchmarkResult {
  docCount: number;
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  nerMergeMs: number;
  dedupMs: number;
  communityDetectionMs: number;
  /** Sum of nerMergeMs + dedupMs + communityDetectionMs only — real performance.now() measurements, nothing projected. This is what the budget check gates on. */
  measuredMs: number;
  enrichmentCallCount: number;
  /** Math.ceil(enrichmentCallCount / ENRICHMENT_CONCURRENCY) * enrichmentLatencyMs — a projection from an assumed per-call latency, not a measurement. Informational only. */
  projectedEnrichmentMs: number;
  /** measuredMs + projectedEnrichmentMs. Informational estimate of end-to-end wall-clock; NOT used for pass/fail (see measuredMs). */
  projectedTotalMs: number;
}

function pseudoRandomVector(seed: number, dim: number): number[] {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const v = Array.from({ length: dim }, () => next() * 2 - 1);
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * One synthetic "document": `entitiesPerDoc` distinct entities arranged in a
 * ring, each pair of neighbors sharing one sentence — so buildCoOccurrenceExtraction
 * (which needs >=2 entities in a sentence to emit an edge) produces exactly
 * `entitiesPerDoc` co-occurrence edges per document, same shape the real NER
 * backbone produces from a document's sentences.
 */
function syntheticDocExtraction(docIndex: number, entitiesPerDoc: number) {
  const names = Array.from({ length: entitiesPerDoc }, (_, i) => `Entity${docIndex}_${i}`);
  const sentences: NerSentenceSpan[] = [];
  const spans: NerSpan[] = [];
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < names.length; i++) {
    const a = names[i];
    const b = names[(i + 1) % names.length];
    const text = `${a} works with ${b}.`;
    const start = cursor;
    sentences.push({ id: `d${docIndex}:c0:s${i}`, start, end: start + text.length });
    spans.push({ label: 'ORG', start, end: start + a.length, score: 0.9 });
    const bStart = start + text.indexOf(b, a.length);
    spans.push({ label: 'ORG', start: bStart, end: bStart + b.length, score: 0.9 });
    parts.push(text);
    cursor = start + text.length + 1; // +1 for the joining space
  }
  return buildCoOccurrenceExtraction(parts.join(' '), sentences, spans);
}

/**
 * Build a synthetic large-corpus graph and time each real Quick-build stage,
 * projecting the bounded LLM-enrichment stage's wall-clock from its exact
 * (corpus-size-independent) call count and a stand-in per-call latency.
 */
export async function runGraphBuildBenchmark(
  opts: { docCount?: number; entitiesPerDoc?: number; enrichmentLatencyMs?: number } = {},
): Promise<GraphBuildBenchmarkResult> {
  const docCount = opts.docCount ?? 200;
  const entitiesPerDoc = opts.entitiesPerDoc ?? 20;
  const enrichmentLatencyMs = opts.enrichmentLatencyMs ?? 300; // stand-in for one local small-model call

  const graph: DocGraph = emptyDocGraph();
  const t0 = performance.now();
  for (let d = 0; d < docCount; d++) {
    mergeExtraction(graph, syntheticDocExtraction(d, entitiesPerDoc), `d${d}`, { markProcessed: false });
  }
  const nerMergeMs = performance.now() - t0;

  const dim = 384; // matches the production local embedder's dimensionality
  const embeddings = new Map(graph.nodes.map((n, i) => [n.id, pseudoRandomVector(i + 1, dim)]));
  const t1 = performance.now();
  await mergeSimilarNodes(graph, embeddings, { threshold: 0.9 });
  const dedupMs = performance.now() - t1;

  const t2 = performance.now();
  const communities = detectCommunities(graph, { minSize: 3, maxCommunities: undefined });
  const communityDetectionMs = performance.now() - t2;

  const relationCalls = Math.min(graph.edges.length, MAX_RELATION_TYPING_EDGES);
  const communityCalls = Math.min(communities.length, MAX_COMMUNITIES);
  const enrichmentCallCount = relationCalls + communityCalls;
  const projectedEnrichmentMs = Math.ceil(enrichmentCallCount / ENRICHMENT_CONCURRENCY) * enrichmentLatencyMs;
  const measuredMs = nerMergeMs + dedupMs + communityDetectionMs;

  return {
    docCount,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    communityCount: communities.length,
    nerMergeMs,
    dedupMs,
    communityDetectionMs,
    measuredMs,
    enrichmentCallCount,
    projectedEnrichmentMs,
    projectedTotalMs: measuredMs + projectedEnrichmentMs,
  };
}

/** The real (non-LLM-projected) Quick-build stages should stay well under this on an M2 Mac 32GB — gates `measuredMs`, not the LLM-inclusive projection. */
export const GRAPH_BUILD_BENCHMARK_BUDGET_MS = 30000;
