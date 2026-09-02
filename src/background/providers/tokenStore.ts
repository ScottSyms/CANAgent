// =============================================================================
// Token storage for subscription-provider connections. Same trust level and
// storage area as the existing Microsoft Graph tokens (background/graphAuth.ts):
// chrome.storage.local, never chrome.storage.sync — a refresh token must never
// leave the device via Chrome's account sync. See docs/providers.md "Threat
// model" for what this does and does not protect against.
//
// Tokens are NOT run through the optional encryption vault (vault.ts) today:
// that vault only wraps the fields on the single `Settings` record. Wiring
// provider tokens through it too is a reasonable follow-up (tracked in
// docs/providers.md) but out of scope here — this module is the one place
// that would need to change to add it, since every provider goes through
// `loadToken`/`saveToken` below rather than touching chrome.storage directly.
// =============================================================================

import type { ProviderId } from './types';

export interface StoredProviderTokens {
  schemaVersion?: 1;
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  /** Epoch ms when the access token expires (already padded early), or undefined = non-expiring. */
  expiresAt?: number;
  /** Provider-specific extra fields (e.g. GitHub's device-flow interval). */
  extra?: Record<string, unknown>;
}

function key(id: ProviderId): string {
  return `ba_provider_tokens_${id}`;
}

export async function loadToken(id: ProviderId): Promise<StoredProviderTokens | null> {
  const k = key(id);
  const r = await chrome.storage.local.get(k);
  const value = r[k] as Partial<StoredProviderTokens> | undefined;
  if (!value) return null;
  if (typeof value.accessToken !== 'string' || value.accessToken.length === 0 || value.accessToken.length > 64 * 1024) {
    await chrome.storage.local.remove(k);
    return null;
  }
  if (value.refreshToken !== undefined && typeof value.refreshToken !== 'string') {
    await chrome.storage.local.remove(k);
    return null;
  }
  // Records created before schemaVersion shipped have the same fields. Stamp
  // the version lazily so upgrades are idempotent and service-worker safe.
  if (value.schemaVersion !== 1) {
    const migrated = { ...value, schemaVersion: 1 as const } as StoredProviderTokens;
    await chrome.storage.local.set({ [k]: migrated });
    return migrated;
  }
  return value as StoredProviderTokens;
}

export async function saveToken(id: ProviderId, tokens: StoredProviderTokens): Promise<void> {
  await chrome.storage.local.set({ [key(id)]: { ...tokens, schemaVersion: 1 } });
}

export async function clearToken(id: ProviderId): Promise<void> {
  await chrome.storage.local.remove(key(id));
}

export function isExpired(tokens: StoredProviderTokens): boolean {
  return typeof tokens.expiresAt === 'number' && Date.now() >= tokens.expiresAt;
}
