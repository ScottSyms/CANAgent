// Pure helpers for the on-device NER backbone of graph building
// (src/background/graphExtract.ts's runNerBackbone, used by the "Quick"
// build). No chrome/DOM/model deps, so the BIO-tag aggregation and
// co-occurrence synthesis below are fully unit-testable without the real
// transformers.js pipeline — only the thin pipeline-invocation code in
// src/offscreen/localNer.ts is unverifiable outside a real browser.

import type { DocExtraction, ExtractedEntity, ExtractedRelation } from './docGraph';

/** One raw per-token result from the token-classification pipeline. */
export interface NerToken {
  word: string;
  score: number;
  /** e.g. "B-PER", "I-ORG", or "O" (outside any entity). */
  entity: string;
  index?: number;
  /** Character offsets into the input text. Absent on some tokenizers/models — such tokens are dropped, since they can't be grounded to a sentence. */
  start?: number;
  end?: number;
}

/** One merged entity mention, offsets into the window text it was found in. */
export interface NerSpan {
  /** Raw entity type with any B-/I- prefix stripped, e.g. "PER", "ORG", "LOC". */
  label: string;
  start: number;
  end: number;
  score: number;
}

function tagParts(entity: string): { prefix: 'B' | 'I' | ''; type: string } {
  const m = /^([BI])-(.+)$/.exec(entity);
  return m ? { prefix: m[1] as 'B' | 'I', type: m[2] } : { prefix: '', type: entity };
}

/**
 * Merge a token-classification pipeline's raw per-token BIO output into
 * entity-level spans. The installed transformers.js version has no built-in
 * `aggregation_strategy` (unlike the Python HF pipeline), so this replicates
 * its "simple" strategy by hand: a "B-" tag or a type change starts a new
 * span; a same-type "I-" tag extends the current one. Tokens tagged "O", or
 * missing character offsets, end/skip the current span.
 */
export function aggregateBioTags(tokens: NerToken[]): NerSpan[] {
  const spans: NerSpan[] = [];
  let current: { type: string; start: number; end: number; scores: number[] } | null = null;

  const flush = () => {
    if (!current) return;
    const avgScore = current.scores.reduce((a, b) => a + b, 0) / current.scores.length;
    spans.push({ label: current.type, start: current.start, end: current.end, score: avgScore });
    current = null;
  };

  for (const t of tokens) {
    if (typeof t.start !== 'number' || typeof t.end !== 'number' || t.end <= t.start) {
      flush();
      continue;
    }
    const { prefix, type } = tagParts(t.entity);
    if (!type || type === 'O') {
      flush();
      continue;
    }
    if (current && prefix !== 'B' && current.type === type) {
      current.end = Math.max(current.end, t.end);
      current.scores.push(t.score);
    } else {
      flush();
      current = { type, start: t.start, end: t.end, scores: [t.score] };
    }
  }
  flush();
  return spans;
}

const LABEL_TYPE_MAP: Record<string, string> = {
  PER: 'person',
  ORG: 'organization',
  LOC: 'location',
  MISC: 'entity',
};

/** Map a raw NER label (e.g. "PER") to the free-text type convention the rest of the graph uses (e.g. "person"). Unknown labels fall back to "entity", same as an LLM extraction with no type. */
export function nerLabelToType(label: string): string {
  return LABEL_TYPE_MAP[label.toUpperCase()] ?? 'entity';
}

/** A sentence's `[start, end)` span within the window text it was drawn from. */
export interface NerSentenceSpan {
  id: string;
  start: number;
  end: number;
}

// Below this confidence, a span is more likely tokenizer noise than a real
// entity -- NER has no evidence-grounding guard the way LLM extraction does
// (coerceExtraction's validIds check), so a score floor is this tier's
// equivalent safeguard against fabricated-looking output.
const MIN_ENTITY_SCORE = 0.5;
const MIN_ENTITY_TEXT_LENGTH = 2;
// A sentence listing more than this many distinct entities (e.g. a roster or
// index) is list-like, not relationship-bearing -- skip co-occurrence pairing
// for it entirely rather than emit a dense cluster of low-value edges.
const MAX_COOCCURRENCE_ENTITIES_PER_SENTENCE = 6;

/**
 * Turn one window's raw NER spans into a DocExtraction, exactly the shape
 * mergeExtraction (docGraph.ts) already knows how to fold into a graph: one
 * entity per mention (grounded to the sentence it was found in), and
 * "co-occurs with" relations between every pair of distinct entities sharing
 * a sentence. NER gives no real relationships; this is a deliberately weak
 * substitute that still lets community detection and the concept map connect
 * related entities, instead of leaving every fast-tier node isolated.
 */
export function buildCoOccurrenceExtraction(
  windowText: string,
  sentences: NerSentenceSpan[],
  spans: NerSpan[],
): DocExtraction {
  const findSentence = (offset: number): NerSentenceSpan | undefined =>
    sentences.find((s) => offset >= s.start && offset < s.end);

  const entities: ExtractedEntity[] = [];
  const entitiesBySentence = new Map<string, Array<{ label: string; type: string }>>();
  const seenPerSentence = new Map<string, Set<string>>();

  for (const span of spans) {
    if (span.score < MIN_ENTITY_SCORE) continue;
    const text = windowText.slice(span.start, span.end).trim();
    if (text.length < MIN_ENTITY_TEXT_LENGTH) continue;
    const sentence = findSentence(span.start) ?? findSentence(span.end - 1);
    if (!sentence) continue;
    const type = nerLabelToType(span.label);

    entities.push({ label: text, type, summary: '', evidence: [sentence.id] });

    const key = `${text.toLowerCase()}|${type}`;
    let seen = seenPerSentence.get(sentence.id);
    if (!seen) seenPerSentence.set(sentence.id, (seen = new Set()));
    if (!seen.has(key)) {
      seen.add(key);
      let list = entitiesBySentence.get(sentence.id);
      if (!list) entitiesBySentence.set(sentence.id, (list = []));
      list.push({ label: text, type });
    }
  }

  const relations: ExtractedRelation[] = [];
  for (const [sentenceId, ents] of entitiesBySentence) {
    if (ents.length < 2 || ents.length > MAX_COOCCURRENCE_ENTITIES_PER_SENTENCE) continue;
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < ents.length; j++) {
        relations.push({ from: ents[i].label, to: ents[j].label, relation: 'co-occurs with', evidence: [sentenceId] });
      }
    }
  }

  return { entities, relations };
}
