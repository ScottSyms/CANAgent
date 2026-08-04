import { describe, expect, it } from 'vitest';
import { evaluateRetrieval } from './retrievalEvaluation';

describe('evaluateRetrieval', () => {
  it('computes macro recall, hit rate, and reciprocal rank', () => {
    const metrics = evaluateRetrieval(
      [
        { id: 'a', relevantChunkIndices: [1, 2] },
        { id: 'b', relevantChunkIndices: [3] },
      ],
      {
        a: [0, 1, 2],
        b: [3, 0],
      },
      2,
      4,
    );

    expect(metrics).toEqual({
      queryCount: 2,
      recallAtK: 0.75,
      hitRateAtK: 1,
      mrr: 0.75,
      invalidResultCount: 0,
    });
  });

  it('counts invalid chunk references and tolerates missing rankings', () => {
    const metrics = evaluateRetrieval(
      [
        { id: 'a', relevantChunkIndices: [0] },
        { id: 'missing', relevantChunkIndices: [1] },
      ],
      { a: [9, 0] },
      1,
      2,
    );
    expect(metrics.invalidResultCount).toBe(1);
    expect(metrics.hitRateAtK).toBe(0);
    expect(metrics.mrr).toBe(0.25);
  });

  it('returns zero metrics for an empty evaluation set', () => {
    expect(evaluateRetrieval([], {}, 5, 0)).toEqual({
      queryCount: 0,
      recallAtK: 0,
      hitRateAtK: 0,
      mrr: 0,
      invalidResultCount: 0,
    });
  });
});
