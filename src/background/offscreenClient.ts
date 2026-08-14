// =============================================================================
// Offscreen client — the service-worker side of the channel to the offscreen
// document. Ensures the offscreen page exists, then exposes typed wrappers
// (PDF/Office extraction, and the repository store ops) that post a request and
// await the matching response. The receiving end is `offscreen.ts`/`repoStore`.
// =============================================================================

import type {
  EmbedLocalRequest,
  EmbedLocalResponse,
  ExportedProduct,
  ExportedRepo,
  ExtractOfficeRequest,
  ExtractOfficeResponse,
  ExtractPdfRequest,
  ExtractPdfResponse,
  GenerateDocumentRequest,
  GenerateDocumentResponse,
  GeneratePresentationRequest,
  SlideSpec,
  NerLocalRequest,
  NerLocalResponse,
  ProductMeta,
  ProductRequest,
  ProductResponse,
  RepoRequest,
  RepoResponse,
  RepoKind,
} from '../shared/messages';
import type { NotebookOverview, StudioDoc } from '../shared/types';
import type { DocGraph } from '../shared/docGraph';

// pdf.js needs a DOM/worker context the service worker can't provide, so it
// runs in an offscreen document created on demand.

let creating: Promise<void> | null = null;
const OFFSCREEN_TIMEOUT_MS = 120_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Bound extension-message waits and let Stop release the caller immediately. */
function waitForOffscreen<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new DOMException('The repository engine did not respond in time.', 'TimeoutError'));
    }, OFFSCREEN_TIMEOUT_MS);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal as AbortSignal));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function hasOffscreen(): Promise<boolean> {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS' as chrome.offscreen.Reason],
        justification: 'Parse PDF files so the agent can read their text.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export async function extractPdf(url: string, maxChars?: number): Promise<ExtractPdfResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the PDF reader: ${String(e)}` };
  }
  const request: ExtractPdfRequest = { target: 'offscreen', type: 'extract_pdf', url, maxChars };
  return sendOffscreen<ExtractPdfResponse>(request);
}

export async function generateDocument(
  format: 'docx',
  title: string,
  markdown: string,
): Promise<GenerateDocumentResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the document generator: ${String(e)}` };
  }
  const request: GenerateDocumentRequest = { target: 'offscreen', type: 'generate_document', format, title, markdown };
  return sendOffscreen<GenerateDocumentResponse>(request);
}

export async function generatePresentation(
  title: string,
  slides: SlideSpec[],
): Promise<GenerateDocumentResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the presentation generator: ${String(e)}` };
  }
  const request: GeneratePresentationRequest = { target: 'offscreen', type: 'generate_presentation', title, slides };
  return sendOffscreen<GenerateDocumentResponse>(request);
}

/**
 * Send a message to the offscreen document. Retries briefly when the listener
 * isn't attached yet ("Receiving end does not exist") — a common race when the
 * service worker recreates a cold offscreen document. If all short retries fail
 * the offscreen doc is probably crashed or was killed by Chrome, so we force-
 * recreate it and retry once more rather than giving up.
 */
async function sendOffscreen<T>(request: unknown, signal?: AbortSignal): Promise<T | { ok: false; error: string }> {
  const doSend = async (): Promise<T | { ok: false; error: string }> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await waitForOffscreen(chrome.runtime.sendMessage(request) as Promise<T>, signal);
      } catch (e) {
        if (signal?.aborted) throw abortReason(signal);
        if (attempt < 15 && /Receiving end does not exist|establish connection/i.test(String(e))) {
          await waitForOffscreen(new Promise((r) => setTimeout(r, 100)), signal);
          continue;
        }
        return { ok: false, error: String(e) };
      }
    }
  };
  const res = await doSend();
  // If the short retry window expired with the doc unresponsive, force-recreate
  // it and retry exactly once.
  const maybe = res as unknown as Record<string, unknown>;
  if (maybe.ok === false && typeof maybe.error === 'string' && /Receiving end does not exist/i.test(maybe.error)) {
    await closeAndRecreate();
    return doSend();
  }
  return res;
}

/** Tear down the current offscreen doc and spin up a fresh one. */
async function closeAndRecreate(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // May already be closed — ignore.
  }
  creating = null;
  // Give Chrome's context registry a moment to notice the close so the
  // subsequent ensureOffscreen check sees no existing document.
  await new Promise((r) => setTimeout(r, 200));
  await ensureOffscreen();
}

/** Embed text on-device with the offscreen transformers.js model (local RAG). */
export async function embedLocal(texts: string[], model?: string, signal?: AbortSignal): Promise<EmbedLocalResponse> {
  try {
    await waitForOffscreen(ensureOffscreen(), signal);
  } catch (e) {
    if (signal?.aborted) throw abortReason(signal);
    return { ok: false, error: `Could not start the local embedder: ${String(e)}` };
  }
  const request: EmbedLocalRequest = { target: 'offscreen', type: 'embed_local', texts, model };
  return sendOffscreen<EmbedLocalResponse>(request, signal);
}

/** Extract named-entity spans on-device with the offscreen transformers.js NER model (graph builder fast tier). */
export async function nerLocal(texts: string[], model?: string, signal?: AbortSignal): Promise<NerLocalResponse> {
  try {
    await waitForOffscreen(ensureOffscreen(), signal);
  } catch (e) {
    if (signal?.aborted) throw abortReason(signal);
    return { ok: false, error: `Could not start the local NER model: ${String(e)}` };
  }
  const request: NerLocalRequest = { target: 'offscreen', type: 'ner_local', texts, model };
  return sendOffscreen<NerLocalResponse>(request, signal);
}

export async function extractOffice(url: string, maxChars?: number): Promise<ExtractOfficeResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the document reader: ${String(e)}` };
  }
  const request: ExtractOfficeRequest = { target: 'offscreen', type: 'extract_office', url, maxChars };
  return sendOffscreen<ExtractOfficeResponse>(request);
}

async function repoRequest(req: RepoRequest, signal?: AbortSignal): Promise<RepoResponse> {
  try {
    await waitForOffscreen(ensureOffscreen(), signal);
  } catch (e) {
    if (signal?.aborted) throw abortReason(signal);
    return { ok: false, error: `Could not start the repository engine: ${String(e)}` };
  }
  return sendOffscreen<RepoResponse>(req, signal);
}

export function repoAdd(
  repo: string,
  doc: { name: string; url: string },
  chunks: string[],
  vectors: number[][],
  opts: { embedModel?: string; kind?: RepoKind; docExtra?: { path?: string; mtime?: number; size?: number }; docId?: string } = {},
): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'add', repo, doc, chunks, vectors, ...opts });
}

/**
 * Add multiple documents in one round trip: the offscreen store reads/rewrites
 * `chunks.json`/`keywordIndex.json`/`meta.json` once for the whole batch
 * instead of once per document (see repoStore.repoAddBatch). Use this instead
 * of calling `repoAdd` in a loop whenever more than one document is ready to
 * store at once (e.g. a folder sync batch).
 */
export function repoAddBatch(
  repo: string,
  docs: Array<{
    doc: { name: string; url: string };
    chunks: string[];
    vectors: number[][];
    docExtra?: { path?: string; mtime?: number; size?: number };
    docId?: string;
  }>,
  opts: { embedModel?: string; kind?: RepoKind } = {},
): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'addBatch', repo, docs, ...opts });
}

export function repoSearch(
  repo: string,
  queryVector: number[],
  k: number,
  embedModel?: string,
  opts: { query?: string; hybrid?: boolean; graphAssist?: boolean; queryVectors?: number[][]; queries?: string[]; signal?: AbortSignal } = {},
): Promise<RepoResponse> {
  return repoRequest({
    target: 'offscreen-repo',
    op: 'search',
    repo,
    queryVector,
    queryVectors: opts.queryVectors,
    k,
    embedModel,
    query: opts.query,
    queries: opts.queries,
    hybrid: opts.hybrid,
    graphAssist: opts.graphAssist,
  }, opts.signal);
}

export function repoList(): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'list' });
}

export function repoDelete(repo: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'delete', repo });
}

export function repoDocs(repo: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'docs', repo });
}

export function repoDeleteDoc(repo: string, docId: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'deleteDoc', repo, docId });
}

export function repoExport(): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'export' });
}

export function repoImport(repos: ExportedRepo[]): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'import', repos });
}

export function repoExportOne(repo: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'exportOne', repo });
}

export function repoImportOne(repoData: ExportedRepo, targetName?: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'importOne', repoData, targetName });
}

export function notebookGet(repo: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'notebookGet', repo });
}

export function notebookSet(repo: string, overview: NotebookOverview): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'notebookSet', repo, overview });
}

export function notebookSample(repo: string, maxChunks?: number): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'notebookSample', repo, maxChunks });
}

export function graphGet(repo: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'graphGet', repo });
}

/** Same as graphGet, but without the staleness gate -- see repoGraphGetRaw. */
export function graphGetRaw(repo: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'graphGetRaw', repo });
}

export function graphSnapshot(repo: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'graphSnapshot', repo });
}

export function graphSet(repo: string, graph: DocGraph, expectedRevision: number): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'graphSet', repo, graph, expectedRevision });
}

export function docChunks(repo: string, docId: string, signal?: AbortSignal): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'docChunks', repo, docId }, signal);
}

export function docVectors(repo: string, docId: string, signal?: AbortSignal): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'docVectors', repo, docId }, signal);
}

export function studioGet(repo: string): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'studioGet', repo });
}

export function studioSet(repo: string, doc: StudioDoc, expectedRevision: number): Promise<RepoResponse> {
  return repoRequest({ target: 'offscreen-repo', op: 'studioSet', repo, doc, expectedRevision });
}

// ----- Products store (durable outputs from scheduled tasks/triggers) -----

async function productRequest(req: ProductRequest): Promise<ProductResponse> {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, error: `Could not start the products store: ${String(e)}` };
  }
  return sendOffscreen<ProductResponse>(req);
}

export async function productSave(
  filename: string,
  mimeType: string,
  dataBase64: string,
  opts: { sourceTitle?: string; conversationId?: string } = {},
): Promise<ProductResponse> {
  return productRequest({ target: 'offscreen-product', op: 'save', filename, mimeType, dataBase64, ...opts });
}

export async function productList(): Promise<ProductMeta[]> {
  const res = await productRequest({ target: 'offscreen-product', op: 'list' });
  return res.ok && Array.isArray(res.result) ? (res.result as ProductMeta[]) : [];
}

export async function productGet(id: string): Promise<{ meta: ProductMeta; dataBase64: string } | null> {
  const res = await productRequest({ target: 'offscreen-product', op: 'get', id });
  return res.ok ? (res.result as { meta: ProductMeta; dataBase64: string } | null) : null;
}

export function productDelete(id: string): Promise<ProductResponse> {
  return productRequest({ target: 'offscreen-product', op: 'delete', id });
}

export function productExport(): Promise<ProductResponse> {
  return productRequest({ target: 'offscreen-product', op: 'export' });
}

export function productImport(products: ExportedProduct[]): Promise<ProductResponse> {
  return productRequest({ target: 'offscreen-product', op: 'import', products });
}
