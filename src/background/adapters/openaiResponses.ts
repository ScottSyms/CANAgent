import type { Settings } from '../../shared/types';
import { resolve } from '../llmNetwork';
import type { ContentPart, LlmMessage, LlmResponseMessage, LlmToolCall, ResponseFormatSpec, ToolDefinition } from '../llmTypes';
import { LlmError } from '../llmTypes';
import { toResponsesTools } from './toolSchema';
import type { AdapterRequest, ProtocolAdapter } from './types';

// =============================================================================
// OpenAI's /responses API (GPT-5.x, Grok). Unlike /chat/completions, the
// request uses `input` (an array of typed Items, not `messages`) and the
// response uses `output` (typed Items, not `choices`). Tool calls/results are
// their own top-level Item types (`function_call` / `function_call_output`)
// keyed by `call_id`, rather than assistant `tool_calls` + a `role: 'tool'`
// message. This extension is stateless per request (no `previous_response_id`
// state on OpenAI's servers) so the *entire* conversation is replayed as
// `input` Items on every call, same as /chat/completions replays `messages`.
// =============================================================================

interface ResponsesContentPart {
  type: 'input_text' | 'output_text' | 'input_image';
  text?: string;
  image_url?: string;
}

interface ResponsesInputItem {
  type?: 'message' | 'function_call' | 'function_call_output';
  role?: 'system' | 'user' | 'assistant';
  content?: ResponsesContentPart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

function toContentParts(content: string | null | ContentPart[], textType: 'input_text' | 'output_text'): ResponsesContentPart[] {
  if (content === null) return [];
  if (typeof content === 'string') return content ? [{ type: textType, text: content }] : [];
  return content.map((p) =>
    p.type === 'image_url'
      ? { type: 'input_image' as const, image_url: p.image_url.url }
      : { type: textType, text: p.text },
  );
}

function buildInput(messages: LlmMessage[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      continue;
    }
    const textType = m.role === 'assistant' ? 'output_text' : 'input_text';
    const content = toContentParts(m.content, textType);
    if (content.length > 0) {
      items.push({ type: 'message', role: m.role, content });
    }
    for (const tc of m.tool_calls ?? []) {
      items.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
    }
  }
  return items;
}

export const openaiResponsesAdapter: ProtocolAdapter = {
  buildRequest(settings: Settings, messages: LlmMessage[], tools?: ToolDefinition[], responseFormat?: ResponseFormatSpec): AdapterRequest {
    const body: Record<string, unknown> = {
      model: settings.model,
      input: buildInput(messages),
    };
    if (tools && tools.length > 0) body.tools = toResponsesTools(tools);
    // Reasoning-capable Responses models may reject `temperature`; it is optional.
    if (settings.maxTokens !== undefined) body.max_output_tokens = settings.maxTokens;
    // /responses uses `text.format`, a different key/shape than /chat/completions' `response_format`.
    if (responseFormat) {
      body.text = { format: { type: 'json_schema', name: responseFormat.name, schema: responseFormat.schema, strict: true } };
    }

    const { base, key } = resolve(settings, 'chat');
    return {
      url: `${base}/responses`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body,
    };
  },

  parseResponse(json: unknown): LlmResponseMessage {
    const data = json as {
      output?: Array<{
        type: string;
        content?: Array<{ type: string; text?: string }>;
        call_id?: string;
        name?: string;
        arguments?: string;
      }>;
    };
    const output = data.output;
    if (!output || output.length === 0) throw new LlmError('Model endpoint returned no output.');

    let text = '';
    const toolCalls: LlmToolCall[] = [];
    for (const item of output) {
      if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && part.text) text += part.text;
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id ?? '',
          type: 'function',
          function: { name: item.name ?? '', arguments: item.arguments ?? '{}' },
        });
      }
    }
    return {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  },
};
