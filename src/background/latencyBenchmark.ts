// =============================================================================
// Node-runnable latency harness. Measures two things separately, so the
// question "how much of a turn's latency is the model vs. us" has a real
// number instead of a guess:
//   - upstream: round-trip time to the real configured LLM/embedding endpoint
//     (complete()/embed() from ./llmProvider — both chrome.*-free, so they run
//     directly under Node exactly like the retrieval-quality benchmark does).
//   - internal: pure, on-device processing (chunking, sentence-splitting,
//     keyword indexing, vector scoring, hybrid fusion, graph ranking) timed
//     with performance.now() against a synthetic corpus, no network involved.
// Driven by scripts/latency-benchmark.ts via Vite's ssrLoadModule, the same
// pattern scripts/retrieval-benchmark.ts already uses for
// src/shared/retrievalBenchmark.ts.
//
// Retries would contaminate a "how slow is one call" reading (requestWithRetry
// in llmNetwork.ts backs off up to 60s on 429s) — every settings object this
// module builds forces `retryOnRateLimit: false`.
// =============================================================================

import type { Settings } from '../shared/types';
import type { DocGraph } from '../shared/docGraph';
import { complete, embed } from './llmProvider';
import { chunkText } from '../shared/repoChunk';
import { citableSentences } from '../shared/sentenceSplit';
import { buildKeywordIndex, bm25RankIndexed } from '../shared/keywordSearch';
import { normalizeVector, quantizeVector, scoreVectors, type ChunkInput } from '../shared/vectorSearch';
import { hybridSearch } from '../shared/hybridSearch';
import { rankGraphEvidence } from '../shared/graphRetrieval';

export interface LatencyStats {
  n: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

function stats(samplesMs: number[]): LatencyStats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    minMs: sorted[0] ?? 0,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: sorted.length ? sum / sorted.length : 0,
  };
}

async function timeMany(n: number, fn: () => Promise<unknown> | unknown): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const before = performance.now();
    await fn();
    out.push(performance.now() - before);
  }
  return out;
}

// ---- upstream: real network calls against the caller's configured endpoint ----

export interface UpstreamResult {
  completion: LatencyStats;
  embedding?: LatencyStats;
  embeddingSkippedReason?: string;
}

/** Time `rounds` round trips to the real configured chat model, and — only when
 * `settings.embedder === 'external'` — to the real configured embeddings
 * endpoint. On-device (`'local'`) embedding is internal processing, not
 * upstream; it also can't run here since it needs the offscreen document. */
export async function measureUpstream(settings: Settings, rounds = 5): Promise<UpstreamResult> {
  const safeSettings: Settings = { ...settings, retryOnRateLimit: false };

  const completionSamples = await timeMany(rounds, () =>
    complete(safeSettings, [{ role: 'user', content: 'Reply with exactly the word OK and nothing else.' }]),
  );
  const out: UpstreamResult = { completion: stats(completionSamples) };

  if (safeSettings.embedder === 'external') {
    const embeddingSamples = await timeMany(rounds, () =>
      embed(safeSettings, ['a short benchmark sentence used to measure embedding latency']),
    );
    out.embedding = stats(embeddingSamples);
  } else {
    out.embeddingSkippedReason =
      "settings.embedder is 'local' (on-device) — not an upstream network call, and on-device embedding's real IPC path needs the offscreen document, which Node can't provide.";
  }
  return out;
}

// ---- internal: pure functions, no network, synthetic corpus ----

const FILLER_SENTENCES = [
  'The quarterly report outlines revenue trends across each business unit.',
  'Engineering completed the migration to the new deployment pipeline.',
  'Customer support tickets decreased after the latest release.',
  'The design team published updated brand guidelines for partners.',
  'Operations reviewed vendor contracts ahead of the renewal cycle.',
];

function fillerText(approxChars: number): string {
  const out: string[] = [];
  let len = 0;
  let i = 0;
  while (len < approxChars) {
    const s = FILLER_SENTENCES[i % FILLER_SENTENCES.length];
    out.push(s);
    len += s.length + 1;
    i++;
  }
  return out.join(' ');
}

/** Same sinusoidal synthetic-vector generator as src/offscreen/repoStore.test.ts's
 * `vec(n, seed)`, so a chunk's "embedding" is deterministic and cheap to produce
 * at any scale without a real model. */
function syntheticVector(seed: number, dim: number): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed + i) + 1.5);
}

export interface InternalCorpusResult {
  chunkCount: number;
  chunkTextMs: LatencyStats;
  sentenceSplitMs: LatencyStats;
  keywordIndexMs: LatencyStats;
  bm25QueryMs: LatencyStats;
  vectorScoreMs: LatencyStats;
  hybridSearchMs: LatencyStats;
  graphRankMs: LatencyStats;
}

/** Time each pure processing stage against a synthetic corpus of `chunkCount`
 * chunks. `dim` defaults to 384 (a common small-embedding-model width). Note:
 * `scoreVectors`/`hybridSearch` here only exercise the JS scoring path — the
 * WASM SIMD backend (src/offscreen/vectorSimd.ts) is offscreen-document-only
 * and isn't reachable from Node. */
export async function measureInternal(chunkCount: number, dim = 384, rounds = 5): Promise<InternalCorpusResult> {
  const docText = fillerText(chunkCount * 700);

  const chunkTextMs = stats(await timeMany(rounds, () => chunkText(docText)));

  const produced = chunkText(docText);
  const rawChunks: string[] = [];
  for (let i = 0; i < chunkCount; i++) rawChunks.push(produced[i % produced.length] ?? FILLER_SENTENCES[0]);

  const sentenceSplitMs = stats(
    await timeMany(rounds, () => rawChunks.forEach((text, i) => citableSentences('bench-doc', i, text))),
  );

  const chunks: ChunkInput[] = rawChunks.map((text, i) => ({
    name: 'bench.md',
    url: 'file:///bench.md',
    text,
    chunkId: `bench-doc:c${i}`,
    sentences: citableSentences('bench-doc', i, text),
  }));

  const keywordIndexMs = stats(await timeMany(rounds, () => buildKeywordIndex(chunks)));
  const keywordIndex = buildKeywordIndex(chunks);
  const query = 'revenue trends deployment pipeline';
  const bm25QueryMs = stats(await timeMany(rounds, () => bm25RankIndexed({ index: keywordIndex, query })));

  const perDimScale = new Array(dim).fill(1);
  const vectors = new Int8Array(chunkCount * dim);
  chunks.forEach((_, i) => vectors.set(quantizeVector(normalizeVector(syntheticVector(i, dim)), perDimScale), i * dim));
  const queryVector = syntheticVector(0, dim);
  const base = { dim, perDimScale, chunkCount, vectors, chunks };

  const vectorScoreMs = stats(await timeMany(rounds, () => scoreVectors({ ...base, queryVector }, 20)));
  const hybridSearchMs = stats(
    await timeMany(rounds, () => hybridSearch({ ...base, queryVector, query, k: 20, keywordIndex })),
  );

  const firstSentenceId = chunks[0]?.sentences?.[0]?.id ?? 'bench-doc:c0:s0#000000';
  const graph: DocGraph = {
    version: 1,
    corpusRevision: 1,
    processedDocIds: ['bench-doc'],
    updatedAt: new Date().toISOString(),
    nodes: [
      {
        id: 'n0',
        type: 'topic',
        label: 'revenue',
        aliases: [],
        summary: 'Revenue trends across business units.',
        evidenceSentenceIds: [firstSentenceId],
        docIds: ['bench-doc'],
      },
    ],
    edges: [],
    communities: [],
  };
  const graphRankMs = stats(await timeMany(rounds, () => rankGraphEvidence(graph, 'revenue trends', chunks)));

  return { chunkCount, chunkTextMs, sentenceSplitMs, keywordIndexMs, bm25QueryMs, vectorScoreMs, hybridSearchMs, graphRankMs };
}
