// Embedding-cluster "Instant" graph-tier support. Pure math + lexical
// helpers, no chrome/DOM/model deps — builds a chunk-to-chunk similarity
// graph from embeddings that already exist (computed once at ingest for
// normal RAG retrieval, never re-embedded here), clusters it via the generic
// label-propagation helper in graphCommunities.ts, then labels each cluster
// with cheap lexical keyword extraction. Zero model calls of any kind, unlike
// the NER and LLM graph tiers (src/background/graphExtract.ts).

import { cosineSim } from './docGraph';
import { tokenize } from './keywordSearch';
import { buildAnnIndex, buildSymmetricAdjacency } from './annIndex';

export interface ClusterChunk {
  chunkId: string;
  docId: string;
  /** Pre-normalized (dequantized) float embedding. */
  vector: number[];
}

// How many nearest neighbors each chunk connects to. Relative/bounded rather
// than an absolute similarity floor, so the graph stays well-formed
// regardless of how tightly or loosely a given corpus's embeddings happen to
// cluster (domain- and embedder-dependent).
const NEIGHBORS_PER_CHUNK = 5;

// Yield back to the event loop this often, measured in actual pairwise
// comparisons performed (NOT outer-loop iterations — the inner loop is O(n)
// per outer step, so gating on the outer index alone lets the synchronous
// stretch between yields grow unboundedly with chunk count, exactly
// reproducing the class of bug fixed in docGraph.ts's mergeSimilarNodes).
// This must stay a true per-comparison count so it's a constant bound
// regardless of notebook size.
const YIELD_EVERY_COMPARISONS = 20000;
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Build a k-nearest-neighbor similarity graph over `chunks`: each chunk gets
 * an edge to its `NEIGHBORS_PER_CHUNK` most cosine-similar other chunks.
 * Candidate neighbors come from an approximate nearest-neighbor bucketing
 * (src/shared/annIndex.ts) instead of an all-pairs scan, so this stays
 * sub-quadratic at chunk counts in the thousands+ (chunk count scales with
 * corpus size, so this was the biggest single risk to a bounded build time on
 * a large notebook). Periodic yields — gated on total comparisons performed,
 * not on the outer loop alone — mean a large clustering pass still never
 * blocks the service worker's message loop for more than a fraction of a
 * second at a stretch. Edges are deduplicated and undirected (a mutual top-k
 * pair only appears once).
 */
export async function buildSimilarityEdges(chunks: ClusterChunk[]): Promise<Array<[string, string]>> {
  const edgeKeys = new Set<string>();
  const edges: Array<[string, string]> = [];
  const addEdge = (a: string, b: string) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(a < b ? [a, b] : [b, a]);
  };

  if (chunks.length < 2) return edges;

  const adjacency = buildSymmetricAdjacency(buildAnnIndex(chunks.map((c) => c.vector)), chunks.length);

  let comparisons = 0;
  for (let i = 0; i < chunks.length; i++) {
    const a = chunks[i];
    // Small bounded top-k selection (k=5) — a full heap isn't worth the extra
    // dependency/complexity at this k, insertion-sort-on-5-elements is cheap.
    const best: Array<{ j: number; score: number }> = [];
    for (const j of adjacency[i]) {
      comparisons++;
      if (comparisons % YIELD_EVERY_COMPARISONS === 0) await yieldToEventLoop();

      const score = cosineSim(a.vector, chunks[j].vector);
      if (best.length < NEIGHBORS_PER_CHUNK) {
        best.push({ j, score });
        best.sort((x, y) => x.score - y.score);
      } else if (score > best[0].score) {
        best[0] = { j, score };
        best.sort((x, y) => x.score - y.score);
      }
    }
    for (const { j } of best) addEdge(a.chunkId, chunks[j].chunkId);
  }

  return edges;
}

// A modest bilingual (EN/FR) stopword list — this app ships a bilingual UI
// (src/sidebar/i18n.tsx) so documents plausibly are too. Not exhaustive, and
// no attempt is made to cover other languages; the fallback is just a less
// polished but still-deterministic keyword title.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'can', 'do', 'does', 'did', 'for',
  'from', 'has', 'have', 'he', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'may', 'might', 'more',
  'most', 'no', 'not', 'of', 'on', 'only', 'or', 'other', 'own', 'same', 'she', 'should', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'then', 'they', 'this', 'to', 'too', 'very', 'was', 'we', 'were',
  'which', 'who', 'will', 'with', 'would', 'you',
  'au', 'aux', 'avec', 'avoir', 'ce', 'ces', 'cette', 'comme', 'dans', 'de', 'des', 'donc', 'du', 'elle',
  'elles', 'en', 'est', 'être', 'et', 'il', 'ils', 'la', 'le', 'les', 'mais', 'nous', 'ont', 'ou', 'par',
  'pas', 'plus', 'pour', 'que', 'qui', 'sa', 'se', 'ses', 'son', 'sont', 'sur', 'un', 'une', 'vous',
]);

const MAX_KEYWORDS = 6;
const MIN_TOKEN_LENGTH = 3;

export interface ClusterLabel {
  title: string;
  keywords: string[];
}

/**
 * Derive a cheap, deterministic, no-model label for a cluster from its member
 * chunk texts: the most frequent non-stopword tokens by term frequency across
 * the cluster. Not full TF-IDF — no corpus-wide index is available here, and
 * this only needs to be "good enough to browse by," not search-quality.
 */
export function deriveClusterLabel(memberTexts: string[]): ClusterLabel {
  const freq = new Map<string, number>();
  for (const text of memberTexts) {
    for (const term of tokenize(text)) {
      if (term.length < MIN_TOKEN_LENGTH || STOPWORDS.has(term)) continue;
      freq.set(term, (freq.get(term) ?? 0) + 1);
    }
  }
  const keywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_KEYWORDS)
    .map(([term]) => term);
  const title = keywords.slice(0, 3).join(', ') || 'Untitled topic';
  return { title, keywords };
}
