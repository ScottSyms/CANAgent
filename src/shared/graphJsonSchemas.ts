// JSON schemas for the knowledge-graph builder's three model-JSON call
// shapes, for use with a provider's constrained/structured-output field (see
// ResponseFormatSpec in src/background/llmTypes.ts and the per-protocol
// mapping in src/background/adapters/). When the configured endpoint
// supports schema-constrained decoding (Ollama, llama.cpp server, LM Studio,
// and many OpenAI-compatible cloud endpoints), this guarantees token-level
// valid JSON instead of just prompting for it — preventing the
// truncated/unparseable-response failure class rather than recovering from
// it after the fact (looksTruncated/extractWindowAdaptive in
// src/background/graphExtract.ts still run unconditionally on whatever comes
// back, so an endpoint that ignores or doesn't support this stays exactly as
// reliable as before, no worse).
//
// Deliberately plain `Record<string, unknown>` shapes (matching this
// codebase's existing ToolDefinition.function.parameters convention in
// src/background/llmTypes.ts) rather than a typed JSON-Schema DSL — three
// fixed, hand-written schemas don't need one, and staying untyped here means
// this stays dependency-free (importable from both background modules and,
// like src/shared/promptDefaults.ts, potentially UI code) without pulling in
// background-only types.

const STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const;

/** Matches DocExtraction (src/shared/docGraph.ts) — the shape extractOneDoc/extractGleaningPass/typeOneRelation's sibling extraction calls expect. */
export const DOC_EXTRACTION_SCHEMA = {
  name: 'doc_extraction',
  schema: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            type: { type: 'string' },
            summary: { type: 'string' },
            evidence: STRING_ARRAY,
          },
          required: ['label', 'type', 'summary', 'evidence'],
        },
      },
      relations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            relation: { type: 'string' },
            evidence: STRING_ARRAY,
          },
          required: ['from', 'to', 'relation', 'evidence'],
        },
      },
    },
    required: ['entities', 'relations'],
  },
};

/** Matches typeOneRelation's expected `{relation: string}` reply (src/background/graphExtract.ts). */
export const RELATION_TYPING_SCHEMA = {
  name: 'relation_typing',
  schema: {
    type: 'object',
    properties: {
      relation: { type: 'string' },
    },
    required: ['relation'],
  },
};

/** Matches summarizeOneCommunity's expected `{title, summary, evidence}` reply (src/background/graphExtract.ts). */
export const COMMUNITY_SUMMARY_SCHEMA = {
  name: 'community_summary',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      evidence: STRING_ARRAY,
    },
    required: ['title', 'summary', 'evidence'],
  },
};
