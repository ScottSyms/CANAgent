// =============================================================================
// Canonical (protocol-agnostic) chat types shared by every provider adapter.
// Shaped after OpenAI's chat/completions message format since that was the
// extension's original (and still most common) wire format — each adapter in
// `adapters/` translates to/from this shape at the network boundary, so the
// agent loop and tool schemas never need to know which protocol is in play.
// =============================================================================

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Opaque Gemini reasoning state that must accompany the function call on the next turn. */
  thoughtSignature?: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ContentPart[];
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Requests schema-constrained/structured output from providers that support
 * it (OpenAI chat-completions/responses' `response_format`, Ollama's
 * OpenAI-compat layer, llama.cpp server, LM Studio, Gemini's
 * `responseSchema`) — the response is guaranteed to match `schema` at the
 * token level, instead of just being asked nicely to return JSON in a
 * prompt. `name` is required by some providers (OpenAI) to label the schema.
 * `schema` is a plain JSON Schema object (untyped here, matching
 * ToolDefinition.function.parameters's existing convention — see
 * src/shared/graphJsonSchemas.ts for the concrete schemas this app uses).
 * Optional per protocol: a protocol with no native constrained-decoding
 * mechanism (Anthropic Messages, as of this codebase's knowledge) ignores it
 * — see anthropicMessages.ts's buildRequest.
 */
export interface ResponseFormatSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface LlmResponseMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: LlmToolCall[];
}

export class LlmError extends Error {
  readonly retryable: boolean;
  /**
   * The model's raw (possibly truncated) response content, when an adapter
   * throws despite the provider having returned some usable text — e.g. a
   * chat-completions response with `finish_reason: 'length'`. Most callers
   * (the main chat/agent loop) have no use for a truncated reply and should
   * keep treating this as a hard failure; a caller that has its own
   * truncation-recovery logic (graphExtract.ts's extractOneDoc, which
   * classifies and adaptively retries a truncated response) can read this
   * instead of losing the content the provider did generate.
   */
  readonly content?: string | null;

  constructor(message: string, options?: { retryable?: boolean; content?: string | null }) {
    super(message);
    this.name = 'LlmError';
    this.retryable = options?.retryable ?? false;
    this.content = options?.content;
  }
}
