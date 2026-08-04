import { citableSentences, shortHash } from './sentenceSplit';
import type { Citation } from './types';

export interface CitableWebSource {
  title: string;
  url: string;
  text: string;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value.trim();
  }
}

/**
 * Convert one exact, already-truncated webpage snapshot into sentence-tagged
 * model context plus fully resolved citation records. IDs change when either
 * the canonical URL or visible text changes, preventing stale live-page spans.
 */
export function citableWebSource(source: CitableWebSource): { taggedText: string; citations: Citation[] } {
  if (!source.text.trim()) return { taggedText: source.text, citations: [] };
  const url = canonicalUrl(source.url);
  const docId = `web-${shortHash(url)}-${shortHash(source.text)}`;
  const citations = citableSentences(docId, 0, source.text).map((sentence): Citation => ({
    sentenceId: sentence.id,
    docName: source.title || url,
    url,
    sourceKind: 'web',
    sentenceText: source.text.slice(sentence.start, sentence.end),
    chunkText: source.text,
    start: sentence.start,
    end: sentence.end,
  }));
  return {
    taggedText: citations.map((citation) => `[[${citation.sentenceId}]] ${citation.sentenceText}`).join('\n'),
    citations,
  };
}
