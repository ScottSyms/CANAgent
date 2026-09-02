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

export const GITLAB_DUO_CAPABILITIES: ProviderCapabilities = {
  tools: false,
  images: false,
  reasoning: false,
  streaming: false,
  authModes: ['unsupported'],
};

const BLOCKED_MESSAGE =
  'GitLab OAuth is documented, but CANChat has not verified a sanctioned third-party GitLab Duo inference transport. ' +
  'The previous aiAction/aiMessages GraphQL experiment is disabled until it can be verified with a Duo-enabled tenant or GitLab confirms the integration contract.';

export class GitLabDuoProvider implements SubscriptionProvider {
  readonly id = 'gitlab-duo' as const;
  readonly capabilities = GITLAB_DUO_CAPABILITIES;

  async connect(): Promise<void> {
    throw new ProviderUnsupportedError(BLOCKED_MESSAGE);
  }

  async completeOAuthCallback(): Promise<void> {
    throw new ProviderUnsupportedError(BLOCKED_MESSAGE);
  }

  async disconnect(): Promise<void> {}

  async getConnectionStatus(): Promise<ConnectionStatusInfo> {
    return { status: 'unsupported', detail: BLOCKED_MESSAGE };
  }

  async getAccountInfo(): Promise<AccountInfo | null> {
    return null;
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    return [];
  }

  async streamResponse(_request: ProviderCompletionRequest, onEvent: (event: ProviderStreamEvent) => void): Promise<string> {
    onEvent({ type: 'error', message: BLOCKED_MESSAGE });
    throw new ProviderUnsupportedError(BLOCKED_MESSAGE);
  }

  abortResponse(): void {}

  async refreshAuthentication(): Promise<void> {
    throw new ProviderUnsupportedError(BLOCKED_MESSAGE);
  }

  async getQuotaStatus(): Promise<QuotaStatus> {
    return { available: false, reason: BLOCKED_MESSAGE };
  }
}
