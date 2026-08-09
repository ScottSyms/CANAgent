// Document knowledge-graph extraction (GraphRAG, Phase 2). Runs in the service
// worker: for each document in a repository, feed the model the document's
// sentence-tagged text ([[id]] per sentence) and extract entities + relationships,
// each grounded to the sentence ids that support it. Extractions merge into a
// per-notebook DocGraph (src/shared/docGraph.ts) persisted as graph.json.
//
// Resumable without the (research-shaped) job engine: the graph records
// `processedDocIds` and is checkpointed after every document, so a service-worker
// eviction mid-build resumes by skipping already-processed docs on the next run.

import { shortHash, type CitableSentence } from '../shared/sentenceSplit';
import type { Settings } from '../shared/types';
import type { LlmMessage } from './llmProvider';
import { complete, resolveModelForRole } from './llmProvider';
import { extractJsonObject } from './scopedSubtask';
import {
  coerceExtraction,
  DOC_GRAPH_VERSION,
  emptyDocGraph,
  markDocFailed,
  markDocProcessed,
  mergeExtraction,
  type CommunitySummary,
  type DocExtraction,
  type GraphCoverageMode,
  type GraphDocCoverage,
  type DocGraph,
} from '../shared/docGraph';
import { detectCommunities, renderCommunityForModel } from '../shared/graphCommunities';
import { docChunks, graphGetRaw, graphSet, graphSnapshot } from './offscreenClient';
import { resolvePrompt } from '../shared/promptDefaults';

const PER_DOC_BUDGET_CHARS = 12000;
// Cap on how many budget-sized windows one document is split into, so a
// pathologically large doc (hundreds of pages) can't blow up build cost/latency.
// At the default budget this covers roughly the first ~20-25 pages of a typical
// PDF — an improvement over the prior single-window (~2-3 page) coverage, not a
// promise of full-document coverage for very large corpora.
const MAX_WINDOWS_PER_DOC = 6;

/** Include both ends while spreading a bounded sample across the whole range. */
export function evenlySpacedIndices(total: number, limit: number): number[] {
  if (total <= 0 || limit <= 0) return [];
  if (total <= limit) return Array.from({ length: total }, (_, index) => index);
  if (limit === 1) return [0];
  const selected = new Set<number>();
  for (let i = 0; i < limit; i++) selected.add(Math.round((i * (total - 1)) / (limit - 1)));
  return [...selected].sort((a, b) => a - b);
}

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

  for (const c of chunks) {
    for (const s of c.sentences) {
      const sentence = c.text.slice(s.start, s.end).trim();
      if (!sentence) continue;
      const line = `[[${s.id}]] ${sentence}`;
      if (used + line.length > budget) {
        flush();
      }
      used += line.length;
      validIds.add(s.id);
      lines.push(line);
    }
  }
  flush();
  if (windows.length === 0) return [{ text: '', validIds: new Set() }];
  if (!Number.isFinite(maxWindows) || windows.length <= maxWindows) return windows;
  const count = Math.max(1, Math.floor(maxWindows));
  return evenlySpacedIndices(windows.length, count).map((index) => windows[index]);
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

export interface DocWindowsResult {
  windows: Array<{ text: string; charCount: number; sentenceCount: number }>;
}

/**
 * The exact sentence-tagged text of every extraction window for one document —
 * i.e. exactly what `buildRepoGraph` sends the model, in the same order and at
 * the same window indices `graph.docCoverage[docId]` refers to (both call
 * `windowDocChunks` the same way, with `maxWindows = Infinity`, so window N
 * here is window N there). Lets the graph UI show a user precisely what was
 * (or wasn't) extracted from, instead of a bare "the model found nothing" reason.
 */
export async function getDocWindows(repo: string, docId: string): Promise<{ ok: true; result: DocWindowsResult } | { ok: false; error: string }> {
  const chunksRes = await docChunks(repo, docId);
  if (!chunksRes.ok) return { ok: false, error: chunksRes.error || 'Could not read document chunks.' };
  const chunks = (chunksRes.result ?? []) as Array<{ text: string; sentences: CitableSentence[] }>;
  if (chunks.length === 0) return { ok: false, error: 'No chunks found for this document.' };
  const windows = windowDocChunks(chunks, PER_DOC_BUDGET_CHARS, Number.POSITIVE_INFINITY);
  return {
    ok: true,
    result: {
      windows: windows.map((w) => ({ text: w.text, charCount: w.text.length, sentenceCount: w.validIds.size })),
    },
  };
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
    { role: 'system', content: resolvePrompt(settings.promptOverrides, 'graphExtraction') },
    { role: 'user', content: taggedText },
  ];
  const reply = await complete(resolveModelForRole(settings, 'knowledgeGraph'), messages, undefined, signal);
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

/**
 * Detect topic communities and synthesize a grounded theme for each (GraphRAG
 * "global" sensemaking). One model call per community; failures skip that
 * community rather than aborting. Evidence ids are validated against the
 * community's own sentences.
 */
export async function summarizeCommunities(
  settings: Settings,
  graph: DocGraph,
  signal?: AbortSignal,
  maxCommunities: number | undefined = MAX_COMMUNITIES,
): Promise<CommunitySummary[]> {
  const raw = detectCommunities(graph, { minSize: COMMUNITY_MIN_SIZE, maxCommunities });
  const out: CommunitySummary[] = [];
  for (const comm of raw) {
    if (signal?.aborted) break;
    const { text, evidenceIds } = renderCommunityForModel(graph, comm);
    if (!text) continue;
    const valid = new Set(evidenceIds);
    try {
      const reply = await complete(
        resolveModelForRole(settings, 'knowledgeGraph'),
        [
          { role: 'system', content: resolvePrompt(settings.promptOverrides, 'communitySummary') },
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
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
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
  windowsTotal: number;
  windowsDone: number;
  mode: GraphCoverageMode;
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
  opts: {
    rebuild?: boolean;
    mode?: GraphCoverageMode;
    signal?: AbortSignal;
    onProgress?: (p: GraphBuildProgress) => void;
  } = {},
): Promise<GraphBuildResult> {
  const mode = opts.mode ?? 'quick';
  const snapshotRes = await graphSnapshot(repo);
  if (!snapshotRes.ok) return { ok: false, error: snapshotRes.error };
  const snapshot = snapshotRes.result as {
    docs?: Array<{ id: string; name: string }>;
    corpusRevision?: number;
  } | undefined;
  const docs = snapshot?.docs ?? [];
  const expectedRevision = snapshot?.corpusRevision ?? 0;
  if (docs.length === 0) return { ok: false, error: 'This repository has no documents to extract a graph from.' };

  let graph = emptyDocGraph();
  if (!opts.rebuild) {
    // Deliberately the *raw*, staleness-ungated read: this resumes the
    // incremental build (docCoverage, nodes, edges) on top of whatever graph
    // actually exists, even if it's behind the repo's current corpusRevision
    // (true any time a document was added/removed since it was last built).
    // Reading through the gated graphGet here would make every rebuild after
    // any corpus change silently discard all prior extraction work.
    const existing = await graphGetRaw(repo);
    if (!existing.ok) return { ok: false, error: existing.error };
    if (existing.result) graph = existing.result as DocGraph;
  }
  graph.corpusRevision = expectedRevision;
  graph.version = DOC_GRAPH_VERSION;
  graph.docCoverage ??= {};

  interface DocWork {
    doc: { id: string; name: string };
    windows: Array<{ text: string; validIds: Set<string> }>;
    targets: number[];
    coverage: GraphDocCoverage;
  }
  const work: DocWork[] = [];
  const setupErrors = new Map<string, string>();

  // Stable filename order prevents picker/filesystem enumeration from deciding
  // extraction priority. Model work below is interleaved one window per document.
  for (const doc of [...docs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    if (opts.signal?.aborted) break;
    let chunksRes;
    try {
      chunksRes = await docChunks(repo, doc.id, opts.signal);
    } catch (error) {
      if (opts.signal?.aborted) break;
      setupErrors.set(doc.id, error instanceof Error ? error.message : 'Could not read document chunks.');
      continue;
    }
    if (!chunksRes.ok) {
      setupErrors.set(doc.id, chunksRes.error || 'Could not read document chunks.');
      continue;
    }
    const chunks = (chunksRes.result ?? []) as Array<{ text: string; sentences: CitableSentence[] }>;
    // Content identity (not window count, which drifts with incidental
    // re-extraction/re-chunking) gates whether prior progress is trusted.
    const contentHash = shortHash(chunks.map((c) => c.text).join('\n'));
    const windows = windowDocChunks(chunks, PER_DOC_BUDGET_CHARS, Number.POSITIVE_INFINITY);
    const allIndices = windows.map((_, index) => index);
    const targets = mode === 'full' || graph.coverageMode === 'full'
      ? allIndices
      : evenlySpacedIndices(windows.length, MAX_WINDOWS_PER_DOC);
    const previous = graph.docCoverage[doc.id];
    const contentUnchanged = previous?.contentHash !== undefined && previous.contentHash === contentHash;
    const coverage: GraphDocCoverage = contentUnchanged
      ? previous
      : { totalWindows: windows.length, selectedWindows: [], completedWindows: [], failedWindows: [], contentHash };
    coverage.totalWindows = windows.length;
    coverage.contentHash = contentHash;
    // Union, not overwrite: a narrower (quick) sample must never erase memory
    // of windows a broader (full) build previously targeted — including ones
    // that failed — or a document can get marked complete/processed while a
    // window outside the current sample was never actually resolved.
    coverage.selectedWindows = Array.from(new Set([...coverage.selectedWindows, ...targets])).sort((a, b) => a - b);
    coverage.completedWindows = coverage.completedWindows.filter((index) => index < windows.length);
    coverage.failedWindows = coverage.failedWindows.filter((index) => index < windows.length);
    graph.docCoverage[doc.id] = coverage;
    const pending = targets.filter((index) => !coverage.completedWindows.includes(index));
    if (pending.length > 0) {
      graph.processedDocIds = graph.processedDocIds.filter((id) => id !== doc.id);
      work.push({ doc, windows, targets: pending, coverage });
    }
  }

  const report = (currentDoc?: string) =>
    opts.onProgress?.({
      docsTotal: docs.length,
      docsDone: graph.processedDocIds.length,
      currentDoc,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      windowsTotal: Object.values(graph.docCoverage ?? {}).reduce((sum, c) => sum + c.selectedWindows.length, 0),
      windowsDone: Object.values(graph.docCoverage ?? {}).reduce(
        (sum, c) => sum + c.selectedWindows.filter((index) => c.completedWindows.includes(index)).length,
        0,
      ),
      mode,
    });

  const stoppedResult = async (): Promise<GraphBuildResult> => {
    const setRes = await graphSet(repo, graph, expectedRevision);
    if (!setRes.ok) return { ok: false, error: setRes.error };
    report();
    return { ok: true, graph, warnings: ['Graph build stopped. Run the same mode again to resume from its window checkpoints.'] };
  };

  if (opts.signal?.aborted) return stoppedResult();

  for (const [docId, error] of setupErrors) markDocFailed(graph, docId, error);

  const maxPending = Math.max(0, ...work.map((item) => item.targets.length));
  for (let round = 0; round < maxPending; round++) {
    for (const item of work) {
      if (opts.signal?.aborted) break;
      const windowIndex = item.targets[round];
      if (windowIndex === undefined) continue;
      report(item.doc.name);
      const window = item.windows[windowIndex];
      let failure = '';
      try {
        if (window.validIds.size === 0) {
          failure = 'the selected window contained no citable sentences';
        } else {
          const outcome = await extractOneDoc(settings, window.text, window.validIds, opts.signal);
          if (outcome.ok) {
            mergeExtraction(graph, outcome.extraction, item.doc.id, { markProcessed: false });
            if (!item.coverage.completedWindows.includes(windowIndex)) item.coverage.completedWindows.push(windowIndex);
            item.coverage.failedWindows = item.coverage.failedWindows.filter((index) => index !== windowIndex);
          } else if (outcome.reason === 'empty') {
            // A valid, complete response with nothing to extract (e.g. a
            // references/qualification-table-only window) is not a failure —
            // completing it as-is stops one boilerplate window from dragging
            // an otherwise-successful document into the failed bucket. See
            // extractOneDoc's own doc comment: "callers decide how to treat
            // each" outcome reason.
            if (!item.coverage.completedWindows.includes(windowIndex)) item.coverage.completedWindows.push(windowIndex);
            item.coverage.failedWindows = item.coverage.failedWindows.filter((index) => index !== windowIndex);
          } else {
            failure = REASON_LABEL[outcome.reason];
          }
        }
      } catch (error) {
        if (opts.signal?.aborted) break;
        failure = error instanceof Error ? error.message : 'extraction failed';
      }
      if (failure) {
        if (!item.coverage.failedWindows.includes(windowIndex)) item.coverage.failedWindows.push(windowIndex);
        graph.docErrors ??= {};
        graph.docErrors[item.doc.id] = `Window ${windowIndex + 1}/${item.coverage.totalWindows}: ${failure}`;
      }
      const setRes = await graphSet(repo, graph, expectedRevision); // checkpoint every window
      if (!setRes.ok) return { ok: false, error: setRes.error };
    }
    if (opts.signal?.aborted) break;
  }

  if (opts.signal?.aborted) return stoppedResult();

  for (const doc of docs) {
    const coverage = graph.docCoverage[doc.id];
    if (!coverage) continue;
    const complete = coverage.selectedWindows.every((index) => coverage.completedWindows.includes(index));
    if (complete) markDocProcessed(graph, doc.id);
    else markDocFailed(graph, doc.id, graph.docErrors?.[doc.id] || 'one or more extraction windows failed');
  }
  if (!opts.signal?.aborted && graph.processedDocIds.length === docs.length) {
    if (mode === 'full' || graph.coverageMode !== 'full') graph.coverageMode = mode;
  }
  const coverageSet = await graphSet(repo, graph, expectedRevision);
  if (!coverageSet.ok) return { ok: false, error: coverageSet.error };

  // Once every document has been attempted (success or failure), cluster the
  // graph into themes (global sensemaking). Re-summarize when new docs were
  // processed, on an explicit rebuild, or when no themes exist yet.
  const attempted = graph.processedDocIds.length + (graph.failedDocIds?.length ?? 0);
  const allAttempted = attempted >= docs.length;
  const shouldSummarize = allAttempted && !opts.signal?.aborted && (opts.rebuild || !graph.communities || work.length > 0);
  if (shouldSummarize && graph.nodes.length > 0) {
    try {
      graph.communities = await summarizeCommunities(
        settings,
        graph,
        opts.signal,
        mode === 'full' ? undefined : MAX_COMMUNITIES,
      );
    } catch (error) {
      if (opts.signal?.aborted) return stoppedResult();
      throw error;
    }
    const setRes = await graphSet(repo, graph, expectedRevision);
    if (!setRes.ok) return { ok: false, error: setRes.error };
  }

  report();
  const warnings: string[] = [];
  if (graph.failedDocIds && graph.failedDocIds.length > 0) {
    warnings.push(
          `${graph.failedDocIds.length} document(s) could not be extracted: ${graph.failedDocIds
            .map((id) => docs.find((d) => d.id === id)?.name ?? id)
            .join(', ')}.`,
    );
  }
  if (mode === 'quick') {
    const omitted = Object.values(graph.docCoverage).reduce(
      (sum, coverage) => sum + Math.max(0, coverage.totalWindows - coverage.selectedWindows.length),
      0,
    );
    if (omitted > 0) warnings.push(`Quick coverage sampled across each document; ${omitted} window(s) require Full Coverage.`);
  }
  return { ok: true, graph, warnings: warnings.length > 0 ? warnings : undefined };
}
