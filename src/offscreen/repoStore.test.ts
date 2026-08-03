import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  repoAdd,
  repoDeleteDoc,
  repoDocChunks,
  repoExportOne,
  repoGraphGet,
  repoGraphSnapshot,
  repoGraphSet,
  repoImportOne,
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

// ---- minimal in-memory OPFS fake (only the surface repoStore uses) ----

class FakeWritable {
  constructor(
    private file: FakeFileHandle,
    keepExistingData: boolean,
  ) {
    if (!keepExistingData) file.bytes = new Uint8Array(0);
  }
  async write(
    input: string | BufferSource | { type: 'write'; position: number; data: string | BufferSource },
  ): Promise<void> {
    const toBytes = (d: string | BufferSource): Uint8Array =>
      typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d as ArrayBuffer);
    let position: number;
    let data: Uint8Array;
    if (input && typeof input === 'object' && 'type' in input) {
      position = input.position;
      data = toBytes(input.data);
    } else {
      position = this.file.bytes.length;
      data = toBytes(input as string | BufferSource);
    }
    const end = position + data.length;
    if (end > this.file.bytes.length) {
      const grown = new Uint8Array(end);
      grown.set(this.file.bytes);
      this.file.bytes = grown;
    }
    this.file.bytes.set(data, position);
  }
  async close(): Promise<void> {}
}

class FakeFileHandle {
  kind = 'file' as const;
  bytes = new Uint8Array(0);
  constructor(public name: string) {}
  async getFile() {
    const bytes = this.bytes;
    return {
      size: bytes.length,
      async text() {
        return new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }
  async createWritable(opts?: { keepExistingData?: boolean }) {
    return new FakeWritable(this, opts?.keepExistingData ?? false);
  }
}

class FakeDirHandle {
  kind = 'directory' as const;
  dirs = new Map<string, FakeDirHandle>();
  files = new Map<string, FakeFileHandle>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw new Error('NotFound');
      d = new FakeDirHandle(name);
      this.dirs.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.files.get(name);
    if (!f) {
      if (!opts?.create) throw new Error('NotFound');
      f = new FakeFileHandle(name);
      this.files.set(name, f);
    }
    return f;
  }
  async removeEntry(name: string) {
    this.dirs.delete(name);
    this.files.delete(name);
  }
  async *entries(): AsyncGenerator<[string, FakeDirHandle | FakeFileHandle]> {
    for (const [n, d] of this.dirs) yield [n, d];
    for (const [n, f] of this.files) yield [n, f];
  }
}

const vec = (n: number, seed: number): number[] => Array.from({ length: n }, (_, i) => Math.sin(seed + i) + 1.5);

beforeEach(() => {
  const root = new FakeDirHandle('root');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  // repoStore now consults the vault (chrome.storage) to decide whether to
  // encrypt. Empty storage ⇒ no vault ⇒ plaintext, so these existing tests are
  // unaffected. (Encryption behavior is covered in repoEncryption.test.ts.)
  const empty = () => ({ async get() { return {}; }, async set() {}, async remove() {} });
  vi.stubGlobal('chrome', { storage: { local: empty(), session: empty() } });
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

  it('increments corpus revisions and invalidates graph and Studio outputs after an add', async () => {
    await repoAdd('r', { name: 'a', url: 'file:///a' }, ['hello'], [vec(8, 1)], { embedModel: 'local:minilm' });
    expect((await repoGraphSnapshot('r')).corpusRevision).toBe(1);

    const graph = emptyDocGraph();
    mergeExtraction(graph, { entities: [{ label: 'A', type: 'x', summary: 's', evidence: ['s1'] }], relations: [] }, 'doc-1');
    await repoGraphSet('r', graph, 1);
    await repoStudioSet('r', { outputs: {} }, 1);

    await repoAdd('r', { name: 'b', url: 'file:///b' }, ['world'], [vec(8, 2)], { embedModel: 'local:minilm' });

    expect((await repoGraphSnapshot('r')).corpusRevision).toBe(2);
    expect(await repoGraphGet('r')).toBeNull();
    expect(await repoStudioGet('r')).toEqual({ outputs: {} });
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
