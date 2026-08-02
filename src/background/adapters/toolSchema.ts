import type { ToolDefinition } from '../llmTypes';

// =============================================================================
// Per-protocol translations of the ~60 tool definitions in shared/schemas.ts.
// Kept as a single small transform per protocol rather than duplicating the
// tool catalogue, so adding/editing a tool never needs a per-provider mirror.
// =============================================================================

/** OpenAI Responses API: flat `{type, name, description, parameters}` (no nested `function`). */
export interface ResponsesToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function toResponsesTools(tools: ToolDefinition[]): ResponsesToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

/** Anthropic Messages API: `{name, description, input_schema}` (no `type`/`function` wrapper). */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function toAnthropicTools(tools: ToolDefinition[]): AnthropicToolDef[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * Gemini's function-declaration parameters use a restricted JSON-Schema
 * dialect: it rejects keywords like `additionalProperties` that our OpenAI
 * schemas include. Strip them recursively rather than hand-maintaining a
 * parallel schema for every tool.
 */
const GEMINI_UNSUPPORTED_KEYS = new Set(['additionalProperties', '$schema', 'const']);

function stripForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripForGemini);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (GEMINI_UNSUPPORTED_KEYS.has(key)) continue;
      out[key] = stripForGemini(value);
    }
    return out;
  }
  return schema;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function toGeminiFunctionDeclarations(tools: ToolDefinition[]): GeminiFunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: stripForGemini(t.function.parameters) as Record<string, unknown>,
  }));
}
