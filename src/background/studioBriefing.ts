// Notebook "studio" — grounded briefing document. Synthesizes a readable briefing
// (Markdown) about a repository from its knowledge graph (themes + key entities),
// with inline [[sentence-id]] citations resolved for click-through. Runs in the
// service worker. The briefing is derived from the graph, so it inherits the
// graph's grounding: every cited claim traces to an exact source sentence.

import type { LlmMessage } from './llmProvider';
import { complete, resolveModelForRole } from './llmProvider';
import { renderSubgraphForModel, type DocGraph } from '../shared/docGraph';
import { renderCommunitiesForModel } from '../shared/graphCommunities';
import { citationTokenRe, extractCitationIds } from '../shared/citations';
import { resolveSentenceCitations } from './sentenceResolve';
import { graphGet } from './offscreenClient';
import type { Briefing, Settings } from '../shared/types';

const TOP_ENTITIES = 30;

const BRIEFING_SYSTEM_PROMPT =
  'You write a concise briefing document (Markdown) about a document collection, for a reader who has not read it. ' +
  'You are given the collection\'s themes and its key entities/relationships, each tagged with [[id]] evidence markers. ' +
  'Using ONLY that material, write: a short intro paragraph; then "## Key themes"; then "## Key entities and ' +
  'relationships"; then "## Open questions". Cite supporting sentences inline by copying the [[id]] tokens verbatim ' +
  'right after the claims they support. Do not invent ids or facts. Output the Markdown only — no preamble or fences.';

/** Render the graph's highest-degree entities (and edges among them) for the briefing. */
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

/** Assemble the sentence-tagged source material a briefing is synthesized from. */
export function buildBriefingContext(graph: DocGraph): string {
  const parts: string[] = [];
  if (graph.communities && graph.communities.length > 0) {
    parts.push(`Themes:\n${renderCommunitiesForModel(graph.communities)}`);
  }
  parts.push(renderTopEntities(graph));
  return parts.join('\n\n');
}

/** Strip [[id]] tokens whose id didn't resolve (fabricated/stale); keep valid ones. */
export function cleanBriefingCitations(markdown: string, validIds: Set<string>): string {
  return markdown.replace(citationTokenRe(), (_whole, rawId: string) => {
    const id = rawId.trim();
    return validIds.has(id) ? `[[${id}]]` : '';
  });
}

export interface BriefingResult {
  ok: boolean;
  briefing?: Briefing;
  error?: string;
}

/** Generate a grounded briefing for a repository from its knowledge graph. */
export async function generateBriefing(settings: Settings, repo: string, signal?: AbortSignal): Promise<BriefingResult> {
  const gRes = await graphGet(repo);
  const graph = gRes.ok ? (gRes.result as DocGraph | null) : null;
  if (!graph || graph.nodes.length === 0) {
    return { ok: false, error: 'Build the knowledge graph for this notebook first — the briefing is generated from it.' };
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: BRIEFING_SYSTEM_PROMPT },
    { role: 'user', content: buildBriefingContext(graph) },
  ];
  let content: string | null;
  try {
    const reply = await complete(resolveModelForRole(settings, 'utility'), messages, undefined, signal);
    content = reply.content;
  } catch (e) {
    return { ok: false, error: `Briefing generation failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const markdown = (content ?? '').trim();
  if (!markdown) return { ok: false, error: 'The model returned an empty briefing.' };

  // Ground the briefing: resolve cited ids, drop any that don't resolve.
  const citations = await resolveSentenceCitations(repo, extractCitationIds(markdown));
  const valid = new Set(citations.map((c) => c.sentenceId));
  return {
    ok: true,
    briefing: {
      title: `Briefing — ${repo}`,
      markdown: cleanBriefingCitations(markdown, valid),
      citations,
      generatedAt: new Date().toISOString(),
    },
  };
}
