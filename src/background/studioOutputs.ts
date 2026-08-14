// Notebook "studio" — grounded generated documents (briefing / FAQ / study guide).
// Each is synthesized from the repository's knowledge graph (themes + key
// entities, already sentence-tagged), with inline [[sentence-id]] citations
// resolved for click-through and any unresolved ids stripped. Runs in the service
// worker; outputs are persisted per repo (studio.json) so they survive reopening.

import type { LlmMessage } from './llmProvider';
import { complete, resolveModelForRole } from './llmProvider';
import { renderSubgraphForModel, type DocGraph } from '../shared/docGraph';
import { renderCommunitiesForModel } from '../shared/graphCommunities';
import { citationIdsInReference, citationTokenRe, extractCitationIds } from '../shared/citations';
import { resolvePrompt, STUDIO_COMMON_TAIL } from '../shared/promptDefaults';
import { resolveSentenceCitations } from './sentenceResolve';
import { graphGet, studioGet, studioSet } from './offscreenClient';
import type { PromptKey, Settings, StudioDoc, StudioKind, StudioOutput } from '../shared/types';

const TOP_ENTITIES = 30;

/** Maps a studio output kind to its overridable prompt key (kept decoupled so they can diverge). */
const KIND_TO_PROMPT_KEY: Record<StudioKind, PromptKey> = {
  briefing: 'studioBriefing',
  faq: 'studioFaq',
  study_guide: 'studioStudyGuide',
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
    return citationIdsInReference(rawId)
      .filter((id) => validIds.has(id))
      .map((id) => `[[${id}]]`)
      .join(' ');
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

  // The kind-specific prompt is user-overridable; the grounding/citation tail
  // is always force-appended after it, so an override can't drop it.
  const systemPrompt = resolvePrompt(settings.promptOverrides, KIND_TO_PROMPT_KEY[kind]) + STUDIO_COMMON_TAIL;
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
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
  const setRes = await studioSet(repo, doc, graph.corpusRevision ?? 0);
  if (!setRes.ok) return { ok: false, error: setRes.error ?? 'Could not save this Studio output.' };

  return { ok: true, output };
}
