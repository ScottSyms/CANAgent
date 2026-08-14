// =============================================================================
// On-device embeddings — runs a small LiteRT.js model inside the offscreen
// document (which has the DOM/WASM/WebGPU context the service worker lacks).
// Inference is always local; both the model weights and the LiteRT wasm
// runtime are bundled with the extension (see vite.config.ts's
// copyLiteRtWasm and public/models/), so this works fully offline and within
// the MV3 CSP — no CDN involved.
//
// The model is a custom conversion of sentence-transformers/all-MiniLM-L6-v2
// (see scripts/convert-litert-embed-model/ for the conversion + validation
// pipeline) with mean-pooling and L2-normalization baked into the graph, so
// the .tflite output IS the final embedding vector — no JS-side pooling step.
// It was converted with a *fixed* batch dimension (EMBED_BATCH) and sequence
// length (SEQ_LEN); callers must not assume dynamic shapes.
// =============================================================================

import { loadAndCompile, loadLiteRt, Tensor, type CompiledModel } from '@litertjs/core';
import { AutoTokenizer, env, type PreTrainedTokenizer } from '@huggingface/transformers';
import { batchArray } from '../shared/repoChunk';
import { DEFAULT_LOCAL_EMBED_MODEL } from '../shared/types';

/** Default model: 384-d, ~23 MB int8, matches the current DEFAULT_LOCAL_EMBED_MODEL. */
export const DEFAULT_LOCAL_MODEL = DEFAULT_LOCAL_EMBED_MODEL;

const MODEL_DIR = 'all-MiniLM-L6-v2-litert';
const SEQ_LEN = 256;
// Fixed batch dimension the .tflite graph was traced with — every inference
// call must supply exactly this many rows, so shorter batches are padded with
// blank rows (dropped from the output afterward) rather than left dynamic.
const EMBED_BATCH = 8;

function modelUrl(): string {
  return chrome.runtime.getURL(`models/${MODEL_DIR}/model.int8.tflite`);
}

// Only the base (non-threaded, non-JSPI) wasm variant is bundled — pointing
// loadLiteRt() at its .js file directly (rather than the wasm/ directory)
// skips LiteRT.js's feature-detection auto-select, so the threaded/JSPI
// variants (which need cross-origin isolation this offscreen document
// doesn't have) can never be picked. This mirrors the single-threaded CPU
// fallback the old ONNX Runtime setup used for stability; WebGPU is a
// separate acceleration path (a delegate, not wasm threading) and stays on.
function litertWasmUrl(): string {
  return chrome.runtime.getURL('litert/litert_wasm_internal.js');
}

/**
 * Cache the result of `factory`, called at most once, until it rejects — a
 * failed load shouldn't poison the cache for the rest of the session, so a
 * rejection clears it and the next call retries from scratch.
 */
function memoizeAsync<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) {
      cached = factory();
      cached.catch(() => {
        cached = null;
      });
    }
    return cached;
  };
}

const ensureLiteRtLoaded = memoizeAsync(() => loadLiteRt(litertWasmUrl()).then(() => undefined));

/**
 * Compile the model, preferring WebGPU and falling back to single-threaded
 * WASM/XNNPACK if WebGPU init fails — offscreen-document GPU context init has
 * historically been a Chrome browser-process crash vector (see localEmbed's
 * git history / the ONNX Runtime setup this replaced), so a failure here
 * degrades to the known-stable CPU path instead of throwing.
 */
const getCompiledModel = memoizeAsync(async (): Promise<CompiledModel> => {
  await ensureLiteRtLoaded();
  const url = modelUrl();
  let compiled: CompiledModel;
  try {
    compiled = await loadAndCompile(url, { accelerator: 'webgpu' });
  } catch (err) {
    console.warn('[localEmbed] WebGPU compile failed, falling back to WASM/XNNPACK:', err);
    compiled = await loadAndCompile(url, { accelerator: 'wasm', cpuOptions: { numThreads: 1 } });
  }
  // The .tflite graph was traced with a fixed [EMBED_BATCH, SEQ_LEN] input
  // shape (see scripts/convert-litert-embed-model/); if the bundled model
  // file and these constants ever drift apart, fail clearly here instead of
  // with an obscure shape/slice error deep in embedTextsLocal.
  const inputShape = Array.from(compiled.getInputDetails()[0]?.shape ?? []);
  const expected = [EMBED_BATCH, SEQ_LEN];
  if (inputShape[0] !== expected[0] || inputShape[1] !== expected[1]) {
    throw new Error(
      `Local embedder model shape [${inputShape}] does not match expected [${expected}] — model.int8.tflite and EMBED_BATCH/SEQ_LEN in localEmbed.ts are out of sync.`,
    );
  }
  return compiled;
});

const getTokenizer = memoizeAsync((): Promise<PreTrainedTokenizer> => {
  env.localModelPath = chrome.runtime.getURL('models/');
  env.allowLocalModels = true;
  env.allowRemoteModels = false; // this tokenizer+model pairing only exists bundled — no CDN copy
  return AutoTokenizer.from_pretrained(MODEL_DIR, { local_files_only: true });
});

function flattenRowsToInt32(rows: number[][], batch: number, seqLen: number): Int32Array {
  const out = new Int32Array(batch * seqLen);
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < seqLen; j++) out[i * seqLen + j] = rows[i][j];
  }
  return out;
}

/**
 * Embed each input string into a mean-pooled, L2-normalized vector. Returns one
 * row per input, aligned by index. Throws on model/runtime failure so the caller
 * can surface a clear error (and optionally fall back to the external embedder).
 */
export async function embedTextsLocal(
  texts: string[],
  model: string = DEFAULT_LOCAL_MODEL,
): Promise<{ vectors: number[][]; model: string }> {
  if (texts.length === 0) return { vectors: [], model };
  if (model !== DEFAULT_LOCAL_MODEL) {
    // Unlike the old transformers.js backend, LiteRT.js only runs the one
    // bundled model — there's no CDN to fetch an arbitrary HF model id from.
    // `model` is only echoed back into the result (used as a cache-key label
    // by callers); surface the mismatch instead of silently ignoring it.
    console.warn(`[localEmbed] Ignoring requested model "${model}" — only ${DEFAULT_LOCAL_MODEL} is bundled.`);
  }
  const [tokenizer, compiledModel] = await Promise.all([getTokenizer(), getCompiledModel()]);
  const vectors: number[][] = [];

  for (const batch of batchArray(texts, EMBED_BATCH)) {
    // A tokenizer can't embed an empty string — swap in a single space so the
    // row count stays aligned with the input chunks. Pad to the model's fixed
    // batch dimension; padding rows are computed but discarded below.
    const safe = batch.map((t) => (t && t.trim() ? t : ' '));
    while (safe.length < EMBED_BATCH) safe.push(' ');

    const enc = tokenizer(safe, {
      padding: 'max_length',
      truncation: true,
      max_length: SEQ_LEN,
      return_tensor: false,
      return_token_type_ids: true,
    }) as { input_ids: number[][]; attention_mask: number[][]; token_type_ids: number[][] };

    const inputTensors = [
      new Tensor(flattenRowsToInt32(enc.input_ids, EMBED_BATCH, SEQ_LEN), [EMBED_BATCH, SEQ_LEN]),
      new Tensor(flattenRowsToInt32(enc.attention_mask, EMBED_BATCH, SEQ_LEN), [EMBED_BATCH, SEQ_LEN]),
      new Tensor(flattenRowsToInt32(enc.token_type_ids, EMBED_BATCH, SEQ_LEN), [EMBED_BATCH, SEQ_LEN]),
    ];
    let outputs: Tensor[] | undefined;
    try {
      outputs = await compiledModel.run(inputTensors);
      const data = await outputs[0].data();
      const dim = data.length / EMBED_BATCH;
      for (let i = 0; i < batch.length; i++) {
        vectors.push(Array.from(data.subarray(i * dim, (i + 1) * dim)));
      }
    } finally {
      for (const t of inputTensors) t.delete();
      if (outputs) for (const t of outputs) t.delete();
    }
  }

  if (vectors.length !== texts.length) {
    throw new Error(`Local embedder returned ${vectors.length} vectors for ${texts.length} inputs.`);
  }
  return { vectors, model };
}
