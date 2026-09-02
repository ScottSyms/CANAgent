import { beforeEach, describe, expect, it, vi } from 'vitest';

// repoIngestLocalBatch dynamically imports localEmbed.ts, which needs a real
// browser (LiteRT/WASM, chrome.runtime.getURL) — mock it with a deterministic
// per-text embedder so the fused offscreen op can be tested against the same
// "two separate calls" reference path without a real model.
const embedTextsLocalMock = vi.fn(async (texts: string[], model?: string) => ({
  vectors: texts.map((t) => Array.from({ length: 8 }, (_, i) => Math.sin(t.length + i) + 1.5)),
  model: model ?? 'all-MiniLM-L6-v2-litert',
}));
vi.mock('./localEmbed', () => ({
  embedTextsLocal: (texts: string[], model?: string) => embedTextsLocalMock(texts, model),
  DEFAULT_LOCAL_MODEL: 'all-MiniLM-L6-v2-litert',
}));

import {
  repoAdd,
  repoAddBatch,
  repoDeleteDoc,
  repoDocChunks,
  repoDocVectors,
  repoExportOne,
  repoGraphGet,
  repoGraphGetRaw,
  repoGraphSnapshot,
  repoGraphSet,
  repoImportOne,
  repoIngestLocalBatch,
  repoList,
  repoNotebookGet,
  repoNotebookSample,
  repoNotebookSet,
  repoSearch,
  repoStudioGet,
  repoStudioSet,
} from './repoStore';
import type { NotebookOverview } from '../shared/types';
import { emptyDocGraph, mergeExtraction } from '../shared/docGraph';
import { dequantizeVector, normalizeVector } from '../shared/vectorSearch';
import { FakeDirHandle, installFakeOpfs } from './fakeOpfs';

const vec = (n: number, seed: number): number[] => Array.from({ length: n }, (_, i) => Math.sin(seed + i) + 1.5);

beforeEach(() => {
  // repoStore consults the vault (chrome.storage) to decide whether to
  // encrypt. Empty storage ⇒ no vault ⇒ plaintext, so these existing tests are
  // unaffected. (Encryption behavior is covered in repoEncryption.test.ts.)
  installFakeOpfs();
  embedTextsLocalMock.mockClear();
});

describe('repoStore model lock', () => {
  it('refuses an add from a different embedder than the repo was built with', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    await expect(
      repoAdd('r', { name: 'b', url: 'file:///b' }, ['world'], [vec(8, 2)], { embedModel: 'external:te3' }),
    ).rejects.toThrow(/built with embedder "local:minilm".*"external:te3"/);
  });

  it('allows further adds from the same embedder', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    const res = await repoAdd('r', { name: 'b', url: 'file:///b' }, ['world'], [vec(8, 2)], { embedModel: 'local:minilm' });
    expect(res.chunkCount).toBe(2);
  });

  it('refuses a query embedded by a different model', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    await expect(repoSearch('r', vec(8, 3), 3, 'external:te3')).rejects.toThrow(/Re-index the repo/);
  });

  it('clears the model lock after the repo is emptied, allowing a re-index with a new model', async () => {
    const { docId } = await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], {
      embedModel: 'local:minilm',
    });
    await repoDeleteDoc('r', docId);
    // Now a different embedder is accepted (re-index).
    const res = await repoAdd('r', { name: 'b', url: 'file:///b' }, ['world'], [vec(8, 2)], { embedModel: 'external:te3' });
    expect(res.chunkCount).toBe(1);
  });
});

describe('repoSearch redundant-normalization skip', () => {
  it('skips query normalization for a local: embedModel repo but not for an external: one', async () => {
    // The local embedder's own model graph already normalizes its output, so
    // repoSearch is expected to pass an un-normalized query straight through
    // for a `local:`-tagged repo, and to still normalize it for `external:`.
    await repoAdd('r-local', { name: 'a', url: 'file:///a' }, ['alpha'], [[1, 0]], { embedModel: 'local:minilm' });
    await repoAdd('r-ext', { name: 'a', url: 'file:///a' }, ['alpha'], [[1, 0]], { embedModel: 'external:te3' });

    const nonUnitQuery = [0.9, 0]; // magnitude 0.9 -- deliberately not unit-norm
    const localRes = await repoSearch('r-local', nonUnitQuery, 1, 'local:minilm');
    const extRes = await repoSearch('r-ext', nonUnitQuery, 1, 'external:te3');

    // Same single chunk either way, but the un-normalized query yields a
    // score scaled by ~0.9 relative to the normalized (external) computation
    // -- proof the local path genuinely skipped normalization end-to-end,
    // not just that scoreVectors' own unit test passed in isolation. Ratio
    // (not absolute score) comparison, since int8 quantization rounding adds
    // discrete noise absolute scores don't tolerate at this precision.
    expect(localRes.results[0].score / extRes.results[0].score).toBeCloseTo(0.9, 1);
  });
});

describe('repoIngestLocalBatch', () => {
  const docs = [
    { doc: { name: 'a', url: 'file:///a' }, chunks: ['alpha one', 'alpha two'] },
    { doc: { name: 'b', url: 'file:///b' }, chunks: ['beta one'] },
  ];

  it('produces the same stored chunks/vectors as calling embedTextsLocal then repoAddBatch separately', async () => {
    // Reference path: the two-step sequence repoIngestLocalBatch replaces.
    const allChunks = docs.flatMap((d) => d.chunks);
    const { vectors } = await embedTextsLocalMock(allChunks);
    let offset = 0;
    const withVectors = docs.map((d) => {
      const v = vectors.slice(offset, offset + d.chunks.length);
      offset += d.chunks.length;
      return { doc: d.doc, chunks: d.chunks, vectors: v };
    });
    await repoAddBatch('repo-reference', withVectors, { embedModel: 'local:all-MiniLM-L6-v2-litert' });

    // Fused path under test.
    const results = await repoIngestLocalBatch('repo-fused', docs, { model: 'all-MiniLM-L6-v2-litert' });
    expect(results.every((r) => r.ok)).toBe(true);

    const reference = await repoExportOne('repo-reference');
    const fused = await repoExportOne('repo-fused');
    expect(fused?.vectorsB64).toBe(reference?.vectorsB64); // same embeddings, same quantization
    expect((fused?.chunks as Array<{ text: string }>).map((c) => c.text)).toEqual(
      (reference?.chunks as Array<{ text: string }>).map((c) => c.text),
    );
    expect(fused?.meta).toMatchObject({ embedModel: 'local:all-MiniLM-L6-v2-litert', chunkCount: 3 });
  });

  it('embeds every document\'s chunks in a single embedTextsLocal call, not once per document', async () => {
    await repoIngestLocalBatch('repo-x', docs, { model: 'all-MiniLM-L6-v2-litert' });
    expect(embedTextsLocalMock).toHaveBeenCalledTimes(1);
    expect(embedTextsLocalMock.mock.calls[0][0]).toEqual(['alpha one', 'alpha two', 'beta one']);
  });

  it('degrades every document to a per-doc error when the embed call fails, instead of throwing', async () => {
    embedTextsLocalMock.mockRejectedValueOnce(new Error('model load failed'));
    const results = await repoIngestLocalBatch('repo-y', docs, { model: 'all-MiniLM-L6-v2-litert' });
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.ok && r.error.includes('model load failed'))).toBe(true);
  });

  it('returns [] for an empty batch without calling the embedder', async () => {
    const results = await repoIngestLocalBatch('repo-z', []);
    expect(results).toEqual([]);
    expect(embedTextsLocalMock).not.toHaveBeenCalled();
  });
});

describe('repoStore folder metadata', () => {
  it('stamps kind:folder and per-doc path/mtime/size for incremental sync', async () => {
    await repoAdd('f', { name: 'notes/a.md', url: 'file:///notes/a.md' }, ['hi'], [vec(8, 1)], {
      embedModel: 'local:minilm',
      kind: 'folder',
      docExtra: { path: 'notes/a.md', mtime: 1234, size: 99 },
    });
    const list = await repoSearch('f', vec(8, 1), 1, 'local:minilm');
    expect(list.results.length).toBe(1);
  });
});

describe('notebook overview', () => {
  const overview: NotebookOverview = {
    overviewMarkdown: '## About\nArctic shipping.',
    keyTopics: ['shipping', 'arctic'],
    suggestedQuestions: ['What routes are covered?'],
    docCount: 1,
    chunkCount: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('returns null when no overview has been generated', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    expect(await repoNotebookGet('r')).toBeNull();
  });

  it('round-trips a stored overview', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    await repoNotebookSet('r', overview);
    expect(await repoNotebookGet('r')).toEqual(overview);
  });

  it('samples chunks strided across the corpus, with docs and total count', async () => {
    const five = (p: string) => [p + '0', p + '1', p + '2', p + '3', p + '4'];
    await repoAdd('r', { name: 'a', url: 'file:///a' }, five('a'), five('a').map((_, i) => vec(8, i)), { embedModel: 'local:minilm' });
    await repoAdd('r', { name: 'b', url: 'file:///b' }, five('b'), five('b').map((_, i) => vec(8, i + 5)), { embedModel: 'local:minilm' });

    const s = await repoNotebookSample('r', 4);
    expect(s.chunkCount).toBe(10);
    expect(s.docs.map((d) => d.name)).toEqual(['a', 'b']);
    expect(s.samples.length).toBe(4); // stride = floor(10/4) = 2 → indices 0,2,4,6
    expect(s.samples[0].text).toBe('a0');
  });

  it('handles an empty repo', async () => {
    expect(await repoNotebookSample('empty')).toEqual({ docs: [], chunkCount: 0, samples: [] });
  });
});

describe('document graph', () => {
  it('round-trips a stored graph', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [{ label: 'SSC', type: 'org', summary: 's', evidence: ['x'] }], relations: [] }, 'doc-1');
    await repoGraphSet('r', g, 1);
    const back = await repoGraphGet('r');
    expect(back?.nodes.map((n) => n.label)).toEqual(['SSC']);
    expect(back?.processedDocIds).toEqual(['doc-1']);
  });

  it('returns null when no graph exists', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    expect(await repoGraphGet('r')).toBeNull();
  });

  it('repoGraphGetRaw returns a stale graph that repoGraphGet correctly refuses (for resuming a build)', async () => {
    // Regression test: buildRepoGraph used to resume via repoGraphGet (the
    // staleness-gated getter meant for live search/UI use) -- so the moment a
    // graph fell behind the repo's current corpusRevision (true as soon as
    // any document is added/removed since it was built), buildRepoGraph saw
    // null and silently discarded all prior nodes/edges/docCoverage on the
    // very next rebuild, even though the data was sitting right there.
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [{ label: 'SSC', type: 'org', summary: 's', evidence: ['x'] }], relations: [] }, 'doc-1');
    await repoGraphSet('r', g, 1);

    // Adding another document bumps corpusRevision to 2 without deleting the
    // graph (see the repoAdd fix above) -- the graph, still stamped at
    // revision 1, is now genuinely stale relative to the repo's meta.
    await repoAdd('r', { name: 'b', url: 'file:///b' }, ['world'], [vec(8, 2)]);

    expect(await repoGraphGet('r')).toBeNull(); // correct: refuse stale data for live use
    const raw = await repoGraphGetRaw('r');
    expect(raw?.nodes.map((n) => n.label)).toEqual(['SSC']); // correct: still resumable
    expect(raw?.corpusRevision).toBe(1);
  });

  it('fuses fresh graph evidence into ordinary hybrid repository search', async () => {
    const { docId } = await repoAdd(
      'r',
      { name: 'a', url: 'file:///a' },
      ['Semantic winner with generic content.', 'Graph-grounded passage with different wording.'],
      [[1, 0], [0, 1]],
      { embedModel: 'local:minilm' },
    );
    const baseline = await repoSearch('r', [1, 0], 1, 'local:minilm', { query: 'Project Atlas', hybrid: true });
    expect(baseline.results[0].text).toContain('Semantic winner');
    expect(baseline.diagnostics).toEqual({
      graphStatus: 'no_graph',
      graphRankingCount: 0,
      graphCandidateCount: 0,
    });

    const doc = await repoDocChunks('r', docId);
    const graph = emptyDocGraph();
    mergeExtraction(graph, {
      entities: [{
        label: 'Project Atlas',
        type: 'project',
        summary: 'A strategic initiative.',
        evidence: [doc[1].sentences[0].id],
      }],
      relations: [],
    }, docId);
    await repoGraphSet('r', graph, 1);

    const assisted = await repoSearch('r', [1, 0], 1, 'local:minilm', { query: 'Project Atlas', hybrid: true });
    expect(assisted.results[0].text).toContain('Graph-grounded passage');
    expect(assisted.diagnostics).toEqual({
      graphStatus: 'used',
      graphRankingCount: 1,
      graphCandidateCount: 1,
    });

    const disabled = await repoSearch('r', [1, 0], 1, 'local:minilm', {
      query: 'Project Atlas',
      hybrid: true,
      graphAssist: false,
    });
    expect(disabled.results[0].text).toContain('Semantic winner');
    expect(disabled.diagnostics.graphStatus).toBe('disabled');

    const noMatch = await repoSearch('r', [1, 0], 1, 'local:minilm', { query: 'Unknown subject', hybrid: true });
    expect(noMatch.results[0].text).toContain('Semantic winner');
    expect(noMatch.diagnostics.graphStatus).toBe('no_match');

    const semanticOnly = await repoSearch('r', [1, 0], 1, 'local:minilm', { query: 'Project Atlas', hybrid: false });
    expect(semanticOnly.diagnostics.graphStatus).toBe('hybrid_disabled');

    const staleArchive = await repoExportOne('r');
    (staleArchive!.meta as { corpusRevision: number }).corpusRevision = 2;
    await repoImportOne(staleArchive!, 'stale');
    const stale = await repoSearch('stale', [1, 0], 1, 'local:minilm', { query: 'Project Atlas', hybrid: true });
    expect(stale.results[0].text).toContain('Semantic winner');
    expect(stale.diagnostics.graphStatus).toBe('stale_graph');
  });

  it('repoDocVectors returns just one document\'s already-computed vectors, correctly sliced from a multi-doc repo', async () => {
    const { docId: docA } = await repoAdd('r', { name: 'a', url: 'file:///a' }, ['alpha one', 'alpha two'], [vec(8, 1), vec(8, 2)], {
      embedModel: 'local:minilm',
    });
    const { docId: docB } = await repoAdd('r', { name: 'b', url: 'file:///b' }, ['beta one'], [vec(8, 3)]);

    const a = await repoDocVectors('r', docA);
    const b = await repoDocVectors('r', docB);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.dim).toBe(8);
    expect(a!.vectors.length).toBe(2 * 8); // 2 chunks for doc A
    expect(b!.vectors.length).toBe(1 * 8); // 1 chunk for doc B

    // Round-trip: dequantizing doc A's first chunk should approximate the
    // same normalized vector repoAdd originally quantized and stored.
    const expected = normalizeVector(vec(8, 1));
    const actual = dequantizeVector(a!.vectors.subarray(0, 8), a!.perDimScale);
    for (let i = 0; i < 8; i++) expect(actual[i]).toBeCloseTo(expected[i], 1);
  });

  it('repoDocVectors returns null for an unknown document or repo', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    expect(await repoDocVectors('r', 'nope')).toBeNull();
    expect(await repoDocVectors('no-such-repo', 'nope')).toBeNull();
  });

  describe('corpus data caching (repoDocChunks/repoDocVectors)', () => {
    it('reads chunks.json/vectors.bin at most once across repeated doc-scoped reads for the same repo', async () => {
      const { docId: docA } = await repoAdd('r', { name: 'a', url: 'file:///a' }, ['alpha one', 'alpha two'], [vec(8, 1), vec(8, 2)], {
        embedModel: 'local:minilm',
      });
      const { docId: docB } = await repoAdd('r', { name: 'b', url: 'file:///b' }, ['beta one'], [vec(8, 3)]);

      // Only spy from here -- the two repoAdd calls above have their own
      // (expected) chunks.json/vectors.bin reads+writes that aren't part of
      // what this test is checking.
      const getFileHandleSpy = vi.spyOn(FakeDirHandle.prototype, 'getFileHandle');

      await repoDocChunks('r', docA);
      await repoDocChunks('r', docB);
      await repoDocVectors('r', docA);
      await repoDocVectors('r', docB);

      const countFor = (file: string) => getFileHandleSpy.mock.calls.filter(([name]) => name === file).length;
      // Before the corpus-cache fix, each of these 4 calls independently
      // re-read the whole file -- 4 reads instead of 1.
      expect(countFor('chunks.json')).toBe(1);
      expect(countFor('vectors.bin')).toBe(1);

      getFileHandleSpy.mockRestore();
    });

    it('forces a fresh read after repoAddBatch adds another document (cache correctly invalidated, not serving a stale doc range)', async () => {
      const { docId: docA } = await repoAdd('r', { name: 'a', url: 'file:///a' }, ['alpha one'], [vec(8, 1)], { embedModel: 'local:minilm' });
      await repoDocChunks('r', docA); // primes the cache at the pre-add revision

      const { docId: docB } = await repoAdd('r', { name: 'b', url: 'file:///b' }, ['beta one'], [vec(8, 2)]);
      // Without correct invalidation this could still see the pre-add cached
      // corpus (wrong revision/chunkCount) and fail to find docB's range.
      const chunksB = await repoDocChunks('r', docB);
      expect(chunksB).toHaveLength(1);
      expect(chunksB[0].text).toBe('beta one');

      const vectorsB = await repoDocVectors('r', docB);
      expect(vectorsB?.vectors.length).toBe(8);
    });
  });

  it('increments corpus revisions after an add without deleting the existing graph/Studio outputs', async () => {
    // Regression test: repoAdd used to delete graph.json/studio.json outright
    // on every add (invalidateGraphArtifacts), destroying prior extraction
    // work the moment one more document was added -- even though
    // buildRepoGraph's own per-document coverage tracking already handles a
    // new/changed document incrementally. The graph/studio file must survive
    // an add; only repoGraphGet/repoStudioGet's own staleness gate (still
    // enforced, unchanged) should refuse to serve it live until rebuilt.
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    expect((await repoGraphSnapshot('r')).corpusRevision).toBe(1);

    const graph = emptyDocGraph();
    mergeExtraction(graph, { entities: [{ label: 'A', type: 'x', summary: 's', evidence: ['s1'] }], relations: [] }, 'doc-1');
    await repoGraphSet('r', graph, 1);
    await repoStudioSet('r', {
      outputs: { briefing: { kind: 'briefing', title: 'B', markdown: '# B', citations: [], generatedAt: '2026-01-01T00:00:00.000Z' } },
    }, 1);

    await repoAdd('r', { name: 'b', url: 'file:///b' }, ['world'], [vec(8, 2)], { embedModel: 'local:minilm' });

    expect((await repoGraphSnapshot('r')).corpusRevision).toBe(2);
    // Live-use getters still correctly refuse a graph/studio that's now
    // behind the repo's current revision -- unchanged, and still correct.
    expect(await repoGraphGet('r')).toBeNull();
    expect(await repoStudioGet('r')).toEqual({ outputs: {} });
    // But the underlying files were NOT deleted: an archive export still
    // captures them, and a future build can resume from them incrementally.
    const exported = await repoExportOne('r');
    expect((exported?.graph as { nodes: Array<{ label: string }> } | undefined)?.nodes[0].label).toBe('A');
    expect((exported?.studio as { outputs: { briefing?: { title: string } } } | undefined)?.outputs.briefing?.title).toBe('B');
  });

  it('rejects a graph checkpoint from an older corpus revision', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    const graph = emptyDocGraph();
    await repoAdd('r', { name: 'b', url: 'file:///b' }, ['world'], [vec(8, 2)], { embedModel: 'local:minilm' });

    await expect(repoGraphSet('r', graph, 1)).rejects.toThrow('Repository changed while the graph was being built');
    expect(await repoGraphGet('r')).toBeNull();
  });

  it('invalidates graph artifacts when a document is deleted', async () => {
    const { docId } = await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    const graph = emptyDocGraph();
    await repoGraphSet('r', graph, 1);

    await repoDeleteDoc('r', docId);

    expect((await repoGraphSnapshot('r')).corpusRevision).toBe(2);
    expect(await repoGraphGet('r')).toBeNull();
  });

  it('exposes a doc\'s chunks with chunkId + sentence spans for extraction', async () => {
    const { docId } = await repoAdd(
      'r',
      { name: 'a', url: 'file:///a' },
      ['First fact here. Second fact follows.'],
      [vec(8, 1)],
      { embedModel: 'local:minilm' },
    );
    const chunks = await repoDocChunks('r', docId);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkId).toContain(':c0');
    expect(chunks[0].sentences.length).toBe(2);
    // Offsets reconstruct the sentence from the chunk text (no fuzzy matching).
    const s = chunks[0].sentences[0];
    expect(chunks[0].text.slice(s.start, s.end)).toBe('First fact here.');
  });

  it('returns [] for an unknown doc', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    expect(await repoDocChunks('r', 'nope')).toEqual([]);
  });

  it('round-trips studio outputs (default empty)', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    expect(await repoStudioGet('r')).toEqual({ outputs: {} });
    const doc = {
      outputs: {
        briefing: { kind: 'briefing' as const, title: 'B', markdown: '# B [[x]]', citations: [], generatedAt: '2026-01-01T00:00:00.000Z' },
      },
    };
    await repoStudioSet('r', doc, 1);
    expect(await repoStudioGet('r')).toEqual({ ...doc, corpusRevision: 1 });
  });
});

describe('repoList', () => {
  it('excludes the reserved kind:memory repo (internal plumbing, not a user knowledge base)', async () => {
    await repoAdd('notes', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm', kind: 'page' });
    await repoAdd('__memory__', { name: 'Fact', url: 'memory:m1' }, ['fact'], [vec(8, 2)], { embedModel: 'local:minilm', kind: 'memory' });
    const list = await repoList();
    expect(list.map((r) => r.name)).toEqual(['notes']);
  });
});

describe('repoExportOne and repoImportOne', () => {
  it('round-trips a single repository with metadata, chunks, overview, graph, and studio', async () => {
    await repoAdd('Original Repo', { name: 'doc1.md', url: 'file:///doc1.md' }, ['Content chunk text.'], [vec(8, 1)], { embedModel: 'local:minilm' });
    
    const overview: NotebookOverview = {
      title: 'AI Notebook Title',
      overviewMarkdown: 'Overview content.',
      keyTopics: ['topic1'],
      suggestedQuestions: ['Q1?'],
      docCount: 1,
      chunkCount: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    await repoNotebookSet('Original Repo', overview);
    const graph = emptyDocGraph();
    mergeExtraction(graph, { entities: [{ label: 'Archived entity', type: 'x', summary: 's', evidence: ['s1'] }], relations: [] }, 'doc-1');
    await repoGraphSet('Original Repo', graph, 1);
    await repoStudioSet('Original Repo', {
      outputs: {
        briefing: { kind: 'briefing', title: 'B', markdown: '# B', citations: [], generatedAt: '2026-01-01T00:00:00.000Z' },
      },
    }, 1);

    const exported = await repoExportOne('Original Repo');
    expect(exported).not.toBeNull();
    expect(exported?.name).toBe('Original Repo');
    expect(exported?.notebook).toEqual(overview);
    expect((exported?.meta as { corpusRevision?: number }).corpusRevision).toBe(1);
    expect((exported?.graph as { corpusRevision?: number }).corpusRevision).toBe(1);
    expect((exported?.studio as { corpusRevision?: number }).corpusRevision).toBe(1);

    // Import under a new target name
    const impRes = await repoImportOne(exported!, 'Imported Repo');
    expect(impRes.ok).toBe(true);
    expect(impRes.name).toBe('Imported Repo');

    // Verify imported notebook overview matches
    const importedOverview = await repoNotebookGet('Imported Repo');
    expect(importedOverview).toEqual(overview);
    expect((await repoGraphGet('Imported Repo'))?.nodes[0].label).toBe('Archived entity');
    expect((await repoStudioGet('Imported Repo')).outputs.briefing?.title).toBe('B');

    // Verify search works in imported repo
    const searchRes = await repoSearch('Imported Repo', vec(8, 1), 5);
    expect(searchRes.results).toHaveLength(1);
    expect(searchRes.results[0].text).toBe('Content chunk text.');
  });

  it('still exports a stale graph/studio (corpusRevision behind the current one), not silently dropped', async () => {
    // Regression test: repoExportOne used to gate graph/studio inclusion on
    // storedGraph.corpusRevision === corpusRevision(meta) -- so any time that
    // invariant doesn't hold (e.g. an archive imported into an environment
    // whose revision bookkeeping has since diverged), every subsequent "Save
    // Archive" would silently exclude the graph/studio the user had already
    // generated, with no warning. An archive exists to preserve generated
    // work; staleness is already detected at use time elsewhere (repoSearch,
    // repoGraphGet, GraphPanel), so export must not drop it.
    await repoAdd('Stale Repo', { name: 'doc1.md', url: 'file:///doc1.md' }, ['Content chunk text.'], [vec(8, 1)], { embedModel: 'local:minilm' });
    const graph = emptyDocGraph();
    mergeExtraction(graph, { entities: [{ label: 'Stale entity', type: 'x', summary: 's', evidence: ['s1'] }], relations: [] }, 'doc-1');
    await repoGraphSet('Stale Repo', graph, 1);
    await repoStudioSet('Stale Repo', {
      outputs: { briefing: { kind: 'briefing', title: 'Stale briefing', markdown: '# B', citations: [], generatedAt: '2026-01-01T00:00:00.000Z' } },
    }, 1);

    // Reimport under a new name with the meta's corpusRevision bumped ahead of
    // the graph/studio's -- repoImportOne (unlike repoAdd) writes exactly what
    // an archive contains, so this reproduces "graph/studio present on disk but
    // behind the repo's current revision" without relying on any particular
    // internal call sequence.
    const exported = await repoExportOne('Stale Repo');
    (exported!.meta as { corpusRevision?: number }).corpusRevision = 2;
    await repoImportOne(exported!, 'Stale Repo Imported');

    const reExported = await repoExportOne('Stale Repo Imported');
    expect((reExported?.meta as { corpusRevision?: number }).corpusRevision).toBe(2);
    expect((reExported?.graph as { corpusRevision?: number } | undefined)?.corpusRevision).toBe(1);
    expect((reExported?.studio as { corpusRevision?: number } | undefined)?.corpusRevision).toBe(1);
    expect((reExported?.graph as { nodes: unknown[] } | undefined)?.nodes).toHaveLength(1);

    const impRes = await repoImportOne(reExported!, 'Stale Repo Reimported');
    expect(impRes.ok).toBe(true);
    // repoGraphGet/repoStudioGet intentionally keep their own staleness gate
    // (using a stale graph for live search citations would be a real
    // correctness problem, unlike archiving it) -- verify via export instead,
    // which is the archive path this test is about.
    const reReExported = await repoExportOne('Stale Repo Reimported');
    expect((reReExported?.graph as { nodes: Array<{ label: string }> } | undefined)?.nodes[0].label).toBe('Stale entity');
    expect((reReExported?.studio as { outputs: { briefing?: { title: string } } } | undefined)?.outputs.briefing?.title).toBe('Stale briefing');
  });

  it('loads a legacy archive whose metadata and graph predate corpus revisions', async () => {
    await repoAdd('Legacy', { name: 'doc.md', url: 'file:///doc.md' }, ['Legacy content.'], [vec(8, 1)], { embedModel: 'local:minilm' });
    const graph = emptyDocGraph();
    mergeExtraction(graph, { entities: [{ label: 'Legacy', type: 'x', summary: 's', evidence: ['s1'] }], relations: [] }, 'doc-1');
    await repoGraphSet('Legacy', graph, 1);
    const exported = await repoExportOne('Legacy');
    const meta = exported!.meta as { corpusRevision?: number };
    const storedGraph = exported!.graph as { corpusRevision?: number };
    delete meta.corpusRevision;
    delete storedGraph.corpusRevision;

    await repoImportOne(exported!, 'Legacy Imported');

    expect((await repoGraphSnapshot('Legacy Imported')).corpusRevision).toBe(0);
    expect((await repoGraphGet('Legacy Imported'))?.nodes[0].label).toBe('Legacy');
  });
});
