// =============================================================================
// Node-runnable "needle in a haystack" retrieval-quality benchmark. Plants one
// distinctive, made-up fact in a large corpus built through the *real*
// chunking/sentence-id pipeline (chunkText, citableSentences/makeSentenceId —
// same functions production ingestion uses), and measures whether the
// retrieval stack reliably finds it as the corpus grows.
//
// Three modes, in increasing order of fidelity (and of what they need):
//   1. synthetic  — no credentials, sinusoidal synthetic vectors (same style as
//      src/shared/retrievalBenchmark.ts and repoStore.test.ts's `vec()`).
//      Tests ranking/fusion machinery and index correctness at scale via the
//      needle's distinctive exact-token phrase (BM25) — not real semantic
//      understanding, since the vectors aren't from a real embedding model.
//   2. real embeddings — embeds every chunk through the caller's actual
//      configured external embedding endpoint (embed(), chrome.*-free, so it
//      runs directly under Node). Genuine semantic retrieval: the query need
//      not share tokens with the needle.
//   3. end-to-end citations — layers a real complete() call on top of mode 2,
//      formatted exactly like search_repo's evidence (`[[sentence-id]] text`),
//      and validates the model's answer contains the exact planted sentence id
//      via the same `extractCitationIds` grammar production citation
//      validation uses (src/shared/citations.ts) — no fuzzy matching.
//
// Driven by scripts/needle-benchmark.ts via Vite's ssrLoadModule, same pattern
// as scripts/retrieval-benchmark.ts.
// =============================================================================

import type { Settings } from '../shared/types';
import { complete, embed } from './llmProvider';
import { chunkText, batchArray } from '../shared/repoChunk';
import { citableSentences } from '../shared/sentenceSplit';
import { extractCitationIds } from '../shared/citations';
import { buildKeywordIndex } from '../shared/keywordSearch';
import { normalizeVector, quantizeVector, type ChunkInput, type SearchHit } from '../shared/vectorSearch';
import { hybridSearch } from '../shared/hybridSearch';
import { evaluateRetrieval, type RetrievalMetrics } from '../shared/retrievalEvaluation';

// Combinatorial filler generator (subject x verb x object = 2,250 distinct
// sentences) rather than a handful of fixed sentences repeated verbatim. With
// only a few unique sentences, BM25 produces many exact-score ties among
// filler chunks — which, combined with hybridSearch's pool cap and this
// module's index-based synthetic vectors (pure noise, uncorrelated with
// content), can let a "lucky" tied filler chunk's dense-list contribution
// outscore the needle at small corpus sizes even though raw BM25 ranks the
// needle #1 by a wide margin. A large, low-repetition filler vocabulary keeps
// that RRF-tie artifact from contaminating the benchmark's own result.
const SUBJECTS = [
  'The quarterly report', 'Engineering', 'Customer support', 'The design team', 'Operations',
  'The onboarding guide', 'Marketing', 'The data warehouse migration', 'The finance team', 'The security review',
  'The platform team', 'Legal', 'The analytics dashboard', 'The support queue', 'The release train',
];
const VERBS = [
  'outlines', 'completed', 'reviewed', 'published', 'finished',
  'updated', 'launched', 'tracked', 'audited', 'summarized',
  'documented', 'measured', 'analyzed', 'coordinated', 'scheduled',
];
const OBJECTS = [
  'revenue trends across each business unit.', 'the migration to the new deployment pipeline.',
  'vendor contracts ahead of the renewal cycle.', 'updated brand guidelines for partners.',
  'the regional campaign for the product refresh.', 'the onboarding guide for new hires.',
  'the quarterly roadmap review.', 'customer feedback from the latest survey.',
  'the incident response runbook.', 'the annual compliance checklist.',
];

function fillerSentence(i: number): string {
  const s = SUBJECTS[i % SUBJECTS.length];
  const v = VERBS[Math.floor(i / SUBJECTS.length) % VERBS.length];
  const o = OBJECTS[Math.floor(i / (SUBJECTS.length * VERBS.length)) % OBJECTS.length];
  return `${s} ${v} ${o}`;
}

function fillerText(approxChars: number): string {
  const out: string[] = [];
  let len = 0;
  let i = 0;
  while (len < approxChars) {
    const s = fillerSentence(i);
    out.push(s);
    len += s.length + 1;
    i++;
  }
  return out.join(' ');
}

export interface NeedleCorpus {
  chunks: ChunkInput[];
  needleIndex: number;
  needleSentenceId: string;
  needleFact: string;
  query: string;
}

/**
 * Build a corpus of `chunkCount` chunks via the real chunking pipeline, with
 * exactly one "needle" chunk — containing a distinctive, made-up fact that
 * can't collide with the filler text — planted a third of the way through (so
 * it's neither trivially first nor last). The needle's sentence id is computed
 * via the real `citableSentences`, so it's the exact id production ingestion
 * would assign, not a stand-in.
 */
export function generateNeedleCorpus(chunkCount: number): NeedleCorpus {
  const docId = 'needle-doc';
  const needleToken = 'Zephyrine-77';
  const needleFact = `The ${needleToken} configuration profile requires a maximum queue depth of 512 entries.`;
  const produced = chunkText(fillerText(chunkCount * 700));
  const rawChunks: string[] = [];
  for (let i = 0; i < chunkCount; i++) rawChunks.push(produced[i % produced.length] ?? fillerSentence(i));

  const needleIndex = Math.floor(chunkCount / 3);
  rawChunks[needleIndex] = needleFact;

  const chunks: ChunkInput[] = rawChunks.map((text, i) => ({
    name: 'corpus.md',
    url: 'file:///corpus.md',
    text,
    chunkId: `${docId}:c${i}`,
    sentences: citableSentences(docId, i, text),
  }));

  const needleSentenceId = chunks[needleIndex].sentences?.[0]?.id ?? '';
  return {
    chunks,
    needleIndex,
    needleSentenceId,
    needleFact,
    query: `What is the maximum queue depth for the ${needleToken} configuration profile?`,
  };
}

function syntheticVector(seed: number, dim: number): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed + i) + 1.5);
}

/** Pack raw f32 vectors into the store's int8 format, calibrating per-dimension
 * scale from the whole batch (mirrors repoStore.repoAdd's first-batch calibration). */
function packVectors(vectors: number[][], dim: number): { vectors: Int8Array; perDimScale: number[] } {
  const perDimScale = new Array(dim).fill(0);
  const normed = vectors.map(normalizeVector);
  for (const v of normed) for (let d = 0; d < dim; d++) perDimScale[d] = Math.max(perDimScale[d], Math.abs(v[d]));
  for (let d = 0; d < dim; d++) if (perDimScale[d] === 0) perDimScale[d] = 1;
  const packed = new Int8Array(vectors.length * dim);
  normed.forEach((v, i) => packed.set(quantizeVector(v, perDimScale), i * dim));
  return { vectors: packed, perDimScale };
}

export interface NeedleRunResult {
  chunkCount: number;
  /** 1-based rank of the needle chunk among the returned hits, or -1 if absent. */
  needleRank: number;
  metrics: RetrievalMetrics;
}

function evaluateNeedleHits(hits: SearchHit[], corpus: NeedleCorpus, k: number): NeedleRunResult {
  const chunkIndexById = new Map(corpus.chunks.map((c, i) => [c.chunkId, i]));
  const ranking = hits.map((h) => chunkIndexById.get(h.chunkId)).filter((i): i is number => i !== undefined);
  const rank = ranking.indexOf(corpus.needleIndex);
  const metrics = evaluateRetrieval(
    [{ id: 'needle', relevantChunkIndices: [corpus.needleIndex] }],
    { needle: ranking },
    k,
    corpus.chunks.length,
  );
  return { chunkCount: corpus.chunks.length, needleRank: rank < 0 ? -1 : rank + 1, metrics };
}

/** Mode 1: synthetic (non-semantic) vectors. No credentials, fast, CI-safe.
 * Tests ranking/fusion machinery and index correctness at scale via the
 * needle's distinctive exact-token phrase (BM25 half of hybrid search).
 *
 * Filler chunks get index-keyed noise vectors (no relationship to content —
 * they're irrelevant, so a real embedding model wouldn't place them near the
 * query either). The needle chunk gets the *same* vector as the query: it's
 * genuinely the relevant passage, and a real embedding model would place it
 * close to a matching query, not at an arbitrary noise position. Without this,
 * the needle's dense rank is pure luck-of-the-seed — at small corpus sizes
 * (where the RRF pool covers a large fraction of the corpus) an unlucky dense
 * placement can let a filler chunk's BM25-tie-plus-lucky-dense-rank outscore
 * the needle's dominant but dense-less BM25 win, even though raw BM25 ranks
 * it #1 by a wide margin — an artifact of adversarial noise, not a retrieval
 * quality signal worth measuring. */
export function runSyntheticNeedle(chunkCount: number, k = 10, dim = 384): NeedleRunResult {
  const corpus = generateNeedleCorpus(chunkCount);
  const queryVector = syntheticVector(0, dim);
  const vectors = corpus.chunks.map((_, i) => (i === corpus.needleIndex ? queryVector : syntheticVector(i, dim)));
  const { vectors: packed, perDimScale } = packVectors(vectors, dim);
  const keywordIndex = buildKeywordIndex(corpus.chunks);
  const hits = hybridSearch({
    dim,
    perDimScale,
    chunkCount,
    vectors: packed,
    chunks: corpus.chunks,
    queryVector,
    query: corpus.query,
    k,
    keywordIndex,
  });
  return evaluateNeedleHits(hits, corpus, k);
}

export interface RealEmbeddingResult extends NeedleRunResult {
  corpus: NeedleCorpus;
  topHits: SearchHit[];
}

/** Mode 2: embeds every chunk through the caller's real configured external
 * embedding endpoint — genuine semantic retrieval, no exact-token overlap
 * required between the query and the needle. */
export async function runRealEmbeddingNeedle(settings: Settings, chunkCount: number, k = 10): Promise<RealEmbeddingResult> {
  const corpus = generateNeedleCorpus(chunkCount);
  const embedSettings: Settings = { ...settings, retryOnRateLimit: false };
  const vectors: number[][] = [];
  for (const batch of batchArray(corpus.chunks.map((c) => c.text), 64)) {
    vectors.push(...(await embed(embedSettings, batch)));
  }
  const dim = vectors[0]?.length ?? 0;
  const { vectors: packed, perDimScale } = packVectors(vectors, dim);
  const keywordIndex = buildKeywordIndex(corpus.chunks);
  const [queryVector] = await embed(embedSettings, [corpus.query]);
  const hits = hybridSearch({
    dim,
    perDimScale,
    chunkCount,
    vectors: packed,
    chunks: corpus.chunks,
    queryVector,
    query: corpus.query,
    k,
    keywordIndex,
  });
  const result = evaluateNeedleHits(hits, corpus, k);
  return { ...result, corpus, topHits: hits.slice(0, k) };
}

export interface CitationNeedleResult {
  retrieval: RealEmbeddingResult;
  cited: boolean;
  answer: string;
}

/** Mode 3: retrieve (mode 2), then ask the model to answer and cite
 * `[[sentence-id]]` tokens exactly like `search_repo` presents evidence, and
 * check the needle's precomputed sentence id survives into the model's
 * answer — the same validation contract `agentRuntime.ts`'s citation pipeline
 * uses in production, applied here via the shared, pure `extractCitationIds`. */
export async function runCitationNeedle(settings: Settings, chunkCount: number, k = 10): Promise<CitationNeedleResult> {
  const retrieval = await runRealEmbeddingNeedle(settings, chunkCount, k);
  const hitChunkIds = new Set(retrieval.topHits.map((h) => h.chunkId));
  const passages = retrieval.corpus.chunks
    .filter((c) => hitChunkIds.has(c.chunkId))
    .map((c) => (c.sentences ?? []).map((s) => `[[${s.id}]] ${c.text.slice(s.start, s.end)}`).join('\n'))
    .join('\n\n');

  const completionSettings: Settings = { ...settings, retryOnRateLimit: false };
  const reply = await complete(completionSettings, [
    {
      role: 'system',
      content:
        'Repository evidence was retrieved before this call. Answer the question using ONLY the passages below, ' +
        'and cite the supporting [[sentence-id]] token immediately after each claim by copying it verbatim. ' +
        'Cite only ids shown here — never invent, guess, or reuse an id.\n\n' +
        passages,
    },
    { role: 'user', content: retrieval.corpus.query },
  ]);
  const answer = reply.content ?? '';
  const cited = extractCitationIds(answer).includes(retrieval.corpus.needleSentenceId);
  return { retrieval, cited, answer };
}
