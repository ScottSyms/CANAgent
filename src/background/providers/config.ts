// =============================================================================
// Read-only access to the provider-connection config fields on Settings
// (client IDs, instance URL) without going through storage.ts's `getSettings`,
// which gates on a fully-configured main model (baseUrl+apiKey+model) and
// vault-decrypts secrets this module doesn't need. A user can connect a
// subscription provider with no main model configured at all, so this reads
// the raw record directly — same approach as sidebar/MailboxSection.tsx uses
// for `graphClientId`.
// =============================================================================

import { DEFAULT_GITLAB_INSTANCE } from '../../shared/gitlabDuoAuth';
import type { Settings } from '../../shared/types';

const SETTINGS_KEY = 'ba_settings';

type ProviderConfigFields = Pick<Settings, 'githubCopilotClientId' | 'gitlabInstanceUrl' | 'gitlabDuoClientId'>;

async function rawSettings(): Promise<ProviderConfigFields> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return (r[SETTINGS_KEY] as ProviderConfigFields | undefined) ?? {};
}

export async function githubCopilotClientId(): Promise<string> {
  return (await rawSettings()).githubCopilotClientId?.trim() ?? '';
}

export async function gitlabInstanceUrl(): Promise<string> {
  return (await rawSettings()).gitlabInstanceUrl?.trim() || DEFAULT_GITLAB_INSTANCE;
}

export async function gitlabDuoClientId(): Promise<string> {
  return (await rawSettings()).gitlabDuoClientId?.trim() ?? '';
}
