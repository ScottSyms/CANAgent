// Pure graph-to-chunk candidate ranking for graph-assisted RAG. The graph never
// becomes answer text here: its grounded sentence ids only nominate current
// repository chunks for later fusion and reranking.

import type { DocGraph, GraphEdge, GraphNode } from './docGraph';
import { tokenize } from './keywordSearch';
import type { ChunkInput } from './vectorSearch';

export interface GraphRankedChunk {
  i: number;
  score: number;
}

export interface GraphRetrievalOptions {
  seedLimit?: number;
  edgeLimitPerSeed?: number;
  candidateLimit?: number;
}

const DEFAULT_SEED_LIMIT = 8;
const DEFAULT_EDGE_LIMIT = 5;
const DEFAULT_CANDIDATE_LIMIT = 50;

function terms(text: string): Set<string> {
  return new Set(tokenize(text));
}

function overlap(query: Set<string>, text: string): number {
  let score = 0;
  for (const term of terms(text)) if (query.has(term)) score++;
  return score;
}

function exactPhrase(query: string, value: string): boolean {
  const q = query.toLowerCase();
  const v = value.trim().toLowerCase();
  return v.length > 0 && q.includes(v);
}

function nodeRelevance(node: GraphNode, query: string, queryTerms: Set<string>): number {
  let score = overlap(queryTerms, node.label) * 4;
  if (exactPhrase(query, node.label)) score += 8;
  for (const alias of node.aliases) {
    score += overlap(queryTerms, alias) * 3;
    if (exactPhrase(query, alias)) score += 7;
  }
  score += overlap(queryTerms, node.summary);
  score += overlap(queryTerms, node.type);
  return score;
}

/**
 * Rank current repository chunks using grounded graph evidence. Seed entities
 * are selected lexically, then a bounded set of incident relations contributes
 * edge and one-hop-neighbor evidence. Community evidence contributes at a lower
 * weight. Missing sentence ids are ignored, which prevents stale graph claims
 * from creating candidates.
 */
export function rankGraphEvidence(
  graph: DocGraph,
  query: string,
  chunks: ChunkInput[],
  options: GraphRetrievalOptions = {},
): GraphRankedChunk[] {
  const queryTerms = terms(query);
  if (queryTerms.size === 0 || graph.nodes.length === 0 || chunks.length === 0) return [];

  const seedLimit = Math.min(DEFAULT_SEED_LIMIT, Math.max(1, options.seedLimit ?? DEFAULT_SEED_LIMIT));
  const edgeLimit = Math.min(DEFAULT_EDGE_LIMIT, Math.max(0, options.edgeLimitPerSeed ?? DEFAULT_EDGE_LIMIT));
  const candidateLimit = Math.min(DEFAULT_CANDIDATE_LIMIT, Math.max(1, options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodeOrder = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const edgeOrder = new Map(graph.edges.map((edge, i) => [edge.id, i]));

  const seeds = graph.nodes
    .map((node) => ({ node, score: nodeRelevance(node, query, queryTerms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || (nodeOrder.get(a.node.id) ?? 0) - (nodeOrder.get(b.node.id) ?? 0))
    .slice(0, seedLimit);
  if (seeds.length === 0) return [];

  const sentenceToChunk = new Map<string, number>();
  chunks.forEach((chunk, i) => {
    for (const sentence of chunk.sentences ?? []) {
      if (!sentenceToChunk.has(sentence.id)) sentenceToChunk.set(sentence.id, i);
    }
  });
  const chunkScores = new Map<number, number>();
  const addEvidence = (ids: string[], score: number) => {
    for (const id of ids) {
      const chunk = sentenceToChunk.get(id);
      if (chunk !== undefined) chunkScores.set(chunk, (chunkScores.get(chunk) ?? 0) + score);
    }
  };

  const seedScores = new Map(seeds.map(({ node, score }) => [node.id, score]));
  for (const { node, score } of seeds) addEvidence(node.evidenceSentenceIds, 10 + score * 4);

  const selectedEdges = new Map<string, GraphEdge>();
  for (const { node } of seeds) {
    graph.edges
      .filter((edge) => edge.from === node.id || edge.to === node.id)
      .map((edge) => ({
        edge,
        score: overlap(queryTerms, edge.relation) * 3 +
          overlap(queryTerms, byId.get(edge.from)?.label ?? '') +
          overlap(queryTerms, byId.get(edge.to)?.label ?? ''),
      }))
      .sort((a, b) => b.score - a.score || (edgeOrder.get(a.edge.id) ?? 0) - (edgeOrder.get(b.edge.id) ?? 0))
      .slice(0, edgeLimit)
      .forEach(({ edge }) => selectedEdges.set(edge.id, edge));
  }

  for (const edge of selectedEdges.values()) {
    const anchorScore = Math.max(seedScores.get(edge.from) ?? 0, seedScores.get(edge.to) ?? 0);
    const relationScore = overlap(queryTerms, edge.relation);
    addEvidence(edge.evidenceSentenceIds, 8 + anchorScore * 2 + relationScore * 3);
    for (const nodeId of [edge.from, edge.to]) {
      if (seedScores.has(nodeId)) continue;
      const neighbor = byId.get(nodeId);
      if (neighbor) addEvidence(neighbor.evidenceSentenceIds, 3 + anchorScore + relationScore);
    }
  }

  for (const community of graph.communities ?? []) {
    const lexical = overlap(queryTerms, `${community.title} ${community.summary}`);
    const seedMembers = community.nodeIds.reduce((count, id) => count + (seedScores.has(id) ? 1 : 0), 0);
    if (lexical > 0 || seedMembers > 0) {
      addEvidence(community.evidenceSentenceIds, 4 + lexical * 2 + seedMembers);
    }
  }

  return [...chunkScores.entries()]
    .map(([i, score]) => ({ i, score }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, candidateLimit);
}
