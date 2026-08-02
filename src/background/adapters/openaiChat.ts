import type { Settings } from '../../shared/types';
import { apiVersion, authHeaders, buildUrl, resolve } from '../llmNetwork';
import type { LlmMessage, LlmResponseMessage, ToolDefinition } from '../llmTypes';
import { LlmError } from '../llmTypes';
import type { AdapterRequest, ProtocolAdapter } from './types';

// =============================================================================
// The original (and default) protocol: OpenAI's /chat/completions shape,
// which DeepSeek, GLM, MiniMax, Kimi, Ollama, vLLM, LM Studio, and Azure
// OpenAI all speak natively (Azure via its api-version/api-key quirks,
// handled by apiVersion()/buildUrl()/authHeaders() in llmNetwork.ts).
// =============================================================================

export const openaiChatAdapter: ProtocolAdapter = {
  buildRequest(settings: Settings, messages: LlmMessage[], tools?: ToolDefinition[]): AdapterRequest {
    const body: Record<string, unknown> = {
      model: settings.model,
      messages,
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (settings.temperature !== undefined) body.temperature = settings.temperature;
    if (settings.maxTokens !== undefined) body.max_tokens = settings.maxTokens;

    const { base, key } = resolve(settings, 'chat');
    const version = apiVersion(settings);
    return {
      url: buildUrl(base, '/chat/completions', version),
      headers: { 'Content-Type': 'application/json', ...authHeaders(key, version) },
      body,
    };
  },

  parseResponse(json: unknown): LlmResponseMessage {
    const data = json as { choices?: Array<{ message?: LlmResponseMessage }> };
    const message = data.choices?.[0]?.message;
    if (!message) throw new LlmError('Model endpoint returned no message.');
    return message;
  },
};
