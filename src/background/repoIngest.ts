// =============================================================================
// Repository ingestion — turn a tab (or a whole tab group) into searchable RAG
// content. For each page it picks the best text source in a ladder: native PDF
// extraction, Office extraction, normal DOM content, app-content fallback, then
// OCR/vision as a last resort. The text is chunked (`chunkText`), embedded
// (`embed`), and written to the OPFS store via `offscreenClient.repoAdd`.
// Called by `agentRuntime` for both the `add_to_repo` tool and the panel's
// "+ Tab / + Group" buttons.
// =============================================================================

import { runWithConcurrency } from '../shared/asyncPool';
import { chunkText } from '../shared/repoChunk';
import type { RepoKind, UploadFile } from '../shared/messages';
import { DEFAULT_LOCAL_EMBED_MODEL, type Settings } from '../shared/types';
import { resolveOfficeUrl, resolvePdfUrl } from '../shared/url';
import * as browser from './browserToolAdapter';
import { captureFullPage } from './fullPageCapture';
import { scheduleInstantGraphRefresh } from './graphExtract';
import { complete, embedChunks, embedderId, resolveModelForRole, type ContentPart } from './llmProvider';
import { extractOffice, extractPdf, repoAdd, repoAddBatch, repoIngestLocalBatch } from './offscreenClient';

// OCR fallback: screenshot the whole (active) tab and have the vision model
// transcribe it. Only works for the active tab (captureVisibleTab limitation).
async function ocrTabText(settings: Settings, tabId: number): Promise<string> {
  const cap = await captureFullPage(tabId, 12);
  if (cap.error || cap.frames.length === 0) return '';
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: 'Transcribe ALL readable text from these screenshots of a web page, top to bottom in reading order. Output only the transcribed text — no commentary, headings, or markup.',
    },
    ...cap.frames.map((url): ContentPart => ({ type: 'image_url', image_url: { url } })),
  ];
  try {
    const reply = await complete(resolveModelForRole(settings, 'vision'), [{ role: 'user', content: parts }]);
    return (reply.content ?? '').trim();
  } catch {
    return '';
  }
}

export interface IngestResult {
  ok: boolean;
  chunks?: number;
  error?: string;
  needsOcr?: boolean;
}

/** Capture a tab's text (DOM → app-content), chunk, embed, and store it. */
export async function ingestTab(
  settings: Settings,
  repo: string,
  tabId: number,
  title: string,
  url: string,
  allowOcr = false,
): Promise<IngestResult> {
  let text = '';
  // PDFs: pdf.js gives clean, selectable text — try it before the DOM/OCR ladder.
  const pdfUrl = resolvePdfUrl(url);
  if (pdfUrl) {
    try {
      const pdf = await extractPdf(pdfUrl);
      if (pdf.ok && pdf.text && pdf.text.trim().length > 30) text = pdf.text;
    } catch {
      // fall through to the page-content ladder
    }
  }
  // Office files (.docx/.pptx/.xlsx, incl. the SharePoint Office-Online viewer
  // wrapper): extract the whole document before the ladder.
  const officeUrl = resolveOfficeUrl(url);
  if (!text && officeUrl) {
    try {
      const office = await extractOffice(officeUrl);
      if (office.ok && office.text && office.text.trim().length > 30) text = office.text;
    } catch {
      // fall through to the page-content ladder
    }
  }
  if (!text) {
    try {
      const content = await browser.getTabContent(tabId);
      if (content.text && content.text.trim().length > 50) text = content.text;
    } catch {
      // fall through to read_app_content
    }
  }
  if (!text) {
    try {
      const parsed = JSON.parse(await browser.readAppContent(tabId)) as { text?: string };
      if (parsed.text && parsed.text.trim().length > 30) text = parsed.text;
    } catch {
      // no app content
    }
  }
  if (!text && allowOcr) {
    text = await ocrTabText(settings, tabId); // vision transcription (active tab only)
  }
  if (!text || text.trim().length < 30) {
    return { ok: false, needsOcr: true, error: 'No extractable text from this page.' };
  }
  return storeText(settings, repo, title || url, url, text);
}

/**
 * Chunk → embed → store text as a repo document. Shared by tab and file
 * ingestion. Local embedder: routes through the fused `repoIngestLocalBatch`
 * offscreen op (embed + store in one round trip — see its own doc comment in
 * repoStore.ts). External provider: unchanged — `embedChunks`'s HTTP call
 * has no offscreen counterpart to fuse with, so it stays a separate
 * embed-then-`repoAdd` sequence.
 */
export async function storeText(
  settings: Settings,
  repo: string,
  name: string,
  url: string,
  text: string,
  opts: { kind?: RepoKind; docExtra?: { path?: string; mtime?: number; size?: number } } = {},
): Promise<IngestResult> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return { ok: false, error: 'No chunks produced.' };

  if (settings.embedder !== 'external') {
    const model = settings.localEmbedModel || DEFAULT_LOCAL_EMBED_MODEL;
    const res = await repoIngestLocalBatch(repo, [{ doc: { name, url }, chunks, docExtra: opts.docExtra }], { model, kind: opts.kind });
    const outcome = res.ok ? (res.result as Array<{ ok: true; docId: string; chunkCount: number } | { ok: false; error: string }> | undefined)?.[0] : undefined;
    if (!res.ok || !outcome?.ok) {
      return { ok: false, error: (!res.ok ? res.error : outcome && !outcome.ok ? outcome.error : undefined) ?? 'Batch store failed.' };
    }
    scheduleInstantGraphRefresh(repo); // fire-and-forget: free topic graph ready before the user asks for it
    return { ok: true, chunks: chunks.length };
  }

  let vectors: number[][];
  try {
    vectors = await embedChunks(settings, chunks);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  const res = await repoAdd(repo, { name, url }, chunks, vectors, {
    embedModel: embedderId(settings),
    kind: opts.kind,
    docExtra: opts.docExtra,
  });
  if (!res.ok) return { ok: false, error: res.error };
  scheduleInstantGraphRefresh(repo); // fire-and-forget: free topic graph ready before the user asks for it
  return { ok: true, chunks: chunks.length };
}

/** The text-extraction ladder shared by `ingestFile` and `ingestFilesBatch`: use the
 * file's own text if present, otherwise run it through the offscreen PDF/Office extractor. */
async function extractFileText(file: UploadFile): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let text = (file.text ?? '').trim();
  try {
    if (!text && file.kind === 'pdf' && file.dataUrl) {
      const pdf = await extractPdf(file.dataUrl);
      if (pdf.ok && pdf.text) text = pdf.text.trim();
      else if (!pdf.ok) return { ok: false, error: pdf.error ?? 'Could not read the PDF.' };
    } else if (!text && file.kind === 'office' && file.dataUrl) {
      const office = await extractOffice(file.dataUrl);
      if (office.ok && office.text) text = office.text.trim();
      else if (!office.ok) return { ok: false, error: office.error ?? 'Could not read the document.' };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  if (text.length < 1) return { ok: false, error: 'No extractable text in the file.' };
  return { ok: true, text };
}

/**
 * Ingest an uploaded file into a repository. Text-like files arrive with their
 * text already read in the UI; PDF/Office files arrive as a data URL the
 * offscreen extractor (pdf.js / OOXML) parses — the same path used for tabs.
 */
export async function ingestFile(
  settings: Settings,
  repo: string,
  file: UploadFile,
  repoKind: RepoKind = 'page',
): Promise<IngestResult> {
  const extracted = await extractFileText(file);
  if (!extracted.ok) return extracted;
  // Folder docs keep their relative path as both the display name and url so the
  // agent can cite the file, and as the incremental-sync key in DocMeta.
  const path = file.path;
  const name = path || file.name;
  const url = `file:///${path || file.name}`;
  return storeText(settings, repo, name, url, extracted.text, {
    kind: repoKind,
    docExtra: { path, mtime: file.mtime, size: file.size },
  });
}

/**
 * Concurrency cap for per-file extract+chunk work in `ingestFilesBatch`
 * (embedding itself runs once, afterward, for the whole batch — see
 * `flattenForEmbedding`). High enough to overlap PDF/Office extraction
 * (CPU/worker-bound) across files; low enough that a folder of hundreds of
 * large docs doesn't hold that many chunk arrays in memory at once.
 */
const FILE_INGEST_CONCURRENCY = 4;

/**
 * Concatenate every entry's chunks into one flat array for a single
 * `embedChunks` call, plus the `{start, count}` range each entry's own chunks
 * land at within it — the map `unflattenVectors` uses to slice the returned
 * vectors back apart afterward. Document boundaries must not reset the local
 * embedder's fixed-size inference batch (`EMBED_BATCH` in localEmbed.ts):
 * embedding each document with its own `embedChunks` call means a folder of
 * many small files each pay for their own mostly-padded last batch instead of
 * packing rows from different documents into the same batch together.
 */
export function flattenForEmbedding<T extends { chunks: string[] }>(
  entries: readonly T[],
): { flatChunks: string[]; ranges: Array<{ start: number; count: number }> } {
  const flatChunks: string[] = [];
  const ranges: Array<{ start: number; count: number }> = [];
  for (const entry of entries) {
    ranges.push({ start: flatChunks.length, count: entry.chunks.length });
    flatChunks.push(...entry.chunks);
  }
  return { flatChunks, ranges };
}

/** Inverse of `flattenForEmbedding`: slice one flat `vectors[]` back into each range's own vectors, index-aligned with the `entries`/`ranges` that produced it. */
export function unflattenVectors(vectors: number[][], ranges: Array<{ start: number; count: number }>): number[][][] {
  return ranges.map(({ start, count }) => vectors.slice(start, start + count));
}

/**
 * Ingest several uploaded files into a repository with a single store write:
 * every file is extracted + chunked concurrently (unavoidable — different
 * text), but instead of calling `repoAdd` once per file (an O(N²) sequence of
 * full chunks.json/keyword-index rewrites over a folder sync, see
 * repoStore.repoAddBatch) or embedding each file independently (under-filling
 * the embedder's fixed batch size on small files — see flattenForEmbedding),
 * every successfully-extracted file's chunks are embedded in ONE global
 * `embedChunks` call, then stored in one `repoAddBatch` call. Returns one
 * `IngestResult` per input file, in the same order.
 *
 * Extraction for each file runs concurrently (capped at
 * `FILE_INGEST_CONCURRENCY`) since it doesn't depend on another file's
 * result; embedding then runs once for the whole batch, and the final
 * `repoAddBatch` write waits for that.
 */
export async function ingestFilesBatch(
  settings: Settings,
  repo: string,
  files: UploadFile[],
  repoKind: RepoKind = 'page',
): Promise<IngestResult[]> {
  const results = new Array<IngestResult>(files.length);
  const prepared: Array<{ index: number; doc: { name: string; url: string }; chunks: string[]; docExtra: { path?: string; mtime?: number; size?: number } }> = [];

  await runWithConcurrency(
    files.map((file, index) => ({ file, index })),
    FILE_INGEST_CONCURRENCY,
    async ({ file, index }) => {
      const extracted = await extractFileText(file);
      if (!extracted.ok) {
        results[index] = extracted;
        return;
      }
      const chunks = chunkText(extracted.text);
      if (chunks.length === 0) {
        results[index] = { ok: false, error: 'No chunks produced.' };
        return;
      }
      const path = file.path;
      prepared.push({
        index,
        doc: { name: path || file.name, url: `file:///${path || file.name}` },
        chunks,
        docExtra: { path, mtime: file.mtime, size: file.size },
      });
    },
  );

  if (prepared.length === 0) return results;

  // Local embedder: the fused offscreen op does its own flatten-then-embed
  // internally (repoStore.repoIngestLocalBatch), so no local flatten/embed
  // step is needed here at all — just hand it every prepared file's chunks.
  if (settings.embedder !== 'external') {
    const model = settings.localEmbedModel || DEFAULT_LOCAL_EMBED_MODEL;
    const res = await repoIngestLocalBatch(
      repo,
      prepared.map((e) => ({ doc: e.doc, chunks: e.chunks, docExtra: e.docExtra })),
      { model, kind: repoKind },
    );
    applyBatchOutcomes(results, prepared, res);
    if (res.ok) scheduleInstantGraphRefresh(repo); // fire-and-forget, once per batch (not per file)
    return results;
  }

  // External provider: embedChunks' HTTP call has no offscreen counterpart to
  // fuse with, so this stays a separate flatten-then-embed-then-store sequence.
  const { flatChunks, ranges } = flattenForEmbedding(prepared);
  let vectorsByEntry: number[][][];
  try {
    vectorsByEntry = unflattenVectors(await embedChunks(settings, flatChunks), ranges);
  } catch (e) {
    // A single global embed call means one failure affects every file that
    // reached this stage — degrade each to its own per-file error result
    // rather than letting the whole batch throw/reject.
    const error = String(e);
    for (const entry of prepared) results[entry.index] = { ok: false, error };
    return results;
  }

  const batchEntries = prepared.map((entry, i) => ({ ...entry, vectors: vectorsByEntry[i] }));
  const res = await repoAddBatch(
    repo,
    batchEntries.map((e) => ({ doc: e.doc, chunks: e.chunks, vectors: e.vectors, docExtra: e.docExtra })),
    { embedModel: embedderId(settings), kind: repoKind },
  );
  applyBatchOutcomes(results, batchEntries, res);
  if (res.ok) scheduleInstantGraphRefresh(repo); // fire-and-forget, once per batch (not per file)

  return results;
}

/** Map a repoAddBatch/repoIngestLocalBatch RepoResponse back onto each entry's own IngestResult, by index. */
function applyBatchOutcomes(
  results: IngestResult[],
  entries: Array<{ index: number; chunks: string[] }>,
  res: { ok: boolean; error?: string; result?: unknown },
): void {
  const outcomes = res.ok && Array.isArray(res.result) ? (res.result as Array<{ ok: true; docId: string; chunkCount: number } | { ok: false; error: string }>) : null;
  entries.forEach((entry, j) => {
    if (!res.ok) {
      results[entry.index] = { ok: false, error: res.error ?? 'Batch store failed.' };
      return;
    }
    const outcome = outcomes?.[j];
    results[entry.index] = outcome?.ok ? { ok: true, chunks: entry.chunks.length } : { ok: false, error: outcome && !outcome.ok ? outcome.error : 'Batch store failed.' };
  });
}
