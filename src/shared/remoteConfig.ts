// Central configuration from a URL: fetch a JSON document and apply only a
// fixed, reviewable allowlist of non-secret Settings fields, with a
// field-level diff the caller must present to the user before applying.
//
// Security boundary (deliberately conservative — this is an ALLOWLIST, never a
// blocklist): every field NOT in REMOTE_CONFIG_ALLOWED_KEYS is silently
// dropped, so a compromised/malicious config URL can never set baseUrl,
// apiKey, or any other endpoint/credential field — it can only ever repoint
// requests to already-configured, already-trusted infrastructure. See the
// plan doc for the full field-by-field rationale.

import type { Settings } from './types';

export const REMOTE_CONFIG_ALLOWED_KEYS = [
  'temperature',
  'maxTokens',
  'repoSearchK',
  'hybridSearch',
  'graphAssistedSearch',
  'maxSteps',
  'model',
  'systemPrompt',
  'promptOverrides',
  'retryOnRateLimit',
  'summarizeObservations',
  'verifyAnswers',
  'restrictBackgroundToLocal',
  'localEmbedModel',
] as const satisfies readonly (keyof Settings)[];

export type RemoteConfigKey = (typeof REMOTE_CONFIG_ALLOWED_KEYS)[number];

/**
 * Filter an arbitrary parsed JSON payload down to only the allowlisted
 * Settings fields. Anything else present in the payload — including
 * baseUrl/apiKey/modelProfiles and any unrecognized key — is dropped, never
 * applied. Tolerant of malformed input (non-object, null, primitives).
 */
export function pickAllowedRemoteConfigFields(json: unknown): Partial<Settings> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const out: Partial<Settings> = {};
  const src = json as Record<string, unknown>;
  for (const key of REMOTE_CONFIG_ALLOWED_KEYS) {
    if (key in src) (out as Record<string, unknown>)[key] = src[key];
  }
  return out;
}

/** Keys present in the raw payload that were NOT applied (for a transparency note in the UI). */
export function droppedRemoteConfigKeys(json: unknown): string[] {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
  const allowed = new Set<string>(REMOTE_CONFIG_ALLOWED_KEYS);
  return Object.keys(json as Record<string, unknown>).filter((k) => !allowed.has(k));
}

export interface ConfigDiffEntry {
  key: RemoteConfigKey;
  before: unknown;
  after: unknown;
}

/** Field-level before/after diff for the allowed fields that would actually change. */
export function diffRemoteConfig(current: Settings, incoming: Partial<Settings>): ConfigDiffEntry[] {
  const diffs: ConfigDiffEntry[] = [];
  for (const key of Object.keys(incoming) as RemoteConfigKey[]) {
    const before = current[key];
    const after = incoming[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) diffs.push({ key, before, after });
  }
  return diffs;
}

/** Config URLs must be https:// — no plaintext transport, no javascript:/data: schemes. */
export function isSafeConfigUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Fetch and parse a remote config JSON document. `fetchImpl` is injectable for testing. */
export async function fetchRemoteConfigJson(url: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (!isSafeConfigUrl(url)) throw new Error('Config URL must use https://.');
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`.trim());
  return res.json();
}
