import { tokenize } from './keywordSearch';
import type { SearchHit } from './vectorSearch';

const QUERY_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is',
  'it', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'which', 'who', 'with',
]);

export interface RetrievalConfidence {
  level: 'strong' | 'weak' | 'empty';
  lexicalCoverage: number;
  distinctDocuments: number;
  graphSupported: boolean;
}

/** Conservative, deterministic gate for deciding whether costly LLM expansion is useful. */
export function assessRetrievalConfidence(
  query: string,
  hits: SearchHit[],
  graphCandidateCount = 0,
): RetrievalConfidence {
  if (hits.length === 0) {
    return { level: 'empty', lexicalCoverage: 0, distinctDocuments: 0, graphSupported: false };
  }
  const terms = [...new Set(tokenize(query).filter((term) => term.length > 2 && !QUERY_STOPWORDS.has(term)))];
  let lexicalCoverage = 0;
  if (terms.length > 0) {
    for (const hit of hits.slice(0, 6)) {
      const textTerms = new Set(tokenize(hit.text));
      const coverage = terms.filter((term) => textTerms.has(term)).length / terms.length;
      lexicalCoverage = Math.max(lexicalCoverage, coverage);
    }
  }
  const distinctDocuments = new Set(hits.slice(0, 6).map((hit) => hit.url || hit.name)).size;
  const graphSupported = graphCandidateCount > 0;
  const strong = lexicalCoverage >= 0.6 || (graphSupported && lexicalCoverage >= 0.3);
  return {
    level: strong ? 'strong' : 'weak',
    lexicalCoverage,
    distinctDocuments,
    graphSupported,
  };
}
