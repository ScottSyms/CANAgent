// =============================================================================
// Offscreen document — a hidden DOM context the service worker spins up for
// work that needs Window APIs it lacks (DOMParser, pdf.js, the async OPFS file
// system). It owns three jobs, routed by message `target`/`type`:
//   - `extract_pdf`: pull text from a PDF with pdf.js.
//   - `extract_office`: unzip .docx/.pptx/.xlsx (fflate) and parse the OOXML.
//   - RAG (`offscreen-repo`): delegate to `repoStore` (OPFS-backed vector store).
//   - Products (`offscreen-product`): delegate to `productStore` (OPFS-backed
//     durable outputs from scheduled tasks/triggers).
// The service worker reaches these via `offscreenClient`; this file is the
// receiving end of that channel. Heavy/binary work lives here so it can't stall
// the worker and so it has a real Window to use.
// =============================================================================

import { strFromU8, unzipSync } from 'fflate';
import * as pdfjs from 'pdfjs-dist';
// Vite emits the worker as an asset and gives us its URL.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
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
  ProductRequest,
  ProductResponse,
  RepoRequest,
  RepoResponse,
} from '../shared/messages';
import {
  repoAdd,
  repoDelete,
  repoDeleteDoc,
  repoDocs,
  repoExportAll,
  repoExportOne,
  repoImportAll,
  repoImportOne,
  repoDocChunks,
  repoGraphGet,
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

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Anti-OOM ceiling on total extracted text (~hundreds of pages). Callers that
// need a smaller, context-budget slice pass `maxChars`.
const SAFETY_MAX = 5_000_000;

// Build a page's text from pdf.js items, preserving line breaks via the per-item
// `hasEOL` flag instead of flattening everything to single spaces.
function pageItemsToText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let out = '';
  for (const it of items) {
    out += it.str ?? '';
    if (it.hasEOL) out += '\n';
  }
  return out
    .replace(/[ \t]+/g, ' ') // collapse runs of spaces/tabs, keep newlines
    .replace(/ *\n */g, '\n') // trim spaces around line breaks
    .replace(/\n{3,}/g, '\n\n') // collapse blank-line runs
    .trim();
}

async function extractPdf(url: string, maxChars?: number): Promise<ExtractPdfResponse> {
  let data: ArrayBuffer;
  try {
    // credentials:'include' so cookie-gated PDFs work under the host permission.
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, error: `Could not fetch the PDF (HTTP ${res.status}).` };
    data = await res.arrayBuffer();
  } catch (e) {
    return { ok: false, error: `Could not fetch the PDF: ${String(e)}` };
  }
  try {
    const doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false, // required under MV3 CSP
      disableFontFace: true,
    } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
    let text = '';
    let hitSafety = false;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      text += pageItemsToText(content.items as Array<{ str?: string; hasEOL?: boolean }>) + '\n\n';
      if (text.length > SAFETY_MAX) {
        hitSafety = true;
        break;
      }
    }
    text = text.trim();
    const charCount = text.length;
    const limit = maxChars ?? SAFETY_MAX;
    const truncated = hitSafety || charCount > limit;
    return {
      ok: true,
      pageCount: doc.numPages,
      truncated,
      charCount,
      text: charCount > limit ? text.slice(0, limit).trim() : text,
    };
  } catch (e) {
    return { ok: false, error: `Not a readable PDF: ${String(e)}` };
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

// ----- Office (OOXML) extraction: .docx / .pptx / .xlsx are ZIP-of-XML. -----

type ZipFiles = Record<string, Uint8Array>;
type OfficeFormat = 'docx' | 'pptx' | 'xlsx';

function parseXml(bytes: Uint8Array): Document {
  return new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
}

function detectOfficeFormat(files: ZipFiles): OfficeFormat | null {
  if (files['word/document.xml']) return 'docx';
  if (Object.keys(files).some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return 'pptx';
  if (files['xl/workbook.xml']) return 'xlsx';
  return null;
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function extractDocx(files: ZipFiles): string {
  const doc = parseXml(files['word/document.xml']);
  const paras = doc.getElementsByTagName('w:p');
  const lines: string[] = [];
  for (let i = 0; i < paras.length; i++) {
    // Walk descendants in document order so tabs/breaks land in the right place.
    const nodes = paras[i].getElementsByTagName('*');
    let line = '';
    for (let j = 0; j < nodes.length; j++) {
      const tag = nodes[j].tagName;
      if (tag === 'w:t') line += nodes[j].textContent ?? '';
      else if (tag === 'w:tab') line += '\t';
      else if (tag === 'w:br' || tag === 'w:cr') line += '\n';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function extractPptx(files: ZipFiles): string {
  const slideNum = (n: string) => Number(/slide(\d+)\.xml$/.exec(n)?.[1] ?? '0');
  const notesNum = (n: string) => Number(/notesSlide(\d+)\.xml$/.exec(n)?.[1] ?? '0');
  // Concatenate all a:t runs under a part as readable lines.
  const textLines = (name: string): string[] => {
    const doc = parseXml(files[name]);
    const paras = doc.getElementsByTagName('a:p');
    const lines: string[] = [];
    for (let i = 0; i < paras.length; i++) {
      const ts = paras[i].getElementsByTagName('a:t');
      let line = '';
      for (let j = 0; j < ts.length; j++) line += ts[j].textContent ?? '';
      if (line.trim()) lines.push(line);
    }
    return lines;
  };
  const slides = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));
  // Speaker notes live in ppt/notesSlides/notesSlideN.xml (N follows slide order).
  const notesByNum = new Map<number, string[]>();
  for (const n of Object.keys(files)) {
    if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)) notesByNum.set(notesNum(n), textLines(n));
  }
  const out: string[] = [];
  slides.forEach((name, idx) => {
    const lines = textLines(name);
    const notes = notesByNum.get(idx + 1) ?? [];
    let block = `--- Slide ${idx + 1} ---\n${lines.join('\n')}`.trim();
    if (notes.length) block += `\n[Speaker notes] ${notes.join(' ')}`;
    out.push(block);
  });
  return out.join('\n\n');
}

function extractXlsx(files: ZipFiles): string {
  // Shared-string table: cells with t="s" index into this.
  const shared: string[] = [];
  if (files['xl/sharedStrings.xml']) {
    const sdoc = parseXml(files['xl/sharedStrings.xml']);
    const sis = sdoc.getElementsByTagName('si');
    for (let i = 0; i < sis.length; i++) {
      const ts = sis[i].getElementsByTagName('t');
      let s = '';
      for (let j = 0; j < ts.length; j++) s += ts[j].textContent ?? '';
      shared.push(s);
    }
  }
  // Map each sheet's display name to its worksheet part via the workbook rels.
  const relMap: Record<string, string> = {};
  if (files['xl/_rels/workbook.xml.rels']) {
    const rels = parseXml(files['xl/_rels/workbook.xml.rels']).getElementsByTagName('Relationship');
    for (let i = 0; i < rels.length; i++) {
      relMap[rels[i].getAttribute('Id') ?? ''] = rels[i].getAttribute('Target') ?? '';
    }
  }
  const sheetEls = parseXml(files['xl/workbook.xml']).getElementsByTagName('sheet');
  const out: string[] = [];
  for (let i = 0; i < sheetEls.length; i++) {
    const name = sheetEls[i].getAttribute('name') || `Sheet${i + 1}`;
    const rid = sheetEls[i].getAttribute('r:id') || '';
    let target = relMap[rid] || `worksheets/sheet${i + 1}.xml`;
    target = target.replace(/^\//, '');
    if (!target.startsWith('xl/')) target = `xl/${target}`;
    const bytes = files[target] || files[`xl/worksheets/sheet${i + 1}.xml`];
    if (!bytes) continue;
    out.push(`# ${name}\n${sheetToCsv(parseXml(bytes), shared)}`);
  }
  return out.join('\n\n');
}

function sheetToCsv(doc: Document, shared: string[]): string {
  const rows = doc.getElementsByTagName('row');
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].getElementsByTagName('c');
    const vals: string[] = [];
    for (let j = 0; j < cells.length; j++) {
      const c = cells[j];
      const t = c.getAttribute('t');
      let v = '';
      if (t === 's') {
        const idx = Number(c.getElementsByTagName('v')[0]?.textContent ?? '');
        v = shared[idx] ?? '';
      } else if (t === 'inlineStr') {
        v = c.getElementsByTagName('t')[0]?.textContent ?? '';
      } else {
        v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      }
      vals.push(csvEscape(v));
    }
    lines.push(vals.join(','));
  }
  return lines.join('\n');
}

// OOXML files are ZIPs, which start with the bytes "PK". A SharePoint direct
// path sometimes returns an HTML viewer/redirect instead of the file; detecting
// the missing ZIP signature lets us retry with a download hint.
function looksLikeZip(data: ArrayBuffer): boolean {
  const b = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  return b[0] === 0x50 && b[1] === 0x4b;
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

async function extractOffice(url: string, maxChars?: number): Promise<ExtractOfficeResponse> {
  let data: ArrayBuffer;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, error: `Could not fetch the file (HTTP ${res.status}).` };
    data = await res.arrayBuffer();
    // If the server handed back a viewer/redirect (not a ZIP), retry once asking
    // for the raw file — common for SharePoint document paths.
    if (!looksLikeZip(data)) {
      const retryUrl = withDownloadParam(url);
      if (retryUrl) {
        const retry = await fetch(retryUrl, { credentials: 'include' });
        if (retry.ok) data = await retry.arrayBuffer();
      }
    }
  } catch (e) {
    return { ok: false, error: `Could not fetch the file: ${String(e)}` };
  }
  let files: ZipFiles;
  try {
    files = unzipSync(new Uint8Array(data));
  } catch {
    return { ok: false, error: 'Not a readable Office file (could not unzip — legacy .doc/.xls/.ppt are not supported).' };
  }
  const format = detectOfficeFormat(files);
  if (!format) {
    return { ok: false, error: 'Unrecognized Office file (only .docx, .pptx, .xlsx are supported).' };
  }
  let text: string;
  try {
    text = format === 'docx' ? extractDocx(files) : format === 'pptx' ? extractPptx(files) : extractXlsx(files);
  } catch (e) {
    return { ok: false, error: `Could not parse the ${format} file: ${String(e)}` };
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const charCount = text.length;
  const limit = maxChars ?? SAFETY_MAX;
  const truncated = charCount > limit;
  return { ok: true, format, charCount, truncated, text: truncated ? text.slice(0, limit).trim() : text };
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
      case 'graphSet':
        await repoGraphSet(req.repo, req.graph, req.expectedRevision);
        return { ok: true };
      case 'docChunks':
        return { ok: true, result: await repoDocChunks(req.repo, req.docId) };
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
