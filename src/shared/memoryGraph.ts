// Pure types and logic for durable graph memory: entities/facts (nodes) and
// relationships (edges) extracted from conversations by reflection, retrieved
// by embedding search, and rendered into the system prompt. Kept free of
// `chrome.*` and runtime state so it is unit-testable; the LLM calls and
// storage that feed it live in `background/memoryStore.ts` and `agentRuntime.ts`.

import type { MemoryEntry } from './types';

export type MemoryNodeKind = 'entity' | 'fact' | 'preference' | 'event';
export type MemoryStatus = 'active' | 'stale' | 'superseded';

export interface MemoryProvenance {
  conversationId: string;
  excerpt: string;
  at: string;
  /** URL/title of the page this fact was read from, when reflection or save_memory captured a source (e.g. an article). */
  sourceUrl?: string;
  sourceTitle?: string;
  /**
   * Stable sentence ids (see src/shared/sentenceSplit.ts) this fact was derived
   * from, when it came out of retrieved repository passages. Makes sentence ids
   * the common provenance mechanism across RAG citations and the graph (spec §9),
   * so a relationship can be traced back to the exact source sentence.
   */
  evidenceSentenceIds?: string[];
}

export interface MemoryNode {
  id: string;
  kind: MemoryNodeKind;
  /** Canonical name, e.g. "Scott", "CANChat deploy pipeline". */
  label: string;
  aliases?: string[];
  /** The memory text itself — source of truth, not the embedding. */
  summary: string;
  confidence: number; // 0..1
  durability: number; // 0..1 — identity/preference high, situational low
  status: MemoryStatus;
  supersededBy?: string;
  /** Nullable project scope; undefined/null means global (visible under every project). */
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt: string;
  provenance: MemoryProvenance[];
}

export interface MemoryEdge {
  id: string;
  from: string;
  to: string;
  /** Free-text verb phrase, e.g. "works_at", "prefers". */
  relation: string;
  confidence: number;
  status: MemoryStatus;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt: string;
  provenance: MemoryProvenance[];
}

export interface MemoryGraph {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  version: number;
}

/** Reserved OPFS repo name for the memory embedding index (never shown as a user repo). */
export const MEMORY_REPO_NAME = '__memory__';

/** Prefix for a memory-index chunk's `url` field, so a search hit maps back to its node id. */
const MEMORY_URL_PREFIX = 'memory:';

/** The embeddable text for one node: label + summary — one node is one chunk. */
export function memoryNodeChunkText(node: Pick<MemoryNode, 'label' | 'summary'>): string {
  return `${node.label}: ${node.summary}`;
}

/** The memory-index doc `url` for a node — encodes the node id for search-result lookup. */
export function memoryNodeUrl(nodeId: string): string {
  return `${MEMORY_URL_PREFIX}${nodeId}`;
}

/** Recover a node id from a memory-index search hit's `url`, or null if not one of ours. */
export function nodeIdFromMemoryUrl(url: string): string | null {
  return url.startsWith(MEMORY_URL_PREFIX) ? url.slice(MEMORY_URL_PREFIX.length) : null;
}

export const MEMORY_GRAPH_VERSION = 1;
export const MEMORY_NODE_CAP = 500;
export const MEMORY_EDGE_CAP = 1000;
/** Below this effective confidence, an active node/edge is marked stale (never auto-deleted). */
export const MEMORY_STALE_THRESHOLD = 0.35;

export function emptyMemoryGraph(): MemoryGraph {
  return { nodes: [], edges: [], version: MEMORY_GRAPH_VERSION };
}

/** Strip a leading/trailing markdown code fence (```json … ```), if present. */
function stripCodeFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
}

function clamp01(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

export interface ParsedMemoryRelation {
  to: string;
  relation: string;
}

export interface ParsedMemoryCandidate {
  kind: MemoryNodeKind;
  subject: string;
  label: string;
  summary: string;
  relations: ParsedMemoryRelation[];
  confidence: number;
  durability: number;
  evidence: string;
}

const VALID_KINDS: MemoryNodeKind[] = ['entity', 'fact', 'preference', 'event'];

/**
 * Parse the reflection model's reply — expected to be `{"memories":[{kind,
 * subject, label, summary, relations, confidence, durability, evidence}]}`.
 * Tolerant of malformed/empty input (returns []) so a flaky reflection call
 * never throws mid-turn; mirrors `parseLesson` in `background/loopHelpers.ts`.
 */
export function parseReflection(raw: string): ParsedMemoryCandidate[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(list)) return [];
  const out: ParsedMemoryCandidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const label = typeof obj.label === 'string' ? obj.label.trim() : '';
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    if (!label || !summary) continue;
    const kind = VALID_KINDS.includes(obj.kind as MemoryNodeKind) ? (obj.kind as MemoryNodeKind) : 'fact';
    const subject = typeof obj.subject === 'string' ? obj.subject.trim() : '';
    const relations: ParsedMemoryRelation[] = Array.isArray(obj.relations)
      ? obj.relations
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map((r) => ({ to: String(r.to ?? '').trim(), relation: String(r.relation ?? '').trim() }))
          .filter((r) => r.to && r.relation)
          .slice(0, 8)
      : [];
    const confidence = clamp01(obj.confidence, 0.6);
    const durability = clamp01(obj.durability, 0.5);
    const evidence = typeof obj.evidence === 'string' ? obj.evidence.trim().slice(0, 200) : '';
    out.push({ kind, subject, label, summary, relations, confidence, durability, evidence });
  }
  return out.slice(0, 12);
}

/**
 * Drop reflection candidates below a user-configured minimum confidence, so a
 * user who wants tighter control over automatic saving can raise the bar.
 * Never applied to explicit `save_memory` calls (those always save at
 * confidence 1, so a sane threshold never filters them).
 */
export function filterByMinConfidence(candidates: ParsedMemoryCandidate[], minConfidence: number): ParsedMemoryCandidate[] {
  return candidates.filter((c) => c.confidence >= minConfidence);
}

/** Lowercase alnum terms, for cheap overlap-based similarity (no embedding call). */
function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []).filter((t) => t.length > 2));
}

/** Jaccard-ish term overlap between two node labels+summaries, used as a merge trigger fallback. */
export function nodeSimilarity(a: Pick<MemoryNode, 'label' | 'summary'>, b: Pick<MemoryNode, 'label' | 'summary'>): number {
  const ta = terms(`${a.label} ${a.summary}`);
  const tb = terms(`${b.label} ${b.summary}`);
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.min(ta.size, tb.size);
}

/** Merge-target similarity below which a reflection hit looks like text drift (possible contradiction) rather than reinforcement, and is worth a real adjudication call. */
export const ADJUDICATION_SIMILARITY_THRESHOLD = 0.3;

/**
 * True when a candidate matched an existing node (by embedding search or
 * `nodeSimilarity`) but their text overlaps little — the sort of mismatch
 * that could mean the candidate updates/contradicts the existing fact rather
 * than merely restating it, and is worth one adjudication LLM call rather
 * than a silent merge.
 */
export function shouldAdjudicate(existing: Pick<MemoryNode, 'label' | 'summary'>, candidate: Pick<ParsedMemoryCandidate, 'label' | 'summary'>): boolean {
  return nodeSimilarity(existing, candidate) < ADJUDICATION_SIMILARITY_THRESHOLD;
}

/**
 * Parse the adjudication model's reply — expected to be
 * `{"supersedes": true|false}`. Fails closed (false = keep both / reinforce
 * rather than supersede) on anything malformed, so a flaky adjudication call
 * never silently discards an existing memory.
 */
export function parseSupersedeVerdict(raw: string): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(stripCodeFence(raw)) as { supersedes?: unknown };
    return parsed?.supersedes === true;
  } catch {
    return false;
  }
}

/**
 * Merge a newly-extracted candidate into an existing node: union provenance,
 * take the max confidence, prefer the candidate's summary when it is more
 * specific (longer), and always bump `lastConfirmedAt`. Pure — the caller
 * decides whether an existing node is a merge target (via `nodeSimilarity` or
 * an embedding-index hit) before calling this.
 */
export function mergeNodes(existing: MemoryNode, incoming: ParsedMemoryCandidate, provenance: MemoryProvenance, now: string): MemoryNode {
  return {
    ...existing,
    summary: incoming.summary.length > existing.summary.length ? incoming.summary : existing.summary,
    confidence: Math.max(existing.confidence, incoming.confidence),
    durability: Math.max(existing.durability, incoming.durability),
    status: 'active',
    updatedAt: now,
    lastConfirmedAt: now,
    provenance: [...existing.provenance, provenance].slice(-10),
  };
}

/**
 * Effective confidence after time-based decay: durability slows the decay
 * rate (a preference decays far slower than a situational fact). Never
 * negative; the caller compares against `MEMORY_STALE_THRESHOLD`.
 */
export function effectiveConfidence(
  record: { confidence: number; lastConfirmedAt: string; durability?: number },
  now: Date,
): number {
  const days = Math.max(0, (now.getTime() - new Date(record.lastConfirmedAt).getTime()) / 86_400_000);
  const durability = record.durability ?? 0.5; // edges carry no durability field; treat as medium
  const halfLifeDays = 14 + durability * 350; // 14d for durability=0 … ~364d for durability=1
  const decay = Math.pow(0.5, days / halfLifeDays);
  return record.confidence * decay;
}

/**
 * Sweep a graph, marking active nodes/edges below the stale threshold as
 * `status:'stale'`. Never deletes — staleness is surfaced to the user, who
 * deletes explicitly. Superseded/already-stale records are left untouched.
 */
export function applyDecay(graph: MemoryGraph, now: Date = new Date()): MemoryGraph {
  const nowIso = now.toISOString();
  const nodes = graph.nodes.map((n) =>
    n.status === 'active' && effectiveConfidence(n, now) < MEMORY_STALE_THRESHOLD
      ? { ...n, status: 'stale' as const, updatedAt: nowIso }
      : n,
  );
  const edges = graph.edges.map((e) =>
    e.status === 'active' && effectiveConfidence(e, now) < MEMORY_STALE_THRESHOLD
      ? { ...e, status: 'stale' as const, updatedAt: nowIso }
      : e,
  );
  return { ...graph, nodes, edges };
}

/**
 * Cap the graph to `MEMORY_NODE_CAP`/`MEMORY_EDGE_CAP`, evicting the
 * lowest-durability, longest-unconfirmed active/stale records first
 * (superseded records are dropped before any active/stale eviction, since
 * they carry no retrieval value once a successor exists).
 */
export function pruneGraph(graph: MemoryGraph): MemoryGraph {
  let nodes = graph.nodes;
  if (nodes.length > MEMORY_NODE_CAP) {
    const superseded = nodes.filter((n) => n.status === 'superseded');
    const keepable = nodes.filter((n) => n.status !== 'superseded');
    const overflow = nodes.length - MEMORY_NODE_CAP;
    if (superseded.length >= overflow) {
      const drop = new Set(
        [...superseded]
          .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
          .slice(0, overflow)
          .map((n) => n.id),
      );
      nodes = nodes.filter((n) => !drop.has(n.id));
    } else {
      const rankable = [...keepable].sort(
        (a, b) => a.durability - b.durability || new Date(a.lastConfirmedAt).getTime() - new Date(b.lastConfirmedAt).getTime(),
      );
      const dropCount = overflow - superseded.length;
      const drop = new Set([...superseded.map((n) => n.id), ...rankable.slice(0, dropCount).map((n) => n.id)]);
      nodes = nodes.filter((n) => !drop.has(n.id));
    }
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  let edges = graph.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  if (edges.length > MEMORY_EDGE_CAP) {
    edges = [...edges]
      .sort((a, b) => new Date(b.lastConfirmedAt).getTime() - new Date(a.lastConfirmedAt).getTime())
      .slice(0, MEMORY_EDGE_CAP);
  }
  return { ...graph, nodes, edges };
}

/**
 * A record is visible under a given active project when it's global (no
 * `projectId`) or scoped to that exact project. `activeProjectId` of
 * null/undefined means "no project active" — only global records are visible.
 * Scoping is a filter, not a partition: nothing is ever hard-excluded by id,
 * so a record created before Projects existed (or left global on purpose)
 * stays visible everywhere.
 */
export function visibleToProject(recordProjectId: string | undefined, activeProjectId: string | null | undefined): boolean {
  return recordProjectId == null || recordProjectId === activeProjectId;
}

/**
 * The top-N durable active nodes, ranked by durability × effective
 * confidence — the core (systemBase) tier. Exported separately from
 * `renderCoreMemoryBlock` so the working-state (relevant-subgraph) tier can
 * exclude these ids without re-deriving the ranking. `activeProjectId` scopes
 * out nodes tagged for a different project (see `visibleToProject`).
 */
export function rankCoreMemoryNodes(
  graph: MemoryGraph,
  activeProjectId: string | null | undefined = null,
  limit = 15,
  now: Date = new Date(),
): MemoryNode[] {
  const active = graph.nodes.filter((n) => n.status !== 'superseded' && visibleToProject(n.projectId, activeProjectId));
  return [...active]
    .sort((a, b) => b.durability * effectiveConfidence(b, now) - a.durability * effectiveConfidence(a, now))
    .slice(0, limit);
}

function renderNodeEdgeLines(graph: MemoryGraph, nodes: MemoryNode[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  return graph.edges
    .filter((e) => e.status === 'active' && ids.has(e.from) && ids.has(e.to))
    .map((e) => {
      const from = nodes.find((n) => n.id === e.from);
      const to = nodes.find((n) => n.id === e.to);
      return from && to ? `- ${from.label} —${e.relation}→ ${to.label}` : '';
    })
    .filter(Boolean);
}

/**
 * Render the core (systemBase) memory block: the top-N durable active facts,
 * ranked by durability × effective confidence, plus their edges. Built once
 * per conversation into the byte-stable system prefix — never called
 * mid-conversation, so prompt caching is unaffected by reflection results.
 * `activeProjectId` scopes out nodes tagged for a different project.
 */
export function renderCoreMemoryBlock(
  graph: MemoryGraph,
  activeProjectId: string | null | undefined = null,
  limit = 15,
  now: Date = new Date(),
): string {
  const guidance =
    `\n\nMemory — the user has enabled persistent memory on this device, building a personal knowledge graph. ` +
    `Save genuinely durable facts with save_memory as you learn them — one fact per call. Two kinds count: ` +
    `(1) facts about the user (their role, projects, interests, preferences, ongoing work); ` +
    `(2) named entities, facts, events, and relationships from articles or pages the user asks you to remember or discusses substantively — people, organizations, places, dates, what happened, and how things relate. Cite sourceUrl/sourceTitle when it came from a page. ` +
    `Never save secrets, credentials, or other sensitive personal data. ` +
    `Use update_memory/delete_memory to keep entries current, and honor "forget ..." requests immediately with delete_memory. ` +
    `If the known facts below already answer the user's question, answer directly from them — do not run searches or tools to re-derive what memory already states. ` +
    `Only reach for live tools when the question concerns live or time-sensitive data (calendar, mail, page contents, anything that changes) or the remembered fact could plausibly be stale. ` +
    `Memories marked (stale) may be outdated — verify before relying on them.`;
  const active = graph.nodes.filter((n) => n.status !== 'superseded' && visibleToProject(n.projectId, activeProjectId));
  if (active.length === 0) return guidance + `\nMemory is currently empty.`;
  const ranked = rankCoreMemoryNodes(graph, activeProjectId, limit, now);
  const lines = ranked.map((n) => `- [${n.id}] ${n.label} — ${n.summary}${n.status === 'stale' ? ' (stale)' : ''}`);
  const edgeLines = renderNodeEdgeLines(graph, ranked);
  return (
    guidance +
    `\nKnown facts (use them naturally to tailor answers; reference by id when updating):\n` +
    lines.join('\n') +
    (edgeLines.length > 0 ? `\nRelationships:\n${edgeLines.join('\n')}` : '')
  );
}

/**
 * Render the working-state (relevant-subgraph) tier: a small set of nodes
 * found relevant to the current user turn by embedding search, that aren't
 * already in the core tier. Returns '' for an empty set so an empty result
 * adds nothing to the working-state block. This is appended to the mutable
 * trailing message each user turn — never to the byte-stable systemBase — so
 * per-turn retrieval never invalidates prompt caching.
 */
export function renderRelevantMemoryBlock(nodes: MemoryNode[]): string {
  if (nodes.length === 0) return '';
  const lines = nodes.map((n) => `- [${n.id}] ${n.label} — ${n.summary}${n.status === 'stale' ? ' (stale)' : ''}`);
  return `\nMemories relevant to this message (not already listed above):\n${lines.join('\n')}`;
}

/**
 * One-time conversion of the legacy flat `MemoryEntry[]` into graph nodes, for
 * the lazy migration in `background/memoryStore.ts`. Each entry becomes a
 * `fact` node with no provenance (the original text carried none) and
 * moderate default confidence/durability, since it was user- or
 * lesson-authored rather than freshly extracted.
 */
export function migrateFlatEntries(entries: MemoryEntry[]): MemoryNode[] {
  return entries.map((e) => {
    const words = e.text.trim().split(/\s+/);
    const label = words.slice(0, 6).join(' ') + (words.length > 6 ? '…' : '');
    return {
      id: e.id,
      kind: 'fact',
      label: label || e.text.slice(0, 40),
      summary: e.text,
      confidence: 0.9,
      durability: 0.7,
      status: 'active',
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      lastConfirmedAt: e.updatedAt,
      provenance: [],
    };
  });
}
