// Node-runnable production-path ingest benchmark for scripts/ingest-benchmark.ts
// (same ssrLoadModule pattern as scripts/graph-build-benchmark.ts). Unlike
// graphBuildBenchmark.ts (which deliberately avoids chrome-dependent modules
// and times a from-scratch re-implementation of the graph-merge algorithms),
// this file imports repoStore.ts directly and times the REAL production code
// path: real chunkText, real quantize/normalize, real encrypted (or plaintext)
// writeJson/readJson, real searchDataCache. The one deliberate seam is the
// embedder itself: the real LiteRT/WASM model needs chrome.runtime/WebGPU/DOM
// and cannot run under Node, so a deterministic synthetic embedder stands in
// for it (documented in the report, not hidden) — real embedder latency stays
// a manual, in-extension spot check.
//
// Central claim under test: search readiness must not depend on graph
// enrichment. This file never imports graphExtract.ts, so that's true by
// construction — reinforced at runtime by asserting no graph.json was ever
// written before repoSearch returns real hits.

import { chunkText } from '../shared/repoChunk';
import { installFakeOpfs, type FakeDirHandle } from './fakeOpfs';
import { repoAddBatch, repoDocChunks, repoDocVectors, repoSearch, type RepoAddDoc } from './repoStore';

const BENCH_EMBED_MODEL = 'local:bench-synthetic';
const BENCH_DIM = 384; // matches the production local embedder's dimensionality

/** Deterministic, fast, fixed-dim stand-in for a real embedding call. */
function syntheticEmbed(text: string, dim = BENCH_DIM): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const v = Array.from({ length: dim }, (_, i) => Math.sin(h * (i + 1)));
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** One synthetic document's text, long enough that `chunkText` yields roughly `chunksPerDoc` chunks. */
function syntheticDocText(docIndex: number, chunksPerDoc: number): string {
  const sentence = `Document ${docIndex} discusses topic ${docIndex % 7} in section paragraph number `;
  const paragraphs = Array.from({ length: chunksPerDoc }, (_, i) => `${sentence}${i}. `.repeat(20));
  return paragraphs.join('\n\n');
}

function buildDoc(index: number, chunksPerDoc: number): RepoAddDoc {
  const chunks = chunkText(syntheticDocText(index, chunksPerDoc));
  return {
    doc: { name: `doc-${index}.txt`, url: `bench://doc-${index}` },
    chunks,
    vectors: chunks.map((c) => syntheticEmbed(c)),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export interface IngestBenchmarkResult {
  corpus: { docCount: number; chunksPerDoc: number; totalChunks: number };
  coldIngestMs: number;
  warmAddOneDocMs: number;
  timeToFirstSearchableMs: number;
  searchedBeforeAnyGraphWrite: boolean;
  docChunksReadMs: { cold: number; warm: number };
  docVectorsReadMs: { cold: number; warm: number };
  throughput: { docsPerSec: number; chunksPerSec: number };
  searchLatencyMs: { p50: number; p95: number };
  totalMs: number;
}

export async function runIngestBenchmark(
  opts: { docCount?: number; chunksPerDoc?: number; searchSamples?: number } = {},
): Promise<IngestBenchmarkResult> {
  const docCount = opts.docCount ?? 50;
  const chunksPerDoc = opts.chunksPerDoc ?? 5;
  const searchSamples = opts.searchSamples ?? 20;
  const repo = `bench-${Date.now()}`;

  const root = installFakeOpfs();
  const t0 = performance.now();

  const corpus = Array.from({ length: docCount }, (_, i) => buildDoc(i, chunksPerDoc));
  const totalChunks = corpus.reduce((n, d) => n + d.chunks.length, 0);

  const tIngest0 = performance.now();
  const addResults = await repoAddBatch(repo, corpus, { embedModel: BENCH_EMBED_MODEL });
  const coldIngestMs = performance.now() - tIngest0;

  const firstOk = addResults.find((r) => r.ok);
  if (!firstOk || !firstOk.ok) throw new Error('ingestBenchmark: seed corpus failed to ingest.');
  const secondOk = addResults[1]?.ok ? (addResults[1] as { ok: true; docId: string }).docId : firstOk.docId;

  // docChunks/docVectors "cold" = first read for a doc after ingest invalidated
  // the search cache; "warm" = a second read for a DIFFERENT doc in the same
  // repo. Before the corpus-caching fix (plan Phase 1), every doc read
  // independently re-reads/re-decrypts the whole corpus, so warm ~= cold; after
  // it lands, warm should be dramatically cheaper (served from the shared
  // per-repo cache instead of hitting the fake OPFS handles again).
  const tdc0 = performance.now();
  await repoDocChunks(repo, firstOk.docId);
  const docChunksCold = performance.now() - tdc0;
  const tdc1 = performance.now();
  await repoDocChunks(repo, secondOk);
  const docChunksWarm = performance.now() - tdc1;

  const tdv0 = performance.now();
  await repoDocVectors(repo, firstOk.docId);
  const docVectorsCold = performance.now() - tdv0;
  const tdv1 = performance.now();
  await repoDocVectors(repo, secondOk);
  const docVectorsWarm = performance.now() - tdv1;

  // Decoupling check: real hits come back, and no graph.json was ever written
  // for this repo — nothing graph-related ran or was waited on to get here.
  const tSearch0 = performance.now();
  const searchRes = await repoSearch(repo, syntheticEmbed('sample query about topic 3'), 5, BENCH_EMBED_MODEL);
  const timeToFirstSearchableMs = performance.now() - tSearch0;
  if (searchRes.results.length === 0) throw new Error('ingestBenchmark: search returned no hits against a freshly-ingested corpus.');
  const repoDir = (root as FakeDirHandle).dirs.get('repos')?.dirs.get(repo);
  const searchedBeforeAnyGraphWrite = !repoDir?.files.has('graph.json');

  const extraDoc = buildDoc(docCount, chunksPerDoc);
  const tWarmAdd0 = performance.now();
  await repoAddBatch(repo, [extraDoc], { embedModel: BENCH_EMBED_MODEL });
  const warmAddOneDocMs = performance.now() - tWarmAdd0;

  const searchTimes: number[] = [];
  for (let i = 0; i < searchSamples; i++) {
    const q = syntheticEmbed(`sample query ${i} about topic ${i % 7}`);
    const t = performance.now();
    await repoSearch(repo, q, 5, BENCH_EMBED_MODEL);
    searchTimes.push(performance.now() - t);
  }
  searchTimes.sort((a, b) => a - b);

  const totalMs = performance.now() - t0;

  return {
    corpus: { docCount, chunksPerDoc, totalChunks },
    coldIngestMs,
    warmAddOneDocMs,
    timeToFirstSearchableMs,
    searchedBeforeAnyGraphWrite,
    docChunksReadMs: { cold: docChunksCold, warm: docChunksWarm },
    docVectorsReadMs: { cold: docVectorsCold, warm: docVectorsWarm },
    throughput: {
      docsPerSec: docCount / (coldIngestMs / 1000),
      chunksPerSec: totalChunks / (coldIngestMs / 1000),
    },
    searchLatencyMs: { p50: percentile(searchTimes, 50), p95: percentile(searchTimes, 95) },
    totalMs,
  };
}

/** Generous ceiling for the default corpus on a synthetic (non-real-model) run — this times storage/caching code, not inference. */
export const INGEST_BENCHMARK_BUDGET_MS = 5000;
