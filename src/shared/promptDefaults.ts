// Default text for every user-editable feature prompt, plus the resolution
// logic that applies a settings.promptOverrides value in place of a default.
// Pure and dependency-free (no chrome/background APIs) so both the background
// modules that actually call the model AND the workspace Settings UI can import
// it directly — the background modules that own these prompts
// (notebookOverview.ts, graphExtract.ts, studioOutputs.ts) are service-worker
// bundles the UI can't import, so this is the single shared source of truth.
//
// Deliberately NOT covered here: the core agent system prompt and inline
// tool-behavior prompts (rerank, query-variant, reflection) in agentRuntime.ts —
// those stay hardcoded so an edit here can never silently break tool-calling or
// citation behavior.

import type { PromptKey } from './types';

/**
 * The shared tail every studio prompt ends with — always force-appended AFTER a
 * resolved (default-or-override) kind prompt, never itself overridable, so
 * grounding/citation behavior can't be silently disabled through the Prompts
 * settings tab.
 */
export const STUDIO_COMMON_TAIL =
  ' You are given the collection\'s themes and its key entities/relationships, each tagged with [[id]] evidence ' +
  'markers. Use ONLY that material. Cite supporting sentences inline by copying the [[id]] tokens verbatim right ' +
  'after the claims they support. Do not invent ids or facts. Output the Markdown only — no preamble or fences.';

export const DEFAULT_PROMPTS: Record<PromptKey, string> = {
  notebookOverview:
    'You are creating a "notebook" overview of a collection of documents for a reader who has not read them. ' +
    'Base everything ONLY on the provided document list and sample passages — do not invent facts. ' +
    'Return ONLY JSON in this exact shape: {"title": string, "overview": string, "keyTopics": string[], "suggestedQuestions": string[]}. ' +
    'title: a concise, descriptive, all-encompassing title (3–7 words) for this repository/notebook collection. ' +
    'overview: 2–4 short markdown paragraphs on what this collection is about, its main themes, and notable entities. ' +
    'keyTopics: 4–8 short topic labels (2–4 words each). ' +
    'suggestedQuestions: 4–6 specific questions a reader could ask that these documents can answer.',

  graphExtraction:
    'You extract a knowledge graph from ONE document. The document is given as a list of sentences, each prefixed ' +
    'with a [[id]] marker. Identify the key entities and the relationships between them, using ONLY the given text. ' +
    'For every entity and every relationship, cite the ids of the supporting sentences — the ids shown inside the ' +
    '[[ ]] markers, WITHOUT the brackets. Return ONLY JSON of the form: ' +
    '{"entities":[{"label":string,"type":string,"summary":string,"evidence":string[]}],' +
    '"relations":[{"from":string,"to":string,"relation":string,"evidence":string[]}]}. ' +
    'label = canonical entity name; type = short category (e.g. organization, system, person, concept); ' +
    'summary = one sentence; relation = short verb phrase; from/to = entity labels that appear in your entities list. ' +
    'Only cite ids that appear in the text; do not invent ids or facts.',

  communitySummary:
    'You summarize a cluster of related entities from a document corpus into a theme. The cluster is given as ' +
    'entities and relationships, each tagged with [[id]] evidence markers. Using ONLY the given text, return ONLY JSON: ' +
    '{"title":string,"summary":string,"evidence":string[]}. title = a short theme name (3–6 words). ' +
    'summary = 2–3 sentences on what this cluster is about and how its members relate. ' +
    'evidence = the ids (WITHOUT brackets) of the most important supporting sentences shown in the [[ ]] markers.',

  studioBriefing:
    'You write a concise briefing document (Markdown) about a document collection, for a reader who has not read it. ' +
    'Structure it as: a short intro paragraph; then "## Key themes"; then "## Key entities and relationships"; then ' +
    '"## Open questions".',

  studioFaq:
    'You write an FAQ (Markdown) about a document collection. Produce 6–10 question/answer pairs the collection can ' +
    'answer. Format each as "### <question>" followed by a concise answer.',

  studioStudyGuide:
    'You write a study guide (Markdown) about a document collection. Produce a "## Key concepts" section (each concept ' +
    'a **bold term** followed by a one-sentence explanation), then a "## Review questions" section with 5–8 questions.',
};

/**
 * Resolve the effective prompt text for `key`: the user's override when
 * present and non-blank, otherwise the built-in default. A whitespace-only
 * override falls back to the default rather than sending an empty/near-empty
 * system prompt, guarding against an accidentally-emptied textarea silently
 * disabling a feature's grounding instructions.
 */
export function resolvePrompt(overrides: Partial<Record<PromptKey, string>> | undefined, key: PromptKey): string {
  const v = overrides?.[key];
  return v && v.trim() ? v : DEFAULT_PROMPTS[key];
}

/**
 * Drop blank/whitespace-only entries from a promptOverrides map (so "reset to
 * default" truly removes the key rather than persisting an empty string), and
 * collapse an all-empty result to `undefined` so Settings stays tidy.
 */
export function pruneEmptyOverrides(
  overrides: Partial<Record<PromptKey, string>> | undefined,
): Partial<Record<PromptKey, string>> | undefined {
  if (!overrides) return undefined;
  const out: Partial<Record<PromptKey, string>> = {};
  for (const [key, value] of Object.entries(overrides) as [PromptKey, string | undefined][]) {
    if (value && value.trim()) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
