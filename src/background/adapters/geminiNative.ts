import type { Settings } from '../../shared/types';
import { resolve } from '../llmNetwork';
import type { ContentPart, LlmMessage, LlmResponseMessage, LlmToolCall, ToolDefinition } from '../llmTypes';
import { LlmError } from '../llmTypes';
import { toGeminiFunctionDeclarations } from './toolSchema';
import type { AdapterRequest, ProtocolAdapter } from './types';

// =============================================================================
// Gemini's native `generateContent` endpoint. Differences from
// /chat/completions this adapter bridges:
//  - No `system`/`assistant`/`tool` roles: only `user` and `model`. The system
//    prompt becomes a top-level `systemInstruction`; assistant -> `model`.
//  - Messages are `contents[].parts[]`, not a flat message list; a tool call is
//    a `functionCall` part on a `model` turn, and a tool result is a
//    `functionResponse` part on a `user` turn (keyed by function *name*, not a
//    call id — Gemini has no call-id concept on the wire).
//  - Auth via the `x-goog-api-key` header; the model id is baked into the URL
//    path (`/{version}/models/{model}:generateContent`), not the request body.
//  - Since our canonical `LlmToolCall.id` has no Gemini equivalent, this
//    adapter invents one per response (`call_<index>_<name>`) and resolves it
//    back to a function name by scanning the full message history for the
//    matching `tool_calls` entry when building the next request's
//    `functionResponse`.
// =============================================================================

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
  thoughtSignature?: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function parseDataUrl(url: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return match ? { mimeType: match[1], data: match[2] } : { mimeType: 'image/jpeg', data: url };
}

function buildGeminiUrl(base: string, model: string): string {
  const versionedBase = /\/v1(?:beta)?$/.test(base) ? base : `${base}/v1beta`;
  return `${versionedBase}/models/${encodeURIComponent(model)}:generateContent`;
}

function toParts(content: ContentPart[]): GeminiPart[] {
  return content.map((p) => {
    if (p.type === 'text') return { text: p.text };
    const { mimeType, data } = parseDataUrl(p.image_url.url);
    return { inlineData: { mimeType, data } };
  });
}

/** Map a canonical tool_call_id back to the function name Gemini needs for functionResponse. */
function functionNameForCallId(messages: LlmMessage[], callId: string | undefined): string {
  if (!callId) return '';
  for (const m of messages) {
    const match = m.tool_calls?.find((tc) => tc.id === callId);
    if (match) return match.function.name;
  }
  return '';
}

function buildContents(messages: LlmMessage[]): { systemInstruction: GeminiContent | undefined; contents: GeminiContent[] } {
  const systemParts: GeminiPart[] = [];
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content) systemParts.push({ text: m.content });
      continue;
    }

    if (m.role === 'tool') {
      const part: GeminiPart = {
        functionResponse: {
          name: functionNameForCallId(messages, m.tool_call_id),
          response: { result: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') },
        },
      };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user') last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      continue;
    }

    const parts: GeminiPart[] = Array.isArray(m.content) ? toParts(m.content) : [];
    if (typeof m.content === 'string' && m.content) parts.push({ text: m.content });
    for (const tc of m.tool_calls ?? []) {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      parts.push({
        functionCall: { name: tc.function.name, args },
        ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
      });
    }
    if (parts.length > 0) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }

  return {
    systemInstruction: systemParts.length > 0 ? { role: 'user', parts: systemParts } : undefined,
    contents,
  };
}

export const geminiNativeAdapter: ProtocolAdapter = {
  buildRequest(settings: Settings, messages: LlmMessage[], tools?: ToolDefinition[]): AdapterRequest {
    const { systemInstruction, contents } = buildContents(messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (tools && tools.length > 0) body.tools = [{ functionDeclarations: toGeminiFunctionDeclarations(tools) }];
    const generationConfig: Record<string, unknown> = {};
    if (settings.temperature !== undefined) generationConfig.temperature = settings.temperature;
    if (settings.maxTokens !== undefined) generationConfig.maxOutputTokens = settings.maxTokens;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    const { base, key } = resolve(settings, 'chat');
    return {
      url: buildGeminiUrl(base, settings.model),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body,
    };
  },

  parseResponse(json: unknown): LlmResponseMessage {
    const data = json as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name: string; args: unknown };
            thoughtSignature?: string;
          }>;
        };
        finishReason?: string;
        finishMessage?: string;
      }>;
      promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
    };
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!parts || parts.length === 0) {
      if (data.promptFeedback?.blockReason) {
        const message = data.promptFeedback.blockReasonMessage ? `: ${data.promptFeedback.blockReasonMessage}` : '';
        throw new LlmError(`Gemini blocked the prompt (${data.promptFeedback.blockReason})${message}`);
      }
      if (candidate?.finishReason === 'MAX_TOKENS') {
        throw new LlmError('Gemini reached the maximum output token limit before returning visible content. Increase Max tokens and retry.');
      }
      if (candidate?.finishReason) {
        const message = candidate.finishMessage ? `: ${candidate.finishMessage}` : '';
        throw new LlmError(`Gemini returned no content (finish reason: ${candidate.finishReason})${message}`);
      }
      if (!candidate) throw new LlmError('Gemini returned no candidates.');
      throw new LlmError('Gemini returned a candidate with no content.');
    }

    let text = '';
    const toolCalls: LlmToolCall[] = [];
    parts.forEach((part, i) => {
      if (part.text) text += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${i}_${part.functionCall.name}`,
          type: 'function',
          function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      }
    });
    return {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  },
};
