// Deterministic retrieval-quality metrics shared by the graph-assisted RAG
// benchmark and unit tests. This evaluates candidate rankings only; answer
// generation and LLM reranking require a separate, model-backed evaluation.

export interface RetrievalEvaluationCase {
  id: string;
  relevantChunkIndices: number[];
}

export interface RetrievalMetrics {
  queryCount: number;
  recallAtK: number;
  hitRateAtK: number;
  mrr: number;
  invalidResultCount: number;
}

/** Compute macro Recall@k, HitRate@k, MRR, and invalid chunk references. */
export function evaluateRetrieval(
  cases: RetrievalEvaluationCase[],
  rankings: Readonly<Record<string, number[]>>,
  k: number,
  corpusSize: number,
): RetrievalMetrics {
  if (cases.length === 0) {
    return { queryCount: 0, recallAtK: 0, hitRateAtK: 0, mrr: 0, invalidResultCount: 0 };
  }
  const topK = Math.max(1, k);
  let recall = 0;
  let hits = 0;
  let reciprocalRank = 0;
  let invalidResultCount = 0;

  for (const testCase of cases) {
    const relevant = new Set(testCase.relevantChunkIndices);
    const ranking = rankings[testCase.id] ?? [];
    invalidResultCount += ranking.filter((i) => i < 0 || i >= corpusSize).length;
    const retrieved = ranking.slice(0, topK);
    const relevantRetrieved = new Set(retrieved.filter((i) => relevant.has(i))).size;
    if (relevant.size > 0) recall += relevantRetrieved / relevant.size;
    if (relevantRetrieved > 0) hits++;
    const firstRelevant = ranking.findIndex((i) => relevant.has(i));
    if (firstRelevant >= 0) reciprocalRank += 1 / (firstRelevant + 1);
  }

  return {
    queryCount: cases.length,
    recallAtK: recall / cases.length,
    hitRateAtK: hits / cases.length,
    mrr: reciprocalRank / cases.length,
    invalidResultCount,
  };
}
