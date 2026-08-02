// Community detection + rendering for GraphRAG "global" sensemaking. Pure and
// deterministic (no chrome/model), so it can be unit-tested and shared. Splits a
// DocGraph's entities into densely-connected clusters via label propagation — a
// dependency-free algorithm well suited to a browser-local graph — which the
// background then summarizes into per-cluster themes (grounded to sentence ids).

import type { CommunitySummary, DocGraph, GraphEdge, GraphNode } from './docGraph';

/** A raw (unsummarized) community: an id and its member node ids. */
export interface RawCommunity {
  id: string;
  nodeIds: string[];
}

/**
 * Partition the graph's nodes into communities with label propagation. Undirected
 * over the edge set; updates asynchronously in a stable node order with a
 * lexicographic tie-break, so the result is deterministic. Communities smaller
 * than `minSize` are dropped (singletons aren't themes) and the largest
 * `maxCommunities` are kept, ordered by size descending.
 */
export function detectCommunities(
  graph: DocGraph,
  opts: { minSize?: number; maxCommunities?: number } = {},
): RawCommunity[] {
  const minSize = opts.minSize ?? 2;
  const nodeIds = graph.nodes.map((n) => n.id).sort();
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set());
  for (const e of graph.edges) {
    if (e.from !== e.to && adj.has(e.from) && adj.has(e.to)) {
      adj.get(e.from)!.add(e.to);
      adj.get(e.to)!.add(e.from);
    }
  }

  const label = new Map<string, string>();
  for (const id of nodeIds) label.set(id, id);

  const MAX_ITER = 20;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let changed = false;
    for (const id of nodeIds) {
      const neighbors = adj.get(id)!;
      if (neighbors.size === 0) continue;
      const counts = new Map<string, number>();
      for (const nb of neighbors) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      // Most frequent neighbor label; ties → lexicographically smallest label.
      let best = label.get(id)!;
      let bestCount = -1;
      for (const [l, c] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (c > bestCount) {
          bestCount = c;
          best = l;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map<string, string[]>();
  for (const id of nodeIds) {
    const l = label.get(id)!;
    let g = groups.get(l);
    if (!g) groups.set(l, (g = []));
    g.push(id);
  }
  let comms = [...groups.values()].filter((c) => c.length >= minSize).sort((a, b) => b.length - a.length);
  if (opts.maxCommunities) comms = comms.slice(0, opts.maxCommunities);
  return comms.map((ids, i) => ({ id: `com${i}`, nodeIds: ids }));
}

const tag = (ids: string[]) => ids.map((id) => `[[${id}]]`).join(' ');

/**
 * Render one community's members and their internal relationships as
 * sentence-tagged lines, for the summarization model to theme + cite.
 */
export function renderCommunityForModel(graph: DocGraph, community: RawCommunity): { text: string; evidenceIds: string[] } {
  const members = new Set(community.nodeIds);
  const nodes = graph.nodes.filter((n) => members.has(n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges.filter((e) => members.has(e.from) && members.has(e.to));
  const evidence = new Set<string>();
  for (const n of nodes) n.evidenceSentenceIds.forEach((id) => evidence.add(id));
  for (const e of edges) e.evidenceSentenceIds.forEach((id) => evidence.add(id));

  const nodeLines = nodes.map((n) => `- ${n.label} (${n.type}): ${n.summary} ${tag(n.evidenceSentenceIds)}`.trim());
  const edgeLines = edges.map(
    (e) => `- ${byId.get(e.from)?.label ?? '?'} —${e.relation}→ ${byId.get(e.to)?.label ?? '?'} ${tag(e.evidenceSentenceIds)}`.trim(),
  );
  const parts: string[] = [];
  if (nodeLines.length) parts.push(`Entities:\n${nodeLines.join('\n')}`);
  if (edgeLines.length) parts.push(`Relationships:\n${edgeLines.join('\n')}`);
  return { text: parts.join('\n\n'), evidenceIds: [...evidence] };
}

/**
 * Render all community summaries as sentence-tagged lines for a corpus-level
 * (global) answer: the model synthesizes across themes and cites their evidence.
 */
export function renderCommunitiesForModel(communities: CommunitySummary[]): string {
  return communities
    .map((c) => `## ${c.title}\n${c.summary} ${tag(c.evidenceSentenceIds)}`.trim())
    .join('\n\n');
}

/** Convenience: the node objects belonging to a raw community. */
export function communityNodes(graph: DocGraph, community: RawCommunity): GraphNode[] {
  const members = new Set(community.nodeIds);
  return graph.nodes.filter((n) => members.has(n.id));
}

/** Convenience: the internal edges of a raw community. */
export function communityEdges(graph: DocGraph, community: RawCommunity): GraphEdge[] {
  const members = new Set(community.nodeIds);
  return graph.edges.filter((e) => members.has(e.from) && members.has(e.to));
}
