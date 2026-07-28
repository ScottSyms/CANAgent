// On-device RAG store: named repositories in OPFS holding chunk text + int8-
// quantized embedding vectors. Runs in the offscreen document (Window context),
// so it uses the async OPFS API (no sync access handles, which are Worker-only).

import type { ExportedRepo, RepoKind } from '../shared/messages';
import { hybridSearch, multiHybridSearch } from '../shared/hybridSearch';
import { buildKeywordIndex, extendKeywordIndex, type KeywordIndex } from '../shared/keywordSearch';
import { normalizeVector, quantizeVector, searchVectors, type SearchHit } from '../shared/vectorSearch';

interface DocMeta {
  id: string;
  name: string;
  url: string;
  capturedAt: string;
  chunkStart: number;
  chunkCount: number;
  /** Folder repos: the file's path relative to the indexed root (incremental-sync key). */
  path?: string;
  /** Folder repos: source file last-modified epoch ms — paired with `size` to detect changes. */
  mtime?: number;
  /** Folder repos: source file size in bytes. */
  size?: number;
}

/** Extra per-document metadata threaded through from folder ingestion. */
export interface DocExtra {
  path?: string;
  mtime?: number;
  size?: number;
}

interface RepoMeta {
  name: string;
  dim: number;
  bits: number;
  perDimScale: number[]; // calibration, fixed from the first batch
  docs: DocMeta[];
  chunkCount: number;
  /** Source family for the repository. */
  kind?: RepoKind;
  /** Embedder identity (e.g. `local:Xenova/all-MiniLM-L6-v2`) the vectors were built with. */
  embedModel?: string;
}

interface ChunkRec {
  docId: string;
  name: string;
  url: string;
  text: string;
}

async function reposDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('repos', { create: true });
}

async function repoDir(name: string): Promise<FileSystemDirectoryHandle> {
  return (await reposDir()).getDirectoryHandle(name, { create: true });
}

async function readJson<T>(dir: FileSystemDirectoryHandle, file: string, fallback: T): Promise<T> {
  try {
    const handle = await dir.getFileHandle(file);
    const text = await (await handle.getFile()).text();
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(dir: FileSystemDirectoryHandle, file: string, obj: unknown): Promise<void> {
  const handle = await dir.getFileHandle(file, { create: true });
  const w = await handle.createWritable();
  await w.write(JSON.stringify(obj));
  await w.close();
}

async function readVectors(dir: FileSystemDirectoryHandle): Promise<Int8Array> {
  try {
    const handle = await dir.getFileHandle('vectors.bin');
    return new Int8Array(await (await handle.getFile()).arrayBuffer());
  } catch {
    return new Int8Array(0);
  }
}

async function appendVectors(dir: FileSystemDirectoryHandle, data: Int8Array): Promise<void> {
  const handle = await dir.getFileHandle('vectors.bin', { create: true });
  const existing = (await handle.getFile()).size;
  const w = await handle.createWritable({ keepExistingData: true });
  await w.write({ type: 'write', position: existing, data: data as unknown as BufferSource });
  await w.close();
}

/** Overwrite vectors.bin wholesale (truncates) — used when rebuilding after a delete. */
async function writeVectors(dir: FileSystemDirectoryHandle, data: Int8Array): Promise<void> {
  const handle = await dir.getFileHandle('vectors.bin', { create: true });
  const w = await handle.createWritable(); // no keepExistingData → truncates to 0 first
  await w.write({ type: 'write', position: 0, data: data as unknown as BufferSource });
  await w.close();
}

async function readOrBuildKeywordIndex(dir: FileSystemDirectoryHandle, chunks: ChunkRec[]): Promise<KeywordIndex> {
  const existing = await readJson<KeywordIndex | null>(dir, 'keywordIndex.json', null);
  if (existing?.version === 1 && existing.docLen.length === chunks.length) return existing;
  const rebuilt = buildKeywordIndex(chunks);
  await writeJson(dir, 'keywordIndex.json', rebuilt);
  return rebuilt;
}

async function rebuildKeywordIndex(dir: FileSystemDirectoryHandle, chunks: ChunkRec[]): Promise<void> {
  await writeJson(dir, 'keywordIndex.json', buildKeywordIndex(chunks));
}

async function appendKeywordIndex(
  dir: FileSystemDirectoryHandle,
  previousChunkCount: number,
  newChunks: ChunkRec[],
  allChunks: ChunkRec[],
): Promise<void> {
  const existing = await readJson<KeywordIndex | null>(dir, 'keywordIndex.json', null);
  const next = existing?.version === 1 && existing.docLen.length === previousChunkCount
    ? extendKeywordIndex(existing, newChunks)
    : buildKeywordIndex(allChunks);
  await writeJson(dir, 'keywordIndex.json', next);
}

export interface RepoAddManyDoc {
  doc: { name: string; url: string };
  chunks: string[];
  vectors: number[][];
  docExtra?: DocExtra;
  docId?: string;
}

/**
 * Add several documents to a repo in one pass. `repoAdd` (a single document)
 * delegates here — batching matters because each write reads the *entire*
 * chunks.json, appends, and rewrites the whole file; calling it once per
 * document in a loop is O(n^2) total I/O for an n-document ingest. This reads
 * meta/chunks/keywordIndex once, folds every document in memory, and writes
 * each OPFS file exactly once regardless of batch size.
 */
export async function repoAddMany(
  repo: string,
  docs: RepoAddManyDoc[],
  opts: { embedModel?: string; kind?: RepoKind } = {},
): Promise<{ docs: Array<{ docId: string; chunkCount: number }>; chunkCount: number }> {
  if (docs.length === 0) return { docs: [], chunkCount: 0 };
  for (const d of docs) {
    if (d.chunks.length === 0 || d.vectors.length !== d.chunks.length) {
      throw new Error('repoAddMany: chunk/vector count mismatch.');
    }
  }
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta>(dir, 'meta.json', {
    name: repo,
    dim: 0,
    bits: 8,
    perDimScale: [],
    docs: [],
    chunkCount: 0,
  });
  // Model lock: vectors from different embedders aren't comparable. Stamp the
  // model on first write; refuse a later add from a different one (re-index).
  if (opts.embedModel) {
    if (!meta.embedModel || meta.chunkCount === 0) meta.embedModel = opts.embedModel;
    else if (meta.embedModel !== opts.embedModel) {
      throw new Error(
        `Repo "${repo}" was built with embedder "${meta.embedModel}" but this add uses "${opts.embedModel}". Re-index the repo to switch embedders.`,
      );
    }
  }
  if (opts.kind && (!meta.kind || meta.chunkCount === 0)) meta.kind = opts.kind;

  const allNormed = docs.map((d) => d.vectors.map(normalizeVector));
  if (meta.dim === 0) {
    // First write to an empty repo: calibrate across every doc in the batch
    // (not just the first) so the scale reflects the whole ingest.
    meta.dim = allNormed[0][0].length;
    const scale = new Array(meta.dim).fill(0);
    for (const normed of allNormed) for (const v of normed) for (let d = 0; d < meta.dim; d++) scale[d] = Math.max(scale[d], Math.abs(v[d]));
    meta.perDimScale = scale.map((s) => s || 1);
  }
  for (const normed of allNormed) {
    if (normed[0].length !== meta.dim) {
      throw new Error(`Embedding dimension ${normed[0].length} does not match repo dimension ${meta.dim}.`);
    }
  }

  let packedLen = 0;
  for (const normed of allNormed) packedLen += normed.length * meta.dim;
  const packed = new Int8Array(packedLen);
  let packedOffset = 0;

  const allChunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  const previousChunkCount = allChunks.length;
  const newChunks: ChunkRec[] = [];
  const results: Array<{ docId: string; chunkCount: number }> = [];

  docs.forEach((d, i) => {
    const normed = allNormed[i];
    normed.forEach((v) => {
      packed.set(quantizeVector(v, meta.perDimScale), packedOffset);
      packedOffset += meta.dim;
    });
    const docId = d.docId ?? `doc-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`;
    for (const text of d.chunks) newChunks.push({ docId, name: d.doc.name, url: d.doc.url, text });
    meta.docs.push({
      id: docId,
      name: d.doc.name,
      url: d.doc.url,
      capturedAt: new Date().toISOString(),
      chunkStart: meta.chunkCount,
      chunkCount: d.chunks.length,
      ...(d.docExtra?.path !== undefined ? { path: d.docExtra.path } : {}),
      ...(d.docExtra?.mtime !== undefined ? { mtime: d.docExtra.mtime } : {}),
      ...(d.docExtra?.size !== undefined ? { size: d.docExtra.size } : {}),
    });
    meta.chunkCount += d.chunks.length;
    results.push({ docId, chunkCount: meta.chunkCount });
  });

  await appendVectors(dir, packed);
  allChunks.push(...newChunks);
  await writeJson(dir, 'chunks.json', allChunks);
  await appendKeywordIndex(dir, previousChunkCount, newChunks, allChunks);
  await writeJson(dir, 'meta.json', meta);

  return { docs: results, chunkCount: meta.chunkCount };
}

export async function repoAdd(
  repo: string,
  doc: { name: string; url: string },
  chunks: string[],
  vectors: number[][],
  opts: { embedModel?: string; kind?: RepoKind; docExtra?: DocExtra; docId?: string } = {},
): Promise<{ docId: string; chunkCount: number }> {
  if (chunks.length === 0 || vectors.length !== chunks.length) {
    throw new Error('repoAdd: chunk/vector count mismatch.');
  }
  const { docs: results } = await repoAddMany(repo, [{ doc, chunks, vectors, docExtra: opts.docExtra, docId: opts.docId }], {
    embedModel: opts.embedModel,
    kind: opts.kind,
  });
  return results[0];
}

export async function repoSearch(
  repo: string,
  queryVector: number[],
  k: number,
  embedModel?: string,
  opts: { query?: string; hybrid?: boolean; queryVectors?: number[][]; queries?: string[] } = {},
): Promise<{ results: SearchHit[] }> {
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta || meta.chunkCount === 0) return { results: [] };
  // Model lock: a query embedded by a different model can't be compared to the
  // stored vectors. Fail loudly so the caller re-indexes rather than returning junk.
  if (embedModel && meta.embedModel && meta.embedModel !== embedModel) {
    throw new Error(
      `Repo "${repo}" was built with embedder "${meta.embedModel}" but the query used "${embedModel}". Re-index the repo (or switch the embedder back) to search it.`,
    );
  }
  const vectors = await readVectors(dir);
  const chunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  const keywordIndex = await readOrBuildKeywordIndex(dir, chunks);
  const base = {
    dim: meta.dim,
    perDimScale: meta.perDimScale,
    chunkCount: meta.chunkCount,
    vectors,
    chunks,
    k,
  };
  // Hybrid (semantic + BM25, RRF-fused) when enabled and the raw query is known;
  // otherwise pure semantic. The query text is only present on the hybrid path.
  const queryVectors = opts.queryVectors?.length ? opts.queryVectors : [queryVector];
  const queries = opts.queries?.length ? opts.queries : opts.query ? [opts.query] : [];
  const results = queryVectors.length > 1 || queries.length > 1
    ? multiHybridSearch({ ...base, queryVectors, queries, hybrid: opts.hybrid !== false, keywordIndex })
    : opts.hybrid && opts.query
      ? hybridSearch({ ...base, queryVector, query: opts.query, keywordIndex })
      : searchVectors({ ...base, queryVector });
  return { results };
}

/**
 * List every repository except the reserved `kind:'memory'` embedding index
 * (`__memory__`) — that repo is internal plumbing for graph memory retrieval,
 * not a user-created knowledge base, and must never appear in (or be
 * deletable from) the repo-management UIs.
 */
export async function repoList(): Promise<
  Array<{ name: string; docs: number; chunks: number; kind?: RepoKind; embedModel?: string }>
> {
  const out: Array<{ name: string; docs: number; chunks: number; kind?: RepoKind; embedModel?: string }> = [];
  const dir = await reposDir();
  // @ts-expect-error - entries() exists on FileSystemDirectoryHandle in Chrome
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory') continue;
    const meta = await readJson<RepoMeta | null>(handle as FileSystemDirectoryHandle, 'meta.json', null);
    if (meta?.kind === 'memory') continue;
    out.push({
      name,
      docs: meta?.docs.length ?? 0,
      chunks: meta?.chunkCount ?? 0,
      kind: meta?.kind,
      embedModel: meta?.embedModel,
    });
  }
  return out;
}

export async function repoDelete(repo: string): Promise<void> {
  const dir = await reposDir();
  await dir.removeEntry(repo, { recursive: true });
}

// ----- backup / restore -----

function u8ToB64(u8: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000; // avoid call-stack limits on large vectors
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** Serialize every repository (meta + chunks + base64 vectors) for backup. */
export async function repoExportAll(): Promise<ExportedRepo[]> {
  const out: ExportedRepo[] = [];
  const dir = await reposDir();
  // @ts-expect-error - entries() exists on FileSystemDirectoryHandle in Chrome
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory') continue;
    const d = handle as FileSystemDirectoryHandle;
    const meta = await readJson<RepoMeta | null>(d, 'meta.json', null);
    if (!meta) continue;
    const chunks = await readJson<ChunkRec[]>(d, 'chunks.json', []);
    const vecs = await readVectors(d);
    const bytes = new Uint8Array(vecs.buffer, vecs.byteOffset, vecs.byteLength);
    out.push({ name, meta, chunks, vectorsB64: u8ToB64(bytes) });
  }
  return out;
}

/** Restore repositories from a backup, overwriting any with the same name. */
export async function repoImportAll(repos: ExportedRepo[]): Promise<{ imported: number }> {
  const root = await reposDir();
  let imported = 0;
  for (const r of repos) {
    if (!r?.name) continue;
    try {
      await root.removeEntry(r.name, { recursive: true });
    } catch {
      // no existing repo by that name
    }
    const d = await root.getDirectoryHandle(r.name, { create: true });
    await writeJson(d, 'meta.json', r.meta);
    await writeJson(d, 'chunks.json', Array.isArray(r.chunks) ? r.chunks : []);
    await rebuildKeywordIndex(d, Array.isArray(r.chunks) ? (r.chunks as ChunkRec[]) : []);
    const u8 = b64ToU8(r.vectorsB64 ?? '');
    await writeVectors(d, new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength));
    imported++;
  }
  return { imported };
}

/** List the documents in a repo (for duplicate detection and the Settings UI). */
export async function repoDocs(repo: string): Promise<DocMeta[]> {
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  return meta?.docs ?? [];
}

/**
 * Every document in a repo with its full text reassembled from chunks.json
 * (chunks are appended contiguously per document, so `chunkStart`/`chunkCount`
 * from meta.json slice out exactly one document's chunks in original order).
 * One meta/chunks read for the whole repo — used by wiki generation, which
 * needs every document's full text at once rather than per-chunk snippets.
 */
export async function repoAllDocsText(repo: string): Promise<Array<DocMeta & { text: string }>> {
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta) return [];
  const chunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  return meta.docs.map((d) => ({
    ...d,
    text: chunks
      .slice(d.chunkStart, d.chunkStart + d.chunkCount)
      .map((c) => c.text)
      .join('\n\n'),
  }));
}

/** Remove one document from a repo, rebuilding vectors.bin + chunks.json + meta. */
export async function repoDeleteDoc(repo: string, docId: string): Promise<{ removed: number; chunkCount: number }> {
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta) return { removed: 0, chunkCount: 0 };
  const doc = meta.docs.find((d) => d.id === docId);
  if (!doc) return { removed: 0, chunkCount: meta.chunkCount };

  const dim = meta.dim;
  const start = doc.chunkStart;
  const end = doc.chunkStart + doc.chunkCount;

  // Rebuild vectors.bin: drop the doc's contiguous [start,end) rows of `dim` bytes.
  const vecs = await readVectors(dir);
  const kept = new Int8Array((meta.chunkCount - doc.chunkCount) * dim);
  kept.set(vecs.subarray(0, start * dim), 0);
  kept.set(vecs.subarray(end * dim, meta.chunkCount * dim), start * dim);
  await writeVectors(dir, kept);

  // Rebuild chunks.json by index.
  const allChunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  allChunks.splice(start, doc.chunkCount);
  await writeJson(dir, 'chunks.json', allChunks);
  await rebuildKeywordIndex(dir, allChunks);

  // Drop the doc and re-sequence every remaining doc's chunkStart.
  meta.docs = meta.docs.filter((d) => d.id !== docId);
  let cursor = 0;
  for (const d of meta.docs) {
    d.chunkStart = cursor;
    cursor += d.chunkCount;
  }
  meta.chunkCount = cursor;
  // Emptied repo: reset calibration + model lock so a later add can recalibrate
  // (e.g. re-indexing with a different embedder).
  if (meta.chunkCount === 0) {
    meta.dim = 0;
    meta.perDimScale = [];
    meta.embedModel = undefined;
  }
  await writeJson(dir, 'meta.json', meta);
  return { removed: doc.chunkCount, chunkCount: meta.chunkCount };
}
