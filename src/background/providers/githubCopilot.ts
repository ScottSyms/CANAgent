// =============================================================================
// GitHub Copilot subscription provider — `direct` for authentication (OAuth
// Device Flow, a publicly documented, no-redirect-URI, no-client-secret
// mechanism: https://docs.github.com/en/apps/oauth-apps), `local_companion`
// for inference.
//
// Why inference needs a companion: GitHub's officially-supported way to call
// Copilot programmatically is the Copilot SDK (`@github/copilot-sdk`), which
// talks JSON-RPC to a spawned `copilot` CLI process. A Chrome MV3 service
// worker cannot spawn subprocesses, and Copilot's actual completions endpoint
// is not otherwise publicly documented for direct HTTP use by third-party
// clients (the endpoints some community tools call directly, e.g.
// api.individual.githubcopilot.com, are undocumented and explicitly out of
// scope for this integration). So: the OAuth token is obtained directly here,
// then handed to a locally-installed native-messaging host
// (companion/github-copilot-host/) that runs the real SDK/CLI and streams
// results back over chrome.runtime.connectNative. See docs/providers.md for
// installation.
// =============================================================================

import {
  buildDeviceCodeBody,
  buildDevicePollBody,
  buildRefreshBody,
  classifyDevicePollError,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_TOKEN_URL,
  type DeviceCodeResponse,
  type DeviceTokenResponse,
} from '../../shared/githubCopilotAuth';
import { githubCopilotClientId } from './config';
import { NativeCompanionClient } from './nativeMessagingClient';
import { redact, redactedError } from './redact';
import { clearToken, isExpired, loadToken, saveToken, type StoredProviderTokens } from './tokenStore';
import type {
  AccountInfo,
  ConnectionStatusInfo,
  ProviderCapabilities,
  ProviderChatMessage,
  ProviderCompletionRequest,
  ProviderModelInfo,
  ProviderStreamEvent,
  QuotaStatus,
  SubscriptionProvider,
} from './types';
import { ProviderAuthError, ProviderUnsupportedError } from './types';
import { requestWithRetry } from '../llmNetwork';

export const GITHUB_COPILOT_NATIVE_HOST = 'com.canchat.github_copilot_host';

export const GITHUB_COPILOT_CAPABILITIES: ProviderCapabilities = {
  tools: false,
  images: false,
  reasoning: true,
  streaming: true, // via the native companion; not directly from the extension
  authModes: ['oauth-device', 'local-companion'],
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** In-memory only: a device-flow attempt in progress. Lost on service-worker restart — the user retries Connect. */
let pendingDevice: { deviceCode: string; interval: number; expiresAt: number } | null = null;
let pollAbort: AbortController | null = null;
let refreshInFlight: Promise<void> | null = null;

export class GitHubCopilotProvider implements SubscriptionProvider {
  readonly id = 'github-copilot' as const;
  readonly capabilities = GITHUB_COPILOT_CAPABILITIES;
  private companion = new NativeCompanionClient(GITHUB_COPILOT_NATIVE_HOST);

  async connect(): Promise<{ verificationUri?: string; userCode?: string }> {
    const clientId = await githubCopilotClientId();
    if (!clientId) {
      throw new ProviderUnsupportedError(
        'Set a GitHub OAuth App Client ID in Settings → Models → Providers first. See docs/providers.md for how to register one.',
      );
    }
    let res: Response;
    try {
      res = await requestWithRetry(
        (signal) => fetch(GITHUB_DEVICE_CODE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: buildDeviceCodeBody(clientId),
          signal,
        }),
        { enabled: true },
      );
    } catch (err) {
      throw redactedError(`Could not reach GitHub (${String(err)}).`);
    }
    const data = (await res.json().catch(() => ({}))) as Partial<DeviceCodeResponse> & { error?: string; error_description?: string };
    if (!res.ok || !data.device_code || !data.user_code || !data.verification_uri) {
      throw redactedError(data.error_description || data.error || `GitHub device authorization request failed (HTTP ${res.status}).`);
    }
    pendingDevice = {
      deviceCode: data.device_code,
      interval: Math.max(5, data.interval ?? 5),
      expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
    };
    return { verificationUri: data.verification_uri, userCode: data.user_code };
  }

  /**
   * Poll the token endpoint until the user finishes authorizing on
   * github.com/login/device, the attempt expires, or it is cancelled.
   * Must be called after connect(); safe to call again if a previous poll's
   * caller navigated away (idempotent against the same pendingDevice).
   */
  async completeOAuthCallback(): Promise<void> {
    const clientId = await githubCopilotClientId();
    const pending = pendingDevice;
    if (!clientId || !pending) {
      throw new Error('No sign-in in progress. Click Connect first.');
    }
    pollAbort = new AbortController();
    const signal = pollAbort.signal;
    try {
      while (Date.now() < pending.expiresAt) {
        if (signal.aborted) throw new Error('Sign-in was cancelled.');
        await sleep(pending.interval * 1000);
        let res: Response;
        try {
          res = await requestWithRetry(
            (attemptSignal) => fetch(GITHUB_TOKEN_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
              body: buildDevicePollBody(clientId, pending.deviceCode),
              signal: attemptSignal,
            }),
            { enabled: true, signal },
          );
        } catch (err) {
          throw redactedError(`Could not reach GitHub (${String(err)}).`);
        }
        const data = (await res.json().catch(() => ({}))) as DeviceTokenResponse;
        if (data.access_token) {
          const tokens: StoredProviderTokens = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            tokenType: data.token_type,
            scope: data.scope,
            expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 - 60_000 : undefined,
          };
          await saveToken('github-copilot', tokens);
          pendingDevice = null;
          return;
        }
        if (data.error) {
          const kind = classifyDevicePollError(data.error);
          if (kind === 'pending') continue;
          if (kind === 'slow_down') {
            pending.interval += 5;
            continue;
          }
          pendingDevice = null;
          throw redactedError(data.error_description || `GitHub sign-in ${data.error === 'expired_token' ? 'expired' : data.error === 'access_denied' ? 'was denied' : 'failed'}.`);
        }
      }
      pendingDevice = null;
      throw new Error('GitHub sign-in timed out. Click Connect and try again.');
    } finally {
      pollAbort = null;
    }
  }

  async disconnect(): Promise<void> {
    // GitHub OAuth App user tokens can only be revoked server-side with a
    // client secret (DELETE /applications/{client_id}/token, Basic-auth'd).
    // This is a public (secretless) client, so no remote revoke call is made —
    // clearing the local token is what "disconnect" means here. Documented in
    // docs/providers.md.
    pollAbort?.abort();
    pendingDevice = null;
    await clearToken('github-copilot');
    this.companion.disconnect();
  }

  async getConnectionStatus(): Promise<ConnectionStatusInfo> {
    const tokens = await loadToken('github-copilot');
    if (!tokens) return { status: 'disconnected' };
    if (isExpired(tokens) && !tokens.refreshToken) {
      return { status: 'expired', detail: 'Sign in again to continue using your Copilot subscription.' };
    }
    return { status: 'connected' };
  }

  async refreshAuthentication(): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = this.refreshAuthenticationOnce();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  private async refreshAuthenticationOnce(): Promise<void> {
    const tokens = await loadToken('github-copilot');
    if (!tokens || !isExpired(tokens)) return;
    if (!tokens.refreshToken) {
      throw new ProviderAuthError('GitHub session expired and no refresh token is available — reconnect.');
    }
    const refreshToken = tokens.refreshToken;
    const clientId = await githubCopilotClientId();
    const res = await requestWithRetry(
      (signal) => fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: buildRefreshBody(clientId, refreshToken),
        signal,
      }),
      { enabled: true },
    );
    const data = (await res.json().catch(() => ({}))) as DeviceTokenResponse;
    if (!res.ok || !data.access_token) {
      throw redactedError(data.error_description || 'GitHub token refresh failed — reconnect.');
    }
    await saveToken('github-copilot', {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      tokenType: data.token_type,
      scope: data.scope,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 - 60_000 : undefined,
    });
  }

  async getAccountInfo(): Promise<AccountInfo | null> {
    const tokens = await loadToken('github-copilot');
    if (!tokens) return null;
    const res = await requestWithRetry(
      (signal) => fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/vnd.github+json' },
        signal,
      }),
      { enabled: true },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw redactedError(`Could not read GitHub account info (HTTP ${res.status}): ${redact(text.slice(0, 200))}`);
    }
    const data = (await res.json()) as { login?: string; name?: string };
    return {
      label: data.name || data.login || 'GitHub account',
      login: data.login,
      note:
        'GitHub does not expose an individual Copilot seat/plan lookup via public REST for a personal OAuth token — only org admins can query org-level seat assignments.',
    };
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    const tokens = await loadToken('github-copilot');
    if (!tokens) return [];
    try {
      const result = (await this.companion.request('listModels', { accessToken: tokens.accessToken })) as { models?: ProviderModelInfo[] };
      return result.models ?? [];
    } catch {
      return [];
    }
  }

  async streamResponse(request: ProviderCompletionRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<string> {
    const tokens = await loadToken('github-copilot');
    if (!tokens) throw new ProviderAuthError('Connect your GitHub Copilot subscription first.');
    let full = '';
    if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    const abort = () => this.companion.disconnect();
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = (await this.companion.request(
        'complete',
        { accessToken: tokens.accessToken, messages: toPlainMessages(request.messages), model: request.model },
        (delta) => {
          full += delta;
          onEvent({ type: 'delta', text: delta });
        },
      )) as { text?: string };
      const text = result.text ?? full;
      onEvent({ type: 'done', text });
      return text;
    } catch (err) {
      if (request.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      const message =
        err instanceof Error && /native messaging is unavailable|disconnected/i.test(err.message)
          ? 'The GitHub Copilot local companion is not installed or not running. See docs/providers.md to install it.'
          : redact(err instanceof Error ? err.message : String(err));
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
    return {
      available: false,
      reason: 'GitHub does not publish a per-user Copilot usage/quota endpoint for personal OAuth tokens.',
    };
  }
}

function toPlainMessages(messages: ProviderChatMessage[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}
