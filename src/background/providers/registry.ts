// =============================================================================
// The provider registry: static metadata (safe to import from UI code, no
// chrome.* deps) plus a factory for the live background implementation. The
// Providers UI renders entirely off `PROVIDER_DESCRIPTORS` + each provider's
// `capabilities` — it must never special-case a provider id when a
// capability/decision check would do instead.
// =============================================================================

import { GITHUB_COPILOT_CAPABILITIES, GitHubCopilotProvider } from './githubCopilot';
import { GITLAB_DUO_CAPABILITIES, GitLabDuoProvider } from './gitlabDuo';
import { OPENAI_CHATGPT_CAPABILITIES, OpenAiChatGptProvider } from './openaiChatgpt';
import type { ProviderCapabilities, ProviderDecision, ProviderId, SubscriptionProvider } from './types';
import { XAI_GROK_CAPABILITIES, XaiGrokProvider } from './xaiGrok';

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  /** Compact text mark used when no third-party image asset is bundled. */
  mark: string;
  decision: ProviderDecision;
  capabilities: ProviderCapabilities;
  /** One-line, user-facing justification for `decision` — always shown, so a provider is never silently overclaimed. */
  summary: string;
}

export const PROVIDER_DESCRIPTORS: Record<ProviderId, ProviderDescriptor> = {
  'github-copilot': {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    mark: 'GH',
    decision: 'local_companion',
    capabilities: GITHUB_COPILOT_CAPABILITIES,
    summary:
      'Sign-in and account info work directly (GitHub OAuth Device Flow). Chatting through Copilot itself requires installing a small local companion that runs GitHub\'s own Copilot SDK/CLI.',
  },
  'gitlab-duo': {
    id: 'gitlab-duo',
    name: 'GitLab Duo',
    mark: 'GL',
    decision: 'blocked',
    capabilities: GITLAB_DUO_CAPABILITIES,
    summary:
      'GitLab OAuth is documented, but no third-party Duo inference transport has been verified for CANChat. The experimental GraphQL path remains disabled.',
  },
  'openai-chatgpt': {
    id: 'openai-chatgpt',
    name: 'ChatGPT / Codex',
    mark: 'OA',
    decision: 'local_companion',
    capabilities: OPENAI_CHATGPT_CAPABILITIES,
    summary:
      'ChatGPT subscription access uses the official Codex App Server in a local companion. CANChat never receives Codex credentials. API-key access remains separately billed.',
  },
  'xai-grok': {
    id: 'xai-grok',
    name: 'xAI / SuperGrok',
    mark: 'xAI',
    decision: 'api_key_only',
    capabilities: XAI_GROK_CAPABILITIES,
    summary:
      'xAI documents API-key auth only; SuperGrok subscription OAuth is not an officially registrable third-party mechanism. Use an xAI API key instead (separate billing).',
  },
};

export function listProviderDescriptors(): ProviderDescriptor[] {
  return Object.values(PROVIDER_DESCRIPTORS);
}

// Singleton instances: OAuth device-flow/PKCE attempts and native-companion
// ports are stateful per provider, so the service worker should reuse one
// instance per id for the lifetime of that worker instance (a fresh instance
// after a worker restart is fine — in-flight sign-ins just have to be retried,
// same as any other in-memory state here).
let instances: Partial<Record<ProviderId, SubscriptionProvider>> | null = null;

export function getProvider(id: ProviderId): SubscriptionProvider {
  if (!instances) {
    instances = {
      'github-copilot': new GitHubCopilotProvider(),
      'gitlab-duo': new GitLabDuoProvider(),
      'openai-chatgpt': new OpenAiChatGptProvider(),
      'xai-grok': new XaiGrokProvider(),
    };
  }
  const provider = instances[id];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}
