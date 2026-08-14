import { DEFAULT_LOCAL_EMBED_MODEL, type ModelRole, type Settings } from '../shared/types';
import { embedLocal } from './offscreenClient';
import { getAdapter } from './adapters';
import { apiVersion, authHeaders, buildUrl, LLM_TIMEOUT_MS, requestWithRetry, resolve, type RetryOpts } from './llmNetwork';
import { LlmError } from './llmTypes';
import type { ContentPart, LlmMessage, LlmResponseMessage, LlmToolCall, ResponseFormatSpec, ToolDefinition } from './llmTypes';

// =============================================================================
// Multi-protocol network adapter — the only module that talks to a model
// endpoint. Everything here runs in the service worker (cross-origin fetch is
// allowed there via the manifest's <all_urls> host permission).
//
// The user supplies the endpoint, key, model, and protocol in Settings;
// nothing ships configured. `complete()` dispatches request-building and
// response-parsing to the adapter for `settings.protocol` (see
// `./adapters/`); everything else here (retry/backoff, endpoint resolution,
// Azure quirks) is protocol-agnostic and lives in `./llmNetwork`. Embeddings
// and transcription may each override the primary endpoint/key (see
// `resolve` in llmNetwork.ts), so a deployment can split chat, RAG, and STT
// across different hosts.
//
// Callers: `agentRuntime` (chat `complete`), `repoIngest`/`offscreen` RAG flow
// (`embed`), the service-worker transcription handler (`transcribe`), and the
// settings screen (`testConnection`). All failures surface as `LlmError` with a
// human-readable message the UI shows verbatim.
// =============================================================================

// Re-exported for backward compatibility — call sites and tests import these
// canonical types and network helpers from this module.
export { LlmError };
export type { ContentPart, LlmMessage, LlmResponseMessage, LlmToolCall, RetryOpts, ToolDefinition };
export { apiVersion, authHeaders, buildUrl, LLM_TIMEOUT_MS };

/**
 * Model orchestration: route a background/utility call to a different
 * `ModelProfile` than the main chat model, by swapping the connection fields
 * on a `Settings` copy — every call site just does
 * `complete(resolveModelForRole(settings, 'reflection'), ...)` rather than
 * `complete(settings, ...)`, so `complete()` itself never needs to know about
 * roles. `'main'` is never routed (it's always the top-level Settings as-is)
 * since it's the primary user-facing chat loop.
 *
 * Pure and total: no chrome.* deps, never throws, and degrades to `settings`
 * unchanged whenever there's nothing to route to (no role mapping, no
 * matching profile, or the profile is gated out) — so a deployment with zero
 * profiles configured behaves exactly as it did before roles existed.
 *
 * `restrictBackgroundToLocal` is the privacy gate: a profile tagged
 * `privacyTier: 'cloud'` is skipped (falling back to main) rather than
 * routing background work off-device. `'local'` profiles and profiles with
 * no tier at all are conservatively treated as needing this same protection
 * — only an explicit `'local'` tag is exempt.
 */
/**
 * True when any message carries image content (an `image_url` content part).
 * The caller uses this to route an image-bearing model call to the vision
 * profile: once a snapshot/attachment is in the conversation, EVERY subsequent
 * request includes it, and a non-vision model rejects the whole request (HTTP
 * 400), so the call has to go to a model that can accept images. Pure.
 */
export function messagesContainImage(msgs: LlmMessage[]): boolean {
  return msgs.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'),
  );
}

export function resolveModelForRole(settings: Settings, role: ModelRole): Settings {
  if (role === 'main') return settings;
  const profileId = settings.roleProfiles?.[role];
  // Graph work historically used Utility. Preserve that routing unless the user
  // explicitly assigns the dedicated Knowledge Graph role.
  if (!profileId) return role === 'knowledgeGraph' ? resolveModelForRole(settings, 'utility') : settings;
  const profile = settings.modelProfiles?.find((p) => p.id === profileId);
  if (!profile) return settings;
  if (settings.restrictBackgroundToLocal && profile.privacyTier !== 'local') return settings;
  return {
    ...settings,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    protocol: profile.protocol,
    apiVersion: profile.apiVersion,
    temperature: profile.temperature ?? settings.temperature,
    maxTokens: profile.maxTokens ?? settings.maxTokens,
    graphWindowChars: profile.graphWindowChars ?? settings.graphWindowChars,
    graphExtractionStrategy: profile.graphExtractionStrategy ?? settings.graphExtractionStrategy,
    graphContextBefore: profile.graphContextBefore ?? settings.graphContextBefore,
    graphContextAfter: profile.graphContextAfter ?? settings.graphContextAfter,
    graphGleaningEnabled: profile.graphGleaningEnabled ?? settings.graphGleaningEnabled,
  };
}

/** Embed a batch of texts via the configured OpenAI-compatible /embeddings route. */
/**
 * Stable identity of the embedder a given Settings selects, stamped onto a repo
 * so we can refuse cross-model queries (vectors from different models aren't
 * comparable). Form: `local:<model>` or `external:<model>`.
 */
export function embedderId(settings: Settings): string {
  if (settings.embedder === 'external') {
    return `external:${settings.embeddingModel || settings.model}`;
  }
  return `local:${settings.localEmbedModel || DEFAULT_LOCAL_EMBED_MODEL}`;
}

/**
 * Embed text for RAG, routing to the on-device transformers.js model (default)
 * or the configured /embeddings endpoint based on `settings.embedder`. Both the
 * ingest and query paths go through this so a repo's vectors and its queries use
 * the same model. Throws on failure (the offscreen embedder or the network).
 */
export async function embedChunks(settings: Settings, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (settings.embedder === 'external') return embed(settings, texts, signal);
  const model = settings.localEmbedModel || DEFAULT_LOCAL_EMBED_MODEL;
  const res = signal ? await embedLocal(texts, model, signal) : await embedLocal(texts, model);
  if (!res.ok || !res.vectors) {
    throw new LlmError(`Local embedder failed: ${res.error ?? 'no vectors returned'}`);
  }
  return res.vectors;
}

export async function embed(settings: Settings, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { base, key } = resolve(settings, 'embedding');
  const version = apiVersion(settings);
  const url = buildUrl(base, '/embeddings', version);
  let response: Response;
  try {
    response = await requestWithRetry(
      (attemptSignal) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(key, version) },
          body: JSON.stringify({ model: settings.embeddingModel || settings.model, input: texts }),
          signal: attemptSignal,
        }),
      { enabled: settings.retryOnRateLimit ?? true, signal },
    );
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err;
    throw new LlmError(`Could not reach the embeddings endpoint (${url}): ${String(err)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(
      `Embeddings request failed (${response.status}). Does your endpoint expose /embeddings? ${text.slice(0, 300)}`,
    );
  }
  const data = (await response.json()) as { data?: Array<{ embedding: number[] }> };
  if (!data.data || data.data.length !== texts.length) {
    throw new LlmError('Embeddings endpoint returned an unexpected response.');
  }
  return data.data.map((d) => d.embedding);
}

/**
 * Transcribe recorded audio via the configured OpenAI-compatible
 * /audio/transcriptions route. `audioDataUrl` is a data: URL (e.g. recorded
 * audio/webm) which we turn back into a Blob for the multipart upload.
 */
export async function transcribe(settings: Settings, audioDataUrl: string, signal?: AbortSignal): Promise<string> {
  const model = settings.transcriptionModel;
  if (!model) {
    throw new LlmError('No transcription model configured. Set one in Settings to use voice prompts.');
  }
  const { base, key } = resolve(settings, 'transcription');
  const version = apiVersion(settings);
  const url = buildUrl(base, '/audio/transcriptions', version);
  const blob = await (await fetch(audioDataUrl)).blob();
  let response: Response;
  try {
    response = await requestWithRetry(
      (attemptSignal) => {
        // Rebuild the multipart body each attempt (a FormData stream is single-use).
        const form = new FormData();
        // OpenAI/Whisper-style endpoints infer the format from the filename extension.
        form.append('file', blob, 'audio.webm');
        form.append('model', model);
        // Do NOT set Content-Type — the runtime adds the multipart boundary.
        return fetch(url, { method: 'POST', headers: { ...authHeaders(key, version) }, body: form, signal: attemptSignal });
      },
      { enabled: settings.retryOnRateLimit ?? true, signal },
    );
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err;
    throw new LlmError(`Could not reach the transcription endpoint (${url}): ${String(err)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmError(
      `Transcription failed (${response.status}). Does your endpoint expose /audio/transcriptions and the model "${settings.transcriptionModel}"? ${text.slice(0, 300)}`,
    );
  }
  const data = (await response.json()) as { text?: string };
  return (data.text ?? '').trim();
}

/**
 * One chat-completion round-trip — the agent loop calls this once per step.
 *
 * Returns the assistant message, which may carry `tool_calls` (the loop then
 * executes them and calls back) or plain content (the final answer). `signal`
 * lets the runtime abort an in-flight request on stop/pause. An `AbortError`/
 * `TimeoutError` is rethrown as-is so the loop can distinguish cancellation
 * from a genuine endpoint failure (which becomes an `LlmError`).
 *
 * `responseFormat`, when given, asks the endpoint to guarantee its response
 * matches a JSON schema at the token level (see ResponseFormatSpec in
 * llmTypes.ts) — supported by Ollama, llama.cpp server, LM Studio, OpenAI,
 * and Gemini; the Anthropic adapter ignores it (no native equivalent). An
 * endpoint that doesn't recognize the field either ignores it silently
 * (today's prompt-based JSON instructions and the caller's own
 * truncated/unparseable-response recovery still apply unchanged) or rejects
 * the request outright — the latter is handled below by retrying once with
 * the field omitted, since a schema-supporting endpoint should never 4xx on
 * a well-formed schema call.
 */
export async function complete(
  settings: Settings,
  messages: LlmMessage[],
  tools?: ToolDefinition[],
  signal?: AbortSignal,
  onRetry?: RetryOpts['onRetry'],
  responseFormat?: ResponseFormatSpec,
): Promise<LlmResponseMessage> {
  const adapter = getAdapter(settings.protocol);
  let currentResponseFormat = responseFormat;
  let triedWithoutResponseFormat = false;

  // OpenRouter and other compatible gateways can report transient provider
  // failures inside an HTTP-200 response. Retry one such parsed failure; no
  // tool has executed yet, so replaying this completion is safe. The same
  // budget also covers the (mutually exclusive) responseFormat-rejected
  // fallback below — a genuinely flaky endpoint that ALSO doesn't support
  // responseFormat is a rare enough double-failure not worth a second budget.
  for (let parsedAttempt = 0; parsedAttempt < 2; parsedAttempt++) {
    const { url, headers, body } = adapter.buildRequest(settings, messages, tools, currentResponseFormat);
    let response: Response;
    try {
      response = await requestWithRetry(
        (attemptSignal) =>
          fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: attemptSignal,
          }),
        { enabled: settings.retryOnRateLimit ?? true, signal, onRetry },
      );
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw err;
      }
      throw new LlmError(
        `Could not reach the model endpoint (${settings.baseUrl}). ` +
          `If the endpoint blocks cross-origin requests, re-save settings to grant the extension access to it. (${String(err)})`,
      );
    }

    if (!response.ok) {
      if (currentResponseFormat && !triedWithoutResponseFormat && response.status >= 400 && response.status < 500) {
        triedWithoutResponseFormat = true;
        currentResponseFormat = undefined;
        continue;
      }
      const text = await response.text().catch(() => '');
      const isHtml = response.headers.get('Content-Type')?.includes('text/html') || /^\s*<!doctype html/i.test(text);
      const detail = isHtml ? 'The endpoint returned an HTML page instead of a model API response.' : text.slice(0, 500);
      throw new LlmError(`Model endpoint ${url} returned ${response.status}: ${detail}`);
    }

    try {
      const message = adapter.parseResponse(await response.json());
      if (!message.content?.trim() && (!message.tool_calls || message.tool_calls.length === 0)) {
        throw new LlmError('Model provider returned no usable text or tool call.', { retryable: true });
      }
      return message;
    } catch (err) {
      if (err instanceof LlmError && err.retryable && parsedAttempt === 0 && (settings.retryOnRateLimit ?? true)) continue;
      throw err;
    }
  }
  throw new LlmError('Model provider returned no usable response after retrying.');
}

/**
 * Settings-screen probe: a trivial one-shot completion that confirms the
 * endpoint, key, and model all work together. Never throws — it converts any
 * failure into `{ ok: false, detail }` for display.
 */
export async function testConnection(settings: Settings): Promise<{ ok: boolean; detail: string }> {
  try {
    // The probe should fail fast: no retries and a tiny deterministic completion,
    // since some local OpenAI-compatible servers default to very large outputs.
    // Reasoning-capable Gemini and Responses models need more than the legacy
    // eight-token probe (Responses also enforces a minimum of 16).
    const probeMaxTokens = settings.protocol === 'gemini-native' || settings.protocol === 'responses' ? 256 : 8;
    const message = await complete({ ...settings, retryOnRateLimit: false, temperature: 0, maxTokens: probeMaxTokens }, [
      { role: 'user', content: 'Reply with the single word: ok' },
    ]);
    return { ok: true, detail: `Connected. Model replied: ${(message.content ?? '').slice(0, 100)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
