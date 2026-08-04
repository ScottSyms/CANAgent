// Versioned deterministic fixture for detecting retrieval regressions. Synthetic
// vectors deliberately isolate semantic, exact-token, and graph-only wins; this
// is a repeatable engineering benchmark, not a claim about production quality.

import type { DocGraph } from './docGraph';
import { rankGraphEvidence } from './graphRetrieval';
import { hybridSearch, multiHybridSearch } from './hybridSearch';
import { evaluateRetrieval, type RetrievalEvaluationCase, type RetrievalMetrics } from './retrievalEvaluation';
import { normalizeVector, quantizeVector, scoreVectors, type ChunkInput, type SearchHit } from './vectorSearch';

export const RETRIEVAL_BENCHMARK_VERSION = 1;
export const RETRIEVAL_BENCHMARK_THRESHOLDS = {
  hybridHitAt1: 0.6,
  graphAssistedHitAt1: 1,
  graphAssistedRecallAt3: 1,
  graphAssistedMrr: 1,
} as const;

interface BenchmarkCase extends RetrievalEvaluationCase {
  query: string;
  queryVariants: string[];
  queryVector: number[];
}

export interface RetrievalBenchmarkVariant {
  at1: RetrievalMetrics;
  at3: RetrievalMetrics;
}

export interface RetrievalBenchmarkResult {
  version: number;
  variants: Record<'dense' | 'hybrid' | 'multiQuery' | 'graphAssisted', RetrievalBenchmarkVariant>;
}

const chunks: ChunkInput[] = [
  {
    name: 'architecture.md',
    url: 'file:///architecture.md',
    text: 'The system architecture uses modular services and stable interfaces.',
    chunkId: 'd0:c0',
    sentences: [{ id: 's-architecture', start: 0, end: 64 }],
  },
  {
    name: 'ownership.md',
    url: 'file:///ownership.md',
    text: 'The initiative is owned by the Digital Platforms directorate.',
    chunkId: 'd1:c0',
    sentences: [{ id: 's-atlas', start: 0, end: 61 }],
  },
  {
    name: 'parts.md',
    url: 'file:///parts.md',
    text: 'Replacement part XJ-9000 requires the revised mounting bracket.',
    chunkId: 'd2:c0',
    sentences: [{ id: 's-part', start: 0, end: 62 }],
  },
  {
    name: 'modernization.md',
    url: 'file:///modernization.md',
    text: 'Workloads move in three waves with governance reviews between stages.',
    chunkId: 'd3:c0',
    sentences: [{ id: 's-cloud', start: 0, end: 66 }],
  },
  {
    name: 'finance.md',
    url: 'file:///finance.md',
    text: 'The annual budget forecast includes operating and capital expenditures.',
    chunkId: 'd4:c0',
    sentences: [{ id: 's-finance', start: 0, end: 68 }],
  },
];

const rawVectors = [
  [1, 0],
  [0, 1],
  [0.3, 0.95],
  [0, 1],
  [0.8, 0.2],
];
const dim = 2;
const perDimScale = [1, 1];
const vectors = new Int8Array(rawVectors.length * dim);
rawVectors.forEach((vector, i) => vectors.set(quantizeVector(normalizeVector(vector), perDimScale), i * dim));

const graph: DocGraph = {
  version: 1,
  corpusRevision: 1,
  processedDocIds: ['d0', 'd1', 'd2', 'd3', 'd4'],
  updatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    {
      id: 'atlas',
      type: 'initiative',
      label: 'Program Northstar',
      aliases: ['Project Atlas'],
      summary: 'A strategic digital program with assigned ownership.',
      evidenceSentenceIds: ['s-atlas'],
      docIds: ['d1'],
    },
    {
      id: 'cloud',
      type: 'strategy',
      label: 'Cloud migration',
      aliases: ['Modernization roadmap'],
      summary: 'A staged migration governed between delivery waves.',
      evidenceSentenceIds: ['s-cloud'],
      docIds: ['d3'],
    },
  ],
  edges: [],
  communities: [
    {
      id: 'modernization',
      title: 'Cloud modernization',
      summary: 'Migration waves and governance checkpoints.',
      nodeIds: ['cloud'],
      evidenceSentenceIds: ['s-cloud'],
    },
  ],
};

const cases: BenchmarkCase[] = [
  {
    id: 'semantic-architecture',
    query: 'system architecture',
    queryVariants: ['system architecture', 'technical design'],
    queryVector: [1, 0],
    relevantChunkIndices: [0],
  },
  {
    id: 'exact-identifier',
    query: 'XJ-9000',
    queryVariants: ['XJ-9000', 'replacement part XJ-9000'],
    queryVector: [1, 0],
    relevantChunkIndices: [2],
  },
  {
    id: 'entity-alias',
    query: 'Who owns Project Atlas?',
    queryVariants: ['Who owns Project Atlas?', 'Northstar responsibility'],
    queryVector: [1, 0],
    relevantChunkIndices: [1],
  },
  {
    id: 'community-theme',
    query: 'cloud migration strategy',
    queryVariants: ['cloud migration strategy', 'modernization roadmap'],
    queryVector: [1, 0],
    relevantChunkIndices: [3],
  },
  {
    id: 'ordinary-topic',
    query: 'annual budget forecast',
    queryVariants: ['annual budget forecast', 'financial planning'],
    queryVector: [0.8, 0.2],
    relevantChunkIndices: [4],
  },
];

const base = { dim, perDimScale, chunkCount: chunks.length, vectors, chunks };
const chunkIndex = new Map(chunks.map((chunk, i) => [chunk.chunkId, i]));

function indices(hits: SearchHit[]): number[] {
  return hits.map((hit) => chunkIndex.get(hit.chunkId)).filter((i): i is number => i !== undefined);
}

/** Execute every deterministic retrieval variant and calculate comparable metrics. */
export function runRetrievalBenchmark(): RetrievalBenchmarkResult {
  const rankings: Record<string, Record<string, number[]>> = {
    dense: {},
    hybrid: {},
    multiQuery: {},
    graphAssisted: {},
  };

  for (const testCase of cases) {
    rankings.dense[testCase.id] = scoreVectors({ ...base, queryVector: testCase.queryVector }).map(({ i }) => i);
    rankings.hybrid[testCase.id] = indices(hybridSearch({
      ...base,
      queryVector: testCase.queryVector,
      query: testCase.query,
      k: chunks.length,
    }));
    const queryVectors = testCase.queryVariants.map(() => testCase.queryVector);
    rankings.multiQuery[testCase.id] = indices(multiHybridSearch({
      ...base,
      queryVectors,
      queries: testCase.queryVariants,
      k: chunks.length,
    }));
    const supplementalRankings = testCase.queryVariants
      .map((query) => rankGraphEvidence(graph, query, chunks))
      .filter((ranking) => ranking.length > 0);
    rankings.graphAssisted[testCase.id] = indices(multiHybridSearch({
      ...base,
      queryVectors,
      queries: testCase.queryVariants,
      supplementalRankings,
      k: chunks.length,
    }));
  }

  const evaluationCases: RetrievalEvaluationCase[] = cases;
  const variants = Object.fromEntries(
    Object.entries(rankings).map(([name, ranking]) => [name, {
      at1: evaluateRetrieval(evaluationCases, ranking, 1, chunks.length),
      at3: evaluateRetrieval(evaluationCases, ranking, 3, chunks.length),
    }]),
  ) as RetrievalBenchmarkResult['variants'];
  return { version: RETRIEVAL_BENCHMARK_VERSION, variants };
}
