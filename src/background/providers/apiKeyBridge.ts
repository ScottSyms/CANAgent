// =============================================================================
// Shared plumbing for the two `blocked`-for-subscription-OAuth providers
// (OpenAI/ChatGPT, xAI/SuperGrok): both already work today with zero new
// network code, via the existing generic endpoint+API-key connection
// (Settings.baseUrl/apiKey or a ModelProfile) and the existing
// 'chat-completions' ProtocolAdapter — xAI's api.x.ai and OpenAI's
// api.openai.com are both OpenAI-compatible. This module just finds whichever
// configured connection (main Settings or a named ModelProfile) points at the
// provider's own API host, so the Providers UI can show real account/model
// info without asking the user to re-enter a key they already configured.
// =============================================================================

import type { ModelProfile, Settings } from '../../shared/types';

const SETTINGS_KEY = 'ba_settings';

async function rawSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return (r[SETTINGS_KEY] as Settings | undefined) ?? { baseUrl: '', apiKey: '', model: '' };
}

export interface ResolvedConnection {
  baseUrl: string;
  apiKey: string;
  model: string;
  source: 'main' | ModelProfile['name'];
}

function matchesHost(baseUrl: string, expectedHost: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === expectedHost.toLowerCase();
  } catch {
    return false;
  }
}

function usableKey(value: string | undefined): value is string {
  return Boolean(value && !value.startsWith('enc:v1:'));
}

/** Find the main Settings connection or first ModelProfile whose parsed hostname matches exactly. */
export async function findConnectionByHost(hostFragment: string): Promise<ResolvedConnection | null> {
  const settings = await rawSettings();
  if (matchesHost(settings.baseUrl, hostFragment) && usableKey(settings.apiKey)) {
    return { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, source: 'main' };
  }
  const profile = (settings.modelProfiles ?? []).find((p) => matchesHost(p.baseUrl, hostFragment) && usableKey(p.apiKey));
  if (profile) {
    return { baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model, source: profile.name };
  }
  return null;
}
