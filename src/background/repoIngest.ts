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
import type { RepoKind } from '../shared/messages';
import type { Settings } from '../shared/types';
import { resolveOfficeUrl, resolvePdfUrl } from '../shared/url';
import * as browser from './browserToolAdapter';
import { captureFullPage } from './fullPageCapture';
import { complete, embedChunks, embedderId, resolveModelForRole, type ContentPart } from './llmProvider';
import { extractOffice, extractPdf, repoAdd, repoAddMany } from './offscreenClient';

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

/** Chunk → embed → store text as a repo document. Shared by tab and file ingestion. */
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
  return { ok: true, chunks: chunks.length };
}

/**
 * Chunk → embed → store several documents as one batch. Unlike calling
 * `storeText` in a loop, this makes exactly one `embedChunks` call (all
 * documents' chunks concatenated — a bigger batch is more efficient for the
 * embedder than N small ones) and one `repoAddMany` call (avoids `repoAdd`'s
 * per-document full chunks.json read/rewrite — see repoStore.ts).
 */
export async function storeTexts(
  settings: Settings,
  repo: string,
  items: Array<{ name: string; url: string; text: string; docExtra?: { path?: string; mtime?: number; size?: number } }>,
  opts: { kind?: RepoKind } = {},
): Promise<IngestResult[]> {
  const perDoc = items.map((it) => ({ ...it, chunks: chunkText(it.text) }));
  const flatChunks: string[] = [];
  const bounds = perDoc.map((d) => {
    const start = flatChunks.length;
    flatChunks.push(...d.chunks);
    return { start, count: d.chunks.length };
  });
  if (flatChunks.length === 0) return perDoc.map(() => ({ ok: false, error: 'No chunks produced.' }));

  let vectors: number[][];
  try {
    vectors = await embedChunks(settings, flatChunks);
  } catch (e) {
    const error = String(e);
    return perDoc.map((d) => (d.chunks.length === 0 ? { ok: false, error: 'No chunks produced.' } : { ok: false, error }));
  }

  const docsForAdd = perDoc
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.chunks.length > 0)
    .map(({ d, i }) => ({
      doc: { name: d.name, url: d.url },
      chunks: d.chunks,
      vectors: vectors.slice(bounds[i].start, bounds[i].start + bounds[i].count),
      docExtra: d.docExtra,
    }));

  let addError: string | undefined;
  if (docsForAdd.length > 0) {
    const res = await repoAddMany(repo, docsForAdd, { embedModel: embedderId(settings), kind: opts.kind });
    if (!res.ok) addError = res.error ?? 'Could not store the documents.';
  }

  return perDoc.map((d) => {
    if (d.chunks.length === 0) return { ok: false, error: 'No chunks produced.' };
    if (addError) return { ok: false, error: addError };
    return { ok: true, chunks: d.chunks.length };
  });
}

/**
 * Ingest several uploaded files at once. Extraction (PDF/Office parsing) runs
 * in parallel — each call is a stateless, independent pdf.js/fflate parse of
 * its own bytes. Embedding and the OPFS write are then done as ONE batch via
 * `storeTexts` rather than per-file, since the embedder's ONNX session isn't
 * safe to invoke concurrently (unlike extraction). A per-file extraction
 * failure doesn't block the others; only successfully-extracted files reach
 * the batch store.
 */
export async function ingestFiles(
  settings: Settings,
  repo: string,
  files: Array<{ name: string; kind: 'text' | 'pdf' | 'office'; text?: string; dataUrl?: string; path?: string; mtime?: number; size?: number }>,
  repoKind: RepoKind = 'page',
): Promise<IngestResult[]> {
  type Extracted = { ok: true; text: string; path?: string; mtime?: number; size?: number } | { ok: false; error: string };

  const extracted: Extracted[] = await Promise.all(
    files.map(async (file): Promise<Extracted> => {
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
      return { ok: true, text, path: file.path, mtime: file.mtime, size: file.size };
    }),
  );

  const okIndexes = extracted.map((e, i) => ({ e, i })).filter(({ e }) => e.ok);
  if (okIndexes.length === 0) {
    return extracted.map((e) => (e.ok ? { ok: true } : { ok: false, error: e.error }));
  }

  const storeResults = await storeTexts(
    settings,
    repo,
    okIndexes.map(({ e, i }) => {
      const x = e as Extract<Extracted, { ok: true }>;
      const path = x.path;
      const name = path || files[i].name;
      return {
        name,
        url: `file:///${path || files[i].name}`,
        text: x.text,
        docExtra: { path, mtime: x.mtime, size: x.size },
      };
    }),
    { kind: repoKind },
  );

  let si = 0;
  return extracted.map((e) => (e.ok ? storeResults[si++] : { ok: false, error: e.error }));
}
