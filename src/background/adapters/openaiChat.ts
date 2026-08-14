import type { Settings } from '../../shared/types';
import { apiVersion, authHeaders, buildUrl, resolve } from '../llmNetwork';
import type { LlmMessage, LlmResponseMessage, ResponseFormatSpec, ToolDefinition } from '../llmTypes';
import { LlmError } from '../llmTypes';
import type { AdapterRequest, ProtocolAdapter } from './types';

interface CompatibleError {
  code?: number | string;
  message?: string;
  metadata?: {
    error_type?: string;
    provider_code?: string;
  };
}

interface ResponseContext {
  id?: string;
  model?: string;
  provider?: string;
}

const TRANSIENT_ERROR_TYPES = new Set([
  'rate_limit_exceeded',
  'provider_overloaded',
  'provider_unavailable',
  'timeout',
  'server',
  'unmapped',
]);

function isTransientError(error: CompatibleError): boolean {
  if (error.metadata?.error_type && TRANSIENT_ERROR_TYPES.has(error.metadata.error_type)) return true;
  const code = Number(error.code);
  return code === 408 || code === 429 || (code >= 500 && code <= 504);
}

function responseContext(context: ResponseContext): string {
  const details = [
    context.provider ? `provider ${context.provider}` : '',
    context.model ? `model ${context.model}` : '',
    context.id ? `generation ${context.id}` : '',
  ].filter(Boolean).join(', ');
  return details ? ` [${details}]` : '';
}

function providerError(error: CompatibleError, context: ResponseContext): LlmError {
  const details = [
    error.code !== undefined ? `code ${error.code}` : '',
    error.metadata?.error_type ?? '',
    error.metadata?.provider_code ? `provider code ${error.metadata.provider_code}` : '',
  ].filter(Boolean).join(', ');
  return new LlmError(
    `Model provider error${details ? ` (${details})` : ''}: ${error.message || 'No error details were returned.'}` +
      responseContext(context),
    { retryable: isTransientError(error) },
  );
}

// =============================================================================
// The original (and default) protocol: OpenAI's /chat/completions shape,
// which DeepSeek, GLM, MiniMax, Kimi, Ollama, vLLM, LM Studio, and Azure
// OpenAI all speak natively (Azure via its api-version/api-key quirks,
// handled by apiVersion()/buildUrl()/authHeaders() in llmNetwork.ts).
// =============================================================================

export const openaiChatAdapter: ProtocolAdapter = {
  buildRequest(settings: Settings, messages: LlmMessage[], tools?: ToolDefinition[], responseFormat?: ResponseFormatSpec): AdapterRequest {
    const body: Record<string, unknown> = {
      model: settings.model,
      messages,
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (settings.temperature !== undefined) body.temperature = settings.temperature;
    if (settings.maxTokens !== undefined) body.max_tokens = settings.maxTokens;
    // The shape Ollama's OpenAI-compat layer, llama.cpp server, vLLM, LM
    // Studio, and OpenAI itself have converged on. An endpoint that doesn't
    // recognize this field either ignores it (today's prompt-based JSON
    // instructions and looksTruncated/extractWindowAdaptive recovery still
    // apply unchanged) or 4xxs — see complete()'s fallback-without-schema
    // retry in llmProvider.ts.
    if (responseFormat) {
      body.response_format = { type: 'json_schema', json_schema: { name: responseFormat.name, strict: true, schema: responseFormat.schema } };
    }

    const { base, key } = resolve(settings, 'chat');
    const version = apiVersion(settings);
    return {
      url: buildUrl(base, '/chat/completions', version),
      headers: { 'Content-Type': 'application/json', ...authHeaders(key, version) },
      body,
    };
  },

  parseResponse(json: unknown): LlmResponseMessage {
    const data = json as {
      id?: string;
      model?: string;
      provider?: string;
      error?: CompatibleError;
      choices?: Array<{
        message?: LlmResponseMessage;
        finish_reason?: string | null;
        native_finish_reason?: string | null;
        error?: CompatibleError;
      }>;
    };
    if (data.error) throw providerError(data.error, data);
    const choice = data.choices?.[0];
    if (choice?.error) throw providerError(choice.error, data);
    const message = choice?.message;
    if (!message) throw new LlmError('Model endpoint returned no message.');
    const finish = choice?.finish_reason ?? 'unknown';
    const native = choice?.native_finish_reason;
    const reason = native && native !== finish ? `${finish}; provider: ${native}` : finish;
    if (finish === 'length') {
      throw new LlmError(
        `Model reached its output or context limit (finish reason: ${reason}). ` +
          'Increase Max tokens or reduce the conversation context and retry.' + responseContext(data),
        // Carry whatever content the model did produce — most callers have no
        // use for a truncated reply and should keep treating this as a hard
        // failure, but a caller with its own truncation-recovery logic (see
        // LlmError's content field) can still use it instead of losing it.
        { content: message.content },
      );
    }
    if (finish === 'content_filter') {
      throw new LlmError(
        `Model output was filtered (finish reason: ${reason}).` + responseContext(data),
      );
    }
    if (!message.content?.trim() && (!message.tool_calls || message.tool_calls.length === 0)) {
      throw new LlmError(
        `Model provider returned no usable content (finish reason: ${reason}).` + responseContext(data),
        { retryable: true },
      );
    }
    return message;
  },
};
