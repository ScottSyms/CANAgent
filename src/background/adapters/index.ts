import type { ModelProtocol } from '../../shared/types';
import { anthropicMessagesAdapter } from './anthropicMessages';
import { geminiNativeAdapter } from './geminiNative';
import { openaiChatAdapter } from './openaiChat';
import { openaiResponsesAdapter } from './openaiResponses';
import type { ProtocolAdapter } from './types';

export type { AdapterRequest, ProtocolAdapter } from './types';

const ADAPTERS: Record<ModelProtocol, ProtocolAdapter> = {
  'chat-completions': openaiChatAdapter,
  responses: openaiResponsesAdapter,
  'anthropic-messages': anthropicMessagesAdapter,
  'gemini-native': geminiNativeAdapter,
};

/** Absent/unrecognized protocol falls back to `'chat-completions'` — today's only behavior. */
export function getAdapter(protocol: ModelProtocol | undefined): ProtocolAdapter {
  return ADAPTERS[protocol ?? 'chat-completions'] ?? openaiChatAdapter;
}
