// =============================================================================
// On-device named entity recognition — runs a small transformers.js
// token-classification model inside the offscreen document (same DOM/WASM
// context localEmbed.ts uses), for the graph builder's on-device NER backbone
// (src/background/graphExtract.ts's runNerBackbone, used by the "Quick"
// build). Inference is always local; model weights are fetched once from the
// Hugging Face CDN (or served from bundled extension assets when present)
// then browser-cached.
// =============================================================================

import { env, pipeline, type TokenClassificationPipeline } from '@huggingface/transformers';
import { batchArray } from '../shared/repoChunk';
import { DEFAULT_LOCAL_NER_MODEL } from '../shared/types';
import { aggregateBioTags, type NerSpan, type NerToken } from '../shared/nerAggregate';

/** Default model: multilingual (10 languages incl. English/French), PER/ORG/LOC. */
export const DEFAULT_LOCAL_MODEL = DEFAULT_LOCAL_NER_MODEL;

// Identical runtime configuration to localEmbed.ts's configureRuntime, for the
// same reasons (single-threaded, non-proxied WASM avoids an offscreen-document
// browser-process crash vector; local models preferred, CDN as fallback).
function configureRuntime(): void {
  try {
    env.localModelPath = chrome.runtime.getURL('models/');
    env.allowLocalModels = true;
    const wasm = env.backends?.onnx?.wasm;
    if (wasm) {
      wasm.wasmPaths = chrome.runtime.getURL('ort/');
      wasm.numThreads = 1;
      wasm.proxy = false;
    }
  } catch {
    // Not in an extension context (tests) — leave defaults.
  }
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
}

// The `pipeline` overload set is huge; narrow it to the one signature we use
// so TypeScript doesn't choke building the full task union (TS2590) — mirrors
// localEmbed.ts's `featureExtraction` narrowing.
const tokenClassification = pipeline as unknown as (
  task: 'token-classification',
  model: string,
  options?: { device?: string },
) => Promise<TokenClassificationPipeline>;

let pipePromise: Promise<TokenClassificationPipeline> | null = null;
let pipeModel = '';

async function getPipeline(model: string): Promise<TokenClassificationPipeline> {
  if (pipePromise && pipeModel === model) return pipePromise;
  configureRuntime();
  pipeModel = model;
  const p = tokenClassification('token-classification', model, { device: 'wasm' });
  pipePromise = p;
  // Don't let a failed load poison the cache for the rest of the session.
  p.catch(() => {
    if (pipePromise === p) {
      pipePromise = null;
      pipeModel = '';
    }
  });
  return p;
}

/**
 * Chunks classified per inference call. Unlike localEmbed.ts's EMBED_BATCH
 * (bounded for memory — a feature-extraction forward pass is cheap), a
 * token-classification forward pass through a BERT-scale model on the
 * single-threaded WASM runtime this codebase deliberately uses (see
 * configureRuntime's comment) runs as one uninterrupted synchronous stretch
 * per call, with no yield point inside it. A batch of several ~1500-char
 * texts can take multiple seconds of blocking compute; since offscreen
 * documents, the service worker, and an extension's own visible pages
 * commonly share a renderer process, that block can starve the *visible* UI
 * tab too — confirmed in practice as a real Chrome "Page Unresponsive" dialog
 * on the notebook tab during a Quick build, not just a theoretical risk.
 * Keeping this at 1 means every inference call is its own await boundary,
 * capping each blocking stretch at one text's worth of compute — the direct,
 * only-available lever, since there's no way to yield mid-WASM-call. This
 * trades a little throughput (more calls, same total texts) for the build
 * never being able to freeze the tab.
 */
const NER_BATCH = 1;

function isTokenLike(x: unknown): boolean {
  return !!x && typeof x === 'object' && ('entity' in (x as object) || 'word' in (x as object));
}

/**
 * The pipeline's batched-call output shape isn't fully pinned down by its
 * types: an N-input batch normally comes back as N per-input token arrays,
 * but a single-item batch can come back as one flat token array instead of a
 * length-1 array of arrays. Normalize both shapes to exactly `expected`
 * per-input arrays, index-aligned to the input batch, so a caller never has
 * to special-case batch size 1 — and so offset/token misalignment from an
 * unexpected shape surfaces as an empty span list for that input rather than
 * silently attributing one text's tokens to another.
 */
function normalizeBatchOutput(raw: unknown, expected: number): NerToken[][] {
  if (!Array.isArray(raw) || raw.length === 0) return Array.from({ length: expected }, () => []);
  if (expected === 1 && !Array.isArray(raw[0]) && isTokenLike(raw[0])) return [raw as NerToken[]];
  const rows = raw.map((row) => (Array.isArray(row) ? (row as NerToken[]) : []));
  while (rows.length < expected) rows.push([]);
  return rows;
}

/**
 * Extract named-entity spans from each input text, aligned by index. Texts
 * are classified in batches (see NER_BATCH) via one array-input pipeline
 * call per batch, rather than one call per text — each per-input token
 * array's character offsets are produced independently by the tokenizer's
 * offset mapping before the batched forward pass, so batching doesn't shift
 * them. Raw per-token BIO output is merged into entity spans via
 * aggregateBioTags (src/shared/nerAggregate.ts), since this transformers.js
 * version has no built-in `aggregation_strategy` the way the Python HF
 * pipeline does. Throws on model/runtime failure so the caller can surface a
 * clear error.
 */
export async function extractEntitiesLocal(
  texts: string[],
  model: string = DEFAULT_LOCAL_MODEL,
): Promise<{ spans: NerSpan[][]; model: string }> {
  if (texts.length === 0) return { spans: [], model };
  const extractor = await getPipeline(model);
  const spans: NerSpan[][] = [];
  for (const batch of batchArray(texts, NER_BATCH)) {
    // A tokenizer can't classify an empty string — swap in a single space so
    // the row count stays aligned with the input texts.
    const safe = batch.map((t) => (t && t.trim() ? t : ' '));
    const raw: unknown = await extractor(safe);
    for (const tokens of normalizeBatchOutput(raw, safe.length)) spans.push(aggregateBioTags(tokens));
  }
  if (spans.length !== texts.length) {
    throw new Error(`Local NER returned ${spans.length} results for ${texts.length} inputs.`);
  }
  return { spans, model };
}
