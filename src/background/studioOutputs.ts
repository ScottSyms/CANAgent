// Notebook "studio" — grounded generated documents (briefing / FAQ / study guide).
// Each is synthesized from the repository's knowledge graph (themes + key
// entities, already sentence-tagged), with inline [[sentence-id]] citations
// resolved for click-through and any unresolved ids stripped. Runs in the service
// worker; outputs are persisted per repo (studio.json) so they survive reopening.

import type { LlmMessage } from './llmProvider';
import { complete, resolveModelForRole } from './llmProvider';
import { renderSubgraphForModel, type DocGraph } from '../shared/docGraph';
import { renderCommunitiesForModel } from '../shared/graphCommunities';
import { citationTokenRe, extractCitationIds } from '../shared/citations';
import { resolveSentenceCitations } from './sentenceResolve';
import { graphGet, studioGet, studioSet } from './offscreenClient';
import type { Settings, StudioDoc, StudioKind, StudioOutput } from '../shared/types';

const TOP_ENTITIES = 30;

const COMMON_TAIL =
  ' You are given the collection\'s themes and its key entities/relationships, each tagged with [[id]] evidence ' +
  'markers. Use ONLY that material. Cite supporting sentences inline by copying the [[id]] tokens verbatim right ' +
  'after the claims they support. Do not invent ids or facts. Output the Markdown only — no preamble or fences.';

const KIND_PROMPTS: Record<StudioKind, string> = {
  briefing:
    'You write a concise briefing document (Markdown) about a document collection, for a reader who has not read it. ' +
    'Structure it as: a short intro paragraph; then "## Key themes"; then "## Key entities and relationships"; then ' +
    '"## Open questions".' +
    COMMON_TAIL,
  faq:
    'You write an FAQ (Markdown) about a document collection. Produce 6–10 question/answer pairs the collection can ' +
    'answer. Format each as "### <question>" followed by a concise answer.' +
    COMMON_TAIL,
  study_guide:
    'You write a study guide (Markdown) about a document collection. Produce a "## Key concepts" section (each concept ' +
    'a **bold term** followed by a one-sentence explanation), then a "## Review questions" section with 5–8 questions.' +
    COMMON_TAIL,
};

const KIND_TITLES: Record<StudioKind, (repo: string) => string> = {
  briefing: (r) => `Briefing — ${r}`,
  faq: (r) => `FAQ — ${r}`,
  study_guide: (r) => `Study guide — ${r}`,
};

/** Render the graph's highest-degree entities (and edges among them). */
function renderTopEntities(graph: DocGraph, max = TOP_ENTITIES): string {
  const deg = new Map<string, number>();
  for (const e of graph.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  const top = [...graph.nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).slice(0, max);
  const ids = new Set(top.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return renderSubgraphForModel({ nodes: top, edges });
}

/** Assemble the sentence-tagged source material a studio output is synthesized from. */
export function buildStudioContext(graph: DocGraph): string {
  const parts: string[] = [];
  if (graph.communities && graph.communities.length > 0) {
    parts.push(`Themes:\n${renderCommunitiesForModel(graph.communities)}`);
  }
  parts.push(renderTopEntities(graph));
  return parts.join('\n\n');
}

/** Strip [[id]] tokens whose id didn't resolve (fabricated/stale); keep valid ones. */
export function cleanCitations(markdown: string, validIds: Set<string>): string {
  return markdown.replace(citationTokenRe(), (_whole, rawId: string) => {
    const id = rawId.trim();
    return validIds.has(id) ? `[[${id}]]` : '';
  });
}

export interface StudioResult {
  ok: boolean;
  output?: StudioOutput;
  error?: string;
}

/** Generate a grounded studio output of `kind` for a repository, and persist it. */
export async function generateStudioOutput(
  settings: Settings,
  repo: string,
  kind: StudioKind,
  signal?: AbortSignal,
): Promise<StudioResult> {
  const gRes = await graphGet(repo);
  const graph = gRes.ok ? (gRes.result as DocGraph | null) : null;
  if (!graph || graph.nodes.length === 0) {
    return { ok: false, error: 'Build the knowledge graph for this notebook first — studio outputs are generated from it.' };
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: KIND_PROMPTS[kind] },
    { role: 'user', content: buildStudioContext(graph) },
  ];
  let content: string | null;
  try {
    const reply = await complete(resolveModelForRole(settings, 'utility'), messages, undefined, signal);
    content = reply.content;
  } catch (e) {
    return { ok: false, error: `Studio generation failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const markdown = (content ?? '').trim();
  if (!markdown) return { ok: false, error: 'The model returned an empty document.' };

  const citations = await resolveSentenceCitations(repo, extractCitationIds(markdown));
  const valid = new Set(citations.map((c) => c.sentenceId));
  const output: StudioOutput = {
    kind,
    title: KIND_TITLES[kind](repo),
    markdown: cleanCitations(markdown, valid),
    citations,
    generatedAt: new Date().toISOString(),
  };

  // Persist alongside any other studio outputs for this repo.
  const docRes = await studioGet(repo);
  const doc = ((docRes.ok ? docRes.result : null) as StudioDoc | null) ?? { outputs: {} };
  doc.outputs = { ...doc.outputs, [kind]: output };
  await studioSet(repo, doc);

  return { ok: true, output };
}
