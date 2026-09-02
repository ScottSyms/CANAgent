// =============================================================================
// xAI/SuperGrok provider — subscription OAuth is `blocked`, not implemented.
//
// Why: xAI's official developer documentation (docs.x.ai) describes API-key
// authentication only, for the pay-per-token api.x.ai surface. The OAuth
// PKCE flow against accounts.x.ai that some third-party CLIs (OpenClaw,
// Hermes Agent, Kilo Code) use to let a SuperGrok/X Premium+ subscription pay
// for model calls is not documented by xAI as an independent third-party
// registration mechanism — it is the consumer login surface those tools have
// reverse-engineered, not something a new client can register itself against.
// Imitating that is exactly what this integration is required not to do, so
// this connection stays `blocked` rather than reverse-engineered, matching
// openaiChatgpt.ts's ChatGPT/Codex decision for the same underlying reason.
//
// What *is* supported: api.x.ai with a user-supplied API key, which is
// OpenAI-compatible and already fully working today via the existing generic
// Settings/ModelProfile connection and the 'chat-completions' ProtocolAdapter.
// This module adds nothing to that call path; it only surfaces model info for
// the Providers UI.
// =============================================================================

import { findConnectionByHost } from './apiKeyBridge';
import { redact } from './redact';
import type {
  AccountInfo,
  ConnectionStatusInfo,
  ProviderCapabilities,
  ProviderCompletionRequest,
  ProviderModelInfo,
  ProviderStreamEvent,
  QuotaStatus,
  SubscriptionProvider,
} from './types';
import { ProviderUnsupportedError } from './types';

const XAI_HOST = 'api.x.ai';

export const XAI_GROK_CAPABILITIES: ProviderCapabilities = {
  tools: true,
  images: true,
  reasoning: true,
  streaming: false, // this module never calls the model itself — see file header
  authModes: ['api-key'],
};

const UNSUPPORTED_MESSAGE =
  'xAI does not document a third-party OAuth registration path for SuperGrok/X Premium+ subscription access. ' +
  'Add an xAI API key instead: Settings → Models, base URL https://api.x.ai/v1. ' +
  'Note: API-key usage is billed separately from a SuperGrok/X Premium+ subscription.';

export class XaiGrokProvider implements SubscriptionProvider {
  readonly id = 'xai-grok' as const;
  readonly capabilities = XAI_GROK_CAPABILITIES;

  async connect(): Promise<void> {
    throw new ProviderUnsupportedError(UNSUPPORTED_MESSAGE);
  }

  async completeOAuthCallback(): Promise<void> {
    throw new ProviderUnsupportedError(UNSUPPORTED_MESSAGE);
  }

  async disconnect(): Promise<void> {
    // Nothing is stored by this provider (see file header) — nothing to clear.
  }

  async getConnectionStatus(): Promise<ConnectionStatusInfo> {
    const conn = await findConnectionByHost(XAI_HOST);
    return conn
      ? { status: 'connected', detail: `Using the "${conn.source}" API-key connection.` }
      : { status: 'unsupported', detail: UNSUPPORTED_MESSAGE };
  }

  async refreshAuthentication(): Promise<void> {
    // API keys don't expire/refresh.
  }

  async getAccountInfo(): Promise<AccountInfo | null> {
    const conn = await findConnectionByHost(XAI_HOST);
    if (!conn) return null;
    return {
      label: 'xAI API key',
      note: 'API-key billing — not tied to a SuperGrok/X Premium+ subscription.',
    };
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    const conn = await findConnectionByHost(XAI_HOST);
    if (!conn) return [];
    const res = await fetch(`${conn.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${conn.apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Could not list xAI models (HTTP ${res.status}): ${redact(text.slice(0, 200))}`);
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => ({ id: m.id, label: m.id }));
  }

  async streamResponse(_request: ProviderCompletionRequest, _onEvent: (event: ProviderStreamEvent) => void): Promise<string> {
    throw new ProviderUnsupportedError(
      'Use the existing Models settings (or a Model Profile) to chat with xAI — this provider entry only surfaces account/model info.',
    );
  }

  abortResponse(): void {
    // No in-flight call owned by this provider.
  }

  async getQuotaStatus(): Promise<QuotaStatus> {
    return {
      available: false,
      reason: 'xAI does not expose per-key usage/quota via a documented endpoint reachable with a plain API key.',
    };
  }
}
