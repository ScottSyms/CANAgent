// Lexical (keyword) ranking for the on-device RAG store — the BM25 half of
// hybrid search. Pure functions, no chrome.* / OPFS / DOM, mirroring
// vectorSearch.ts so the offscreen repo store and the Word add-in can share it.
//
// Semantic (dense vector) search excels at meaning but can miss exact tokens —
// part numbers, identifiers, surnames, codes. BM25 over the same chunk text
// recovers that exact-token recall; the two rankings are then fused (RRF) in
// hybridSearch.ts.

/**
 * Tokenize for lexical matching. Lowercased, and crucially **keeps identifiers
 * intact**: internal `.`/`_`/`-` are preserved so `AB-1234`, `v2.3`,
 * `CVE-2024-1234`, `foo_bar` stay single tokens (the whole point of adding a
 * keyword layer is exact-token lookup). Leading/trailing punctuation is dropped.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
}

export interface KeywordHit {
  i: number;
  score: number;
}

export interface KeywordIndex {
  version: 1;
  avgdl: number;
  docLen: number[];
  docFreq: Record<string, number>;
  termFreqs: Array<Array<[term: string, freq: number]>>;
}

export interface Bm25Params {
  /** Chunk records aligned to the vector rows (only `text` is read). */
  chunks: Array<{ text: string }>;
  query: string;
  /** Term-frequency saturation. Default 1.5 (standard). */
  k1?: number;
  /** Length-normalization strength, 0..1. Default 0.75 (standard). */
  b?: number;
}

export function buildKeywordIndex(chunks: Array<{ text: string }>): KeywordIndex {
  const docLen: number[] = [];
  const docFreq: Record<string, number> = {};
  const termFreqs: Array<Array<[string, number]>> = [];
  let totalLen = 0;
  for (const chunk of chunks) {
    const toks = tokenize(chunk.text);
    docLen.push(toks.length);
    totalLen += toks.length;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const term of tf.keys()) docFreq[term] = (docFreq[term] ?? 0) + 1;
    termFreqs.push([...tf.entries()]);
  }
  return { version: 1, avgdl: totalLen / Math.max(1, chunks.length), docLen, docFreq, termFreqs };
}

export function extendKeywordIndex(index: KeywordIndex, chunks: Array<{ text: string }>): KeywordIndex {
  const docLen = [...index.docLen];
  const docFreq: Record<string, number> = { ...index.docFreq };
  const termFreqs = index.termFreqs.map((tf) => tf.slice());
  let totalLen = docLen.reduce((n, len) => n + len, 0);
  for (const chunk of chunks) {
    const toks = tokenize(chunk.text);
    docLen.push(toks.length);
    totalLen += toks.length;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const term of tf.keys()) docFreq[term] = (docFreq[term] ?? 0) + 1;
    termFreqs.push([...tf.entries()]);
  }
  return { version: 1, avgdl: totalLen / Math.max(1, docLen.length), docLen, docFreq, termFreqs };
}

export interface Bm25IndexedParams {
  index: KeywordIndex;
  query: string;
  k1?: number;
  b?: number;
}

export function bm25RankIndexed(params: Bm25IndexedParams): KeywordHit[] {
  const { index, query } = params;
  const k1 = params.k1 ?? 1.5;
  const b = params.b ?? 0.75;
  const N = index.docLen.length;
  if (N === 0 || index.version !== 1) return [];
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0) return [];

  const qIdf = new Map<string, number>();
  for (const term of qTerms) {
    const df = index.docFreq[term] ?? 0;
    if (df > 0) qIdf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }
  if (qIdf.size === 0) return [];

  const hits: KeywordHit[] = [];
  for (let i = 0; i < N; i++) {
    const terms = index.termFreqs[i];
    if (!terms || terms.length === 0) continue;
    let score = 0;
    const norm = k1 * (1 - b + b * ((index.docLen[i] ?? 0) / (index.avgdl || 1)));
    // Single pass over this chunk's terms, no per-chunk Map allocation: qIdf
    // (built once above, sized to the query's term count) is the O(1) lookup.
    for (let j = 0; j < terms.length; j++) {
      const [term, f] = terms[j];
      const idf = qIdf.get(term);
      if (idf === undefined || !f) continue;
      score += idf * ((f * (k1 + 1)) / (f + norm));
    }
    if (score > 0) hits.push({ i, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/**
 * Rank chunks by BM25 against the query. Returns only chunks with a non-zero
 * score (i.e. that share at least one query term), sorted by score descending.
 * Convenience wrapper that builds an in-memory keyword index for callers that do
 * not have a persisted index. Repos use `KeywordIndex` directly to avoid
 * re-tokenizing the whole corpus on every query.
 */
export function bm25Rank(params: Bm25Params): KeywordHit[] {
  return bm25RankIndexed({ index: buildKeywordIndex(params.chunks), query: params.query, k1: params.k1, b: params.b });
}
