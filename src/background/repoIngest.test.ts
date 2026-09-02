import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UploadFile } from '../shared/messages';
import type { Settings } from '../shared/types';

const embedChunksMock = vi.fn();
const embedderIdMock = vi.fn();
embedderIdMock.mockReturnValue('local:test-model');
vi.mock('./llmProvider', () => ({
  embedChunks: (...a: unknown[]) => embedChunksMock(...a),
  embedderId: (...a: unknown[]) => embedderIdMock(...a),
  complete: vi.fn(),
  resolveModelForRole: vi.fn(),
}));

const repoAddBatchMock = vi.fn();
const repoAddMock = vi.fn();
const repoIngestLocalBatchMock = vi.fn();
const extractPdfMock = vi.fn();
const extractOfficeMock = vi.fn();
vi.mock('./offscreenClient', () => ({
  extractPdf: (...a: unknown[]) => extractPdfMock(...a),
  extractOffice: (...a: unknown[]) => extractOfficeMock(...a),
  repoAdd: (...a: unknown[]) => repoAddMock(...a),
  repoAddBatch: (...a: unknown[]) => repoAddBatchMock(...a),
  repoIngestLocalBatch: (...a: unknown[]) => repoIngestLocalBatchMock(...a),
}));

// Mocked (not exercised for real): scheduleInstantGraphRefresh's own
// debounce/build behavior is covered directly in graphExtract.test.ts with
// fake timers. Here we only assert repoIngest.ts calls it at the right
// moments -- letting the real 2s-debounced setTimeout run for real in this
// file would leave a background timer outliving each test.
const scheduleInstantGraphRefreshMock = vi.fn();
vi.mock('./graphExtract', () => ({
  scheduleInstantGraphRefresh: (...a: unknown[]) => scheduleInstantGraphRefreshMock(...a),
}));

import { flattenForEmbedding, ingestFilesBatch, storeText, unflattenVectors } from './repoIngest';

// Default settings route through the LOCAL embedder (settings.embedder is
// unset, and ingestFilesBatch/storeText treat anything other than
// 'external' as local) -- i.e. through the fused repoIngestLocalBatch op.
const settings: Settings = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt' };
const externalSettings: Settings = { ...settings, embedder: 'external' };

function textFile(name: string, text: string): UploadFile {
  return { name, kind: 'text', text };
}

/** Default happy-path result shape shared by repoAddBatch and repoIngestLocalBatch mocks: one ok result per doc, in order. */
function okBatchResult(docs: Array<{ chunks: string[] }>) {
  return {
    ok: true,
    result: docs.map((d, i) => ({ ok: true, docId: `doc-${i}`, chunkCount: d.chunks.length })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  embedChunksMock.mockReset();
  repoAddBatchMock.mockReset();
  repoAddMock.mockReset();
  repoIngestLocalBatchMock.mockReset();
  extractPdfMock.mockReset();
  extractOfficeMock.mockReset();
  scheduleInstantGraphRefreshMock.mockReset();
});

describe('flattenForEmbedding / unflattenVectors', () => {
  it('concatenates chunks in order and records each entry\'s range', () => {
    const entries = [{ chunks: ['a1', 'a2', 'a3'] }, { chunks: ['b1'] }, { chunks: [] }, { chunks: ['c1', 'c2'] }];
    const { flatChunks, ranges } = flattenForEmbedding(entries);
    expect(flatChunks).toEqual(['a1', 'a2', 'a3', 'b1', 'c1', 'c2']);
    expect(ranges).toEqual([
      { start: 0, count: 3 },
      { start: 3, count: 1 },
      { start: 4, count: 0 },
      { start: 4, count: 2 },
    ]);
  });

  it('slices a flat vectors array back into each range, index-aligned', () => {
    const ranges = [{ start: 0, count: 2 }, { start: 2, count: 1 }, { start: 3, count: 0 }, { start: 3, count: 2 }];
    const vectors = [[1], [2], [3], [4], [5]];
    expect(unflattenVectors(vectors, ranges)).toEqual([[[1], [2]], [[3]], [], [[4], [5]]]);
  });
});

describe('ingestFilesBatch (local embedder — default settings)', () => {
  it('routes through the fused repoIngestLocalBatch op, once per batch (not once per file, and no separate embedChunks call)', async () => {
    const files = [textFile('a.txt', 'alpha'), textFile('b.txt', 'beta'), textFile('c.txt', 'gamma')];
    repoIngestLocalBatchMock.mockImplementation((_repo: string, docs: Array<{ chunks: string[] }>) => Promise.resolve(okBatchResult(docs)));

    const results = await ingestFilesBatch(settings, 'r', files);

    expect(repoIngestLocalBatchMock).toHaveBeenCalledTimes(1);
    expect(embedChunksMock).not.toHaveBeenCalled(); // embedding happens inside the (mocked) offscreen op, not here
    expect(repoAddBatchMock).not.toHaveBeenCalled();
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('one file\'s extraction failure does not block or misalign the others', async () => {
    const files = [textFile('ok-a.txt', 'alpha content'), textFile('bad.pdf', ''), textFile('ok-b.txt', 'beta content')];
    files[1].kind = 'pdf'; // no dataUrl and no inline text -> extractFileText fails
    let capturedDocs: Array<{ doc: { name: string }; chunks: string[] }> = [];
    repoIngestLocalBatchMock.mockImplementation((_repo: string, docs: typeof capturedDocs) => {
      capturedDocs = docs;
      return Promise.resolve(okBatchResult(docs));
    });

    const results = await ingestFilesBatch(settings, 'r', files);

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(true);
    // The failed file never reached the ingest stage; the other two still
    // get their own, correctly-indexed doc in the batch write.
    expect(capturedDocs.map((d) => d.doc.name)).toEqual(['ok-a.txt', 'ok-b.txt']);
    expect(repoIngestLocalBatchMock).toHaveBeenCalledTimes(1);
  });

  it('an offscreen op failure surfaces as a per-file error result, not a thrown rejection', async () => {
    repoIngestLocalBatchMock.mockResolvedValue({ ok: false, error: 'local embedding failed' });
    const files = [textFile('a.txt', 'alpha'), textFile('b.txt', 'beta')];

    const results = await ingestFilesBatch(settings, 'r', files);

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.every((r) => !r.ok && r.error?.includes('local embedding failed'))).toBe(true);
  });

  it('passes settings.localEmbedModel through as the raw model id', async () => {
    let capturedOpts: { model?: string } = {};
    repoIngestLocalBatchMock.mockImplementation((_repo: string, docs: Array<{ chunks: string[] }>, opts: { model?: string }) => {
      capturedOpts = opts;
      return Promise.resolve(okBatchResult(docs));
    });

    await ingestFilesBatch({ ...settings, localEmbedModel: 'custom-model' }, 'r', [textFile('a.txt', 'alpha')]);

    expect(capturedOpts.model).toBe('custom-model');
  });
});

describe('ingestFilesBatch (external embedder)', () => {
  it('calls embedChunks exactly once for a multi-file batch (not once per file), then repoAddBatch', async () => {
    embedChunksMock.mockResolvedValue([[1], [2], [3]]);
    const files = [textFile('a.txt', 'alpha'), textFile('b.txt', 'beta'), textFile('c.txt', 'gamma')];
    repoAddBatchMock.mockImplementation((_repo: string, docs: Array<{ chunks: string[] }>) => Promise.resolve(okBatchResult(docs)));

    const results = await ingestFilesBatch(externalSettings, 'r', files);

    expect(embedChunksMock).toHaveBeenCalledTimes(1);
    expect(repoIngestLocalBatchMock).not.toHaveBeenCalled(); // external path never touches the local-only fused op
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('maps vectors back to the correct file after flatten/unflatten', async () => {
    // Distinguishable per-chunk vectors tagged [fileIndex, chunkIndex, ...] so
    // a misaligned slice would be caught, not just "some vector or other".
    embedChunksMock.mockImplementation((_settings: Settings, texts: string[]) =>
      Promise.resolve(texts.map((t) => [t.length, texts.indexOf(t)])),
    );
    const files = [textFile('a.txt', 'aa'), textFile('b.txt', 'bbb bbb bbb')]; // multi-chunk via long text
    let capturedDocs: Array<{ doc: { name: string }; chunks: string[]; vectors: number[][] }> = [];
    repoAddBatchMock.mockImplementation((_repo: string, docs: typeof capturedDocs) => {
      capturedDocs = docs;
      return Promise.resolve(okBatchResult(docs));
    });

    await ingestFilesBatch(externalSettings, 'r', files);

    expect(capturedDocs).toHaveLength(2);
    for (const doc of capturedDocs) {
      expect(doc.vectors).toHaveLength(doc.chunks.length);
    }
  });

  it('one file\'s extraction failure does not block or misalign the others', async () => {
    embedChunksMock.mockResolvedValue([[1], [2]]);
    const files = [textFile('ok-a.txt', 'alpha content'), textFile('bad.pdf', ''), textFile('ok-b.txt', 'beta content')];
    files[1].kind = 'pdf'; // no dataUrl and no inline text -> extractFileText fails
    let capturedDocs: Array<{ doc: { name: string }; chunks: string[] }> = [];
    repoAddBatchMock.mockImplementation((_repo: string, docs: typeof capturedDocs) => {
      capturedDocs = docs;
      return Promise.resolve(okBatchResult(docs));
    });

    const results = await ingestFilesBatch(externalSettings, 'r', files);

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(true);
    // The failed file never reached the flatten/embed stage; the other two
    // still get their own, correctly-indexed doc in the batch write.
    expect(capturedDocs.map((d) => d.doc.name)).toEqual(['ok-a.txt', 'ok-b.txt']);
    expect(embedChunksMock).toHaveBeenCalledTimes(1);
  });

  it('an embed-call failure surfaces as a per-file error result, not a thrown rejection', async () => {
    embedChunksMock.mockRejectedValue(new Error('embedder unavailable'));
    const files = [textFile('a.txt', 'alpha'), textFile('b.txt', 'beta')];

    const results = await ingestFilesBatch(externalSettings, 'r', files);

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results.every((r) => !r.ok && r.error?.includes('embedder unavailable'))).toBe(true);
    expect(repoAddBatchMock).not.toHaveBeenCalled();
  });
});

describe('background Instant-tier refresh scheduling', () => {
  it('ingestFilesBatch (local): schedules a refresh once per successful batch, not once per file', async () => {
    const files = [textFile('a.txt', 'alpha'), textFile('b.txt', 'beta'), textFile('c.txt', 'gamma')];
    repoIngestLocalBatchMock.mockImplementation((_repo: string, docs: Array<{ chunks: string[] }>) => Promise.resolve(okBatchResult(docs)));

    await ingestFilesBatch(settings, 'repo-x', files);

    expect(scheduleInstantGraphRefreshMock).toHaveBeenCalledTimes(1);
    expect(scheduleInstantGraphRefreshMock).toHaveBeenCalledWith('repo-x');
  });

  it('ingestFilesBatch (local): does not schedule a refresh when the offscreen op fails', async () => {
    repoIngestLocalBatchMock.mockResolvedValue({ ok: false, error: 'store failed' });

    await ingestFilesBatch(settings, 'repo-x', [textFile('a.txt', 'alpha')]);

    expect(scheduleInstantGraphRefreshMock).not.toHaveBeenCalled();
  });

  it('ingestFilesBatch (external): schedules a refresh on success, not on embed failure', async () => {
    embedChunksMock.mockResolvedValue([[1]]);
    repoAddBatchMock.mockImplementation((_repo: string, docs: Array<{ chunks: string[] }>) => Promise.resolve(okBatchResult(docs)));
    await ingestFilesBatch(externalSettings, 'repo-x', [textFile('a.txt', 'alpha')]);
    expect(scheduleInstantGraphRefreshMock).toHaveBeenCalledWith('repo-x');

    scheduleInstantGraphRefreshMock.mockClear();
    embedChunksMock.mockRejectedValue(new Error('embedder unavailable'));
    await ingestFilesBatch(externalSettings, 'repo-x', [textFile('b.txt', 'beta')]);
    expect(scheduleInstantGraphRefreshMock).not.toHaveBeenCalled();
    expect(repoAddBatchMock).toHaveBeenCalledTimes(1); // only from the first (successful) call above
  });

  it('storeText also schedules a refresh on success, and not on failure', async () => {
    repoIngestLocalBatchMock.mockResolvedValueOnce({ ok: true, result: [{ ok: true, docId: 'd1', chunkCount: 1 }] });
    const ok = await storeText(settings, 'repo-y', 'doc', 'file:///doc', 'some text content');
    expect(ok.ok).toBe(true);
    expect(scheduleInstantGraphRefreshMock).toHaveBeenCalledWith('repo-y');

    scheduleInstantGraphRefreshMock.mockClear();
    repoIngestLocalBatchMock.mockResolvedValueOnce({ ok: false, error: 'store failed' });
    const failed = await storeText(settings, 'repo-y', 'doc2', 'file:///doc2', 'more text content');
    expect(failed.ok).toBe(false);
    expect(scheduleInstantGraphRefreshMock).not.toHaveBeenCalled();
  });
});
