import { describe, expect, it } from 'vitest';
import { aggregateBioTags, buildCoOccurrenceExtraction, nerLabelToType, type NerToken } from './nerAggregate';

describe('aggregateBioTags', () => {
  it('merges a multi-token B-/I- entity into one span', () => {
    const tokens: NerToken[] = [
      { word: 'New', score: 0.9, entity: 'B-LOC', start: 0, end: 3 },
      { word: 'York', score: 0.8, entity: 'I-LOC', start: 4, end: 8 },
    ];
    const [span] = aggregateBioTags(tokens);
    expect(span).toMatchObject({ label: 'LOC', start: 0, end: 8 });
    expect(span.score).toBeCloseTo(0.85);
  });

  it('splits two adjacent same-type entities separated by an explicit B- tag', () => {
    const tokens: NerToken[] = [
      { word: 'Alice', score: 0.9, entity: 'B-PER', start: 0, end: 5 },
      { word: 'Bob', score: 0.9, entity: 'B-PER', start: 6, end: 9 },
    ];
    expect(aggregateBioTags(tokens)).toEqual([
      { label: 'PER', start: 0, end: 5, score: 0.9 },
      { label: 'PER', start: 6, end: 9, score: 0.9 },
    ]);
  });

  it('ends the current span on an "O" tag', () => {
    const tokens: NerToken[] = [
      { word: 'Alice', score: 0.9, entity: 'B-PER', start: 0, end: 5 },
      { word: 'went', score: 0.99, entity: 'O', start: 6, end: 10 },
      { word: 'Bob', score: 0.8, entity: 'B-PER', start: 11, end: 14 },
    ];
    expect(aggregateBioTags(tokens)).toEqual([
      { label: 'PER', start: 0, end: 5, score: 0.9 },
      { label: 'PER', start: 11, end: 14, score: 0.8 },
    ]);
  });

  it('starts a new span on a type change even without an explicit B- tag', () => {
    const tokens: NerToken[] = [
      { word: 'Acme', score: 0.9, entity: 'B-ORG', start: 0, end: 4 },
      { word: 'Paris', score: 0.9, entity: 'I-LOC', start: 5, end: 10 },
    ];
    expect(aggregateBioTags(tokens)).toEqual([
      { label: 'ORG', start: 0, end: 4, score: 0.9 },
      { label: 'LOC', start: 5, end: 10, score: 0.9 },
    ]);
  });

  it('drops tokens missing character offsets instead of throwing', () => {
    const tokens: NerToken[] = [
      { word: 'Acme', score: 0.9, entity: 'B-ORG', start: 0, end: 4 },
      { word: '??', score: 0.5, entity: 'I-ORG' }, // no start/end
      { word: 'Corp', score: 0.9, entity: 'B-ORG', start: 10, end: 14 },
    ];
    expect(() => aggregateBioTags(tokens)).not.toThrow();
    expect(aggregateBioTags(tokens)).toEqual([
      { label: 'ORG', start: 0, end: 4, score: 0.9 },
      { label: 'ORG', start: 10, end: 14, score: 0.9 },
    ]);
  });

  it('returns an empty array for no entities', () => {
    expect(aggregateBioTags([{ word: 'the', score: 0.99, entity: 'O', start: 0, end: 3 }])).toEqual([]);
    expect(aggregateBioTags([])).toEqual([]);
  });
});

describe('nerLabelToType', () => {
  it('maps known labels to free-text types, case-insensitively', () => {
    expect(nerLabelToType('PER')).toBe('person');
    expect(nerLabelToType('org')).toBe('organization');
    expect(nerLabelToType('Loc')).toBe('location');
    expect(nerLabelToType('MISC')).toBe('entity');
  });

  it('falls back to "entity" for an unrecognized label', () => {
    expect(nerLabelToType('WIDGET')).toBe('entity');
  });
});

describe('buildCoOccurrenceExtraction', () => {
  const text = 'Alice met Bob in Paris. Carol works alone.';
  // Sentence spans within `text`.
  const sentences = [
    { id: 's1', start: 0, end: 23 }, // "Alice met Bob in Paris."
    { id: 's2', start: 24, end: 44 }, // "Carol works alone."
  ];

  it('creates co-occurrence relations only between entities sharing a sentence', () => {
    const spans = [
      { label: 'PER', start: 0, end: 5, score: 0.9 }, // Alice
      { label: 'PER', start: 10, end: 13, score: 0.9 }, // Bob
      { label: 'LOC', start: 17, end: 22, score: 0.9 }, // Paris
      { label: 'PER', start: 24, end: 29, score: 0.9 }, // Carol
    ];
    const extraction = buildCoOccurrenceExtraction(text, sentences, spans);

    expect(extraction.entities.map((e) => e.label).sort()).toEqual(['Alice', 'Bob', 'Carol', 'Paris']);
    expect(extraction.entities.every((e) => e.summary === '')).toBe(true);
    // 3 entities in s1 -> 3 pairs; Carol is alone in s2 -> no pairs there.
    expect(extraction.relations).toHaveLength(3);
    expect(extraction.relations.every((r) => r.relation === 'co-occurs with' && r.evidence[0] === 's1')).toBe(true);
    const pairs = extraction.relations.map((r) => [r.from, r.to].sort().join('+')).sort();
    expect(pairs).toEqual(['Alice+Bob', 'Alice+Paris', 'Bob+Paris']);
  });

  it('drops low-confidence spans', () => {
    const spans = [{ label: 'PER', start: 0, end: 5, score: 0.2 }]; // below MIN_ENTITY_SCORE
    expect(buildCoOccurrenceExtraction(text, sentences, spans).entities).toEqual([]);
  });

  it('drops spans that resolve to text shorter than the minimum length', () => {
    const spans = [{ label: 'PER', start: 0, end: 1, score: 0.9 }]; // "A" only
    expect(buildCoOccurrenceExtraction(text, sentences, spans).entities).toEqual([]);
  });

  it('drops a span that falls outside every sentence range', () => {
    const spans = [{ label: 'PER', start: 1000, end: 1005, score: 0.9 }];
    expect(buildCoOccurrenceExtraction(text, sentences, spans).entities).toEqual([]);
  });

  it('skips co-occurrence pairing for a sentence with too many distinct entities, but still keeps the entities', () => {
    const manyNames = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay', 'Guy'].map((_name, i) => ({
      label: 'PER',
      start: i * 4,
      end: i * 4 + 3,
      score: 0.9,
    }));
    const wideSentence = [{ id: 'wide', start: 0, end: 100 }];
    const wideText = manyNames.map(() => 'xxx ').join('');
    const extraction = buildCoOccurrenceExtraction(wideText, wideSentence, manyNames);
    expect(extraction.entities).toHaveLength(7);
    expect(extraction.relations).toEqual([]);
  });

  it('deduplicates identical (label, type) mentions within one sentence before pairing', () => {
    const spans = [
      { label: 'PER', start: 0, end: 5, score: 0.9 }, // Alice
      { label: 'PER', start: 0, end: 5, score: 0.8 }, // Alice again (overlapping/duplicate detection)
      { label: 'PER', start: 10, end: 13, score: 0.9 }, // Bob
    ];
    const extraction = buildCoOccurrenceExtraction(text, sentences, spans);
    // Both "Alice" mentions still become entity records (evidence-bearing), but only one distinct pair forms.
    expect(extraction.entities.filter((e) => e.label === 'Alice')).toHaveLength(2);
    expect(extraction.relations).toHaveLength(1);
  });
});
