// Per-notebook document knowledge graph (GraphRAG). Pure + dependency-free (no
// chrome/OPFS/DOM/model) so it can be unit-tested and shared. A DocGraph is a
// *stable extraction of a document corpus* — deliberately separate from the
// personal, decaying memory graph (src/shared/memoryGraph.ts). Every node and
// edge is grounded to sentence ids (src/shared/sentenceSplit.ts), so any graph
// claim resolves to the exact source sentence through the same citation path as
// RAG answers.

import { shortHash } from './sentenceSplit';
import { buildAnnIndex, buildForwardAdjacency } from './annIndex';

export interface GraphNode {
  id: string;
  /** Free-text entity category the model supplied (e.g. "organization", "system"). */
  type: string;
  /** Canonical display name. */
  label: string;
  aliases: string[];
  summary: string;
  /** Stable sentence ids this node was drawn from — its provenance. */
  evidenceSentenceIds: string[];
  /** Documents the node appears in. */
  docIds: string[];
  /** L2-normalized embedding of `${label} — ${summary}`, keyed to DocGraph.embedModel. Absent until a dedup pass computes it. */
  embedding?: number[];
}

export interface GraphEdge {
  id: string;
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  relation: string;
  evidenceSentenceIds: string[];
}

/**
 * A summarized community of related entities (GraphRAG "global" sensemaking): a
 * cluster of densely-connected nodes with a synthesized theme. Grounded to
 * sentence ids like every other graph claim.
 */
export interface CommunitySummary {
  id: string;
  title: string;
  summary: string;
  /** Member node ids. */
  nodeIds: string[];
  evidenceSentenceIds: string[];
  /** How this summary was produced. Absent on summaries written before this field existed — treated as 'llm'. */
  method?: 'llm' | 'extractive';
}

export type GraphCoverageMode = 'quick' | 'full';

export interface GraphDocCoverage {
  /** Number of extraction windows in the complete document. */
  totalWindows: number;
  /** Union of every window index any build has ever targeted for this doc
   * (not just the most recent build's sample) — so a narrower quick-mode
   * sample can never erase memory of windows a broader full-mode build
   * previously targeted (including ones that failed). */
  selectedWindows: number[];
  /** Successfully extracted window indices, checkpointed individually. */
  completedWindows: number[];
  /** Failed window indices; retried by later builds. */
  failedWindows: number[];
  /** Window indices skipped by the low-information pre-filter — no model call was made. */
  skippedWindows?: number[];
  /**
   * shortHash() of this doc's concatenated chunk text when this coverage was
   * last established. Gates whether completedWindows/failedWindows are
   * trusted (content unchanged) or reset (content changed/never hashed).
   * Absent on coverage records written before this field existed — treated
   * as "no signal, assume changed" so a legacy record gets exactly one clean
   * re-hash + possible reprocess, not a crash or a silent trust of stale
   * progress.
   */
  contentHash?: string;
  /**
   * shortHash() of this doc's content the last time the on-device NER
   * backbone (src/background/graphExtract.ts's runNerBackbone, used by the
   * "Quick" build) processed it. Entirely separate from `contentHash` above —
   * the NER backbone doesn't participate in the quick/full LLM coverage state
   * machine at all (no selectedWindows/completedWindows, no coverageMode, no
   * processedDocIds), it just skips re-running NER on a document whose
   * content hasn't changed since its last backbone pass.
   */
  fastContentHash?: string;
}

export interface DocGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  version: number;
  /** Repository corpus revision this graph was extracted from. Absent means legacy revision 0. */
  corpusRevision?: number;
  /** Embedder identity that produced GraphNode.embedding values, so a switched embedder invalidates them instead of comparing incompatible vectors. */
  embedModel?: string;
  /** Node ids touched (created/re-merged) since their community last received an LLM summary. Persisted so it survives interrupted/resumed builds. */
  dirtyNodeIds?: string[];
  /** Doc ids already folded in — lets extraction resume without reprocessing. */
  processedDocIds: string[];
  /**
   * Doc ids whose most recent extraction attempt produced nothing (every window
   * failed) — deliberately kept OUT of processedDocIds so a normal (non-rebuild)
   * build retries them, instead of silently and permanently treating a failed
   * document as done.
   */
  failedDocIds?: string[];
  /** Human-readable failure reason per doc id in failedDocIds. */
  docErrors?: Record<string, string>;
  /** Corpus-level topic communities + summaries (computed after extraction). */
  communities?: CommunitySummary[];
  /** Per-document extraction coverage. Absent on legacy graphs. */
  docCoverage?: Record<string, GraphDocCoverage>;
  /** Highest coverage mode completed or currently being built. */
  coverageMode?: GraphCoverageMode;
  updatedAt: string;
}

// v3 adds optional GraphNode.embedding, DocGraph.dirtyNodeIds,
// GraphDocCoverage.skippedWindows, CommunitySummary.method — all additive, no
// migration needed; legacy graphs simply have `undefined` until their next build.
export const DOC_GRAPH_VERSION = 3;
const MAX_EVIDENCE_PER_ITEM = 12;

export function emptyDocGraph(): DocGraph {
  return { nodes: [], edges: [], version: DOC_GRAPH_VERSION, processedDocIds: [], updatedAt: new Date(0).toISOString() };
}

/**
 * Record a document as processed (its extraction produced at least something
 * usable, or ran with no error). Dedupes, and clears any prior failure entry —
 * a doc that later succeeds is no longer "failed".
 */
export function markDocProcessed(graph: DocGraph, docId: string): void {
  if (!graph.processedDocIds.includes(docId)) graph.processedDocIds.push(docId);
  if (graph.failedDocIds) graph.failedDocIds = graph.failedDocIds.filter((id) => id !== docId);
  if (graph.docErrors) delete graph.docErrors[docId];
}

/**
 * Record a document as failed (every extraction attempt produced nothing). Left
 * OUT of processedDocIds so it is retried on the next non-rebuild build. Dedupes.
 */
export function markDocFailed(graph: DocGraph, docId: string, reason: string): void {
  graph.processedDocIds = graph.processedDocIds.filter((id) => id !== docId);
  if (!graph.failedDocIds) graph.failedDocIds = [];
  if (!graph.failedDocIds.includes(docId)) graph.failedDocIds.push(docId);
  if (!graph.docErrors) graph.docErrors = {};
  graph.docErrors[docId] = reason;
}

/** Normalize an entity name for identity (case/whitespace-insensitive). */
export function normLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim();
}

function nodeIdFor(label: string): string {
  return `n_${shortHash(normLabel(label))}`;
}
function edgeIdFor(from: string, relation: string, to: string): string {
  return `e_${shortHash(`${from}|${normLabel(relation)}|${to}`)}`;
}

function uniqPush(list: string[], values: Iterable<string>, cap: number): void {
  const seen = new Set(list);
  for (const v of values) {
    const t = v.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      list.push(t);
      if (list.length >= cap) return;
    }
  }
}

// ----- extraction shapes (validated from the model's JSON) -----

export interface ExtractedEntity {
  label: string;
  type: string;
  summary: string;
  evidence: string[];
}
export interface ExtractedRelation {
  from: string;
  to: string;
  relation: string;
  evidence: string[];
}
export interface DocExtraction {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];
}

/**
 * Coerce an already-parsed model object into a DocExtraction, keeping only
 * evidence ids that actually exist in this document (`validIds`) — the same
 * fabricated-citation guard used for RAG answers, applied at extraction time.
 */
export function coerceExtraction(obj: unknown, validIds: Set<string>): DocExtraction {
  const o = (obj ?? {}) as { entities?: unknown; relations?: unknown };
  const keepIds = (ids: string[]) => ids.filter((id) => validIds.has(id)).slice(0, MAX_EVIDENCE_PER_ITEM);

  const entities: ExtractedEntity[] = Array.isArray(o.entities)
    ? o.entities
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e) => ({
          label: typeof e.label === 'string' ? e.label.trim() : '',
          type: typeof e.type === 'string' ? e.type.trim() : 'entity',
          summary: typeof e.summary === 'string' ? e.summary.trim() : '',
          evidence: keepIds(strArr(e.evidence)),
        }))
        .filter((e) => e.label && e.evidence.length > 0)
    : [];

  const relations: ExtractedRelation[] = Array.isArray(o.relations)
    ? o.relations
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({
          from: typeof r.from === 'string' ? r.from.trim() : '',
          to: typeof r.to === 'string' ? r.to.trim() : '',
          relation: typeof r.relation === 'string' ? r.relation.trim() : '',
          evidence: keepIds(strArr(r.evidence)),
        }))
        .filter((r) => r.from && r.to && r.relation && r.evidence.length > 0)
    : [];

  return { entities, relations };
}

/** Build a label→node lookup (including aliases) for the current graph. */
function indexByLabel(graph: DocGraph): Map<string, GraphNode> {
  const idx = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    idx.set(normLabel(n.label), n);
    for (const a of n.aliases) idx.set(normLabel(a), n);
  }
  return idx;
}

/**
 * Fold one document's extraction into `graph` (mutates and returns it). Entities
 * merge by normalized label/alias; relations resolve endpoints to nodes (creating
 * missing ones) and merge by (from, relation, to). Evidence sentence ids are
 * unioned. Records the doc as processed. Deterministic given the same inputs.
 */
export function mergeExtraction(
  graph: DocGraph,
  extraction: DocExtraction,
  docId: string,
  opts: { markProcessed?: boolean; touchedNodeIds?: Set<string> } = {},
): DocGraph {
  const idx = indexByLabel(graph);

  const resolveOrCreate = (label: string, type: string, summary: string): GraphNode => {
    const key = normLabel(label);
    let node = idx.get(key);
    if (!node) {
      node = { id: nodeIdFor(label), type: type || 'entity', label, aliases: [], summary, evidenceSentenceIds: [], docIds: [] };
      // Guard against a hash collision producing a different node with the same id.
      if (!graph.nodes.some((n) => n.id === node!.id)) {
        graph.nodes.push(node);
        idx.set(key, node);
      } else {
        node = graph.nodes.find((n) => n.id === node!.id)!;
        idx.set(key, node);
      }
    }
    opts.touchedNodeIds?.add(node.id);
    return node;
  };

  for (const e of extraction.entities) {
    const node = resolveOrCreate(e.label, e.type, e.summary);
    // Prefer the richer description rather than permanently preserving whichever
    // document happened to be ingested first.
    if (e.summary.length > node.summary.length) node.summary = e.summary;
    if (normLabel(e.label) !== normLabel(node.label)) uniqPush(node.aliases, [e.label], 20);
    uniqPush(node.evidenceSentenceIds, e.evidence, 50);
    uniqPush(node.docIds, [docId], 200);
  }

  for (const r of extraction.relations) {
    const from = resolveOrCreate(r.from, 'entity', '');
    const to = resolveOrCreate(r.to, 'entity', '');
    uniqPush(from.docIds, [docId], 200);
    uniqPush(to.docIds, [docId], 200);
    const id = edgeIdFor(from.id, r.relation, to.id);
    let edge = graph.edges.find((x) => x.id === id);
    if (!edge) {
      edge = { id, from: from.id, to: to.id, relation: r.relation, evidenceSentenceIds: [] };
      graph.edges.push(edge);
    }
    uniqPush(edge.evidenceSentenceIds, r.evidence, 50);
  }

  if (opts.markProcessed !== false && !graph.processedDocIds.includes(docId)) graph.processedDocIds.push(docId);
  graph.updatedAt = new Date().toISOString();
  return graph;
}

// ----- embedding-based fuzzy entity dedup (second pass, after exact-label merge) -----

/** Cosine-similarity threshold for folding two entities together by embedding alone. Conservative: MiniLM isn't fine-tuned for entity linking. */
export const EMBED_MERGE_THRESHOLD = 0.9;

const GENERIC_TYPES = new Set(['entity']);

/** Dot product of two already L2-normalized vectors (= cosine similarity). Mismatched lengths score 0 rather than throwing. */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Two entity types may be merged if they match exactly, or either is the generic model fallback type — never fold a `person` into an `organization` on embedding similarity alone. */
function typesCompatible(a: string, b: string): boolean {
  const na = normLabel(a);
  const nb = normLabel(b);
  return na === nb || GENERIC_TYPES.has(na) || GENERIC_TYPES.has(nb);
}

/** Fold `absorb` into `keep`: union aliases/evidence/docIds, prefer the richer summary, redirect edges (deduping/dropping self-loops on collision), and remove the absorbed node. Takes the already-resolved node objects (not ids) so callers iterating pairs don't need a redundant lookup per pair. */
function mergeNodePair(graph: DocGraph, keep: GraphNode, absorb: GraphNode): void {
  const keepId = keep.id;
  const absorbId = absorb.id;

  if (absorb.summary.length > keep.summary.length) keep.summary = absorb.summary;
  uniqPush(keep.aliases, [absorb.label, ...absorb.aliases], 20);
  uniqPush(keep.evidenceSentenceIds, absorb.evidenceSentenceIds, 50);
  uniqPush(keep.docIds, absorb.docIds, 200);

  for (const edge of [...graph.edges]) {
    const newFrom = edge.from === absorbId ? keepId : edge.from;
    const newTo = edge.to === absorbId ? keepId : edge.to;
    if (newFrom === edge.from && newTo === edge.to) continue;
    if (newFrom === newTo) {
      // The merge collapsed a relation onto itself — no self-loop, just drop it.
      graph.edges = graph.edges.filter((e) => e.id !== edge.id);
      continue;
    }
    const newId = edgeIdFor(newFrom, edge.relation, newTo);
    const existing = graph.edges.find((e) => e.id === newId && e.id !== edge.id);
    if (existing) {
      uniqPush(existing.evidenceSentenceIds, edge.evidenceSentenceIds, 50);
      graph.edges = graph.edges.filter((e) => e.id !== edge.id);
    } else {
      edge.id = newId;
      edge.from = newFrom;
      edge.to = newTo;
    }
  }

  graph.nodes = graph.nodes.filter((n) => n.id !== absorbId);
}

/**
 * Change an edge's relation label, recomputing its id (which encodes
 * `from|relation|to`, see `edgeIdFor`) so a later rebuild that regenerates the
 * original generic relation for the same from/to pair (e.g. the NER
 * backbone's "co-occurs with") finds no existing edge under the old id and
 * doesn't recreate a duplicate — and so a collision with an edge that already
 * has the new relation merges evidence into it instead of leaving two edges
 * for the same fact. Used by the bounded LLM relation-typing enrichment pass
 * (src/background/graphExtract.ts) to upgrade a co-occurrence edge to a real
 * relationship without disturbing dedup/merge invariants.
 */
export function retypeEdge(graph: DocGraph, edge: GraphEdge, newRelation: string): void {
  const newId = edgeIdFor(edge.from, newRelation, edge.to);
  if (newId === edge.id) {
    edge.relation = newRelation;
    return;
  }
  const existing = graph.edges.find((e) => e.id === newId);
  if (existing) {
    uniqPush(existing.evidenceSentenceIds, edge.evidenceSentenceIds, 50);
    graph.edges = graph.edges.filter((e) => e.id !== edge.id);
  } else {
    edge.id = newId;
    edge.relation = newRelation;
  }
}

// Yield back to the event loop this often (in pairwise comparisons), so a
// large dedup pass never monopolizes the single-threaded service worker for
// more than a fraction of a second at a stretch — the extension (chat, the
// build-progress poll, everything) shares that one thread. A real macrotask
// yield (setTimeout), not a microtask, since chrome.runtime message dispatch
// needs an actual event-loop turn to run.
const YIELD_EVERY_COMPARISONS = 2000;
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Second-pass fuzzy merge over the graph's (already exact-label-deduped) nodes,
 * using precomputed embeddings. Greedy single-pass in stable id order (not
 * globally-optimal clustering). Candidate pairs come from an approximate
 * nearest-neighbor bucketing (src/shared/annIndex.ts) instead of an all-pairs
 * scan, so this stays sub-quadratic at node counts in the thousands+ — each
 * surviving candidate is still a real id-map lookup plus a 384-d dot product,
 * with periodic yields (see YIELD_EVERY_COMPARISONS) so a large dedup pass
 * never monopolizes the single-threaded service worker for more than a
 * fraction of a second at a stretch. Mutates `graph.dirtyNodeIds` in place,
 * rewriting any absorbed id to its surviving id, so callers tracking
 * "touched" node ids for incremental community summarization stay correct
 * across merges.
 */
export async function mergeSimilarNodes(
  graph: DocGraph,
  embeddings: Map<string, number[]>,
  opts: { threshold?: number } = {},
): Promise<{ mergedCount: number; idRemap: Map<string, string> }> {
  const threshold = opts.threshold ?? EMBED_MERGE_THRESHOLD;
  const ids = graph.nodes.map((n) => n.id).sort().filter((id) => embeddings.has(id));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const absorbed = new Set<string>();
  const idRemap = new Map<string, string>();
  let mergedCount = 0;
  let comparisons = 0;

  const vectors = ids.map((id) => embeddings.get(id)!);
  const adjacency = buildForwardAdjacency(buildAnnIndex(vectors));

  for (let i = 0; i < ids.length; i++) {
    const keepId = ids[i];
    if (absorbed.has(keepId)) continue;
    const keepNode = nodeById.get(keepId);
    if (!keepNode) continue;
    const keepEmb = vectors[i];

    for (const j of adjacency.get(i) ?? []) {
      const candidateId = ids[j];
      if (absorbed.has(candidateId)) continue;

      comparisons++;
      if (comparisons % YIELD_EVERY_COMPARISONS === 0) await yieldToEventLoop();

      const candidateNode = nodeById.get(candidateId);
      if (!candidateNode || !typesCompatible(keepNode.type, candidateNode.type)) continue;
      if (cosineSim(keepEmb, vectors[j]) < threshold) continue;
      mergeNodePair(graph, keepNode, candidateNode);
      absorbed.add(candidateId);
      idRemap.set(candidateId, keepId);
      mergedCount++;
    }
  }

  if (idRemap.size > 0 && graph.dirtyNodeIds) {
    graph.dirtyNodeIds = [...new Set(graph.dirtyNodeIds.map((id) => idRemap.get(id) ?? id))];
  }

  return { mergedCount, idRemap };
}

// ----- retrieval for GraphRAG answering -----

function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9.-]*/g) ?? []);
}

/**
 * Lexically select the nodes most relevant to `query` (term overlap on
 * label/aliases/summary), then expand one hop along edges to pull in neighbors —
 * so multi-hop relationships surface even when the query names only one endpoint.
 */
export function selectSubgraph(graph: DocGraph, query: string, k = 8): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const q = terms(query);
  const scored = graph.nodes
    .map((n) => {
      const hay = terms(`${n.label} ${n.aliases.join(' ')} ${n.summary}`);
      let score = 0;
      for (const t of q) if (hay.has(t)) score++;
      return { n, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const keep = new Set(scored.map((s) => s.n.id));
  const edges = graph.edges.filter((e) => keep.has(e.from) || keep.has(e.to));
  for (const e of edges) {
    keep.add(e.from);
    keep.add(e.to);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return { nodes: [...keep].map((id) => byId.get(id)).filter((n): n is GraphNode => !!n), edges };
}

/**
 * Render a subgraph as sentence-tagged lines for the model — entities with their
 * evidence, then relations — mirroring the `[[id]]` grammar so graph-derived
 * answers cite exactly like RAG answers.
 */
export function renderSubgraphForModel(sub: { nodes: GraphNode[]; edges: GraphEdge[] }): string {
  const byId = new Map(sub.nodes.map((n) => [n.id, n]));
  const label = (id: string) => byId.get(id)?.label ?? '?';
  const tag = (ids: string[]) => ids.map((id) => `[[${id}]]`).join(' ');
  const nodeLines = sub.nodes.map((n) => `- ${n.label} (${n.type}): ${n.summary} ${tag(n.evidenceSentenceIds)}`.trim());
  const edgeLines = sub.edges.map((e) => `- ${label(e.from)} —${e.relation}→ ${label(e.to)} ${tag(e.evidenceSentenceIds)}`.trim());
  const parts: string[] = [];
  if (nodeLines.length) parts.push(`Entities:\n${nodeLines.join('\n')}`);
  if (edgeLines.length) parts.push(`Relationships:\n${edgeLines.join('\n')}`);
  return parts.join('\n\n');
}
