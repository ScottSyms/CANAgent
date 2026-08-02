import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../llmTypes';
import { toAnthropicTools, toGeminiFunctionDeclarations, toResponsesTools } from './toolSchema';

const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Search the web',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    },
  },
];

describe('toResponsesTools', () => {
  it('flattens function into a top-level type/name/description/parameters', () => {
    expect(toResponsesTools(tools)).toEqual([
      { type: 'function', name: 'search', description: 'Search the web', parameters: tools[0].function.parameters },
    ]);
  });
});

describe('toAnthropicTools', () => {
  it('renames parameters to input_schema with no type/function wrapper', () => {
    expect(toAnthropicTools(tools)).toEqual([
      { name: 'search', description: 'Search the web', input_schema: tools[0].function.parameters },
    ]);
  });
});

describe('toGeminiFunctionDeclarations', () => {
  it('strips additionalProperties recursively', () => {
    const [decl] = toGeminiFunctionDeclarations(tools);
    expect(decl.parameters).toEqual({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
  });
});
