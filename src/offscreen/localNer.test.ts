import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NerToken } from '../shared/nerAggregate';

// Mocks the transformers.js pipeline entirely — this only verifies the
// batching/dispatch/normalization logic in localNer.ts (does a batch call's
// output get sliced back to the right per-input span list, in order, with no
// cross-input mixing), not the real model's batching behavior, which can't be
// exercised outside a live browser (see the file-level comment in
// src/shared/nerAggregate.ts).
const extractorMock = vi.fn();
vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: {} } } },
  pipeline: vi.fn(() => Promise.resolve(extractorMock)),
}));

function token(word: string, entity: string, start: number, end: number, score = 0.95): NerToken {
  return { word, entity, start, end, score };
}

describe('extractEntitiesLocal batching', () => {
  beforeEach(() => {
    extractorMock.mockReset();
  });

  it('dispatches a single input in one call', async () => {
    const { extractEntitiesLocal } = await import('./localNer');
    extractorMock.mockImplementation(async (texts: string[]) =>
      texts.map((t, i) => [token(t, i % 2 === 0 ? 'B-PER' : 'B-ORG', 0, t.length)]),
    );

    const { spans } = await extractEntitiesLocal(['Alice']);

    expect(extractorMock).toHaveBeenCalledTimes(1);
    expect(extractorMock.mock.calls[0][0]).toHaveLength(1);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual([{ label: 'PER', start: 0, end: 5, score: 0.95 }]);
  });

  it('dispatches each input as its own call (NER_BATCH=1 — each inference call is its own await boundary, so a slow WASM forward pass never blocks the extension for more than one text at a stretch), preserving global index alignment', async () => {
    const { extractEntitiesLocal } = await import('./localNer');
    extractorMock.mockImplementation(async (texts: string[]) => texts.map((t) => [token(t, 'B-LOC', 0, t.length)]));

    const texts = Array.from({ length: 10 }, (_, i) => `text${i}`);
    const { spans } = await extractEntitiesLocal(texts);

    expect(extractorMock).toHaveBeenCalledTimes(10);
    for (const call of extractorMock.mock.calls) expect(call[0]).toHaveLength(1);
    expect(spans).toHaveLength(10);
    spans.forEach((s, i) => expect(s[0].end).toBe(texts[i].length));
  });

  it('normalizes a flat (non-nested) result for a single-item batch instead of misreading it as one shared span list', async () => {
    const { extractEntitiesLocal } = await import('./localNer');
    // Simulates a pipeline that collapses a length-1 batch to a flat token
    // array instead of [[...tokens]].
    extractorMock.mockImplementation(async (texts: string[]) =>
      texts.length === 1 ? [token('Solo', 'B-PER', 0, 4)] : texts.map(() => []),
    );

    const { spans } = await extractEntitiesLocal(['Solo']);
    expect(spans).toEqual([[{ label: 'PER', start: 0, end: 4, score: 0.95 }]]);
  });

  it('produces an empty span list (not a crash) for a malformed per-call result', async () => {
    const { extractEntitiesLocal } = await import('./localNer');
    extractorMock
      .mockImplementationOnce(async () => [[token('A', 'B-PER', 0, 1)]])
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => undefined);

    const { spans } = await extractEntitiesLocal(['a', 'b', 'c']);
    expect(spans).toHaveLength(3);
    expect(spans[0]).toEqual([{ label: 'PER', start: 0, end: 1, score: 0.95 }]);
    expect(spans[1]).toEqual([]);
    expect(spans[2]).toEqual([]);
  });

  it('swaps blank inputs for a single space so row alignment never drifts', async () => {
    const { extractEntitiesLocal } = await import('./localNer');
    const seen: string[] = [];
    extractorMock.mockImplementation(async (texts: string[]) => {
      seen.push(...texts);
      return texts.map(() => []);
    });

    const { spans } = await extractEntitiesLocal(['', 'real text']);
    expect(seen).toEqual([' ', 'real text']);
    expect(spans).toHaveLength(2);
  });

  it('returns immediately for an empty input array without calling the model', async () => {
    const { extractEntitiesLocal } = await import('./localNer');
    const { spans } = await extractEntitiesLocal([]);
    expect(spans).toEqual([]);
    expect(extractorMock).not.toHaveBeenCalled();
  });
});
