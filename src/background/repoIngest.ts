// =============================================================================
// Repository ingestion — turn a tab (or a whole tab group) into searchable RAG
// content. For each page it picks the best text source in a ladder: native PDF
// extraction, Office extraction, normal DOM content, app-content fallback, then
// OCR/vision as a last resort. The text is chunked (`chunkText`), embedded
// (`embed`), and written to the OPFS store via `offscreenClient.repoAdd`.
// Called by `agentRuntime` for both the `add_to_repo` tool and the panel's
// "+ Tab / + Group" buttons.
// =============================================================================

import { chunkText } from '../shared/repoChunk';
import type { RepoKind, UploadFile } from '../shared/messages';
import type { Settings } from '../shared/types';
import { resolveOfficeUrl, resolvePdfUrl } from '../shared/url';
import * as browser from './browserToolAdapter';
import { captureFullPage } from './fullPageCapture';
import { complete, embedChunks, embedderId, resolveModelForRole, type ContentPart } from './llmProvider';
import { extractOffice, extractPdf, repoAdd, repoAddBatch } from './offscreenClient';

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

/** Chunk + embed text, without storing it — the shared prep step for both the
 * single-document (`storeText`) and batched (`ingestFilesBatch`) store paths. */
async function prepareTextDoc(
  settings: Settings,
  text: string,
): Promise<{ ok: true; chunks: string[]; vectors: number[][] } | { ok: false; error: string }> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return { ok: false, error: 'No chunks produced.' };
  try {
    const vectors = await embedChunks(settings, chunks);
    return { ok: true, chunks, vectors };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Chunk → embed → store text as a repo document. Shared by tab and file ingestion. */
export async function storeText(
  settings: Settings,
  repo: string,
  name: string,
  url: string,
  text: string,
  opts: { kind?: RepoKind; docExtra?: { path?: string; mtime?: number; size?: number } } = {},
): Promise<IngestResult> {
  const prepared = await prepareTextDoc(settings, text);
  if (!prepared.ok) return prepared;
  const res = await repoAdd(repo, { name, url }, prepared.chunks, prepared.vectors, {
    embedModel: embedderId(settings),
    kind: opts.kind,
    docExtra: opts.docExtra,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, chunks: prepared.chunks.length };
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
 * Concurrency cap for per-file extract+embed work in `ingestFilesBatch`. High
 * enough to overlap PDF/Office extraction (CPU/worker-bound) with embedding
 * (WASM/GPU-bound) across files; low enough that a folder of hundreds of large
 * docs doesn't hold that many chunk/vector arrays in memory at once or flood
 * the single embedding pipeline with concurrent large-document requests.
 */
const FILE_INGEST_CONCURRENCY = 4;

/**
 * Run `fn` over `items` with at most `limit` in flight at once, as a rolling
 * pool — each of `limit` workers pulls the next unclaimed item as soon as it
 * finishes its current one, rather than waiting for a whole fixed-size batch
 * to settle before starting the next (which would idle freed slots behind a
 * single slow item). Callers write their own results (e.g. into an outer
 * array by index) from within `fn`, so this doesn't collect return values.
 */
async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Ingest several uploaded files into a repository with a single store write:
 * each file is extracted + chunked + embedded individually (unavoidable —
 * different text, different embedding calls), but instead of calling
 * `repoAdd` once per file (an O(N²) sequence of full chunks.json/keyword-index
 * rewrites over a folder sync, see repoStore.repoAddBatch), every successfully
 * prepared file is stored in one `repoAddBatch` call. Returns one `IngestResult`
 * per input file, in the same order.
 *
 * Extraction + embedding for each file runs concurrently (capped at
 * `FILE_INGEST_CONCURRENCY`) instead of one file at a time, since neither step
 * depends on another file's result — only the final `repoAddBatch` write needs
 * to wait for all of them.
 */
export async function ingestFilesBatch(
  settings: Settings,
  repo: string,
  files: UploadFile[],
  repoKind: RepoKind = 'page',
): Promise<IngestResult[]> {
  const results = new Array<IngestResult>(files.length);
  const batchEntries: Array<{ index: number; doc: { name: string; url: string }; chunks: string[]; vectors: number[][]; docExtra: { path?: string; mtime?: number; size?: number } }> = [];

  await runWithConcurrency(
    files.map((file, index) => ({ file, index })),
    FILE_INGEST_CONCURRENCY,
    async ({ file, index }) => {
      const extracted = await extractFileText(file);
      if (!extracted.ok) {
        results[index] = extracted;
        return;
      }
      const prepared = await prepareTextDoc(settings, extracted.text);
      if (!prepared.ok) {
        results[index] = prepared;
        return;
      }
      const path = file.path;
      batchEntries.push({
        index,
        doc: { name: path || file.name, url: `file:///${path || file.name}` },
        chunks: prepared.chunks,
        vectors: prepared.vectors,
        docExtra: { path, mtime: file.mtime, size: file.size },
      });
    },
  );

  if (batchEntries.length > 0) {
    const res = await repoAddBatch(
      repo,
      batchEntries.map((e) => ({ doc: e.doc, chunks: e.chunks, vectors: e.vectors, docExtra: e.docExtra })),
      { embedModel: embedderId(settings), kind: repoKind },
    );
    const outcomes = res.ok && Array.isArray(res.result) ? (res.result as Array<{ ok: true; docId: string; chunkCount: number } | { ok: false; error: string }>) : null;
    batchEntries.forEach((entry, j) => {
      if (!res.ok) {
        results[entry.index] = { ok: false, error: res.error ?? 'Batch store failed.' };
        return;
      }
      const outcome = outcomes?.[j];
      results[entry.index] = outcome?.ok ? { ok: true, chunks: entry.chunks.length } : { ok: false, error: outcome && !outcome.ok ? outcome.error : 'Batch store failed.' };
    });
  }

  return results;
}
