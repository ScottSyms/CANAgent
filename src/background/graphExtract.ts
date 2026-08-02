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
import { coerceExtraction, emptyDocGraph, mergeExtraction, type DocExtraction, type DocGraph } from '../shared/docGraph';
import { docChunks, graphGet, graphSet, repoDocs } from './offscreenClient';

const PER_DOC_BUDGET_CHARS = 12000;

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
 * Render a document's chunks as sentence-tagged lines (`[[id]] sentence`) within a
 * char budget, returning the text plus the set of ids that actually appear — the
 * allow-list the extraction is validated against (fabricated ids are rejected).
 */
export function tagDocChunks(
  chunks: Array<{ text: string; sentences: CitableSentence[] }>,
  budget = PER_DOC_BUDGET_CHARS,
): { text: string; validIds: Set<string> } {
  const validIds = new Set<string>();
  const lines: string[] = [];
  let used = 0;
  for (const c of chunks) {
    for (const s of c.sentences) {
      const sentence = c.text.slice(s.start, s.end).trim();
      if (!sentence) continue;
      const line = `[[${s.id}]] ${sentence}`;
      if (used + line.length > budget) return { text: lines.join('\n'), validIds };
      used += line.length;
      validIds.add(s.id);
      lines.push(line);
    }
  }
  return { text: lines.join('\n'), validIds };
}

/** Extract one document's entities/relations from its sentence-tagged text. */
export async function extractOneDoc(
  settings: Settings,
  taggedText: string,
  validIds: Set<string>,
  signal?: AbortSignal,
): Promise<DocExtraction> {
  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: taggedText },
  ];
  const reply = await complete(resolveModelForRole(settings, 'utility'), messages, undefined, signal);
  let obj: unknown;
  try {
    obj = extractJsonObject(reply.content ?? '');
  } catch {
    return { entities: [], relations: [] };
  }
  return coerceExtraction(obj, validIds);
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
}

/**
 * Build (or resume/rebuild) the knowledge graph for a repository. Iterates the
 * documents not yet in `processedDocIds`, extracts each, merges into the graph,
 * and checkpoints after every document. A failed document is still marked
 * processed (a full rebuild re-attempts it) so a persistently-failing doc can't
 * stall the build.
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
    try {
      const chunksRes = await docChunks(repo, doc.id);
      const chunks = (chunksRes.ok ? chunksRes.result : []) as Array<{ text: string; sentences: CitableSentence[] }>;
      const { text, validIds } = tagDocChunks(chunks);
      if (validIds.size > 0) {
        const extraction = await extractOneDoc(settings, text, validIds, opts.signal);
        mergeExtraction(graph, extraction, doc.id);
      }
    } catch {
      // Extraction/model failure — fall through and still mark the doc processed.
    }
    if (!graph.processedDocIds.includes(doc.id)) graph.processedDocIds.push(doc.id);
    const setRes = await graphSet(repo, graph); // checkpoint after every doc
    if (!setRes.ok) return { ok: false, error: setRes.error };
  }
  report();
  return { ok: true, graph };
}
