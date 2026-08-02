// Document knowledge-graph extraction (GraphRAG, Phase 2). Runs in the service
// worker: for each document in a repository, feed the model the document's
// sentence-tagged text ([[id]] per sentence) and extract entities + relationships,
// each grounded to the sentence ids that support it. Extractions merge into a
// per-notebook DocGraph (src/shared/docGraph.ts) persisted as graph.json.
//
// Resumable without the (research-shaped) job engine: the graph records
// `processedDocIds` and is checkpointed after every document, so a service-worker
// eviction mid-build resumes by skipping already-processed docs on the next run.

import type { CitableSentence } from '../shared/sentenceSplit';
import type { Settings } from '../shared/types';
import type { LlmMessage } from './llmProvider';
import { complete, resolveModelForRole } from './llmProvider';
import { extractJsonObject } from './scopedSubtask';
import {
  coerceExtraction,
  emptyDocGraph,
  markDocFailed,
  markDocProcessed,
  mergeExtraction,
  type CommunitySummary,
  type DocExtraction,
  type DocGraph,
} from '../shared/docGraph';
import { detectCommunities, renderCommunityForModel } from '../shared/graphCommunities';
import { docChunks, graphGet, graphSet, repoDocs } from './offscreenClient';

const PER_DOC_BUDGET_CHARS = 12000;
// Cap on how many budget-sized windows one document is split into, so a
// pathologically large doc (hundreds of pages) can't blow up build cost/latency.
// At the default budget this covers roughly the first ~20-25 pages of a typical
// PDF — an improvement over the prior single-window (~2-3 page) coverage, not a
// promise of full-document coverage for very large corpora.
const MAX_WINDOWS_PER_DOC = 6;

const SYSTEM_PROMPT =
  'You extract a knowledge graph from ONE document. The document is given as a list of sentences, each prefixed ' +
  'with a [[id]] marker. Identify the key entities and the relationships between them, using ONLY the given text. ' +
  'For every entity and every relationship, cite the ids of the supporting sentences — the ids shown inside the ' +
  '[[ ]] markers, WITHOUT the brackets. Return ONLY JSON of the form: ' +
  '{"entities":[{"label":string,"type":string,"summary":string,"evidence":string[]}],' +
  '"relations":[{"from":string,"to":string,"relation":string,"evidence":string[]}]}. ' +
  'label = canonical entity name; type = short category (e.g. organization, system, person, concept); ' +
  'summary = one sentence; relation = short verb phrase; from/to = entity labels that appear in your entities list. ' +
  'Only cite ids that appear in the text; do not invent ids or facts.';

/**
 * Split a document's chunks into budget-sized, sentence-tagged windows
 * (`[[id]] sentence` lines), covering the WHOLE document (up to `maxWindows`)
 * rather than only its first budget's worth — a large document is extracted
 * across multiple model calls instead of silently dropping everything past the
 * first window. Each returned window carries the set of sentence ids it
 * contains — the allow-list that window's extraction is validated against
 * (fabricated ids are rejected). Always returns at least one (possibly empty)
 * window, so callers don't need to special-case an empty document.
 */
export function windowDocChunks(
  chunks: Array<{ text: string; sentences: CitableSentence[] }>,
  budget = PER_DOC_BUDGET_CHARS,
  maxWindows = MAX_WINDOWS_PER_DOC,
): Array<{ text: string; validIds: Set<string> }> {
  const windows: Array<{ text: string; validIds: Set<string> }> = [];
  let lines: string[] = [];
  let validIds = new Set<string>();
  let used = 0;
  const flush = () => {
    if (lines.length === 0) return;
    windows.push({ text: lines.join('\n'), validIds });
    lines = [];
    validIds = new Set();
    used = 0;
  };

  outer: for (const c of chunks) {
    for (const s of c.sentences) {
      const sentence = c.text.slice(s.start, s.end).trim();
      if (!sentence) continue;
      const line = `[[${s.id}]] ${sentence}`;
      if (used + line.length > budget) {
        flush();
        if (windows.length >= maxWindows) break outer;
      }
      used += line.length;
      validIds.add(s.id);
      lines.push(line);
    }
  }
  flush();
  return windows.length > 0 ? windows : [{ text: '', validIds: new Set() }];
}

/**
 * Single-window convenience wrapper over `windowDocChunks` — the first window
 * only (matches the original single-window extraction shape for call sites that
 * intentionally only want a document's opening portion).
 */
export function tagDocChunks(
  chunks: Array<{ text: string; sentences: CitableSentence[] }>,
  budget = PER_DOC_BUDGET_CHARS,
): { text: string; validIds: Set<string> } {
  return windowDocChunks(chunks, budget, 1)[0];
}

export type ExtractOutcome =
  | { ok: true; extraction: DocExtraction }
  | { ok: false; reason: 'truncated' | 'parse_error' | 'empty' };

/**
 * Heuristic: does `content` look like it was cut off mid-JSON (unbalanced
 * braces/brackets outside of string literals)? There's no `finish_reason`
 * exposed by this provider's reply shape, so this is the signal available —
 * good enough to distinguish "the model ran out of tokens" from "the model
 * returned genuinely malformed JSON" for reporting purposes.
 */
export function looksTruncated(content: string): boolean {
  if (!content.trim()) return false;
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escaped = false;
  for (const ch of content) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  return braces !== 0 || brackets !== 0;
}

/**
 * Extract one document window's entities/relations from its sentence-tagged
 * text. Unlike the original version, failures are reported (truncated model
 * output, unparseable JSON, or a genuinely empty extraction) rather than
 * silently collapsed into an empty result — callers decide how to treat each.
 */
export async function extractOneDoc(
  settings: Settings,
  taggedText: string,
  validIds: Set<string>,
  signal?: AbortSignal,
): Promise<ExtractOutcome> {
  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: taggedText },
  ];
  const reply = await complete(resolveModelForRole(settings, 'utility'), messages, undefined, signal);
  const content = reply.content ?? '';
  let obj: unknown;
  try {
    obj = extractJsonObject(content);
  } catch {
    return { ok: false, reason: looksTruncated(content) ? 'truncated' : 'parse_error' };
  }
  const extraction = coerceExtraction(obj, validIds);
  if (extraction.entities.length === 0 && extraction.relations.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, extraction };
}

const MAX_COMMUNITIES = 12;
const COMMUNITY_MIN_SIZE = 3;
const COMMUNITY_SYSTEM_PROMPT =
  'You summarize a cluster of related entities from a document corpus into a theme. The cluster is given as ' +
  'entities and relationships, each tagged with [[id]] evidence markers. Using ONLY the given text, return ONLY JSON: ' +
  '{"title":string,"summary":string,"evidence":string[]}. title = a short theme name (3–6 words). ' +
  'summary = 2–3 sentences on what this cluster is about and how its members relate. ' +
  'evidence = the ids (WITHOUT brackets) of the most important supporting sentences shown in the [[ ]] markers.';

/**
 * Detect topic communities and synthesize a grounded theme for each (GraphRAG
 * "global" sensemaking). One model call per community; failures skip that
 * community rather than aborting. Evidence ids are validated against the
 * community's own sentences.
 */
export async function summarizeCommunities(settings: Settings, graph: DocGraph, signal?: AbortSignal): Promise<CommunitySummary[]> {
  const raw = detectCommunities(graph, { minSize: COMMUNITY_MIN_SIZE, maxCommunities: MAX_COMMUNITIES });
  const out: CommunitySummary[] = [];
  for (const comm of raw) {
    if (signal?.aborted) break;
    const { text, evidenceIds } = renderCommunityForModel(graph, comm);
    if (!text) continue;
    const valid = new Set(evidenceIds);
    try {
      const reply = await complete(
        resolveModelForRole(settings, 'utility'),
        [
          { role: 'system', content: COMMUNITY_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        undefined,
        signal,
      );
      const obj = extractJsonObject(reply.content ?? '') as { title?: unknown; summary?: unknown; evidence?: unknown };
      const title = typeof obj.title === 'string' ? obj.title.trim() : '';
      const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      const evidence = Array.isArray(obj.evidence)
        ? obj.evidence.filter((x): x is string => typeof x === 'string' && valid.has(x))
        : [];
      if (title || summary) {
        out.push({
          id: comm.id,
          title: title || 'Untitled theme',
          summary,
          nodeIds: comm.nodeIds,
          evidenceSentenceIds: evidence.length > 0 ? evidence : evidenceIds.slice(0, 8),
        });
      }
    } catch {
      // Model/parse failure for this community — skip it.
    }
  }
  return out;
}

export interface GraphBuildProgress {
  docsTotal: number;
  docsDone: number;
  currentDoc?: string;
  nodes: number;
  edges: number;
}

export interface GraphBuildResult {
  ok: boolean;
  graph?: DocGraph;
  error?: string;
  /** Non-fatal issues (e.g. documents that failed extraction) — the build still succeeded overall. */
  warnings?: string[];
}

const REASON_LABEL: Record<'truncated' | 'parse_error' | 'empty', string> = {
  truncated: 'the model\'s output was truncated (try a smaller/simpler document, or increase max tokens)',
  parse_error: 'the model did not return valid JSON',
  empty: 'the model found nothing to extract',
};

/**
 * Build (or resume/rebuild) the knowledge graph for a repository. Iterates the
 * documents not yet in `processedDocIds` (which now excludes docs whose last
 * attempt failed entirely — see `failedDocIds`), extracts each across multiple
 * windows when large, merges successes into the graph, and checkpoints after
 * every document. A document where every window fails is recorded in
 * `failedDocIds` (NOT `processedDocIds`) with a reason, so a plain rebuild-free
 * "Build"/"Update" naturally retries it next time instead of getting stuck.
 */
export async function buildRepoGraph(
  settings: Settings,
  repo: string,
  opts: { rebuild?: boolean; signal?: AbortSignal; onProgress?: (p: GraphBuildProgress) => void } = {},
): Promise<GraphBuildResult> {
  const docsRes = await repoDocs(repo);
  if (!docsRes.ok) return { ok: false, error: docsRes.error };
  const docs = (docsRes.result as Array<{ id: string; name: string }>) ?? [];
  if (docs.length === 0) return { ok: false, error: 'This repository has no documents to extract a graph from.' };

  let graph = emptyDocGraph();
  if (!opts.rebuild) {
    const existing = await graphGet(repo);
    if (existing.ok && existing.result) graph = existing.result as DocGraph;
  }
  const processed = new Set(graph.processedDocIds);
  const todo = docs.filter((d) => !processed.has(d.id));

  const report = (currentDoc?: string) =>
    opts.onProgress?.({
      docsTotal: docs.length,
      docsDone: graph.processedDocIds.length,
      currentDoc,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
    });

  for (const doc of todo) {
    if (opts.signal?.aborted) break;
    report(doc.name);
    let anySuccess = false;
    let lastFailureReason = '';
    try {
      const chunksRes = await docChunks(repo, doc.id);
      const chunks = (chunksRes.ok ? chunksRes.result : []) as Array<{ text: string; sentences: CitableSentence[] }>;
      const windows = windowDocChunks(chunks);
      for (const { text, validIds } of windows) {
        if (validIds.size === 0) continue;
        const outcome = await extractOneDoc(settings, text, validIds, opts.signal);
        if (outcome.ok) {
          mergeExtraction(graph, outcome.extraction, doc.id);
          anySuccess = true;
        } else {
          lastFailureReason = REASON_LABEL[outcome.reason];
        }
      }
    } catch (e) {
      lastFailureReason = e instanceof Error ? e.message : 'extraction failed';
    }
    if (anySuccess) {
      // Partial coverage (some windows succeeded) still counts as processed —
      // better than none, and avoids re-doing the successful windows on retry.
      markDocProcessed(graph, doc.id);
    } else {
      markDocFailed(graph, doc.id, lastFailureReason || 'no content could be extracted');
    }
    const setRes = await graphSet(repo, graph); // checkpoint after every doc
    if (!setRes.ok) return { ok: false, error: setRes.error };
  }

  // Once every document has been attempted (success or failure), cluster the
  // graph into themes (global sensemaking). Re-summarize when new docs were
  // processed, on an explicit rebuild, or when no themes exist yet.
  const attempted = graph.processedDocIds.length + (graph.failedDocIds?.length ?? 0);
  const allAttempted = attempted >= docs.length;
  const shouldSummarize = allAttempted && !opts.signal?.aborted && (opts.rebuild || !graph.communities || todo.length > 0);
  if (shouldSummarize && graph.nodes.length > 0) {
    graph.communities = await summarizeCommunities(settings, graph, opts.signal);
    const setRes = await graphSet(repo, graph);
    if (!setRes.ok) return { ok: false, error: setRes.error };
  }

  report();
  const warnings =
    graph.failedDocIds && graph.failedDocIds.length > 0
      ? [
          `${graph.failedDocIds.length} document(s) could not be extracted: ${graph.failedDocIds
            .map((id) => docs.find((d) => d.id === id)?.name ?? id)
            .join(', ')}.`,
        ]
      : undefined;
  return { ok: true, graph, warnings };
}
