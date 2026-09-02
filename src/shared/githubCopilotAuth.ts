// =============================================================================
// Pure helpers for GitHub's OAuth Device Authorization Grant (RFC 8628), the
// mechanism GitHub documents for public clients that cannot host a redirect
// URI or hold a client secret — https://docs.github.com/en/apps/oauth-apps.
// No chrome.*/network here (unit-testable); background/providers/githubCopilot.ts
// does the interactive polling loop and token storage.
//
// This is a *separate*, independently-registered GitHub OAuth App's client
// ID (configured by whoever runs this build — see docs/providers.md) — never
// the Copilot CLI's or OpenCode's client ID. A GitHub-issued user access
// token from this flow is billed to the authenticated user's own Copilot
// subscription (Individual/Business/Enterprise), per GitHub's Copilot SDK
// documentation.
// =============================================================================

export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Minimal scope: Copilot SDK authenticates as the user; no repo/org scope is requested by default. */
export const DEFAULT_GITHUB_SCOPE = '';

export function buildDeviceCodeBody(clientId: string, scope = DEFAULT_GITHUB_SCOPE): string {
  const b = new URLSearchParams();
  b.set('client_id', clientId);
  if (scope) b.set('scope', scope);
  return b.toString();
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export function buildDevicePollBody(clientId: string, deviceCode: string): string {
  const b = new URLSearchParams();
  b.set('client_id', clientId);
  b.set('device_code', deviceCode);
  b.set('grant_type', GITHUB_DEVICE_GRANT_TYPE);
  return b.toString();
}

export function buildRefreshBody(clientId: string, refreshToken: string): string {
  const b = new URLSearchParams();
  b.set('client_id', clientId);
  b.set('refresh_token', refreshToken);
  b.set('grant_type', 'refresh_token');
  return b.toString();
}

export interface DeviceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'unsupported_grant_type' | string;
  error_description?: string;
}

/** RFC 8628 §3.5 error handling: which poll errors mean "keep polling" vs "stop". */
export function classifyDevicePollError(error: string): 'pending' | 'slow_down' | 'stop' {
  if (error === 'authorization_pending') return 'pending';
  if (error === 'slow_down') return 'slow_down';
  return 'stop';
}
