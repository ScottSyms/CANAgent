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
import { complete, embedChunks, embedderId, LlmError, resolveModelForRole } from './llmProvider';
import { extractJsonObject } from './scopedSubtask';
import {
  coerceExtraction,
  DOC_GRAPH_VERSION,
  EMBED_MERGE_THRESHOLD,
  emptyDocGraph,
  markDocFailed,
  markDocProcessed,
  mergeExtraction,
  mergeSimilarNodes,
  retypeEdge,
  type CommunitySummary,
  type DocExtraction,
  type GraphCoverageMode,
  type GraphDocCoverage,
  type DocGraph,
  type GraphEdge,
  type GraphNode,
} from '../shared/docGraph';
import { detectCommunities, extractiveCommunitySummary, labelPropagate, renderCommunityForModel, type RawCommunity } from '../shared/graphCommunities';
import { buildSimilarityEdges, deriveClusterLabel, type ClusterChunk } from '../shared/chunkClusters';
import { buildCoOccurrenceExtraction, type NerSentenceSpan } from '../shared/nerAggregate';
import { docChunks, docVectors, graphGetRaw, graphSet, graphSnapshot, nerLocal } from './offscreenClient';
import { resolvePrompt } from '../shared/promptDefaults';
import { COMMUNITY_SUMMARY_SCHEMA, DOC_EXTRACTION_SCHEMA, RELATION_TYPING_SCHEMA } from '../shared/graphJsonSchemas';
import { resolveSentenceCitations } from './sentenceResolve';
import { dequantizeVector, normalizeVector } from '../shared/vectorSearch';
import { graphBuilding } from './graphBuildState';

// Halved from an earlier 12000: GraphRAG's own research found a small model
// extracts substantially more entities from a smaller chunk (roughly 2x more
// at 600 tokens vs. 2400) — a large window isn't just a truncation risk, it's
// also a recall problem. This still isn't sized for a genuinely low-context
// local model on its own; graphWindowChars (Settings/ModelProfile) is the
// surgical per-role override for that (see the workspace hint text pointing
// small/local setups at 2000-4000).
const PER_DOC_BUDGET_CHARS = 6000;
// Cap on how many budget-sized windows one document is split into, so a
// pathologically large doc (hundreds of pages) can't blow up build cost/latency.
// At the default budget this covers roughly the first ~20-25 pages of a typical
// PDF — an improvement over the prior single-window (~2-3 page) coverage, not a
// promise of full-document coverage for very large corpora.
const MAX_WINDOWS_PER_DOC = 6;
// Sentence-context mode's "windows" are one sentence each rather than
// PER_DOC_BUDGET_CHARS-sized, so the equivalent quick-mode sample needs a
// much larger count to cover a comparable amount of text. A reasonable quick
// sample, not an attempt to precisely match MAX_WINDOWS_PER_DOC's coverage —
// Full coverage remains the way to process every sentence.
const MAX_SENTENCE_WINDOWS_PER_DOC = 400;

// A window scoring below this on scoreWindowInformationValue's 0..1 scale is a
// pre-filter candidate to skip (never sent to the model). Applies to both
// Quick and Full builds — Full has no window cap today, so boilerplate is the
// biggest single driver of avoidable calls there.
const WINDOW_SKIP_SCORE_THRESHOLD = 0.25;
// Never skip more than half of a document's targeted windows, bounding damage
// from the heuristic misfiring on an unusual document genre.
const WINDOW_SKIP_CAP_RATIO = 0.5;

// How many independent LLM calls (window extractions, community summaries)
// run concurrently. Extraction used to be fully sequential — one window at a
// time across the ENTIRE build, regardless of document count — which was by
// far the dominant driver of wall-clock time (token cost is a separate axis
// the pre-filter/dedup/incremental-summary optimizations above address).
// Modest default to stay polite to rate-limited cloud endpoints.
const EXTRACTION_CONCURRENCY = 4;
export const COMMUNITY_CONCURRENCY = 4;

/**
 * Run `fn` over `items` in fixed-size concurrent batches, preserving output
 * order (each result lands at its input's index regardless of which call in
 * a batch settles first) — parallelizes independent LLM calls without
 * reordering the deterministic sequence callers/tests rely on.
 */
async function mapInBatches<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((item) => fn(item)));
    results.forEach((r, j) => {
      out[i + j] = r;
    });
  }
  return out;
}

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

// Defensive cap on a single sentence's length in sentence-context mode —
// guards against a pathologically long "sentence" (e.g. a PDF text
// extraction that merges several paragraphs with no detected sentence
// break), which would otherwise blow past a small model's context on its
// own regardless of how tightly context is trimmed around it.
const SENTENCE_MODE_MAX_SENTENCE_CHARS = 2000;

interface FlatSentence {
  id: string;
  text: string;
}

function flattenSentences(chunks: Array<{ text: string; sentences: CitableSentence[] }>): FlatSentence[] {
  const flat: FlatSentence[] = [];
  for (const c of chunks) {
    for (const s of c.sentences) {
      const text = c.text.slice(s.start, s.end).trim();
      if (!text) continue;
      flat.push({
        id: s.id,
        text: text.length > SENTENCE_MODE_MAX_SENTENCE_CHARS ? `${text.slice(0, SENTENCE_MODE_MAX_SENTENCE_CHARS)}…` : text,
      });
    }
  }
  return flat;
}

/**
 * Target-sentence-with-context extraction windows: one window per sentence in
 * the document, each formatted as CONTEXT BEFORE / TARGET / CONTEXT AFTER
 * sections (the `graphExtractionSentence` prompt instructs the model
 * accordingly). Bounds a single call's reasoning surface to the smallest
 * possible unit — one sentence — using its immediate neighbors only to
 * resolve pronouns/references, never as additional extraction targets. Costs
 * one call per sentence instead of one call per `graphWindowChars`, a very
 * different call-count profile the caller should account for in sampling.
 *
 * `validIds` is deliberately restricted to the target sentence's id alone —
 * an attempted citation of a context sentence is rejected by the same
 * validIds-filtering `coerceExtraction` already applies on the window-mode
 * path, with no new validation code needed.
 */
export function buildSentenceContextWindows(
  chunks: Array<{ text: string; sentences: CitableSentence[] }>,
  opts: { contextBefore?: number; contextAfter?: number } = {},
): Array<{ text: string; validIds: Set<string> }> {
  const contextBefore = Math.max(0, opts.contextBefore ?? 1);
  const contextAfter = Math.max(0, opts.contextAfter ?? 1);
  const flat = flattenSentences(chunks);
  if (flat.length === 0) return [{ text: '', validIds: new Set() }];

  const line = (s: FlatSentence) => `[[${s.id}]] ${s.text}`;

  return flat.map((target, i) => {
    const before = flat.slice(Math.max(0, i - contextBefore), i);
    const after = flat.slice(i + 1, i + 1 + contextAfter);
    const parts: string[] = [];
    if (before.length > 0) parts.push(`CONTEXT BEFORE:\n${before.map(line).join('\n')}`);
    parts.push(`TARGET:\n${line(target)}`);
    if (after.length > 0) parts.push(`CONTEXT AFTER:\n${after.map(line).join('\n')}`);
    return { text: parts.join('\n\n'), validIds: new Set([target.id]) };
  });
}

export interface DocWindowsResult {
  windows: Array<{ text: string; charCount: number; sentenceCount: number }>;
}

/**
 * The exact sentence-tagged text of every extraction window for one document —
 * i.e. exactly what `buildRepoGraph` sends the model, in the same order and at
 * the same window indices `graph.docCoverage[docId]` refers to (both resolve
 * the window strategy/budget from `settings` the same way, and both use
 * `maxWindows = Infinity`/full sentence coverage, so window N here is window
 * N there). Lets the graph UI show a user precisely what was (or wasn't)
 * extracted from, instead of a bare "the model found nothing" reason.
 * `settings`, when passed, resolves the Knowledge Graph role's
 * `graphWindowChars`/`graphExtractionStrategy` overrides so this preview
 * matches what a real build actually uses.
 */
export async function getDocWindows(
  repo: string,
  docId: string,
  settings?: Settings,
): Promise<{ ok: true; result: DocWindowsResult } | { ok: false; error: string }> {
  const chunksRes = await docChunks(repo, docId);
  if (!chunksRes.ok) return { ok: false, error: chunksRes.error || 'Could not read document chunks.' };
  const chunks = (chunksRes.result ?? []) as Array<{ text: string; sentences: CitableSentence[] }>;
  if (chunks.length === 0) return { ok: false, error: 'No chunks found for this document.' };
  const graphRoleSettings = settings ? resolveModelForRole(settings, 'knowledgeGraph') : undefined;
  const windows = graphRoleSettings?.graphExtractionStrategy === 'sentence'
    ? buildSentenceContextWindows(chunks, {
        contextBefore: graphRoleSettings.graphContextBefore ?? 1,
        contextAfter: graphRoleSettings.graphContextAfter ?? 1,
      })
    : windowDocChunks(chunks, graphRoleSettings?.graphWindowChars ?? PER_DOC_BUDGET_CHARS, Number.POSITIVE_INFINITY);
  return {
    ok: true,
    result: {
      windows: windows.map((w) => ({ text: w.text, charCount: w.text.length, sentenceCount: w.validIds.size })),
    },
  };
}

// A BERT-style token-classification model has a much smaller context window
// than the LLM extraction budget above (~512 wordpiece tokens) — this is
// deliberately conservative (well under the ~2000-2500 chars 512 tokens
// usually allows) so ordinary prose doesn't risk silent truncation.
const NER_WINDOW_BUDGET_CHARS = 1500;

// A real on-device inference call, not a network round-trip — but on the
// single-threaded WASM runtime this codebase deliberately uses for offscreen-
// document stability (see localNer.ts), each batch's forward passes still run
// as one uninterrupted synchronous stretch. Earlier revisions treated NER as
// having "no per-call cost to ration" and covered every window of every
// document uncapped; on a genuinely large document (hundreds of NER windows)
// that meant dozens of multi-second blocking stretches back to back, the
// root cause of "Quick build" appearing to hang. Capping per document, the
// same way the LLM tiers ration their window count, trades some recall on
// very large documents for a build that reliably finishes in bounded time —
// consistent with Quick's whole design point. "Full coverage" has no
// equivalent NER-only mode, so this cap doesn't affect it.
const MAX_NER_WINDOWS_PER_DOC = 60;

export interface NerWindow {
  /** Raw, untagged window text (no `[[id]]` markers — NER doesn't understand that grammar). */
  text: string;
  /** Each sentence's `[start, end)` span within `text`, for mapping an entity span back to the sentence it was found in. */
  sentences: NerSentenceSpan[];
}

/**
 * Like windowDocChunks, but for the NER backbone: raw concatenated sentence
 * text (sentences joined by a single space) instead of `[[id]] sentence`
 * tagged lines, plus each sentence's character span within that raw text —
 * the offset map buildCoOccurrenceExtraction needs to ground a recognized
 * entity span back to the sentence it came from. Samples evenly across the
 * whole document (see MAX_NER_WINDOWS_PER_DOC) rather than covering every
 * window unconditionally, for a bounded per-document inference cost.
 */
export function windowDocChunksForNer(
  chunks: Array<{ text: string; sentences: CitableSentence[] }>,
  budget = NER_WINDOW_BUDGET_CHARS,
  maxWindows = MAX_NER_WINDOWS_PER_DOC,
): NerWindow[] {
  const windows: NerWindow[] = [];
  let text = '';
  let sentences: NerSentenceSpan[] = [];
  const flush = () => {
    if (sentences.length === 0) return;
    windows.push({ text, sentences });
    text = '';
    sentences = [];
  };
  for (const c of chunks) {
    for (const s of c.sentences) {
      const sentence = c.text.slice(s.start, s.end).trim();
      if (!sentence) continue;
      if (text.length > 0 && text.length + 1 + sentence.length > budget) flush();
      if (text.length > 0) text += ' ';
      const start = text.length;
      text += sentence;
      sentences.push({ id: s.id, start, end: text.length });
    }
  }
  flush();
  if (windows.length === 0) return [{ text: '', sentences: [] }];
  if (!Number.isFinite(maxWindows) || windows.length <= maxWindows) return windows;
  const count = Math.max(1, Math.floor(maxWindows));
  return evenlySpacedIndices(windows.length, count).map((index) => windows[index]);
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'he', 'i', 'in', 'is', 'it', 'its', 'may', 'might', 'no', 'not', 'of',
  'on', 'or', 'she', 'should', 'so', 'such', 'than', 'that', 'the', 'their',
  'then', 'they', 'this', 'to', 'was', 'we', 'were', 'which', 'who', 'will',
  'with', 'would', 'you',
]);
const PROPER_NOUN_PHRASE_RE = /\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)+)\b/g;
const DIGIT_PUNCT_RE = /[0-9.·…\t]/g;

export interface WindowScore {
  /** 0..1, higher = more worth an extraction call. */
  score: number;
  wordsPerLine: number;
  properNounPhrases: number;
  digitPunctRatio: number;
  stopwordRatio: number;
  repeatedLineRatio: number;
}

/**
 * Cheap, deterministic, no-model proxy for "is this window worth an LLM
 * extraction call": combines sentence density, proper-noun-phrase density (an
 * entity proxy), digit/punctuation ratio (flags tables/TOCs/reference lists),
 * stopword ratio (bare lists read very differently from prose), and line
 * repetition (running headers/footers) — within this window, and across a
 * document's windows when `seenLines` is threaded through in window order.
 */
export function scoreWindowInformationValue(text: string, seenLines?: Set<string>): WindowScore {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^\[\[[^\]]+\]\]\s*/, '').trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { score: 0, wordsPerLine: 0, properNounPhrases: 0, digitPunctRatio: 0, stopwordRatio: 0, repeatedLineRatio: 0 };
  }

  const words = lines.flatMap((line) => line.split(/\s+/).filter(Boolean));
  const wordsPerLine = words.length / lines.length;

  let properNounPhrases = 0;
  for (const line of lines) properNounPhrases += line.match(PROPER_NOUN_PHRASE_RE)?.length ?? 0;

  const chars = lines.join('');
  const digitPunctRatio = chars.length > 0 ? (chars.match(DIGIT_PUNCT_RE)?.length ?? 0) / chars.length : 0;

  const stopwordCount = words.filter((w) => STOPWORDS.has(w.toLowerCase().replace(/[^a-z']/g, ''))).length;
  const stopwordRatio = words.length > 0 ? stopwordCount / words.length : 0;

  let repeated = 0;
  const localSeen = new Set<string>();
  for (const line of lines) {
    const norm = line.toLowerCase();
    // Only short lines act like running headers/footers/TOC entries — long
    // repeated prose (e.g. a refrain) shouldn't be penalized the same way.
    if (norm.length === 0 || norm.length > 80) continue;
    if (localSeen.has(norm) || seenLines?.has(norm)) repeated++;
    localSeen.add(norm);
    seenLines?.add(norm);
  }
  const repeatedLineRatio = repeated / lines.length;

  const densityScore = Math.min(1, wordsPerLine / 8);
  const properNounScore = Math.min(1, properNounPhrases / lines.length);
  const digitPunctScore = 1 - Math.min(1, digitPunctRatio * 4);
  const stopwordScore = stopwordRatio >= 0.15 && stopwordRatio <= 0.6 ? 1 : 0.3;
  const repeatedScore = 1 - Math.min(1, repeatedLineRatio);

  const score = densityScore * 0.35 + properNounScore * 0.2 + digitPunctScore * 0.2 + stopwordScore * 0.1 + repeatedScore * 0.15;

  return { score, wordsPerLine, properNounPhrases, digitPunctRatio, stopwordRatio, repeatedLineRatio };
}

export type ExtractOutcome =
  | { ok: true; extraction: DocExtraction; content: string }
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
 * `promptKey` selects which extraction prompt frames the task — the default
 * multi-sentence-window prompt, or `graphExtractionSentence` for
 * target-sentence-with-context mode (buildSentenceContextWindows). An empty
 * extraction is a normal, frequent outcome in sentence mode (most individual
 * sentences have nothing to extract) — see the `'empty'` outcome's caller
 * treatment, already a non-failure, in buildRepoGraph's round loop.
 */
export async function extractOneDoc(
  settings: Settings,
  taggedText: string,
  validIds: Set<string>,
  signal?: AbortSignal,
  promptKey: 'graphExtraction' | 'graphExtractionSentence' = 'graphExtraction',
): Promise<ExtractOutcome> {
  const messages: LlmMessage[] = [
    { role: 'system', content: resolvePrompt(settings.promptOverrides, promptKey) },
    { role: 'user', content: taggedText },
  ];
  let content: string;
  try {
    const reply = await complete(resolveModelForRole(settings, 'knowledgeGraph'), messages, undefined, signal, undefined, DOC_EXTRACTION_SCHEMA);
    content = reply.content ?? '';
  } catch (err) {
    // A provider-reported output/context-limit failure (e.g. chat-completions'
    // finish_reason:'length', the exact failure a small local model hits on a
    // dense window) still carries whatever content the model DID produce —
    // see LlmError.content's doc comment. Recover it instead of losing it, so
    // the truncation classification/adaptive-retry below still gets a chance
    // to run, instead of this window failing outright with no recovery
    // attempt at all. Any other failure (network error, auth, a provider that
    // truly returned nothing) has no content to recover and must propagate.
    if (err instanceof LlmError && err.content != null) {
      content = err.content;
    } else {
      throw err;
    }
  }
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
  return { ok: true, extraction, content };
}

/**
 * GraphRAG's "gleaning" technique: one follow-up call on the SAME window,
 * continuing the model's own first exchange (not a fresh call re-describing
 * what was already found), asking it to report only what it missed. Small
 * models extract noticeably more from a smaller window in one pass, but
 * gleaning recovers additional recall without needing a bigger window at all.
 * Best-effort — any failure here (bad JSON, empty, network error) just means
 * nothing extra was recovered; it never turns an already-successful window
 * into a failure, so callers should ignore errors rather than propagate them.
 */
async function extractGleaningPass(
  settings: Settings,
  taggedText: string,
  validIds: Set<string>,
  firstResponseContent: string,
  signal?: AbortSignal,
): Promise<DocExtraction | undefined> {
  try {
    const messages: LlmMessage[] = [
      { role: 'system', content: resolvePrompt(settings.promptOverrides, 'graphExtraction') },
      { role: 'user', content: taggedText },
      { role: 'assistant', content: firstResponseContent },
      { role: 'user', content: resolvePrompt(settings.promptOverrides, 'graphExtractionGleaning') },
    ];
    const reply = await complete(resolveModelForRole(settings, 'knowledgeGraph'), messages, undefined, signal, undefined, DOC_EXTRACTION_SCHEMA);
    const obj = extractJsonObject(reply.content ?? '');
    const extraction = coerceExtraction(obj, validIds);
    if (extraction.entities.length === 0 && extraction.relations.length === 0) return undefined;
    return extraction;
  } catch {
    return undefined;
  }
}

// How many times a truncated window gets halved-and-retried before giving up
// on it. Depth 2 means a window can shrink to 1/4 its original size (two
// halvings) — enough to recover a window whose *last* portion (a dense
// references/appendix section, in practice the single most common cause)
// pushed the model's output past its max-token limit, without unboundedly
// retrying a document that's genuinely too dense for the configured model.
const MAX_TRUNCATION_SPLIT_DEPTH = 2;

/**
 * Split a `[[id]] sentence`-tagged window's text (windowDocChunks's format —
 * one sentence per line) into two roughly-equal halves by line count, for
 * retrying a truncated window with less input. A window's expected output
 * size scales with how much it asks the model to extract, so sending half the
 * sentences is the direct lever available to shrink a response that didn't
 * fit — raising maxTokens doesn't help when the server's total context is the
 * binding constraint (see windowBudget's doc comment above). Returns `null`
 * when there's nothing left to split (one line, or none) so the caller can
 * fall back to reporting the failure as-is.
 */
export function splitTaggedWindow(
  text: string,
  validIds: Set<string>,
): [{ text: string; validIds: Set<string> }, { text: string; validIds: Set<string> }] | null {
  const lines = text.split('\n').filter((line) => line.length > 0);
  if (lines.length < 2) return null;
  const mid = Math.ceil(lines.length / 2);
  const idPattern = /^\[\[([^\]]+)\]\]/;
  const half = (lines: string[]) => {
    const ids = new Set<string>();
    for (const line of lines) {
      const m = idPattern.exec(line);
      if (m && validIds.has(m[1])) ids.add(m[1]);
    }
    return { text: lines.join('\n'), validIds: ids };
  };
  return [half(lines.slice(0, mid)), half(lines.slice(mid))];
}

/**
 * extractOneDoc with adaptive recovery for a truncated or unparseable
 * response: split the window in half and retry each half independently
 * (recursively, up to MAX_TRUNCATION_SPLIT_DEPTH), instead of just failing
 * the whole window. Applies to both `'truncated'` (the model ran out of
 * output tokens — less input directly shrinks the expected output) and
 * `'parse_error'` (the model returned something that isn't valid JSON at
 * all — a small model is more likely to lose the format on a longer,
 * denser prompt, so the same shrink-and-retry is a reasonable recovery
 * there too). Only applies to window-mode text (`[[id]] sentence` lines,
 * one per line) — sentence mode's CONTEXT BEFORE/TARGET/CONTEXT AFTER
 * structure can't be split this way and is already small enough that
 * either failure is rare, so callers should only use this for
 * `promptKey === 'graphExtraction'`. Returns every extraction obtained (0,
 * 1, or up to 2^depth from partial splits) plus a failure reason only when
 * NOTHING could be recovered at all.
 *
 * `glean`, when true, runs one gleaning follow-up (extractGleaningPass) after
 * a successful first-pass extraction — but ONLY at `depth === 0`, i.e. never
 * on a window recovered via the truncation-retry split. This keeps the two
 * techniques from compounding: gleaning improves recall on a window that
 * already succeeded outright; splitting recovers a window that failed. A
 * split sub-window gleaning too would let one troublesome window balloon
 * into an unbounded number of extra calls.
 */
export async function extractWindowAdaptive(
  settings: Settings,
  window: { text: string; validIds: Set<string> },
  signal: AbortSignal | undefined,
  depth = 0,
  glean = false,
): Promise<{ extractions: DocExtraction[]; failure?: 'truncated' | 'parse_error' | 'empty' }> {
  const outcome = await extractOneDoc(settings, window.text, window.validIds, signal, 'graphExtraction');
  if (outcome.ok) {
    const extractions = [outcome.extraction];
    if (glean && depth === 0) {
      const gleaned = await extractGleaningPass(settings, window.text, window.validIds, outcome.content, signal);
      if (gleaned) extractions.push(gleaned);
    }
    return { extractions };
  }
  if (outcome.reason === 'empty') return { extractions: [] };
  if ((outcome.reason === 'truncated' || outcome.reason === 'parse_error') && depth < MAX_TRUNCATION_SPLIT_DEPTH) {
    const halves = splitTaggedWindow(window.text, window.validIds);
    if (halves) {
      const [a, b] = await Promise.all(halves.map((h) => extractWindowAdaptive(settings, h, signal, depth + 1)));
      const extractions = [...a.extractions, ...b.extractions];
      // Recovered (fully or partially) if at least one half came back clean —
      // the other half's failure, if any, is folded into the parent's
      // reported reason only when literally nothing was recovered anywhere.
      if (!a.failure || !b.failure) return { extractions };
      return { extractions, failure: a.failure };
    }
  }
  return { extractions: [], failure: outcome.reason };
}

/**
 * Extract entities + co-occurrence relations from every window of one
 * document via the on-device NER pipeline, in a single offscreen round-trip
 * (nerLocal batches every input text into one message, unlike the per-window
 * LLM calls extractOneDoc makes). Throws on a pipeline/runtime failure so the
 * caller can decide how to report it against the whole document.
 */
async function extractEntitiesForDoc(windows: NerWindow[], signal?: AbortSignal): Promise<DocExtraction[]> {
  if (windows.length === 0) return [];
  const res = await nerLocal(windows.map((w) => w.text), undefined, signal);
  if (!res.ok || !res.spans) throw new Error(res.error || 'Local NER extraction failed.');
  return windows.map((w, i) => buildCoOccurrenceExtraction(w.text, w.sentences, res.spans?.[i] ?? []));
}

export const MAX_COMMUNITIES = 12;
const COMMUNITY_MIN_SIZE = 3;

/**
 * Second-pass fuzzy entity merge using the extension's existing free,
 * on-device embedder (the same one used for RAG chunks — no new dependency,
 * no external call). Runs once per build round, after this round's
 * exact-label merges (`mergeExtraction`) and before community detection.
 * Only embeds nodes lacking `.embedding` (new, or invalidated by an embedder
 * change) — a stable incremental update with no new entities makes zero
 * embedding calls.
 */
export async function dedupeEntitiesByEmbedding(
  settings: Settings,
  graph: DocGraph,
  signal?: AbortSignal,
): Promise<{ mergedCount: number; idRemap: Map<string, string> }> {
  const currentModel = embedderId(settings);
  if (graph.embedModel && graph.embedModel !== currentModel) {
    // Stale/incomparable — self-heal by recomputing rather than erroring;
    // this is a build-time optimization, not a query-time correctness path.
    for (const n of graph.nodes) n.embedding = undefined;
  }

  const candidates = graph.nodes.filter((n) => !n.embedding);
  if (candidates.length === 0 && graph.embedModel === currentModel) {
    return { mergedCount: 0, idRemap: new Map() };
  }
  if (candidates.length > 0) {
    const texts = candidates.map((n) => `${n.label} — ${n.summary}`.trim());
    const vectors = await embedChunks(settings, texts, signal);
    candidates.forEach((n, i) => {
      n.embedding = normalizeVector(vectors[i]);
    });
    graph.embedModel = currentModel;
  }

  const embeddings = new Map(graph.nodes.filter((n) => n.embedding).map((n) => [n.id, n.embedding!]));
  return mergeSimilarNodes(graph, embeddings, { threshold: EMBED_MERGE_THRESHOLD });
}

// Cap on how many "co-occurs with" edges one relation-typing enrichment pass
// upgrades to a real relationship — fixed regardless of corpus size, so this
// (together with MAX_COMMUNITIES) bounds the fast/"Quick" build's total LLM
// call count to a constant instead of one that scales with document count.
export const MAX_RELATION_TYPING_EDGES = 50;
export const RELATION_TYPING_CONCURRENCY = 4;
const GENERIC_RELATION = 'co-occurs with';

/**
 * Pick which generic co-occurrence edges are worth a real LLM call: ranked by
 * the sum of both endpoints' degree (a cheap proxy for "connects two
 * well-connected, likely-important entities"), ties broken by edge id for
 * determinism. Capped at `limit` regardless of how many co-occurrence edges
 * the NER backbone produced.
 */
function selectEdgesForRelationTyping(graph: DocGraph, limit: number): GraphEdge[] {
  const candidates = graph.edges.filter((e) => normLabelForCompare(e.relation) === GENERIC_RELATION);
  if (candidates.length <= limit) return candidates;
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const score = (e: GraphEdge) => (degree.get(e.from) ?? 0) + (degree.get(e.to) ?? 0);
  return [...candidates].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)).slice(0, limit);
}

function normLabelForCompare(relation: string): string {
  return relation.toLowerCase().trim();
}

async function typeOneRelation(
  settings: Settings,
  fromNode: GraphNode,
  toNode: GraphNode,
  evidenceText: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const userMsg =
    `Entity A: ${fromNode.label} (${fromNode.type})\n` +
    `Entity B: ${toNode.label} (${toNode.type})\n` +
    `Shared sentence: ${evidenceText}`;
  try {
    const reply = await complete(
      resolveModelForRole(settings, 'knowledgeGraph'),
      [
        { role: 'system', content: resolvePrompt(settings.promptOverrides, 'graphRelationTyping') },
        { role: 'user', content: userMsg },
      ],
      undefined,
      signal,
      undefined,
      RELATION_TYPING_SCHEMA,
    );
    const obj = extractJsonObject(reply.content ?? '') as { relation?: unknown };
    const relation = typeof obj.relation === 'string' ? obj.relation.trim() : '';
    return relation && normLabelForCompare(relation) !== GENERIC_RELATION ? relation.slice(0, 60) : undefined;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return undefined; // Model/parse failure for this edge — leave it generic.
  }
}

/**
 * Upgrade a capped, corpus-size-independent number of the NER backbone's
 * generic "co-occurs with" edges to a real relationship, via one short LLM
 * call per selected edge (batched at RELATION_TYPING_CONCURRENCY). This is
 * one of exactly two sources of network/LLM calls in the fast/"Quick" build
 * pipeline (the other is summarizeCommunities) — together they bound total
 * LLM calls to a fixed ceiling regardless of how many documents are in the
 * notebook, which is what makes a bounded build time possible for a small,
 * low-context local model.
 */
export async function enrichRelationTypes(
  settings: Settings,
  repo: string,
  graph: DocGraph,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<{ upgradedCount: number }> {
  const edges = selectEdgesForRelationTyping(graph, opts.limit ?? MAX_RELATION_TYPING_EDGES);
  if (edges.length === 0) return { upgradedCount: 0 };

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const evidenceIds = [...new Set(edges.flatMap((e) => e.evidenceSentenceIds))];
  const citations = await resolveSentenceCitations(repo, evidenceIds);
  const sentenceText = new Map(citations.map((c) => [c.sentenceId, c.sentenceText]));

  const results = await mapInBatches(edges, RELATION_TYPING_CONCURRENCY, async (edge) => {
    if (opts.signal?.aborted) return undefined;
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    if (!fromNode || !toNode) return undefined;
    const evidenceText = edge.evidenceSentenceIds
      .map((id) => sentenceText.get(id))
      .filter((t): t is string => !!t)
      .join(' ');
    if (!evidenceText) return undefined;
    const relation = await typeOneRelation(settings, fromNode, toNode, evidenceText, opts.signal);
    return relation ? { edge, relation } : undefined;
  });

  let upgradedCount = 0;
  for (const r of results) {
    if (!r) continue;
    retypeEdge(graph, r.edge, r.relation);
    upgradedCount++;
  }
  return { upgradedCount };
}

/**
 * Summarize a single community via the model. Returns `undefined` on a
 * model/parse failure or an empty result — same "skip this one" treatment
 * `summarizeCommunities` has always given a failed community, just factored
 * out so `summarizeCommunitiesIncremental` can share it.
 */
async function summarizeOneCommunity(
  settings: Settings,
  graph: DocGraph,
  comm: RawCommunity,
  signal?: AbortSignal,
): Promise<CommunitySummary | undefined> {
  const { text, evidenceIds } = renderCommunityForModel(graph, comm);
  if (!text) return undefined;
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
      undefined,
      COMMUNITY_SUMMARY_SCHEMA,
    );
    const obj = extractJsonObject(reply.content ?? '') as { title?: unknown; summary?: unknown; evidence?: unknown };
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    const evidence = Array.isArray(obj.evidence)
      ? obj.evidence.filter((x): x is string => typeof x === 'string' && valid.has(x))
      : [];
    if (!title && !summary) return undefined;
    return {
      id: comm.id,
      title: title || 'Untitled theme',
      summary,
      nodeIds: comm.nodeIds,
      evidenceSentenceIds: evidence.length > 0 ? evidence : evidenceIds.slice(0, 8),
      method: 'llm',
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return undefined; // Model/parse failure for this community — skip it.
  }
}

/**
 * Detect topic communities and synthesize a grounded theme for each (GraphRAG
 * "global" sensemaking). One model call per community; failures skip that
 * community rather than aborting. Evidence ids are validated against the
 * community's own sentences. Used for full rebuilds and first-ever builds,
 * where every community needs a fresh abstractive summary.
 */
export async function summarizeCommunities(
  settings: Settings,
  graph: DocGraph,
  signal?: AbortSignal,
  maxCommunities: number | undefined = MAX_COMMUNITIES,
): Promise<CommunitySummary[]> {
  const raw = detectCommunities(graph, { minSize: COMMUNITY_MIN_SIZE, maxCommunities });
  const results = await mapInBatches(raw, COMMUNITY_CONCURRENCY, async (comm) => {
    if (signal?.aborted) return undefined;
    return summarizeOneCommunity(settings, graph, comm, signal);
  });
  return results.filter((c): c is CommunitySummary => !!c);
}

/**
 * Incremental variant: only communities containing at least one node from
 * `touchedNodeIds` get a fresh LLM (abstractive) summary; every other
 * community keeps a deterministic extractive summary instead — avoiding the
 * single biggest per-update cost (re-summarizing every community from
 * scratch on any incremental "Quick update").
 */
export async function summarizeCommunitiesIncremental(
  settings: Settings,
  graph: DocGraph,
  touchedNodeIds: ReadonlySet<string>,
  signal?: AbortSignal,
  maxCommunities: number | undefined = MAX_COMMUNITIES,
): Promise<CommunitySummary[]> {
  const raw = detectCommunities(graph, { minSize: COMMUNITY_MIN_SIZE, maxCommunities });
  return mapInBatches(raw, COMMUNITY_CONCURRENCY, async (comm) => {
    if (signal?.aborted) return extractiveCommunitySummary(graph, comm);
    const touched = comm.nodeIds.some((id) => touchedNodeIds.has(id));
    const summarized = touched ? await summarizeOneCommunity(settings, graph, comm, signal) : undefined;
    return summarized ?? extractiveCommunitySummary(graph, comm);
  });
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

  // A small/low-context local model (e.g. assigned to the Knowledge Graph
  // role specifically) may need a much smaller input window than the default
  // so one window's input plus its requested output together fit inside the
  // model server's actual context — raising maxTokens alone doesn't help if
  // the server's total context, not the requested output length, is the
  // binding constraint. Resolved once per build, not per window.
  const graphRoleSettings = resolveModelForRole(settings, 'knowledgeGraph');
  const windowBudget = graphRoleSettings.graphWindowChars ?? PER_DOC_BUDGET_CHARS;
  // Sentence-context mode bounds each call to one target sentence (plus a
  // little read-only neighbor context) instead of many sentences per window —
  // see buildSentenceContextWindows's doc comment. Best-suited to very small
  // models that struggle with a multi-sentence window's combined reasoning
  // and output-length demands.
  const useSentenceMode = graphRoleSettings.graphExtractionStrategy === 'sentence';
  const sentenceContextBefore = graphRoleSettings.graphContextBefore ?? 1;
  const sentenceContextAfter = graphRoleSettings.graphContextAfter ?? 1;
  const extractionPromptKey = useSentenceMode ? 'graphExtractionSentence' : 'graphExtraction';
  // Gleaning only applies to window mode (see extractWindowAdaptive's doc
  // comment) — absent = enabled.
  const gleaningEnabled = !useSentenceMode && graphRoleSettings.graphGleaningEnabled !== false;

  interface DocWork {
    doc: { id: string; name: string };
    windows: Array<{ text: string; validIds: Set<string> }>;
    targets: number[];
    coverage: GraphDocCoverage;
    /** Target window indices the pre-filter decided not to send to the model. */
    skipWindows: Set<number>;
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
    const windows = useSentenceMode
      ? buildSentenceContextWindows(chunks, { contextBefore: sentenceContextBefore, contextAfter: sentenceContextAfter })
      : windowDocChunks(chunks, windowBudget, Number.POSITIVE_INFINITY);
    const allIndices = windows.map((_, index) => index);
    const targets = mode === 'full' || graph.coverageMode === 'full'
      ? allIndices
      : evenlySpacedIndices(windows.length, useSentenceMode ? MAX_SENTENCE_WINDOWS_PER_DOC : MAX_WINDOWS_PER_DOC);
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

      // Low-information pre-filter: score each targeted window and mark the
      // worst-scoring ones (below threshold, capped at half the doc's target
      // count, never the first/last targeted window) to skip without a model
      // call. Scored in target order so cross-window repeated-line detection
      // (running headers/footers) sees the same sequence that will be sent.
      // Skipped entirely in sentence mode: each "window" there is already a
      // single atomic sentence deliberately targeted by the sampling/full
      // list, not an arbitrary blob that might mix boilerplate with content —
      // and the heuristic (word density, line repetition) was tuned for
      // multi-sentence text, not a one-line target plus CONTEXT BEFORE/AFTER
      // labels, which would confuse it.
      const sortedTargets = [...targets].sort((a, b) => a - b);
      const boundaryTargets = new Set(
        sortedTargets.length > 0 ? [sortedTargets[0], sortedTargets[sortedTargets.length - 1]] : [],
      );
      const seenLines = new Set<string>();
      const pendingSet = new Set(pending);
      const skipCandidates: Array<{ index: number; score: number }> = [];
      if (!useSentenceMode) {
        for (const index of sortedTargets) {
          const { score } = scoreWindowInformationValue(windows[index].text, seenLines);
          if (pendingSet.has(index) && !boundaryTargets.has(index) && score < WINDOW_SKIP_SCORE_THRESHOLD) {
            skipCandidates.push({ index, score });
          }
        }
      }
      const skipWindows = new Set(
        skipCandidates
          .sort((a, b) => a.score - b.score)
          .slice(0, Math.floor(sortedTargets.length * WINDOW_SKIP_CAP_RATIO))
          .map((c) => c.index),
      );

      work.push({ doc, windows, targets: pending, coverage, skipWindows });
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

  // Node ids touched (created/re-merged) by this call's extraction — read by
  // the incremental community-summarization step below to decide which
  // communities need a fresh LLM pass vs. an extractive one.
  const roundTouchedNodeIds = new Set<string>();

  // Every pending window across every document, flattened into one list —
  // NOT grouped/interleaved by document — so a notebook with many documents
  // AND a notebook with one huge document both get the same concurrency
  // benefit (the old per-document round-robin only parallelized across
  // documents, which did nothing for a single-document build).
  const pendingWindows: Array<{ item: DocWork; windowIndex: number }> = [];
  for (const item of work) for (const windowIndex of item.targets) pendingWindows.push({ item, windowIndex });

  for (let i = 0; i < pendingWindows.length; i += EXTRACTION_CONCURRENCY) {
    if (opts.signal?.aborted) break;
    const batch = pendingWindows.slice(i, i + EXTRACTION_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ item, windowIndex }) => {
        if (opts.signal?.aborted) return;
        report(item.doc.name);
        const window = item.windows[windowIndex];
        let failure = '';
        const markWindowDone = () => {
          if (!item.coverage.completedWindows.includes(windowIndex)) item.coverage.completedWindows.push(windowIndex);
          item.coverage.failedWindows = item.coverage.failedWindows.filter((index) => index !== windowIndex);
        };
        if (item.skipWindows.has(windowIndex)) {
          item.coverage.skippedWindows = Array.from(new Set([...(item.coverage.skippedWindows ?? []), windowIndex]));
          markWindowDone();
        } else {
          try {
            if (window.validIds.size === 0) {
              failure = 'the selected window contained no citable sentences';
            } else if (extractionPromptKey === 'graphExtraction') {
              // Window mode can recover from a truncated response by retrying
              // with half the sentences (see extractWindowAdaptive) — sentence
              // mode's CONTEXT BEFORE/TARGET/CONTEXT AFTER structure can't be
              // split this way, so it goes through the plain path below.
              const result = await extractWindowAdaptive(settings, window, opts.signal, 0, gleaningEnabled);
              for (const extraction of result.extractions) {
                mergeExtraction(graph, extraction, item.doc.id, { markProcessed: false, touchedNodeIds: roundTouchedNodeIds });
              }
              if (result.extractions.length > 0 || !result.failure) {
                // Recovered (fully, or with something extracted from at least
                // one half after a split) or genuinely empty — either way
                // there's nothing left to retry for this window.
                markWindowDone();
              } else {
                failure = REASON_LABEL[result.failure];
              }
            } else {
              const outcome = await extractOneDoc(settings, window.text, window.validIds, opts.signal, extractionPromptKey);
              if (outcome.ok) {
                mergeExtraction(graph, outcome.extraction, item.doc.id, { markProcessed: false, touchedNodeIds: roundTouchedNodeIds });
                markWindowDone();
              } else if (outcome.reason === 'empty') {
                // A valid, complete response with nothing to extract (e.g. a
                // references/qualification-table-only window) is not a failure —
                // completing it as-is stops one boilerplate window from dragging
                // an otherwise-successful document into the failed bucket. See
                // extractOneDoc's own doc comment: "callers decide how to treat
                // each" outcome reason.
                markWindowDone();
              } else {
                failure = REASON_LABEL[outcome.reason];
              }
            }
          } catch (error) {
            if (opts.signal?.aborted) return;
            failure = error instanceof Error ? error.message : 'extraction failed';
          }
        }
        if (failure) {
          if (!item.coverage.failedWindows.includes(windowIndex)) item.coverage.failedWindows.push(windowIndex);
          graph.docErrors ??= {};
          graph.docErrors[item.doc.id] = `Window ${windowIndex + 1}/${item.coverage.totalWindows}: ${failure}`;
        }
      }),
    );
    // One checkpoint per concurrent batch instead of one per window — fewer
    // round-trips, and safe because JS's single-threaded execution means the
    // graph mutations above never actually race even though their network
    // calls overlapped in flight.
    const setRes = await graphSet(repo, graph, expectedRevision);
    if (!setRes.ok) return { ok: false, error: setRes.error };
  }

  if (opts.signal?.aborted) return stoppedResult();

  // A document is only reported as failed when NOTHING was extracted from
  // it. A document where most windows succeeded and only a few (typically a
  // dense references/appendix section near the end) couldn't be recovered
  // even after extractWindowAdaptive's retries still has real, useful data
  // merged into the graph — reporting it as "extraction failed" would be
  // actively misleading. That case is instead reported as a per-doc warning
  // (partialDocWarnings, folded into the final warnings list below) while the
  // document itself counts as processed.
  const partialDocWarnings: string[] = [];
  for (const doc of docs) {
    const coverage = graph.docCoverage[doc.id];
    if (!coverage) continue;
    const completedCount = coverage.selectedWindows.filter((index) => coverage.completedWindows.includes(index)).length;
    const totalSelected = coverage.selectedWindows.length;
    if (completedCount === totalSelected) {
      markDocProcessed(graph, doc.id);
    } else if (completedCount > 0) {
      const failedCount = totalSelected - completedCount;
      partialDocWarnings.push(
        `${doc.name}: ${failedCount} of ${totalSelected} window(s) failed extraction (${graph.docErrors?.[doc.id] ?? 'see details'}) — entities from the other ${completedCount} window(s) were still added.`,
      );
      markDocProcessed(graph, doc.id);
    } else {
      markDocFailed(graph, doc.id, graph.docErrors?.[doc.id] || 'one or more extraction windows failed');
    }
  }
  if (!opts.signal?.aborted && graph.processedDocIds.length === docs.length) {
    if (mode === 'full' || graph.coverageMode !== 'full') graph.coverageMode = mode;
  }
  const coverageSet = await graphSet(repo, graph, expectedRevision);
  if (!coverageSet.ok) return { ok: false, error: coverageSet.error };

  // Fold this round's touched nodes into the persisted dirty set (survives
  // interrupted/resumed builds), then run the embedding-based fuzzy merge —
  // reusing the extension's existing free, on-device embedder — before
  // community detection, so a freshly-detected community never references a
  // node id that just got merged away.
  graph.dirtyNodeIds = [...new Set([...(graph.dirtyNodeIds ?? []), ...roundTouchedNodeIds])];
  if (!opts.signal?.aborted && graph.nodes.length > 0) {
    try {
      const dedup = await dedupeEntitiesByEmbedding(settings, graph, opts.signal);
      for (const [absorbedId, keepId] of dedup.idRemap) {
        roundTouchedNodeIds.delete(absorbedId);
        roundTouchedNodeIds.add(keepId);
      }
      if (dedup.mergedCount > 0) {
        const dedupSet = await graphSet(repo, graph, expectedRevision);
        if (!dedupSet.ok) return { ok: false, error: dedupSet.error };
      }
    } catch (error) {
      if (opts.signal?.aborted) return stoppedResult();
      throw error;
    }
  }

  // Once every document has been attempted (success or failure), cluster the
  // graph into themes (global sensemaking). Re-summarize when new docs were
  // processed, on an explicit rebuild, or when no themes exist yet. A full
  // rebuild/first-ever-build/full-mode build gets a fresh LLM summary for
  // every community; an incremental update only spends an LLM call on
  // communities the dirty set actually touched, falling back to a
  // deterministic extractive summary for the rest.
  const attempted = graph.processedDocIds.length + (graph.failedDocIds?.length ?? 0);
  const allAttempted = attempted >= docs.length;
  const shouldSummarize = allAttempted && !opts.signal?.aborted && (opts.rebuild || !graph.communities || work.length > 0);
  if (shouldSummarize && graph.nodes.length > 0) {
    const useLlmForAll = opts.rebuild || mode === 'full' || !graph.communities;
    try {
      if (useLlmForAll) {
        graph.communities = await summarizeCommunities(
          settings,
          graph,
          opts.signal,
          mode === 'full' ? undefined : MAX_COMMUNITIES,
        );
        graph.dirtyNodeIds = [];
      } else {
        const dirty = new Set(graph.dirtyNodeIds ?? []);
        graph.communities = await summarizeCommunitiesIncremental(settings, graph, dirty, opts.signal, MAX_COMMUNITIES);
        // Only clear dirty ids whose community actually got a fresh LLM
        // summary this pass — a community that stayed extractive keeps its
        // members dirty so a later build still owes it an abstractive pass.
        const stillDirty = new Set(dirty);
        for (const c of graph.communities) {
          if (c.method === 'llm') for (const id of c.nodeIds) stillDirty.delete(id);
        }
        graph.dirtyNodeIds = [...stillDirty];
      }
    } catch (error) {
      if (opts.signal?.aborted) return stoppedResult();
      throw error;
    }
    const setRes = await graphSet(repo, graph, expectedRevision);
    if (!setRes.ok) return { ok: false, error: setRes.error };
  }

  report();
  const warnings: string[] = [...partialDocWarnings];
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
  const skippedWindowCount = Object.values(graph.docCoverage).reduce((sum, c) => sum + (c.skippedWindows?.length ?? 0), 0);
  if (skippedWindowCount > 0) {
    warnings.push(`${skippedWindowCount} window(s) skipped as low-information (boilerplate/headers/tables) — no model call made.`);
  }
  return { ok: true, graph, warnings: warnings.length > 0 ? warnings : undefined };
}

export interface GraphBuildBackboneProgress {
  docsTotal: number;
  docsDone: number;
  currentDoc?: string;
  nodes: number;
  edges: number;
}

type NerBackboneResult =
  | { status: 'ok'; touchedNodeIds: Set<string>; warnings: string[] }
  | { status: 'aborted'; warnings: string[] }
  | { status: 'error'; error: string };

/**
 * The on-device NER backbone of the default Quick tier (buildRepoGraphQuick):
 * extract entities + co-occurrence edges from every changed document via
 * on-device NER (zero network calls — see buildCoOccurrenceExtraction's doc
 * comment for why co-occurrence stands in for real relationship extraction
 * and its limits), merge into `graph`, then fuzzy-dedup entities by
 * embedding. Covers every window of every document — no sampling, since
 * there's no per-call cost to ration the way an LLM-extraction pass does.
 * Mutates `graph` in place and checkpoints after each document and after a
 * non-trivial dedup pass, so the caller stays resumable.
 *
 * Always layers onto whatever graph already exists (LLM-built or
 * backbone-built) — there's no "rebuild from scratch" concept here since a
 * pass is cheap enough to just re-run; `opts.rebuild` instead means "ignore
 * the per-doc fast-content-hash cache and reprocess every document." Merges
 * through the exact same mergeExtraction/dedupeEntitiesByEmbedding path
 * buildRepoGraph's window/sentence LLM extraction uses, so a later "Full"
 * build naturally enriches or merges into backbone-built nodes rather than
 * duplicating them.
 *
 * Deliberately does NOT touch processedDocIds, docCoverage.selectedWindows/
 * completedWindows, or coverageMode — those belong exclusively to
 * buildRepoGraph's window/sentence LLM coverage state machine ("Full" mode).
 * Marking a doc processed here would wrongly make a later Full rebuild think
 * that doc already got real LLM extraction. Progress is tracked only via
 * docCoverage[docId].fastContentHash, a separate field, so this backbone and
 * an LLM build never confuse each other's notion of "already covered."
 */
async function runNerBackbone(
  settings: Settings,
  repo: string,
  graph: DocGraph,
  docs: Array<{ id: string; name: string }>,
  expectedRevision: number,
  opts: {
    rebuild?: boolean;
    signal?: AbortSignal;
    report: (currentDoc?: string) => void;
    onDocDone: () => void;
  },
): Promise<NerBackboneResult> {
  const touchedNodeIds = new Set<string>();
  const warnings: string[] = [];
  // Checkpoint every NER_CHECKPOINT_BATCH successfully-extracted documents
  // instead of every one (matching EXTRACTION_CONCURRENCY's batch size for
  // consistency with the Full tier) — meaningfully fewer graph.json
  // writes/encryptions over a large notebook. Accepted tradeoff: a service-
  // worker eviction mid-batch now loses up to NER_CHECKPOINT_BATCH-1
  // documents' worth of NER work instead of at most 1, since a retry simply
  // re-extracts whatever wasn't checkpointed — no user data is lost, only
  // some already-cheap on-device NER work. A clean Stop still flushes
  // everything: buildRepoGraphQuick's caller-side `stoppedResult()` (and its
  // own final `graphSet` on normal completion) unconditionally persists the
  // in-memory graph regardless of where the last batch checkpoint landed.
  const NER_CHECKPOINT_BATCH = EXTRACTION_CONCURRENCY;
  let docsSinceCheckpoint = 0;

  const sortedDocs = [...docs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const doc of sortedDocs) {
    if (opts.signal?.aborted) break;
    opts.report(doc.name);

    let chunksRes;
    try {
      chunksRes = await docChunks(repo, doc.id, opts.signal);
    } catch (error) {
      if (opts.signal?.aborted) break;
      warnings.push(`${doc.name}: ${error instanceof Error ? error.message : 'could not read document chunks'}`);
      continue;
    }
    if (!chunksRes.ok) {
      warnings.push(`${doc.name}: ${chunksRes.error || 'could not read document chunks'}`);
      continue;
    }
    const chunks = (chunksRes.result ?? []) as Array<{ text: string; sentences: CitableSentence[] }>;
    const contentHash = shortHash(chunks.map((c) => c.text).join('\n'));
    const coverage: GraphDocCoverage =
      graph.docCoverage![doc.id] ?? { totalWindows: 0, selectedWindows: [], completedWindows: [], failedWindows: [] };

    if (!opts.rebuild && coverage.fastContentHash === contentHash) {
      opts.onDocDone();
      continue; // unchanged since its last backbone pass
    }

    try {
      const windows = windowDocChunksForNer(chunks);
      const extractions = await extractEntitiesForDoc(windows, opts.signal);
      for (const extraction of extractions) {
        mergeExtraction(graph, extraction, doc.id, { markProcessed: false, touchedNodeIds });
      }
      coverage.fastContentHash = contentHash;
      graph.docCoverage![doc.id] = coverage;
    } catch (error) {
      if (opts.signal?.aborted) break;
      warnings.push(`${doc.name}: ${error instanceof Error ? error.message : 'local NER extraction failed'}`);
      opts.onDocDone();
      continue;
    }

    opts.onDocDone();
    docsSinceCheckpoint++;
    if (docsSinceCheckpoint >= NER_CHECKPOINT_BATCH) {
      const setRes = await graphSet(repo, graph, expectedRevision);
      if (!setRes.ok) return { status: 'error', error: setRes.error ?? 'Failed to save graph.' };
      docsSinceCheckpoint = 0;
    }
  }

  if (opts.signal?.aborted) return { status: 'aborted', warnings };

  graph.dirtyNodeIds = [...new Set([...(graph.dirtyNodeIds ?? []), ...touchedNodeIds])];
  if (graph.nodes.length > 0) {
    try {
      const dedup = await dedupeEntitiesByEmbedding(settings, graph, opts.signal);
      for (const [absorbedId, keepId] of dedup.idRemap) {
        touchedNodeIds.delete(absorbedId);
        touchedNodeIds.add(keepId);
      }
      // Checkpoint the deduped graph before the caller's community/enrichment
      // step — if the service worker is evicted or crashes during that
      // (longer-running) phase, this NER-extracted-and-deduped work isn't
      // lost and a retry doesn't have to redo it.
      if (dedup.mergedCount > 0) {
        const dedupSet = await graphSet(repo, graph, expectedRevision);
        if (!dedupSet.ok) return { status: 'error', error: dedupSet.error ?? 'Failed to save graph.' };
      }
    } catch (error) {
      if (opts.signal?.aborted) return { status: 'aborted', warnings };
      throw error;
    }
  }

  return { status: 'ok', touchedNodeIds, warnings };
}

/**
 * Build (or update) the knowledge graph's default "Quick" tier: the
 * on-device NER backbone (runNerBackbone) plus a bounded,
 * corpus-size-independent layer of LLM enrichment — community
 * titles/summaries (summarizeCommunities/summarizeCommunitiesIncremental) and
 * typed-relation upgrades for the highest-value co-occurrence edges
 * (enrichRelationTypes). Because that enrichment's LLM call count is capped
 * (MAX_COMMUNITIES + a fixed relation-typing budget) rather than scaling with
 * document/window count, build time stays bounded even for a large notebook —
 * unlike buildRepoGraph's window/sentence extraction (still available as
 * "Full" mode), which is one LLM call per window/sentence across the whole
 * corpus. Requires a model configured (unlike Instant): the NER and
 * embedding-based dedup stay fully on-device, but community summaries and
 * relation typing go through the configured knowledgeGraph-role model.
 */
export async function buildRepoGraphQuick(
  settings: Settings,
  repo: string,
  opts: {
    rebuild?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: GraphBuildBackboneProgress) => void;
  } = {},
): Promise<GraphBuildResult> {
  const snapshotRes = await graphSnapshot(repo);
  if (!snapshotRes.ok) return { ok: false, error: snapshotRes.error };
  const snapshot = snapshotRes.result as { docs?: Array<{ id: string; name: string }>; corpusRevision?: number } | undefined;
  const docs = snapshot?.docs ?? [];
  const expectedRevision = snapshot?.corpusRevision ?? 0;
  if (docs.length === 0) return { ok: false, error: 'This repository has no documents to extract a graph from.' };

  const existing = await graphGetRaw(repo);
  if (!existing.ok) return { ok: false, error: existing.error };
  const graph: DocGraph = (existing.result as DocGraph | null) ?? emptyDocGraph();
  graph.corpusRevision = expectedRevision;
  graph.version = DOC_GRAPH_VERSION;
  graph.docCoverage ??= {};

  let docsDone = 0;
  const report = (currentDoc?: string) =>
    opts.onProgress?.({ docsTotal: docs.length, docsDone, currentDoc, nodes: graph.nodes.length, edges: graph.edges.length });

  const stoppedResult = async (): Promise<GraphBuildResult> => {
    const setRes = await graphSet(repo, graph, expectedRevision);
    if (!setRes.ok) return { ok: false, error: setRes.error };
    report();
    return { ok: true, graph, warnings: ['Quick build stopped. Run it again to resume from where it left off.'] };
  };

  const backbone = await runNerBackbone(settings, repo, graph, docs, expectedRevision, {
    rebuild: opts.rebuild,
    signal: opts.signal,
    report,
    onDocDone: () => {
      docsDone++;
    },
  });
  if (backbone.status === 'error') return { ok: false, error: backbone.error };
  if (backbone.status === 'aborted') return stoppedResult();

  // Bounded LLM enrichment — skipped on a no-op rebuild (nothing new to
  // summarize and existing communities already have themes), same gating
  // buildRepoGraph itself uses to decide full vs. incremental resummarization.
  const shouldEnrich = graph.nodes.length > 0 && (opts.rebuild || !graph.communities || backbone.touchedNodeIds.size > 0);
  if (shouldEnrich) {
    try {
      const relTyping = await enrichRelationTypes(settings, repo, graph, { signal: opts.signal });
      if (relTyping.upgradedCount > 0) {
        const relSet = await graphSet(repo, graph, expectedRevision);
        if (!relSet.ok) return { ok: false, error: relSet.error };
      }

      const useLlmForAll = opts.rebuild || !graph.communities;
      if (useLlmForAll) {
        graph.communities = await summarizeCommunities(settings, graph, opts.signal, MAX_COMMUNITIES);
        graph.dirtyNodeIds = [];
      } else {
        const dirty = new Set(graph.dirtyNodeIds ?? []);
        graph.communities = await summarizeCommunitiesIncremental(settings, graph, dirty, opts.signal, MAX_COMMUNITIES);
        // Only clear dirty ids whose community actually got a fresh LLM
        // summary this pass — a community that stayed extractive keeps its
        // members dirty so a later build still owes it an abstractive pass.
        const stillDirty = new Set(dirty);
        for (const c of graph.communities) {
          if (c.method === 'llm') for (const id of c.nodeIds) stillDirty.delete(id);
        }
        graph.dirtyNodeIds = [...stillDirty];
      }
    } catch (error) {
      if (opts.signal?.aborted) return stoppedResult();
      throw error;
    }
  }

  const setRes = await graphSet(repo, graph, expectedRevision);
  if (!setRes.ok) return { ok: false, error: setRes.error };
  report();
  return { ok: true, graph, warnings: backbone.warnings.length > 0 ? backbone.warnings : undefined };
}

// Chunk-level clusters kept, and the ceiling on how many topic nodes an
// Instant build surfaces — bounds the graph to a browsable size regardless of
// notebook size, mirroring MAX_COMMUNITIES's role for the LLM tier's themes.
const INSTANT_CLUSTER_MIN_SIZE = 2;
const INSTANT_MAX_CLUSTERS = 30;

export interface GraphBuildInstantProgress {
  docsTotal: number;
  docsDone: number;
  currentDoc?: string;
  chunksGathered: number;
}

/**
 * Build (or replace) the knowledge graph's "Instant" tier: topic clusters
 * derived purely from chunk embeddings that already exist from normal
 * document ingestion (computed once at ingest for RAG retrieval, never
 * re-embedded or re-extracted here) — zero model calls of any kind, not even
 * NER. A genuinely different graph shape from the other tiers: nodes are
 * topic clusters (`type: 'topic'`), not named entities, labeled with cheap
 * lexical keyword extraction rather than a real name; edges connect clusters
 * that share a source document rather than expressing a real relationship.
 *
 * Always fully replaces the graph's prior topic-type nodes/edges — a full
 * re-cluster, not an incremental update. Clustering inherently needs the
 * whole corpus's chunks in memory at once (there's no meaningful way to
 * "only re-cluster the changed part"), and the computation is cheap enough
 * that incremental tracking isn't worth the complexity the other tiers carry
 * for it. Entity-type nodes/edges from Quick/Full builds are left
 * completely untouched — running this tier never destroys another tier's
 * extraction work, and vice versa.
 */
export async function buildRepoGraphInstant(
  repo: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: GraphBuildInstantProgress) => void;
  } = {},
): Promise<GraphBuildResult> {
  const snapshotRes = await graphSnapshot(repo);
  if (!snapshotRes.ok) return { ok: false, error: snapshotRes.error };
  const snapshot = snapshotRes.result as { docs?: Array<{ id: string; name: string }>; corpusRevision?: number } | undefined;
  const docs = snapshot?.docs ?? [];
  const expectedRevision = snapshot?.corpusRevision ?? 0;
  if (docs.length === 0) return { ok: false, error: 'This repository has no documents to extract a graph from.' };

  const existing = await graphGetRaw(repo);
  if (!existing.ok) return { ok: false, error: existing.error };
  const graph: DocGraph = (existing.result as DocGraph | null) ?? emptyDocGraph();
  graph.corpusRevision = expectedRevision;
  graph.version = DOC_GRAPH_VERSION;

  interface GatheredChunk {
    chunkId: string;
    docId: string;
    text: string;
    sentenceIds: string[];
    vector: number[];
  }
  const gathered: GatheredChunk[] = [];
  const warnings: string[] = [];
  let docsDone = 0;

  const report = (currentDoc?: string) =>
    opts.onProgress?.({ docsTotal: docs.length, docsDone, currentDoc, chunksGathered: gathered.length });

  const sortedDocs = [...docs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const doc of sortedDocs) {
    if (opts.signal?.aborted) break;
    report(doc.name);

    let chunksRes;
    let vectorsRes;
    try {
      [chunksRes, vectorsRes] = await Promise.all([docChunks(repo, doc.id, opts.signal), docVectors(repo, doc.id, opts.signal)]);
    } catch (error) {
      if (opts.signal?.aborted) break;
      warnings.push(`${doc.name}: ${error instanceof Error ? error.message : 'could not read document data'}`);
      continue;
    }
    if (!chunksRes.ok || !vectorsRes.ok) {
      warnings.push(`${doc.name}: ${chunksRes.error || vectorsRes.error || 'could not read document data'}`);
      continue;
    }
    const chunks = (chunksRes.result ?? []) as Array<{ chunkId: string; text: string; sentences: CitableSentence[] }>;
    const vectorData = vectorsRes.result as { vectors: Int8Array | number[]; dim: number; perDimScale: number[] } | null;
    if (!vectorData || vectorData.dim === 0 || chunks.length === 0) {
      docsDone++;
      continue; // no vectors yet (e.g. doc mid-ingest) -- skip, not a failure
    }
    const rawVectors = vectorData.vectors instanceof Int8Array ? vectorData.vectors : Int8Array.from(vectorData.vectors);
    chunks.forEach((c, i) => {
      const row = rawVectors.subarray(i * vectorData.dim, (i + 1) * vectorData.dim);
      if (row.length !== vectorData.dim) return; // fewer vectors than chunks -- skip defensively
      gathered.push({
        chunkId: c.chunkId || `${doc.id}:c${i}`,
        docId: doc.id,
        text: c.text,
        sentenceIds: c.sentences.map((s) => s.id),
        vector: normalizeVector(dequantizeVector(row, vectorData.perDimScale)),
      });
    });
    docsDone++;
  }

  if (opts.signal?.aborted) {
    return { ok: true, graph, warnings: ['Instant build stopped before clustering started. Run it again to redo the (cheap) whole pass.'] };
  }
  if (gathered.length === 0) {
    return { ok: false, error: 'No embedded chunks were found to cluster. Make sure the notebook\'s documents have finished indexing.' };
  }

  const clusterChunks: ClusterChunk[] = gathered.map((g) => ({ chunkId: g.chunkId, docId: g.docId, vector: g.vector }));
  const edges = await buildSimilarityEdges(clusterChunks);
  if (opts.signal?.aborted) {
    return { ok: true, graph, warnings: ['Instant build stopped during clustering. Run it again to redo the (cheap) whole pass.'] };
  }

  const raw = labelPropagate(
    gathered.map((g) => g.chunkId),
    edges,
    { minSize: INSTANT_CLUSTER_MIN_SIZE, maxCommunities: INSTANT_MAX_CLUSTERS },
  );

  const byChunkId = new Map(gathered.map((g) => [g.chunkId, g]));
  const topicNodes: GraphNode[] = [];
  for (const community of raw) {
    const members = community.nodeIds.map((id) => byChunkId.get(id)).filter((c): c is GatheredChunk => !!c);
    if (members.length === 0) continue;
    const { title, keywords } = deriveClusterLabel(members.map((m) => m.text));
    const docIds = [...new Set(members.map((m) => m.docId))];
    const nodeId = `topic_${shortHash([...members.map((m) => m.chunkId)].sort().join(','))}`;
    topicNodes.push({
      id: nodeId,
      type: 'topic',
      label: title,
      aliases: keywords,
      summary: `A cluster of ${members.length} related passage(s) across ${docIds.length} document(s): ${keywords.join(', ')}.`,
      evidenceSentenceIds: [...new Set(members.flatMap((m) => m.sentenceIds))].slice(0, 12),
      docIds,
    });
  }

  // Edges between topic clusters that share a source document — the same
  // "genuine relationships are out of scope for a model-free tier" tradeoff
  // the NER tier makes with sentence-level co-occurrence, just at cluster
  // granularity (see buildCoOccurrenceExtraction's doc comment).
  const topicEdges: GraphEdge[] = [];
  const nodeDocIds = new Map(topicNodes.map((n) => [n.id, new Set(n.docIds)]));
  for (let i = 0; i < topicNodes.length; i++) {
    for (let j = i + 1; j < topicNodes.length; j++) {
      const a = topicNodes[i];
      const b = topicNodes[j];
      const shared = [...nodeDocIds.get(a.id)!].some((d) => nodeDocIds.get(b.id)!.has(d));
      if (!shared) continue;
      topicEdges.push({ id: `topic_e_${shortHash(`${a.id}|${b.id}`)}`, from: a.id, to: b.id, relation: 'related topic', evidenceSentenceIds: [] });
    }
  }

  // Full replace of prior topic-type nodes/edges only — entity-type
  // nodes/edges from other tiers are left completely untouched.
  const priorTopicIds = new Set(graph.nodes.filter((n) => n.type === 'topic').map((n) => n.id));
  graph.nodes = [...graph.nodes.filter((n) => n.type !== 'topic'), ...topicNodes];
  graph.edges = [...graph.edges.filter((e) => !priorTopicIds.has(e.from) && !priorTopicIds.has(e.to)), ...topicEdges];
  graph.updatedAt = new Date().toISOString();

  const setRes = await graphSet(repo, graph, expectedRevision);
  if (!setRes.ok) return { ok: false, error: setRes.error };
  report();
  return { ok: true, graph, warnings: warnings.length > 0 ? warnings : undefined };
}

const pendingInstantRefresh = new Map<string, ReturnType<typeof setTimeout>>();
// Debounced so a burst of ingest activity for one repo (a multi-file batch, a
// folder sync) triggers one background Instant build, not one per document.
const INSTANT_REFRESH_DEBOUNCE_MS = 2000;

/**
 * Fire-and-forget: (re)build the free Instant tier shortly after ingestion
 * activity quiets down for a repo, so its cheap embedding-derived topic graph
 * (buildRepoGraphInstant — zero model/LLM calls, reuses chunk embeddings
 * already computed for RAG) is ready by the time a user opens the graph
 * panel, instead of requiring an explicit "Build" click first.
 *
 * Never competes with a real (Quick/Full/manual-Instant) build already
 * running for the repo — skips silently if `graphBuilding.has(repo)`, and
 * doesn't claim that map slot itself beyond the build it starts, so a
 * `notebook_graph_build` request that arrives after this schedules but before
 * it fires still sees the repo as free. A failure (including losing the
 * corpusRevision race to a concurrent add — `repoGraphSet`'s own
 * `expectedRevision` check) is swallowed: this is a nice-to-have background
 * refresh, not a request a caller is waiting on, and the next ingest call
 * naturally re-schedules another attempt.
 */
export function scheduleInstantGraphRefresh(repo: string): void {
  const existing = pendingInstantRefresh.get(repo);
  if (existing) clearTimeout(existing);
  pendingInstantRefresh.set(
    repo,
    setTimeout(() => {
      pendingInstantRefresh.delete(repo);
      if (graphBuilding.has(repo)) return; // a real build already owns this repo
      const controller = new AbortController();
      graphBuilding.set(repo, controller);
      buildRepoGraphInstant(repo, { signal: controller.signal })
        .catch((error) => console.warn(`[graphExtract] background Instant-tier refresh failed for "${repo}":`, error))
        .finally(() => graphBuilding.delete(repo));
    }, INSTANT_REFRESH_DEBOUNCE_MS),
  );
}
