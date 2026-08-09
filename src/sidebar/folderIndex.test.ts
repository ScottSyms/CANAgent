import { afterEach, describe, expect, it, vi } from 'vitest';
import { filesFromList, folderRepoName, syncFolderFiles, type IndexedDoc, type PickedFile } from './folderIndex';

// A minimal File stand-in (jsdom-free) carrying what the indexer reads.
function fakeFile(name: string, relPath: string, lastModified: number, size = 10): File {
  return {
    name,
    type: '',
    size,
    lastModified,
    webkitRelativePath: relPath,
    text: async () => `contents of ${name}`,
  } as unknown as File;
}

afterEach(() => vi.restoreAllMocks());

describe('folderRepoName', () => {
  it('prefixes with a folder glyph and strips unsafe chars', () => {
    expect(folderRepoName('My Reports/2024')).toBe('📁 My Reports2024');
    expect(folderRepoName('')).toBe('📁 folder');
  });
});

describe('filesFromList', () => {
  it('keeps supported files with their relative paths and reports the root name', () => {
    const list = [
      fakeFile('a.md', 'root/a.md', 1),
      fakeFile('image.png', 'root/image.png', 1), // unsupported → dropped
      fakeFile('b.txt', 'root/sub/b.txt', 1),
      fakeFile('c.pdf', 'root/sub/deep/c.pdf', 1),
    ];
    const { rootName, files } = filesFromList(list);
    expect(rootName).toBe('root');
    expect(files.map((f) => f.path).sort()).toEqual(['root/a.md', 'root/sub/b.txt', 'root/sub/deep/c.pdf']);
  });
});

describe('syncFolderFiles incremental sync', () => {
  it('skips unchanged, updates changed, adds new, and removes vanished files', async () => {
    const existing: IndexedDoc[] = [
      { id: 'd1', path: 'root/keep.md', mtime: 100, size: 10 },
      { id: 'd2', path: 'root/change.md', mtime: 100, size: 10 },
      { id: 'd3', path: 'root/gone.md', mtime: 100, size: 10 },
    ];
    const picked: PickedFile[] = [
      { file: fakeFile('keep.md', 'root/keep.md', 100, 10), path: 'root/keep.md' },
      { file: fakeFile('change.md', 'root/change.md', 200, 10), path: 'root/change.md' },
      { file: fakeFile('new.md', 'root/new.md', 100, 10), path: 'root/new.md' },
    ];

    const sent: Array<{ type: string; docId?: string; kind?: string; files?: Array<{ name: string; path?: string }> }> = [];
    const sendMessage = vi.fn(async (msg: { type: string; [k: string]: unknown }) => {
      sent.push(msg as never);
      if (msg.type === 'add_files_to_repo') {
        const files = (msg.files as Array<{ name: string }>) ?? [];
        return { ok: true, results: files.map((f) => ({ name: f.name, ok: true })) };
      }
      return { ok: true };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const prog = await syncFolderFiles('repo', picked, existing);

    expect(prog.skipped).toBe(1); // keep.md
    expect(prog.added).toBe(1); // new.md
    expect(prog.updated).toBe(1); // change.md
    expect(prog.removed).toBe(1); // gone.md
    expect(prog.failed).toBe(0);

    const deletes = sent.filter((m) => m.type === 'repo_doc_delete').map((m) => m.docId).sort();
    expect(deletes).toEqual(['d2', 'd3']); // changed doc deleted before re-ingest; vanished doc removed

    const ingests = sent.filter((m) => m.type === 'add_files_to_repo');
    expect(ingests.every((m) => m.kind === 'folder')).toBe(true);
    expect(ingests.flatMap((m) => m.files ?? []).map((f) => f.path).sort()).toEqual(['root/change.md', 'root/new.md']);
  });

  it('isolates a NotReadableError (cloud placeholder) and still indexes the rest', async () => {
    // A OneDrive online-only file: reading throws NotReadableError on every try.
    const cloud = {
      name: 'cloud.md',
      type: '',
      size: 10,
      lastModified: 1,
      webkitRelativePath: 'root/cloud.md',
      text: async () => {
        throw Object.assign(new Error('The requested file could not be read'), { name: 'NotReadableError' });
      },
    } as unknown as File;
    const picked: PickedFile[] = [
      { file: cloud, path: 'root/cloud.md' },
      { file: fakeFile('ok.md', 'root/ok.md', 1, 10), path: 'root/ok.md' },
    ];

    const sendMessage = vi.fn(async (msg: { type: string; files?: Array<{ name: string }> }) =>
      msg.type === 'add_files_to_repo'
        ? { ok: true, results: (msg.files ?? []).map((f) => ({ name: f.name, ok: true })) }
        : { ok: true },
    );
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const prog = await syncFolderFiles('repo', picked, []);

    expect(prog.added).toBe(1); // ok.md still indexed — the batch did not abort
    expect(prog.failed).toBe(1);
    expect(prog.unreadable).toBe(1);
    expect(prog.phase).toBe('done');
  }, 10_000); // allows the single 800ms read-retry
});
