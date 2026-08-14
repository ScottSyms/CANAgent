// =============================================================================
// Offscreen document — a hidden DOM context the service worker spins up for
// work that needs Window APIs it lacks (DOMParser, the async OPFS file
// system). It owns three jobs, routed by message `target`/`type`:
//   - `extract_pdf` / `extract_office`: convert a PDF or an Office/OpenDocument/
//     RTF/EPUB file to Markdown with anydoc (a WASM document-conversion
//     library — see anydocParse.ts).
//   - RAG (`offscreen-repo`): delegate to `repoStore` (OPFS-backed vector store).
//   - Products (`offscreen-product`): delegate to `productStore` (OPFS-backed
//     durable outputs from scheduled tasks/triggers).
// The service worker reaches these via `offscreenClient`; this file is the
// receiving end of that channel. Heavy/binary work lives here so it can't stall
// the worker and so it has a real Window to use.
// =============================================================================

import { AnydocConvertError, convertToMarkdown, detectFormat } from './anydocParse';
import type {
  EmbedLocalRequest,
  EmbedLocalResponse,
  ExtractOfficeRequest,
  ExtractOfficeResponse,
  ExtractPdfRequest,
  ExtractPdfResponse,
  GenerateDocumentRequest,
  GenerateDocumentResponse,
  GeneratePresentationRequest,
  NerLocalRequest,
  NerLocalResponse,
  ProductRequest,
  ProductResponse,
  RepoRequest,
  RepoResponse,
} from '../shared/messages';
import {
  repoAdd,
  repoAddBatch,
  repoDelete,
  repoDeleteDoc,
  repoDocs,
  repoExportAll,
  repoExportOne,
  repoImportAll,
  repoImportOne,
  repoDocChunks,
  repoDocVectors,
  repoGraphGet,
  repoGraphGetRaw,
  repoGraphSnapshot,
  repoGraphSet,
  repoList,
  repoNotebookGet,
  repoNotebookSample,
  repoNotebookSet,
  repoSearch,
  repoStudioGet,
  repoStudioSet,
} from './repoStore';
import { productDelete, productExportAll, productGet, productImportAll, productList, productSave } from './productStore';
import { initVectorSimd, simdDotBatch } from './vectorSimd';
import { setSimdBackend } from '../shared/vectorSearch';

// Load the WASM dot-product kernel in the background; scoreVectors keeps using
// its JS fallback until (and unless) this resolves true. Never blocks offscreen
// document startup.
void initVectorSimd().then((ok) => {
  if (ok) setSimdBackend(simdDotBatch);
});

// Anti-OOM ceiling on total extracted text (~hundreds of pages). Callers that
// need a smaller, context-budget slice pass `maxChars`.
const SAFETY_MAX = 5_000_000;

// A SharePoint direct path sometimes returns an HTML viewer/redirect instead
// of the real file; detecting that (rather than sniffing for a specific file
// signature — anydoc's supported formats span ZIP, OLE2, RTF, and raw PDF, so
// no single "looks valid" signature check covers all of them) lets us retry
// once with a download hint before handing anydoc content it can't parse.
function looksLikeHtml(data: ArrayBuffer): boolean {
  const sample = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(data, 0, Math.min(512, data.byteLength)));
  return /^\s*<!doctype html/i.test(sample) || /^\s*<html[\s>]/i.test(sample);
}

/** Append SharePoint's `download=1` hint so a viewer URL serves the raw file. */
function withDownloadParam(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.searchParams.has('download')) return null; // already tried
    u.searchParams.set('download', '1');
    return u.toString();
  } catch {
    return null;
  }
}

/** Fetch a document's bytes, retrying once with a download hint if the server handed back an HTML viewer page instead of the file (common for SharePoint document paths). */
async function fetchDocumentBytes(url: string): Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }> {
  let data: ArrayBuffer;
  try {
    // credentials:'include' so cookie-gated documents work under the host permission.
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, error: `Could not fetch the file (HTTP ${res.status}).` };
    data = await res.arrayBuffer();
  } catch (e) {
    return { ok: false, error: `Could not fetch the file: ${String(e)}` };
  }
  if (looksLikeHtml(data)) {
    const retryUrl = withDownloadParam(url);
    if (retryUrl) {
      try {
        const retry = await fetch(retryUrl, { credentials: 'include' });
        if (retry.ok) data = await retry.arrayBuffer();
      } catch {
        // Keep the original (HTML) bytes — the caller's conversion attempt
        // below will fail with a clear "unrecognized format" error.
      }
    }
  }
  return { ok: true, data };
}

/** Slice `text` to `limit` chars, matching the truncation contract both extract_pdf and extract_office responses share. */
function sliceToLimit(text: string, limit: number): { text: string; charCount: number; truncated: boolean } {
  const charCount = text.length;
  const truncated = charCount > limit;
  return { text: truncated ? text.slice(0, limit).trim() : text, charCount, truncated };
}

async function extractPdf(url: string, maxChars?: number): Promise<ExtractPdfResponse> {
  const fetched = await fetchDocumentBytes(url);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  try {
    const { text: fullText } = await convertToMarkdown(new Uint8Array(fetched.data), 'pdf');
    const { text, charCount, truncated } = sliceToLimit(fullText, maxChars ?? SAFETY_MAX);
    // anydoc converts the whole document in one call (no page-by-page early
    // stop like pdf.js's incremental extraction), so charCount is always
    // exact — the truncation, if any, only ever happens in the slice above.
    return { ok: true, truncated, charCount, charCountExact: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof AnydocConvertError ? e.message : `Not a readable PDF: ${String(e)}` };
  }
}

chrome.runtime.onMessage.addListener((message: ExtractPdfRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'extract_pdf') return undefined;
  extractPdf(message.url, message.maxChars).then(sendResponse);
  return true; // async response
});

// ----- Document generation: markdown → .docx (create_word_document tool). -----

chrome.runtime.onMessage.addListener((message: GenerateDocumentRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'generate_document') return undefined;
  (async () => {
    try {
      // Lazy import so the docx library only loads when generation is requested.
      const { markdownToDocxBase64 } = await import('./docGen');
      const dataBase64 = await markdownToDocxBase64(message.title, message.markdown);
      sendResponse({
        ok: true,
        dataBase64,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      } satisfies GenerateDocumentResponse);
    } catch (e) {
      sendResponse({ ok: false, error: String(e) } satisfies GenerateDocumentResponse);
    }
  })();
  return true; // async response
});

// ----- Presentation generation: slide spec → .pptx (create_powerpoint tool). -----

chrome.runtime.onMessage.addListener((message: GeneratePresentationRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'generate_presentation') return undefined;
  (async () => {
    try {
      // Lazy import so pptxgenjs only loads when a deck is requested.
      const { slidesToPptxBase64 } = await import('./pptGen');
      const dataBase64 = await slidesToPptxBase64(message.title, message.slides);
      sendResponse({
        ok: true,
        dataBase64,
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      } satisfies GenerateDocumentResponse);
    } catch (e) {
      sendResponse({ ok: false, error: String(e) } satisfies GenerateDocumentResponse);
    }
  })();
  return true; // async response
});

// ----- Office/OpenDocument/RTF/EPUB extraction, via anydoc. -----

async function extractOffice(url: string, maxChars?: number): Promise<ExtractOfficeResponse> {
  const fetched = await fetchDocumentBytes(url);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const bytes = new Uint8Array(fetched.data);
  try {
    const detected = await detectFormat(bytes);
    if (!detected || detected === 'pdf') {
      return { ok: false, error: 'Unrecognized file (expected .docx/.doc, .pptx/.ppt, .xlsx, an OpenDocument file, .rtf, or .epub).' };
    }
    const { text: fullText } = await convertToMarkdown(bytes, detected);
    const { text, charCount, truncated } = sliceToLimit(fullText, maxChars ?? SAFETY_MAX);
    return { ok: true, format: detected, charCount, truncated, charCountExact: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof AnydocConvertError ? e.message : `Could not parse the file: ${String(e)}` };
  }
}

chrome.runtime.onMessage.addListener((message: ExtractOfficeRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'extract_office') return undefined;
  extractOffice(message.url, message.maxChars).then(sendResponse);
  return true; // async response
});

async function handleRepo(req: RepoRequest): Promise<RepoResponse> {
  try {
    switch (req.op) {
      case 'add':
        return {
          ok: true,
          result: await repoAdd(req.repo, req.doc, req.chunks, req.vectors, {
            embedModel: req.embedModel,
            kind: req.kind,
            docExtra: req.docExtra,
            docId: req.docId,
          }),
        };
      case 'addBatch':
        return { ok: true, result: await repoAddBatch(req.repo, req.docs, { embedModel: req.embedModel, kind: req.kind }) };
      case 'search':
        return {
          ok: true,
          result: await repoSearch(req.repo, req.queryVector, req.k, req.embedModel, {
            query: req.query,
            queryVectors: req.queryVectors,
            queries: req.queries,
            hybrid: req.hybrid,
            graphAssist: req.graphAssist,
          }),
        };
      case 'list':
        return { ok: true, result: await repoList() };
      case 'delete':
        await repoDelete(req.repo);
        return { ok: true };
      case 'docs':
        return { ok: true, result: await repoDocs(req.repo) };
      case 'deleteDoc':
        return { ok: true, result: await repoDeleteDoc(req.repo, req.docId) };
      case 'export':
        return { ok: true, result: await repoExportAll() };
      case 'import':
        return { ok: true, result: await repoImportAll(req.repos) };
      case 'exportOne':
        return { ok: true, result: await repoExportOne(req.repo) };
      case 'importOne':
        return { ok: true, result: await repoImportOne(req.repoData, req.targetName) };
      case 'notebookGet':
        return { ok: true, result: await repoNotebookGet(req.repo) };
      case 'notebookSet':
        await repoNotebookSet(req.repo, req.overview);
        return { ok: true };
      case 'notebookSample':
        return { ok: true, result: await repoNotebookSample(req.repo, req.maxChunks) };
      case 'graphSnapshot':
        return { ok: true, result: await repoGraphSnapshot(req.repo) };
      case 'graphGet':
        return { ok: true, result: await repoGraphGet(req.repo) };
      case 'graphGetRaw':
        return { ok: true, result: await repoGraphGetRaw(req.repo) };
      case 'graphSet':
        await repoGraphSet(req.repo, req.graph, req.expectedRevision);
        return { ok: true };
      case 'docChunks':
        return { ok: true, result: await repoDocChunks(req.repo, req.docId) };
      case 'docVectors':
        return { ok: true, result: await repoDocVectors(req.repo, req.docId) };
      case 'studioGet':
        return { ok: true, result: await repoStudioGet(req.repo) };
      case 'studioSet':
        await repoStudioSet(req.repo, req.doc, req.expectedRevision);
        return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((message: RepoRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen-repo') return undefined;
  handleRepo(message).then(sendResponse);
  return true; // async response
});

async function handleProduct(req: ProductRequest): Promise<ProductResponse> {
  try {
    switch (req.op) {
      case 'save':
        return { ok: true, result: await productSave(req.filename, req.mimeType, req.dataBase64, { sourceTitle: req.sourceTitle, conversationId: req.conversationId }) };
      case 'list':
        return { ok: true, result: await productList() };
      case 'get':
        return { ok: true, result: await productGet(req.id) };
      case 'delete':
        return { ok: true, result: await productDelete(req.id) };
      case 'export':
        return { ok: true, result: await productExportAll() };
      case 'import':
        return { ok: true, result: await productImportAll(req.products) };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((message: ProductRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen-product') return undefined;
  handleProduct(message).then(sendResponse);
  return true; // async response
});

// On-device embeddings (transformers.js). Dynamic import keeps the model runtime
// out of the offscreen bundle's startup path — it only loads when first used.
chrome.runtime.onMessage.addListener((message: EmbedLocalRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'embed_local') return undefined;
  (async () => {
    try {
      const { embedTextsLocal, DEFAULT_LOCAL_MODEL } = await import('./localEmbed');
      const { vectors, model } = await embedTextsLocal(message.texts, message.model || DEFAULT_LOCAL_MODEL);
      sendResponse({ ok: true, vectors, model } satisfies EmbedLocalResponse);
    } catch (e) {
      sendResponse({ ok: false, error: String(e) } satisfies EmbedLocalResponse);
    }
  })();
  return true; // async response
});

// On-device named entity recognition (transformers.js), for the graph
// builder's fast tier. Same dynamic-import pattern as embed_local above.
chrome.runtime.onMessage.addListener((message: NerLocalRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || message.type !== 'ner_local') return undefined;
  (async () => {
    try {
      const { extractEntitiesLocal, DEFAULT_LOCAL_MODEL } = await import('./localNer');
      const { spans, model } = await extractEntitiesLocal(message.texts, message.model || DEFAULT_LOCAL_MODEL);
      sendResponse({ ok: true, spans, model } satisfies NerLocalResponse);
    } catch (e) {
      sendResponse({ ok: false, error: String(e) } satisfies NerLocalResponse);
    }
  })();
  return true; // async response
});
