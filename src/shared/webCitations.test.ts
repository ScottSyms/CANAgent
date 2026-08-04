import { describe, expect, it } from 'vitest';
import { extractCitationIds, injectCitationChips } from './citations';
import { citableWebSource } from './webCitations';

describe('citableWebSource', () => {
  it('creates reconstructable sentence citations for the exact visible snapshot', () => {
    const result = citableWebSource({
      title: 'Article',
      url: 'https://example.com/article#section',
      text: 'First fact. Second fact follows.',
    });
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]).toMatchObject({ docName: 'Article', url: 'https://example.com/article', sourceKind: 'web' });
    for (const citation of result.citations) {
      expect(citation.chunkText.slice(citation.start, citation.end)).toBe(citation.sentenceText);
      expect(result.taggedText).toContain(`[[${citation.sentenceId}]] ${citation.sentenceText}`);
    }
  });

  it('changes IDs when live page content changes', () => {
    const first = citableWebSource({ title: 'A', url: 'https://example.com', text: 'Current value is one.' });
    const second = citableWebSource({ title: 'A', url: 'https://example.com', text: 'Current value is two.' });
    expect(first.citations[0].sentenceId).not.toBe(second.citations[0].sentenceId);
  });

  it('separates identical text from different pages', () => {
    const a = citableWebSource({ title: 'A', url: 'https://a.example.com', text: 'Shared sentence.' });
    const b = citableWebSource({ title: 'B', url: 'https://b.example.com', text: 'Shared sentence.' });
    expect(a.citations[0].sentenceId).not.toBe(b.citations[0].sentenceId);
  });

  it('registers only text supplied by the caller', () => {
    const full = 'Visible sentence. Hidden sentence.';
    const visible = full.slice(0, full.indexOf(' Hidden'));
    const result = citableWebSource({ title: 'A', url: 'https://example.com', text: visible });
    expect(result.taggedText).toContain('Visible sentence.');
    expect(result.taggedText).not.toContain('Hidden sentence.');
  });

  it('renders registered web sentence tokens as citation chips', () => {
    const result = citableWebSource({ title: 'Article', url: 'https://example.com', text: 'Supported web claim.' });
    const citation = result.citations[0];
    const answer = `The page confirms this. [[${citation.sentenceId}]]`;
    const registry = new Map([[citation.sentenceId, citation]]);
    const cited = extractCitationIds(answer).filter((id) => registry.has(id));
    const rendered = injectCitationChips(answer, new Map([[citation.sentenceId, 1]]));

    expect(cited).toEqual([citation.sentenceId]);
    expect(registry.get(cited[0])).toBe(citation);
    expect(rendered).toContain('citation-chip');
    expect(rendered).not.toContain(`[[${citation.sentenceId}]]`);
  });
});
