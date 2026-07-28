import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../shared/types';

const embedChunks = vi.fn();
const embedderId = vi.fn();
vi.mock('./llmProvider', () => ({
  embedChunks: (...a: unknown[]) => embedChunks(...a),
  embedderId: (...a: unknown[]) => embedderId(...a),
}));

const extractPdf = vi.fn();
const extractOffice = vi.fn();
const repoAdd = vi.fn();
const repoAddMany = vi.fn();
vi.mock('./offscreenClient', () => ({
  extractPdf: (...a: unknown[]) => extractPdf(...a),
  extractOffice: (...a: unknown[]) => extractOffice(...a),
  repoAdd: (...a: unknown[]) => repoAdd(...a),
  repoAddMany: (...a: unknown[]) => repoAddMany(...a),
}));

import { ingestFiles, storeTexts } from './repoIngest';

const settings: Settings = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt' };

afterEach(() => {
  vi.restoreAllMocks();
  embedChunks.mockReset();
  embedderId.mockReset();
  extractPdf.mockReset();
  extractOffice.mockReset();
  repoAdd.mockReset();
  repoAddMany.mockReset();
});

describe('storeTexts', () => {
  it('embeds every document\'s chunks in one call and stores them via a single repoAddMany batch', async () => {
    embedderId.mockReturnValue('local:minilm');
    // 2 chunks for "a" (short text chunked twice by the fixture's chunker isn't
    // realistic here — chunkText decides chunk count for real text, so use text
    // long enough to be one chunk each and assert on the flattened call shape).
    embedChunks.mockResolvedValue([[1, 0], [0, 1]]);
    repoAddMany.mockResolvedValue({ ok: true, result: { docs: [{ docId: 'd1', chunkCount: 1 }, { docId: 'd2', chunkCount: 2 }] } });

    const results = await storeTexts(
      settings,
      'repo',
      [
        { name: 'a', url: 'file:///a', text: 'alpha text' },
        { name: 'b', url: 'file:///b', text: 'beta text' },
      ],
      { kind: 'folder' },
    );

    expect(embedChunks).toHaveBeenCalledTimes(1);
    expect(repoAddMany).toHaveBeenCalledTimes(1);
    const [repoArg, docsArg, optsArg] = repoAddMany.mock.calls[0];
    expect(repoArg).toBe('repo');
    expect(docsArg.map((d: { doc: { name: string } }) => d.doc.name)).toEqual(['a', 'b']);
    expect(optsArg).toEqual({ embedModel: 'local:minilm', kind: 'folder' });
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('propagates a repoAddMany failure to every document in the batch', async () => {
    embedderId.mockReturnValue('local:minilm');
    embedChunks.mockResolvedValue([[1]]);
    repoAddMany.mockResolvedValue({ ok: false, error: 'model lock mismatch' });

    const results = await storeTexts(settings, 'repo', [{ name: 'a', url: 'file:///a', text: 'alpha text' }]);
    expect(results).toEqual([{ ok: false, error: 'model lock mismatch' }]);
  });

  it('returns per-item errors without calling embedChunks when every item chunks to nothing', async () => {
    const results = await storeTexts(settings, 'repo', [{ name: 'empty', url: 'file:///e', text: '' }]);
    expect(results).toEqual([{ ok: false, error: 'No chunks produced.' }]);
    expect(embedChunks).not.toHaveBeenCalled();
  });
});

describe('ingestFiles', () => {
  it('extracts files in parallel and stores successfully-extracted ones as a single batch', async () => {
    extractPdf.mockResolvedValue({ ok: true, text: 'pdf body text here' });
    extractOffice.mockResolvedValue({ ok: true, text: 'office body text here' });
    embedderId.mockReturnValue('local:minilm');
    embedChunks.mockResolvedValue([[1], [2]]);
    repoAddMany.mockResolvedValue({ ok: true, result: { docs: [] } });

    const results = await ingestFiles(
      settings,
      'repo',
      [
        { name: 'a.pdf', kind: 'pdf', dataUrl: 'data:app/pdf;base64,x' },
        { name: 'b.docx', kind: 'office', dataUrl: 'data:app/docx;base64,y' },
      ],
      'page',
    );

    expect(extractPdf).toHaveBeenCalledTimes(1);
    expect(extractOffice).toHaveBeenCalledTimes(1);
    expect(repoAddMany).toHaveBeenCalledTimes(1); // one batched store call, not one per file
    expect(results).toEqual([{ ok: true, chunks: 1 }, { ok: true, chunks: 1 }]);
  });

  it('keeps a per-file extraction failure from blocking the others, and preserves result order', async () => {
    extractPdf.mockResolvedValue({ ok: false, error: 'Not a readable PDF.' });
    embedderId.mockReturnValue('local:minilm');
    embedChunks.mockResolvedValue([[1]]);
    repoAddMany.mockResolvedValue({ ok: true, result: { docs: [] } });

    const results = await ingestFiles(
      settings,
      'repo',
      [
        { name: 'bad.pdf', kind: 'pdf', dataUrl: 'data:app/pdf;base64,x' },
        { name: 'ok.txt', kind: 'text', text: 'plain text content here' },
      ],
      'page',
    );

    expect(results[0]).toEqual({ ok: false, error: 'Not a readable PDF.' });
    expect(results[1]).toEqual({ ok: true, chunks: 1 });
    // Only the successfully-extracted file reaches the embed/store batch.
    expect(embedChunks).toHaveBeenCalledWith(settings, ['plain text content here']);
  });

  it('skips the batch store entirely when every file fails extraction', async () => {
    extractPdf.mockResolvedValue({ ok: false, error: 'boom' });
    const results = await ingestFiles(settings, 'repo', [{ name: 'bad.pdf', kind: 'pdf', dataUrl: 'data:app/pdf;base64,x' }], 'page');
    expect(results).toEqual([{ ok: false, error: 'boom' }]);
    expect(embedChunks).not.toHaveBeenCalled();
    expect(repoAddMany).not.toHaveBeenCalled();
  });
});
