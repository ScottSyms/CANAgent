import type { Settings } from '../../shared/types';
import { resolve } from '../llmNetwork';
import type { ContentPart, LlmMessage, LlmResponseMessage, LlmToolCall, ToolDefinition } from '../llmTypes';
import { LlmError } from '../llmTypes';
import { toAnthropicTools } from './toolSchema';
import type { AdapterRequest, ProtocolAdapter } from './types';

// =============================================================================
// Anthropic's /v1/messages API (Claude, and Qwen deployments that mirror it).
// Differences from /chat/completions this adapter bridges:
//  - No `system` role message: the system prompt is a top-level `system`
//    string field, so any `role: 'system'` messages are pulled out and joined.
//  - Auth is `x-api-key` + `anthropic-version` headers, not `Authorization:
//    Bearer` — Anthropic's Bearer scheme is reserved for OAuth, not API keys.
//  - `max_tokens` is *required* (no server-side default), so we fall back to
//    a reasonable default when the user hasn't set one.
//  - Tool calls are `tool_use` content blocks on an assistant message (not a
//    separate `tool_calls` field); tool results are `tool_result` content
//    blocks on a `user` message (not a `role: 'tool'` message) — Anthropic
//    also requires strictly alternating user/assistant turns, so consecutive
//    canonical `tool` messages (parallel tool calls) must merge into one
//    `user` turn with multiple `tool_result` blocks.
// =============================================================================

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string }
type AnthropicBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

/** `data:image/png;base64,AAAA` -> `{ mediaType: 'image/png', data: 'AAAA' }`. Falls back to jpeg if unparseable. */
function parseDataUrl(url: string): { mediaType: string; data: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : { mediaType: 'image/jpeg', data: url };
}

function toBlocks(content: ContentPart[]): AnthropicBlock[] {
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    const { mediaType, data } = parseDataUrl(p.image_url.url);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  });
}

function buildMessages(messages: LlmMessage[]): { system: string | undefined; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      continue;
    }

    if (m.role === 'tool') {
      const block: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      };
      // Consecutive tool results (parallel tool calls) merge into one user turn.
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    const blocks: AnthropicBlock[] = Array.isArray(m.content) ? toBlocks(m.content) : [];
    if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
    for (const tc of m.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks.length > 0 ? blocks : '' });
  }

  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: out };
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  buildRequest(settings: Settings, messages: LlmMessage[], tools?: ToolDefinition[]): AdapterRequest {
    const { system, messages: anthropicMessages } = buildMessages(messages);
    const body: Record<string, unknown> = {
      model: settings.model,
      max_tokens: settings.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: anthropicMessages,
    };
    if (system) body.system = system;
    if (tools && tools.length > 0) body.tools = toAnthropicTools(tools);
    if (settings.temperature !== undefined) body.temperature = settings.temperature;

    const { base, key } = resolve(settings, 'chat');
    return {
      url: `${base}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body,
    };
  },

  parseResponse(json: unknown): LlmResponseMessage {
    const data = json as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
    const blocks = data.content;
    if (!blocks || blocks.length === 0) throw new LlmError('Model endpoint returned no content.');

    let text = '';
    const toolCalls: LlmToolCall[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text) text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? '',
          type: 'function',
          function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
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
