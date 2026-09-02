// =============================================================================
// Provider-neutral interface for subscription-backed model connections
// (ChatGPT/Codex, GitHub Copilot, GitLab Duo, xAI/SuperGrok). This sits
// *alongside* the existing endpoint+API-key ProtocolAdapter layer
// (background/adapters/), not in place of it: a ProtocolAdapter is a
// stateless per-request wire-format translator, while a SubscriptionProvider
// owns an account connection's whole lifecycle — OAuth (or the truthful lack
// of one), token refresh, and the capabilities the UI should show for it.
//
// Every concrete provider (providers/githubCopilot.ts, gitlabDuo.ts,
// openaiChatgpt.ts, xaiGrok.ts) implements `SubscriptionProvider`. The rest of
// the extension (the Providers UI, serviceWorker message routing) only ever
// talks to this interface plus the static `ProviderDescriptor` capability
// flags in registry.ts — it must never branch on a specific provider id when
// a capability check on `ProviderCapabilities` would do instead.
// =============================================================================

import type { ProviderId } from '../../shared/providerIds';
export type { ProviderId };

/**
 * How a provider's connection is (or isn't) established. Matches the task's
 * decision taxonomy:
 *  - `oauth-device`: RFC 8628 device authorization grant (no redirect URI, no
 *    client secret) — used where the extension can't host a redirect page
 *    a public client can safely use, or where the official flow *is* device
 *    flow (GitHub).
 *  - `oauth-pkce`: Authorization Code + PKCE via chrome.identity.launchWebAuthFlow.
 *  - `api-key`: the user supplies a provider API key (billed separately from
 *    any chat subscription); always available as the documented fallback.
 *  - `local-companion`: inference (sometimes also auth) is delegated to a
 *    locally-installed native-messaging host running the provider's own
 *    officially-supported CLI/SDK, because the extension process cannot do it
 *    directly (e.g. no subprocess spawning in a service worker).
 *  - `unsupported`: no sanctioned third-party path exists today; the provider
 *    entry exists so the UI can say so truthfully instead of omitting it.
 */
export type AuthMode = 'oauth-device' | 'oauth-pkce' | 'api-key' | 'local-companion' | 'unsupported';

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'expired'
  | 'error'
  | 'unsupported';

/** Static, chrome-API-free capability flags — safe to import from UI code. */
export interface ProviderCapabilities {
  tools: boolean;
  images: boolean;
  reasoning: boolean;
  /** True token-level streaming vs. a single buffered "done" event. */
  streaming: boolean;
  authModes: AuthMode[];
}

/**
 * The task's `direct | local_companion | api_key_only | blocked` decision,
 * plus a one-line human-readable justification shown in the Providers UI so
 * a provider is never silently misrepresented as fully supported.
 */
export type ProviderDecision = 'direct' | 'local_companion' | 'api_key_only' | 'blocked';

export interface ConnectionStatusInfo {
  status: ConnectionStatus;
  /** Truthful, user-facing explanation — shown verbatim in the Providers UI. */
  detail?: string;
}

export interface AccountInfo {
  /** Short display label, e.g. a GitHub login or "OpenAI API key". */
  label: string;
  login?: string;
  organization?: string;
  /** Subscription/plan name when the provider exposes one (e.g. "Copilot Individual"). */
  plan?: string;
  note?: string;
}

export interface ProviderModelInfo {
  id: string;
  label: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsImages?: boolean;
}

export interface QuotaStatus {
  available: boolean;
  used?: number;
  limit?: number;
  unit?: string;
  resetAt?: string;
  /** Set when `available` is false — why quota isn't shown (no docs, needs admin scope, ...). */
  reason?: string;
}

/** One normalized chat message for a provider inference call (subset of the app's LlmMessage). */
export interface ProviderChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderCompletionRequest {
  messages: ProviderChatMessage[];
  model?: string;
  signal?: AbortSignal;
}

/** Normalized streaming/response events every provider's streamResponse() emits. */
export type ProviderStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

export class ProviderUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnsupportedError';
  }
}

export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

/**
 * The provider-neutral connection contract. `connect()` must only ever be
 * called from a user gesture (chrome.identity's interactive flows require
 * this); every method redacts credentials from any error it throws (see
 * providers/redact.ts).
 */
export interface SubscriptionProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  /**
   * Start (or, for device flow, kick off) an interactive sign-in. PKCE
   * providers complete entirely within this call. Device-flow providers
   * return immediately with a user code to display, and finish
   * asynchronously — `completeOAuthCallback()` reports that result.
   */
  connect(): Promise<{ verificationUri?: string; userCode?: string } | void>;

  /**
   * For device-flow providers: poll until the user has authorized (or the
   * attempt times out/is denied). For PKCE providers this is a no-op that
   * reports the already-established status (connect() finished the exchange
   * itself). Always safe to call after connect().
   */
  completeOAuthCallback(): Promise<void>;

  /** Revoke locally-held tokens (and, best-effort, ask the provider to revoke them too). */
  disconnect(): Promise<void>;

  getConnectionStatus(): Promise<ConnectionStatusInfo>;

  getAccountInfo(): Promise<AccountInfo | null>;

  listModels(): Promise<ProviderModelInfo[]>;

  /**
   * One chat completion, streamed. Providers without true streaming call
   * `onEvent` exactly once with `{type:'done', text}` (or `{type:'error'}`).
   * Returns the full text (same as the final 'done' event) for callers that
   * don't need incremental output.
   */
  streamResponse(request: ProviderCompletionRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<string>;

  abortResponse(): void;

  /** Refresh the stored access token if the provider supports refresh; no-op if not needed. */
  refreshAuthentication(): Promise<void>;

  /** Only implemented where the provider documents a usage/quota endpoint. */
  getQuotaStatus(): Promise<QuotaStatus>;
}
