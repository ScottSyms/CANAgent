import { findConnectionByHost } from './apiKeyBridge';
import { NativeCompanionClient } from './nativeMessagingClient';
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
import { ProviderAuthError } from './types';

const OPENAI_HOST = 'api.openai.com';
const CODEX_DISABLED_KEY = 'ba_provider_disabled_openai-chatgpt';
export const OPENAI_CODEX_NATIVE_HOST = 'com.canchat.codex_host';

export const OPENAI_CHATGPT_CAPABILITIES: ProviderCapabilities = {
  // The companion deliberately runs Codex read-only without ambient or dynamic
  // tools. CANChat must not claim tool support until calls can be relayed safely.
  tools: false,
  images: false,
  reasoning: true,
  streaming: true,
  authModes: ['local-companion', 'api-key'],
};

type CodexAccountStatus = {
  signedIn?: boolean;
  requiresOpenaiAuth?: boolean;
  account?: { type?: string; email?: string; planType?: string } | null;
};

export class OpenAiChatGptProvider implements SubscriptionProvider {
  readonly id = 'openai-chatgpt' as const;
  readonly capabilities = OPENAI_CHATGPT_CAPABILITIES;
  private companion = new NativeCompanionClient(OPENAI_CODEX_NATIVE_HOST);

  async connect(): Promise<void> {
    const status = (await this.companion.request('accountStatus', {}, undefined, { timeoutMs: 15_000 })) as CodexAccountStatus;
    if (!status.signedIn) {
      throw new ProviderAuthError(
        'The Codex companion is installed but Codex is not signed in. Run `npx codex login`, then reconnect.',
      );
    }
    await chrome.storage.local.remove(CODEX_DISABLED_KEY);
  }

  async completeOAuthCallback(): Promise<void> {
    await this.connect();
  }

  async disconnect(): Promise<void> {
    await chrome.storage.local.set({ [CODEX_DISABLED_KEY]: true });
    this.companion.disconnect();
  }

  async getConnectionStatus(): Promise<ConnectionStatusInfo> {
    const disabled = await chrome.storage.local.get(CODEX_DISABLED_KEY);
    if (disabled[CODEX_DISABLED_KEY] === true) {
      return { status: 'disconnected', detail: 'Disconnected from CANChat. Run `npx codex logout` to revoke the local Codex session itself.' };
    }
    try {
      const status = (await this.companion.request('accountStatus', {}, undefined, { timeoutMs: 10_000 })) as CodexAccountStatus;
      if (status.signedIn) return { status: 'connected' };
      return {
        status: 'disconnected',
        detail: 'Codex is not signed in. Run `npx codex login`; CANChat never reads or copies Codex credentials.',
      };
    } catch (error) {
      const apiKey = await findConnectionByHost(OPENAI_HOST);
      if (apiKey) return { status: 'connected', detail: `Using the "${apiKey.source}" API-key connection.` };
      return {
        status: 'disconnected',
        detail: /native|host|companion|unavailable/i.test(error instanceof Error ? error.message : String(error))
          ? 'Install the official Codex local companion, or configure an OpenAI API key with separate API billing.'
          : redact(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async refreshAuthentication(): Promise<void> {
    // account/read is the documented app-server status operation. Codex owns
    // managed ChatGPT token refresh and keeps tokens outside the extension.
    await this.connect();
  }

  async getAccountInfo(): Promise<AccountInfo | null> {
    if ((await chrome.storage.local.get(CODEX_DISABLED_KEY))[CODEX_DISABLED_KEY] === true) return null;
    try {
      const status = (await this.companion.request('accountStatus', {}, undefined, { timeoutMs: 10_000 })) as CodexAccountStatus;
      if (!status.signedIn) return null;
      return {
        label: status.account?.email || 'ChatGPT account',
        plan: status.account?.planType,
        note: 'Authentication and refresh are managed locally by the official Codex runtime; CANChat never receives its tokens.',
      };
    } catch {
      const conn = await findConnectionByHost(OPENAI_HOST);
      return conn ? { label: 'OpenAI API key', note: 'API-key billing is separate from a ChatGPT subscription.' } : null;
    }
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    if ((await chrome.storage.local.get(CODEX_DISABLED_KEY))[CODEX_DISABLED_KEY] === true) return [];
    try {
      const result = (await this.companion.request('listModels', {}, undefined, { timeoutMs: 30_000 })) as {
        models?: Array<{ id: string; label: string }>;
      };
      return result.models ?? [];
    } catch {
      const conn = await findConnectionByHost(OPENAI_HOST);
      if (!conn) return [];
      const response = await fetch(`${conn.baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${conn.apiKey}` },
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map(({ id }) => ({ id, label: id }));
    }
  }

  async streamResponse(request: ProviderCompletionRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<string> {
    if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    let full = '';
    const abort = () => this.companion.disconnect();
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = (await this.companion.request(
        'complete',
        { messages: request.messages, model: request.model },
        (text) => {
          full += text;
          onEvent({ type: 'delta', text });
        },
        { timeoutMs: 120_000, signal: request.signal },
      )) as { text?: string };
      const text = result.text ?? full;
      onEvent({ type: 'done', text });
      return text;
    } catch (error) {
      if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      const message = redact(error instanceof Error ? error.message : String(error));
      onEvent({ type: 'error', message });
      throw new Error(message);
    } finally {
      request.signal?.removeEventListener('abort', abort);
    }
  }

  abortResponse(): void {
    this.companion.disconnect();
  }

  async getQuotaStatus(): Promise<QuotaStatus> {
    try {
      const quota = (await this.companion.request('quota', {}, undefined, { timeoutMs: 15_000 })) as {
        available?: boolean;
        usedPercent?: number;
        resetsAt?: number;
        windowDurationMins?: number;
        limitName?: string;
        reached?: boolean;
      };
      if (!quota.available || typeof quota.usedPercent !== 'number') {
        return { available: false, reason: 'Codex did not return a rate-limit window for this account.' };
      }
      return {
        available: true,
        used: quota.usedPercent,
        limit: 100,
        unit: `% of ${quota.windowDurationMins ?? '?'} minute window`,
        resetAt: typeof quota.resetsAt === 'number' ? new Date(quota.resetsAt * 1000).toISOString() : undefined,
      };
    } catch {
      return { available: false, reason: 'Codex rate-limit status is unavailable.' };
    }
  }
}
