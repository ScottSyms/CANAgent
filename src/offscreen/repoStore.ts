// On-device RAG store: named repositories in OPFS holding chunk text + int8-
// quantized embedding vectors. Runs in the offscreen document (Window context),
// so it uses the async OPFS API (no sync access handles, which are Worker-only).

import type { ExportedRepo, RepoKind } from '../shared/messages';
import type { NotebookOverview, StudioDoc } from '../shared/types';
import type { DocGraph } from '../shared/docGraph';
import { hybridSearch, multiHybridSearch } from '../shared/hybridSearch';
import { buildKeywordIndex, extendKeywordIndex, type KeywordIndex } from '../shared/keywordSearch';
import { normalizeVector, quantizeVector, searchVectors, type ChunkInput, type SearchHit } from '../shared/vectorSearch';
import { citableSentences, type CitableSentence } from '../shared/sentenceSplit';
// Vault crypto is delegated to the service worker (see vaultClient): the
// offscreen document may lack chrome.storage, so it cannot reach the DEK itself.
import { getVaultState, isVaultUnlocked, vaultDecrypt, vaultEncrypt } from './vaultClient';

// Content-bearing repo files are encrypted at rest when a vault is active
// (specification.md §24.6): the chunk text and the keyword (BM25) index built
// from it. vectors.bin (opaque int8 embeddings) and meta.json (the catalogue —
// doc names, counts, calibration) stay plaintext so the Knowledge list still
// works while locked. readJson/writeJson below transparently (de)crypt these two
// files, so every call site is covered with no other change.
const ENCRYPTED_FILES = new Set(['chunks.json', 'keywordIndex.json', 'notebook.json', 'graph.json', 'studio.json']);

interface EncEnvelope {
  __enc: string;
}

/**
 * Refuse repo reads/writes while a vault exists but is locked: a write would
 * clobber ciphertext with plaintext, and a read would silently return nothing.
 * No vault or unlocked ⇒ proceed. Knowledge is sealed until the user unlocks.
 */
async function assertVaultUsable(): Promise<void> {
  if ((await getVaultState()) === 'locked') {
    throw new Error('Unlock the encryption vault to use knowledge repositories.');
  }
}

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
  /**
   * Citable sentence spans within `text`, cached at ingest (spec §2). Optional:
   * chunks indexed before this feature have none and are segmented on read via
   * `enrichChunks`. Offsets are into `text`; the sentence text is not duplicated.
   */
  sentences?: CitableSentence[];
}

/**
 * Attach sentence-level provenance to raw chunk records for retrieval. Derives
 * each chunk's stable `chunkId` (`${docId}:c${localChunkIdx}`) from the doc
 * ranges in `meta`, and reuses cached `sentences` or recomputes them from the
 * chunk text (legacy repos) — the derivation is deterministic, so read-time and
 * ingest-time ids match.
 */
function enrichChunks(meta: RepoMeta, chunks: ChunkRec[]): ChunkInput[] {
  const coord = new Array<{ docId: string; localIdx: number } | undefined>(chunks.length);
  for (const d of meta.docs) {
    for (let local = 0; local < d.chunkCount; local++) {
      const gi = d.chunkStart + local;
      if (gi >= 0 && gi < coord.length) coord[gi] = { docId: d.id, localIdx: local };
    }
  }
  return chunks.map((c, i) => {
    const co = coord[i] ?? { docId: c.docId, localIdx: i };
    return {
      name: c.name,
      url: c.url,
      text: c.text,
      chunkId: `${co.docId}:c${co.localIdx}`,
      sentences: c.sentences ?? citableSentences(co.docId, co.localIdx, c.text),
    };
  });
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
    if (!text) return fallback;
    const parsed = JSON.parse(text);
    if (ENCRYPTED_FILES.has(file) && parsed && typeof parsed === 'object' && typeof (parsed as EncEnvelope).__enc === 'string') {
      const json = await vaultDecrypt((parsed as EncEnvelope).__enc);
      if (json === null) return fallback; // vault locked/erased (callers gate on this)
      return JSON.parse(json) as T;
    }
    return parsed as T; // plaintext (no vault, or a non-encrypted file)
  } catch {
    return fallback;
  }
}

async function writeJson(dir: FileSystemDirectoryHandle, file: string, obj: unknown): Promise<void> {
  let payload = JSON.stringify(obj);
  if (ENCRYPTED_FILES.has(file) && (await isVaultUnlocked())) {
    payload = JSON.stringify({ __enc: await vaultEncrypt(payload) } satisfies EncEnvelope);
  }
  const handle = await dir.getFileHandle(file, { create: true });
  const w = await handle.createWritable();
  await w.write(payload);
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
  await assertVaultUsable();
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
  const normed = vectors.map(normalizeVector);
  if (meta.dim === 0) {
    meta.dim = normed[0].length;
    const scale = new Array(meta.dim).fill(0);
    for (const v of normed) for (let d = 0; d < meta.dim; d++) scale[d] = Math.max(scale[d], Math.abs(v[d]));
    meta.perDimScale = scale.map((s) => s || 1);
  }
  if (normed[0].length !== meta.dim) {
    throw new Error(`Embedding dimension ${normed[0].length} does not match repo dimension ${meta.dim}.`);
  }

  const packed = new Int8Array(normed.length * meta.dim);
  normed.forEach((v, i) => packed.set(quantizeVector(v, meta.perDimScale), i * meta.dim));
  await appendVectors(dir, packed);

  const allChunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  const previousChunkCount = allChunks.length;
  const docId = opts.docId ?? `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // localChunkIdx is the chunk's position within this document, so sentence ids
  // are stable regardless of where the doc lands in the repo.
  const newChunks = chunks.map((text, localIdx) => ({
    docId,
    name: doc.name,
    url: doc.url,
    text,
    sentences: citableSentences(docId, localIdx, text),
  }));
  allChunks.push(...newChunks);
  await writeJson(dir, 'chunks.json', allChunks);
  await appendKeywordIndex(dir, previousChunkCount, newChunks, allChunks);

  meta.docs.push({
    id: docId,
    name: doc.name,
    url: doc.url,
    capturedAt: new Date().toISOString(),
    chunkStart: meta.chunkCount,
    chunkCount: chunks.length,
    ...(opts.docExtra?.path !== undefined ? { path: opts.docExtra.path } : {}),
    ...(opts.docExtra?.mtime !== undefined ? { mtime: opts.docExtra.mtime } : {}),
    ...(opts.docExtra?.size !== undefined ? { size: opts.docExtra.size } : {}),
  });
  meta.chunkCount += chunks.length;
  await writeJson(dir, 'meta.json', meta);
  return { docId, chunkCount: meta.chunkCount };
}

export async function repoSearch(
  repo: string,
  queryVector: number[],
  k: number,
  embedModel?: string,
  opts: { query?: string; hybrid?: boolean; queryVectors?: number[][]; queries?: string[] } = {},
): Promise<{ results: SearchHit[] }> {
  await assertVaultUsable();
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
    // Attach chunkId + sentence spans so hits carry provenance to the agent.
    chunks: enrichChunks(meta, chunks),
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
  await assertVaultUsable(); // export decrypts chunk text, so needs the vault unlocked
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
  await assertVaultUsable(); // import re-encrypts chunk text under the active vault
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

/** Remove one document from a repo, rebuilding vectors.bin + chunks.json + meta. */
export async function repoDeleteDoc(repo: string, docId: string): Promise<{ removed: number; chunkCount: number }> {
  await assertVaultUsable(); // rebuilds chunks.json + keywordIndex.json, so needs decryptable content
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

// ----- notebook overview (NotebookLM-style per-repo synthesized view) -----

/** Read the cached notebook overview for a repo (null if none). Encrypted at rest. */
export async function repoNotebookGet(repo: string): Promise<NotebookOverview | null> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  return readJson<NotebookOverview | null>(dir, 'notebook.json', null);
}

/** Persist the notebook overview for a repo. */
export async function repoNotebookSet(repo: string, overview: NotebookOverview): Promise<void> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  await writeJson(dir, 'notebook.json', overview);
}

/**
 * A representative sample of a repo's chunks — evenly strided across all chunks so
 * both many-small-docs and one-large-doc repos get coverage — plus the doc
 * catalogue and total chunk count. The background generator synthesizes the
 * overview from this without loading the whole corpus.
 */
export async function repoNotebookSample(
  repo: string,
  maxChunks = 40,
): Promise<{ docs: DocMeta[]; chunkCount: number; samples: Array<{ docId: string; name: string; text: string }> }> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta || meta.chunkCount === 0) return { docs: [], chunkCount: 0, samples: [] };
  const chunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  const n = Math.min(Math.max(1, maxChunks), chunks.length);
  const stride = Math.max(1, Math.floor(chunks.length / n));
  const samples: Array<{ docId: string; name: string; text: string }> = [];
  for (let i = 0; i < chunks.length && samples.length < n; i += stride) {
    const c = chunks[i];
    samples.push({ docId: c.docId, name: c.name, text: c.text });
  }
  return { docs: meta.docs, chunkCount: meta.chunkCount, samples };
}

// ----- document knowledge graph (per-notebook GraphRAG) -----

/** Read the extracted knowledge graph for a repo (null if none). Encrypted at rest. */
export async function repoGraphGet(repo: string): Promise<DocGraph | null> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  return readJson<DocGraph | null>(dir, 'graph.json', null);
}

/** Persist the extracted knowledge graph for a repo. */
export async function repoGraphSet(repo: string, graph: DocGraph): Promise<void> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  await writeJson(dir, 'graph.json', graph);
}

/**
 * The chunks of one document, enriched with their stable chunkId and citable
 * sentence spans — the substrate the graph extractor tags with `[[id]]` tokens so
 * every extracted node/edge can be grounded to exact source sentences.
 */
export async function repoDocChunks(
  repo: string,
  docId: string,
): Promise<Array<{ chunkId: string; text: string; sentences: CitableSentence[] }>> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta) return [];
  const doc = meta.docs.find((d) => d.id === docId);
  if (!doc) return [];
  const chunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  return enrichChunks(meta, chunks)
    .slice(doc.chunkStart, doc.chunkStart + doc.chunkCount)
    .map((c) => ({ chunkId: c.chunkId ?? '', text: c.text, sentences: c.sentences ?? [] }));
}

// ----- notebook studio outputs (briefing / FAQ / study guide) -----

/** Read all persisted studio outputs for a repo. */
export async function repoStudioGet(repo: string): Promise<StudioDoc> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  return readJson<StudioDoc>(dir, 'studio.json', { outputs: {} });
}

/** Persist all studio outputs for a repo. */
export async function repoStudioSet(repo: string, doc: StudioDoc): Promise<void> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  await writeJson(dir, 'studio.json', doc);
}
