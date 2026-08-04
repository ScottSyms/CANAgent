import { describe, expect, it } from 'vitest';
import { assessRetrievalConfidence } from './retrievalConfidence';
import type { SearchHit } from './vectorSearch';

const hit = (text: string, name = 'a'): SearchHit => ({ name, url: `file:///${name}`, text, score: 1 });

describe('assessRetrievalConfidence', () => {
  it('accepts a passage containing most meaningful query terms', () => {
    const result = assessRetrievalConfidence(
      'vacation entitlement after 20 years of service',
      [hit('Vacation entitlement increases after 20 years of service.')],
    );
    expect(result.level).toBe('strong');
    expect(result.lexicalCoverage).toBeGreaterThanOrEqual(0.6);
  });

  it('requires expansion for weak lexical evidence without graph support', () => {
    expect(assessRetrievalConfidence('vacation entitlement service', [hit('Unrelated collective agreement text.')]).level).toBe('weak');
  });

  it('reports an empty retrieval distinctly', () => {
    expect(assessRetrievalConfidence('query', [])).toMatchObject({ level: 'empty', lexicalCoverage: 0 });
  });
});
