// On-device RAG store: named repositories in OPFS holding chunk text + int8-
// quantized embedding vectors. Runs in the offscreen document (Window context),
// so it uses the async OPFS API (no sync access handles, which are Worker-only).

import type { ExportedRepo, RepoKind } from '../shared/messages';
import type { NotebookOverview, StudioDoc } from '../shared/types';
import type { DocGraph } from '../shared/docGraph';
import { rankGraphEvidence } from '../shared/graphRetrieval';
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
  /** Monotonic content revision. Absent on legacy repositories means revision 0. */
  corpusRevision?: number;
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

interface RepoSearchData {
  revision: number;
  chunkCount: number;
  meta: RepoMeta;
  vectors: Int8Array;
  chunks: ReturnType<typeof enrichChunks>;
  keywordIndex: KeywordIndex;
  /**
   * Lazily-loaded graph for this corpus revision. `undefined` = not yet
   * attempted; `null` = attempted and there is no (or a stale) graph. Once
   * set, reused across every `repoSearch` call at this revision instead of
   * re-reading + re-decrypting `graph.json` from OPFS every time.
   */
  graph?: DocGraph | null;
}

const SEARCH_DATA_CACHE_LIMIT = 3;
const searchDataCache = new Map<string, RepoSearchData>();

function cacheSearchData(repo: string, data: RepoSearchData): void {
  searchDataCache.delete(repo);
  searchDataCache.set(repo, data);
  while (searchDataCache.size > SEARCH_DATA_CACHE_LIMIT) {
    const oldest = searchDataCache.keys().next().value as string | undefined;
    if (!oldest) break;
    searchDataCache.delete(oldest);
  }
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

function corpusRevision(meta: RepoMeta): number {
  return meta.corpusRevision ?? 0;
}

async function invalidateGraphArtifacts(dir: FileSystemDirectoryHandle): Promise<void> {
  for (const file of ['graph.json', 'studio.json']) {
    try {
      await dir.removeEntry(file);
    } catch {
      // Missing artifacts are expected. Revision checks still hide a file if an
      // underlying filesystem error prevents best-effort removal.
    }
  }
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

export interface RepoAddDoc {
  doc: { name: string; url: string };
  chunks: string[];
  vectors: number[][];
  docExtra?: DocExtra;
  docId?: string;
}

export type RepoAddResult = { ok: true; docId: string; chunkCount: number } | { ok: false; error: string };

/**
 * Add one or more documents to a repository in a single pass: `meta.json`,
 * `chunks.json`, and `keywordIndex.json` are each read and rewritten exactly
 * once for the whole batch, and `vectors.bin` gets one combined append —
 * instead of the O(corpus size) read+rewrite that adding N documents one at a
 * time (via N separate `repoAdd` calls) repeats N times, which is O(N²) total
 * over a folder sync. `repoAdd` below is just `repoAddBatch` with one entry.
 */
export async function repoAddBatch(
  repo: string,
  docs: RepoAddDoc[],
  opts: { embedModel?: string; kind?: RepoKind } = {},
): Promise<RepoAddResult[]> {
  if (docs.length === 0) return [];
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
      const error = `Repo "${repo}" was built with embedder "${meta.embedModel}" but this add uses "${opts.embedModel}". Re-index the repo to switch embedders.`;
      return docs.map(() => ({ ok: false, error }));
    }
  }
  if (opts.kind && (!meta.kind || meta.chunkCount === 0)) meta.kind = opts.kind;

  const allChunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  const previousChunkCount = allChunks.length;
  const newChunksAllDocs: ChunkRec[] = [];
  const packedBatches: Int8Array[] = [];
  const results: RepoAddResult[] = [];
  let anyAdded = false;

  for (const entry of docs) {
    if (entry.chunks.length === 0 || entry.vectors.length !== entry.chunks.length) {
      results.push({ ok: false, error: 'repoAdd: chunk/vector count mismatch.' });
      continue;
    }
    const normed = entry.vectors.map(normalizeVector);
    if (meta.dim === 0) {
      meta.dim = normed[0].length;
      const scale = new Array(meta.dim).fill(0);
      for (const v of normed) for (let d = 0; d < meta.dim; d++) scale[d] = Math.max(scale[d], Math.abs(v[d]));
      meta.perDimScale = scale.map((s) => s || 1);
    }
    if (normed[0].length !== meta.dim) {
      results.push({ ok: false, error: `Embedding dimension ${normed[0].length} does not match repo dimension ${meta.dim}.` });
      continue;
    }

    const packed = new Int8Array(normed.length * meta.dim);
    normed.forEach((v, i) => packed.set(quantizeVector(v, meta.perDimScale), i * meta.dim));
    packedBatches.push(packed);

    const docId = entry.docId ?? `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // localChunkIdx is the chunk's position within this document, so sentence
    // ids are stable regardless of where the doc lands in the repo.
    const newChunks = entry.chunks.map((text, localIdx) => ({
      docId,
      name: entry.doc.name,
      url: entry.doc.url,
      text,
      sentences: citableSentences(docId, localIdx, text),
    }));
    newChunksAllDocs.push(...newChunks);
    allChunks.push(...newChunks);

    meta.docs.push({
      id: docId,
      name: entry.doc.name,
      url: entry.doc.url,
      capturedAt: new Date().toISOString(),
      chunkStart: meta.chunkCount,
      chunkCount: entry.chunks.length,
      ...(entry.docExtra?.path !== undefined ? { path: entry.docExtra.path } : {}),
      ...(entry.docExtra?.mtime !== undefined ? { mtime: entry.docExtra.mtime } : {}),
      ...(entry.docExtra?.size !== undefined ? { size: entry.docExtra.size } : {}),
    });
    meta.chunkCount += entry.chunks.length;
    results.push({ ok: true, docId, chunkCount: meta.chunkCount });
    anyAdded = true;
  }

  if (!anyAdded) return results;

  const totalVectorLen = packedBatches.reduce((n, p) => n + p.length, 0);
  const combined = new Int8Array(totalVectorLen);
  let off = 0;
  for (const p of packedBatches) {
    combined.set(p, off);
    off += p.length;
  }
  await appendVectors(dir, combined);
  await writeJson(dir, 'chunks.json', allChunks);
  await appendKeywordIndex(dir, previousChunkCount, newChunksAllDocs, allChunks);

  meta.corpusRevision = corpusRevision(meta) + 1;
  await writeJson(dir, 'meta.json', meta);
  // Deliberately does NOT invalidate (delete) graph.json/studio.json here.
  // Adding a document only ever grows the corpus, and buildRepoGraph's own
  // per-document coverage tracking (content-hash gated, see graphExtract.ts)
  // already handles "this doc is new/changed" incrementally — it would just
  // see the new doc as pending work on the next build. Deleting the whole
  // graph on every add destroyed potentially hours of prior extraction work
  // for no benefit: repoGraphGet/repoStudioGet already refuse to serve a
  // graph/studio whose corpusRevision is behind the repo's current one (their
  // own staleness gate, unchanged), so nothing stale is served live — but the
  // file survives to be built on, and to be included in an archive export.
  searchDataCache.delete(repo);
  return results;
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
  const [result] = await repoAddBatch(repo, [{ doc, chunks, vectors, docExtra: opts.docExtra, docId: opts.docId }], {
    embedModel: opts.embedModel,
    kind: opts.kind,
  });
  if (!result.ok) throw new Error(result.error);
  return { docId: result.docId, chunkCount: result.chunkCount };
}

export async function repoSearch(
  repo: string,
  queryVector: number[],
  k: number,
  embedModel?: string,
  opts: { query?: string; hybrid?: boolean; graphAssist?: boolean; queryVectors?: number[][]; queries?: string[] } = {},
): Promise<{
  results: SearchHit[];
  diagnostics: {
    graphStatus: 'used' | 'disabled' | 'hybrid_disabled' | 'no_graph' | 'stale_graph' | 'no_match';
    graphRankingCount: number;
    graphCandidateCount: number;
  };
}> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta || meta.chunkCount === 0) {
    return { results: [], diagnostics: { graphStatus: 'no_graph', graphRankingCount: 0, graphCandidateCount: 0 } };
  }
  // Model lock: a query embedded by a different model can't be compared to the
  // stored vectors. Fail loudly so the caller re-indexes rather than returning junk.
  if (embedModel && meta.embedModel && meta.embedModel !== embedModel) {
    throw new Error(
      `Repo "${repo}" was built with embedder "${meta.embedModel}" but the query used "${embedModel}". Re-index the repo (or switch the embedder back) to search it.`,
    );
  }
  const revision = corpusRevision(meta);
  let cached = searchDataCache.get(repo);
  if (!cached || cached.revision !== revision || cached.chunkCount !== meta.chunkCount) {
    const vectors = await readVectors(dir);
    const chunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
    const keywordIndex = await readOrBuildKeywordIndex(dir, chunks);
    cached = { revision, chunkCount: meta.chunkCount, meta, vectors, chunks: enrichChunks(meta, chunks), keywordIndex };
    cacheSearchData(repo, cached);
  } else {
    // Refresh LRU order on use.
    cacheSearchData(repo, cached);
  }
  const { vectors, chunks: enrichedChunks, keywordIndex } = cached;
  const base = {
    dim: meta.dim,
    perDimScale: meta.perDimScale,
    chunkCount: meta.chunkCount,
    vectors,
    // Attach chunkId + sentence spans so hits carry provenance to the agent.
    chunks: enrichedChunks,
    k,
  };
  // Hybrid (semantic + BM25, RRF-fused) when enabled and the raw query is known;
  // otherwise pure semantic. The query text is only present on the hybrid path.
  const queryVectors = opts.queryVectors?.length ? opts.queryVectors : [queryVector];
  const queries = opts.queries?.length ? opts.queries : opts.query ? [opts.query] : [];
  const multiQuery = queryVectors.length > 1 || queries.length > 1;
  const hybridEnabled = multiQuery ? opts.hybrid !== false : opts.hybrid === true && !!opts.query;
  const graphEnabled = opts.graphAssist !== false && hybridEnabled;
  if (graphEnabled && cached.graph === undefined) {
    cached.graph = await readJson<DocGraph | null>(dir, 'graph.json', null);
  }
  const storedGraph = graphEnabled ? (cached.graph ?? null) : null;
  const graph = storedGraph && (storedGraph.corpusRevision ?? 0) === corpusRevision(meta) ? storedGraph : null;
  const supplementalRankings = graph
    ? queries.map((q) => rankGraphEvidence(graph, q, enrichedChunks)).filter((ranking) => ranking.length > 0)
    : [];
  let graphStatus: 'used' | 'disabled' | 'hybrid_disabled' | 'no_graph' | 'stale_graph' | 'no_match';
  if (opts.graphAssist === false) graphStatus = 'disabled';
  else if (!hybridEnabled) graphStatus = 'hybrid_disabled';
  else if (!storedGraph) graphStatus = 'no_graph';
  else if (!graph) graphStatus = 'stale_graph';
  else if (supplementalRankings.length === 0) graphStatus = 'no_match';
  else graphStatus = 'used';
  const graphCandidateCount = new Set(supplementalRankings.flatMap((ranking) => ranking.map(({ i }) => i))).size;
  const results = multiQuery
    ? multiHybridSearch({ ...base, queryVectors, queries, hybrid: opts.hybrid !== false, keywordIndex, supplementalRankings })
    : opts.hybrid && opts.query
      ? hybridSearch({ ...base, queryVector, query: opts.query, keywordIndex, supplementalRankings })
      : searchVectors({ ...base, queryVector });
  return {
    results,
    diagnostics: {
      graphStatus,
      graphRankingCount: supplementalRankings.length,
      graphCandidateCount,
    },
  };
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
  searchDataCache.delete(repo);
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

/** Serialize one repository with all metadata, chunks, vectors, overview, graph, and studio. */
export async function repoExportOne(repo: string): Promise<ExportedRepo | null> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta) return null;
  const chunks = await readJson<ChunkRec[]>(dir, 'chunks.json', []);
  const vecs = await readVectors(dir);
  const bytes = new Uint8Array(vecs.buffer, vecs.byteOffset, vecs.byteLength);

  const notebook = await readJson<unknown>(dir, 'notebook.json', null);
  // Export whatever is stored, even if its corpusRevision predates the repo's
  // current one (e.g. a document was added after the graph/studio were last
  // built) — an archive exists to preserve the user's generated work, and
  // silently dropping it here on every subsequent export looks like data
  // loss. Staleness relative to the current corpus is already detected and
  // surfaced at *use* time (repoSearch's graphEnabled check, repoGraphGet,
  // GraphPanel's coverage display) via the corpusRevision each artifact
  // already carries with it, so it's safe — and correct — to carry the
  // artifact through unconditionally here.
  const graph = await readJson<DocGraph | null>(dir, 'graph.json', null);
  const studio = await readJson<StudioDoc | null>(dir, 'studio.json', null);

  return {
    name: repo,
    meta,
    chunks,
    vectorsB64: u8ToB64(bytes),
    ...(notebook ? { notebook } : {}),
    ...(graph ? { graph } : {}),
    ...(studio ? { studio } : {}),
  };
}

/** Import one repository archive file into OPFS under targetName || repoData.name. */
export async function repoImportOne(repoData: ExportedRepo, targetName?: string): Promise<{ ok: boolean; name: string }> {
  await assertVaultUsable();
  if (!repoData?.meta || !repoData?.name) return { ok: false, name: '' };
  const name = (targetName || repoData.name).trim();
  if (!name) return { ok: false, name: '' };

  const root = await reposDir();
  try {
    await root.removeEntry(name, { recursive: true });
  } catch {
    // no existing repo by that name
  }

  const d = await root.getDirectoryHandle(name, { create: true });

  // Update meta.name to match destination name
  const meta = typeof repoData.meta === 'object' && repoData.meta ? { ...repoData.meta, name } : repoData.meta;

  await writeJson(d, 'meta.json', meta);
  await writeJson(d, 'chunks.json', Array.isArray(repoData.chunks) ? repoData.chunks : []);
  await rebuildKeywordIndex(d, Array.isArray(repoData.chunks) ? (repoData.chunks as ChunkRec[]) : []);
  const u8 = b64ToU8(repoData.vectorsB64 ?? '');
  await writeVectors(d, new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength));

  if (repoData.notebook) await writeJson(d, 'notebook.json', repoData.notebook);
  if (repoData.graph) await writeJson(d, 'graph.json', repoData.graph);
  if (repoData.studio) await writeJson(d, 'studio.json', repoData.studio);

  searchDataCache.delete(name);
  return { ok: true, name };
}

/** Serialize every repository (meta + chunks + base64 vectors + artifacts) for backup. */
export async function repoExportAll(): Promise<ExportedRepo[]> {
  await assertVaultUsable(); // export decrypts chunk text, so needs the vault unlocked
  const out: ExportedRepo[] = [];
  const dir = await reposDir();
  // @ts-expect-error - entries() exists on FileSystemDirectoryHandle in Chrome
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory') continue;
    const exp = await repoExportOne(name);
    if (exp) out.push(exp);
  }
  return out;
}

/** Restore repositories from a backup, overwriting any with the same name. */
export async function repoImportAll(repos: ExportedRepo[]): Promise<{ imported: number }> {
  await assertVaultUsable(); // import re-encrypts chunk text under the active vault
  let imported = 0;
  for (const r of repos) {
    if (!r?.name) continue;
    const res = await repoImportOne(r);
    if (res.ok) imported++;
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
  meta.corpusRevision = corpusRevision(meta) + 1;
  await writeJson(dir, 'meta.json', meta);
  await invalidateGraphArtifacts(dir);
  searchDataCache.delete(repo);
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

/** Atomically capture the document catalogue and corpus revision for a graph build. */
export async function repoGraphSnapshot(
  repo: string,
): Promise<{ docs: Array<{ id: string; name: string }>; corpusRevision: number }> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta) return { docs: [], corpusRevision: 0 };
  return {
    docs: meta.docs.map((d) => ({ id: d.id, name: d.name })),
    corpusRevision: corpusRevision(meta),
  };
}

/** Read the extracted knowledge graph for a repo (null if none). Encrypted at rest. */
export async function repoGraphGet(repo: string): Promise<DocGraph | null> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  const [meta, graph] = await Promise.all([
    readJson<RepoMeta | null>(dir, 'meta.json', null),
    readJson<DocGraph | null>(dir, 'graph.json', null),
  ]);
  if (!meta || !graph || (graph.corpusRevision ?? 0) !== corpusRevision(meta)) return null;
  return graph;
}

/**
 * Read the extracted knowledge graph regardless of whether it's stale
 * relative to the repo's current corpusRevision (null only when there's
 * genuinely no graph.json). `repoGraphGet`'s staleness gate is correct for
 * live search/UI use — a stale graph shouldn't silently back a citation or
 * concept map — but `buildRepoGraph` needs the *actual* stored graph to
 * resume its incremental, per-document progress (docCoverage) on top of.
 * Reading through the gated getter there would make every rebuild after any
 * corpus change discard all prior extraction work and start over.
 */
export async function repoGraphGetRaw(repo: string): Promise<DocGraph | null> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  return readJson<DocGraph | null>(dir, 'graph.json', null);
}

/** Persist a graph only if the repository still matches the build's snapshot. */
export async function repoGraphSet(repo: string, graph: DocGraph, expectedRevision: number): Promise<void> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta) throw new Error(`Repository "${repo}" no longer exists.`);
  const current = corpusRevision(meta);
  if (current !== expectedRevision) {
    throw new Error('Repository changed while the graph was being built. Rebuild the graph.');
  }
  await writeJson(dir, 'graph.json', { ...graph, corpusRevision: current });
  // The corpus revision is unchanged (only the graph itself was (re)built), so
  // the revision check in repoSearch's cache wouldn't otherwise notice — drop
  // the cached search data so the next search picks up the new graph.
  searchDataCache.delete(repo);
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
  const [meta, doc] = await Promise.all([
    readJson<RepoMeta | null>(dir, 'meta.json', null),
    readJson<StudioDoc>(dir, 'studio.json', { outputs: {} }),
  ]);
  if (!meta || (doc.corpusRevision ?? 0) !== corpusRevision(meta)) return { outputs: {} };
  return doc;
}

/** Persist Studio outputs only while their source graph revision is current. */
export async function repoStudioSet(repo: string, doc: StudioDoc, expectedRevision: number): Promise<void> {
  await assertVaultUsable();
  const dir = await repoDir(repo);
  const meta = await readJson<RepoMeta | null>(dir, 'meta.json', null);
  if (!meta) throw new Error(`Repository "${repo}" no longer exists.`);
  const current = corpusRevision(meta);
  if (current !== expectedRevision) {
    throw new Error('Repository changed while the Studio output was being generated. Regenerate it.');
  }
  await writeJson(dir, 'studio.json', { ...doc, corpusRevision: current });
}
