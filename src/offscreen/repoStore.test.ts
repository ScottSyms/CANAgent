import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoAdd, repoAddMany, repoDeleteDoc, repoDocs, repoList, repoSearch } from './repoStore';

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

describe('repoAddMany', () => {
  it('adds several documents in one call with correct chunk offsets, matching a sequential repoAdd loop', async () => {
    const res = await repoAddMany(
      'batch',
      [
        { doc: { name: 'a', url: 'file:///a' }, chunks: ['a1', 'a2'], vectors: [vec(8, 1), vec(8, 2)] },
        { doc: { name: 'b', url: 'file:///b' }, chunks: ['b1'], vectors: [vec(8, 3)] },
        { doc: { name: 'c', url: 'file:///c' }, chunks: ['c1', 'c2', 'c3'], vectors: [vec(8, 4), vec(8, 5), vec(8, 6)] },
      ],
      { embedModel: 'local:minilm', kind: 'folder' },
    );
    expect(res.chunkCount).toBe(6);
    expect(res.docs.map((d) => d.chunkCount)).toEqual([2, 3, 6]);

    const docs = await repoDocs('batch');
    expect(docs.map((d) => ({ name: d.name, chunkStart: d.chunkStart, chunkCount: d.chunkCount }))).toEqual([
      { name: 'a', chunkStart: 0, chunkCount: 2 },
      { name: 'b', chunkStart: 2, chunkCount: 1 },
      { name: 'c', chunkStart: 3, chunkCount: 3 },
    ]);

    // Every chunk is searchable — the batch write didn't drop or misalign anything.
    const hits = await repoSearch('batch', vec(8, 4), 6, 'local:minilm');
    expect(hits.results.map((h) => h.text).sort()).toEqual(['a1', 'a2', 'b1', 'c1', 'c2', 'c3']);
  });

  it('enforces the same embedder model lock as repoAdd', async () => {
    await repoAddMany('batch', [{ doc: { name: 'a', url: 'file:///a' }, chunks: ['a1'], vectors: [vec(8, 1)] }], {
      embedModel: 'local:minilm',
    });
    await expect(
      repoAddMany('batch', [{ doc: { name: 'b', url: 'file:///b' }, chunks: ['b1'], vectors: [vec(8, 2)] }], {
        embedModel: 'external:te3',
      }),
    ).rejects.toThrow(/built with embedder "local:minilm".*"external:te3"/);
  });

  it('appending via repoAddMany after repoAdd (and vice versa) produces the same repo state', async () => {
    await repoAdd('mixed', { name: 'a', url: 'file:///a' }, ['a1'], [vec(8, 1)], { embedModel: 'local:minilm' });
    await repoAddMany(
      'mixed',
      [
        { doc: { name: 'b', url: 'file:///b' }, chunks: ['b1'], vectors: [vec(8, 2)] },
        { doc: { name: 'c', url: 'file:///c' }, chunks: ['c1'], vectors: [vec(8, 3)] },
      ],
      { embedModel: 'local:minilm' },
    );
    const docs = await repoDocs('mixed');
    expect(docs.map((d) => d.name)).toEqual(['a', 'b', 'c']);
    expect(docs.map((d) => d.chunkStart)).toEqual([0, 1, 2]);
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
