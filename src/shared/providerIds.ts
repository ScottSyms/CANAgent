// The four subscription-provider ids, shared between the UI-facing message
// protocol (shared/messages.ts) and the background provider implementation
// (background/providers/types.ts) so there is exactly one definition.
export type ProviderId = 'github-copilot' | 'gitlab-duo' | 'openai-chatgpt' | 'xai-grok';

export const PROVIDER_IDS = ['github-copilot', 'gitlab-duo', 'openai-chatgpt', 'xai-grok'] as const;

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}
