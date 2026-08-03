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

export interface LlmResponseMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: LlmToolCall[];
}

export class LlmError extends Error {}
