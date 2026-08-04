import type { Settings } from '../shared/types';

// =============================================================================
// Protocol-agnostic network plumbing shared by every adapter: retry/backoff,
// endpoint resolution (chat/embedding/transcription overrides), and the Azure
// URL/auth-header quirks that predate the multi-protocol adapter layer. None
// of this depends on a request/response *shape* — it only moves bytes.
// =============================================================================

/** Per-attempt request timeout. Exported so the runtime's timeout message matches. */
export const LLM_TIMEOUT_MS = 120000;
const RETRY_MAX_ATTEMPTS = 6; // initial try + up to 5 retries
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const RETRY_AFTER_CAP_MS = 60000;

export interface RetryOpts {
  /** When false, no retries — fail on the first response (e.g. the Settings probe). */
  enabled: boolean;
  /** Caller cancellation (the task's abort controller); also interrupts backoff. */
  signal?: AbortSignal;
  /** Called before each backoff wait, so the UI can show "retrying in Ns". */
  onRetry?: (info: { attempt: number; delayMs: number; status: number }) => void;
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 504);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) to ms, capped. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  if (Number.isFinite(secs)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, secs * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, date - Date.now()));
  return null;
}

/** Retry-After if the server gave one, else exponential backoff with full jitter. */
function backoffDelay(attempt: number, header: string | null): number {
  const fromHeader = parseRetryAfter(header);
  if (fromHeader !== null) return fromHeader;
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

/** Sleep that rejects (with the signal's reason) if the signal aborts first. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `makeRequest` with a per-attempt timeout, retrying transient failures
 * (429 / 5xx) with backoff. Returns the final Response — the caller still
 * inspects `!res.ok` and throws its own LlmError. AbortError/TimeoutError from a
 * request (caller Stop or the per-attempt timeout) propagate without retry.
 */
export async function requestWithRetry(
  makeRequest: (signal: AbortSignal) => Promise<Response>,
  opts: RetryOpts,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const perAttempt = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)])
      : AbortSignal.timeout(LLM_TIMEOUT_MS);
    const res = await makeRequest(perAttempt);
    if (res.ok || !opts.enabled || !isRetryable(res.status) || attempt >= RETRY_MAX_ATTEMPTS - 1) {
      return res;
    }
    const delayMs = backoffDelay(attempt, res.headers.get('Retry-After'));
    opts.onRetry?.({ attempt: attempt + 1, delayMs, status: res.status });
    // Discard the error body so the connection can be reused, then wait.
    await res.body?.cancel().catch(() => {});
    await abortableSleep(delayMs, opts.signal);
  }
}

/**
 * Resolve the base URL and API key for a given service. Embeddings and
 * transcription can each override the primary endpoint/key; blank falls back.
 */
export function resolve(settings: Settings, kind: 'chat' | 'embedding' | 'transcription'): {
  base: string;
  key: string;
} {
  const base =
    kind === 'embedding'
      ? settings.embeddingBaseUrl
      : kind === 'transcription'
        ? settings.transcriptionBaseUrl
        : undefined;
  const key =
    kind === 'embedding'
      ? settings.embeddingApiKey
      : kind === 'transcription'
        ? settings.transcriptionApiKey
        : undefined;
  return {
    base: (base?.trim() || settings.baseUrl).replace(/\/+$/, ''),
    key: key?.trim() || settings.apiKey,
  };
}

/**
 * Azure mode is keyed entirely off `apiVersion`: Azure OpenAI rejects any
 * request lacking the api-version query param, so its presence is the cleanest
 * signal that the user is on Azure. Returns the version string or undefined for
 * a standard OpenAI-compatible endpoint. Only meaningful for the
 * chat-completions/embeddings/transcription protocol — other protocols ignore it.
 */
export function apiVersion(settings: Settings): string | undefined {
  return settings.apiVersion?.trim() || undefined;
}

/**
 * Append `?api-version=…` when on Azure. The per-service base URL already points
 * at the Azure deployment (…/openai/deployments/{name}), so we only add the
 * route suffix and the query string here.
 */
export function buildUrl(base: string, path: string, version: string | undefined): string {
  const url = base + path;
  return version ? `${url}?api-version=${encodeURIComponent(version)}` : url;
}

/**
 * Azure authenticates API keys with the `api-key` header; standard OpenAI uses
 * `Authorization: Bearer`. (Azure's Bearer scheme is reserved for Entra ID
 * tokens, which this extension does not issue.)
 */
export function authHeaders(key: string, version: string | undefined): Record<string, string> {
  if (!key) return {};
  return version ? { 'api-key': key } : { Authorization: `Bearer ${key}` };
}
