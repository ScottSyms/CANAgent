import { describe, expect, it } from 'vitest';
import { makeSentenceId, shortHash, splitSentences } from './sentenceSplit';

describe('splitSentences', () => {
  it('splits prose into sentences', () => {
    const text = 'Shared Services Canada provides common IT services. The department operates several cloud services. Model selection is configured at the application level.';
    const spans = splitSentences(text);
    expect(spans.length).toBe(3);
    expect(spans[0].text).toBe('Shared Services Canada provides common IT services.');
    expect(spans[2].text).toBe('Model selection is configured at the application level.');
  });

  it('produces offsets that reconstruct each sentence (no fuzzy matching)', () => {
    const text = 'First fact here. Second fact follows! A third one? And a trailing clause';
    for (const span of splitSentences(text)) {
      expect(text.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it('numbers sentences sequentially from zero', () => {
    const spans = splitSentences('One. Two. Three.');
    expect(spans.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('drops whitespace-only segments and handles empty input', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n\n  ')).toEqual([]);
  });

  it('handles a single sentence with no terminal punctuation', () => {
    const spans = splitSentences('just one line of text');
    expect(spans.length).toBe(1);
    expect(spans[0].text).toBe('just one line of text');
    expect(spans[0].start).toBe(0);
  });
});

describe('shortHash', () => {
  it('is deterministic and 6 hex chars', () => {
    const h = shortHash('The department operates several cloud services.');
    expect(h).toMatch(/^[0-9a-f]{6}$/);
    expect(shortHash('The department operates several cloud services.')).toBe(h);
  });

  it('ignores whitespace and case differences', () => {
    expect(shortHash('Hello   World')).toBe(shortHash('hello world'));
  });

  it('differs for different content', () => {
    expect(shortHash('alpha')).not.toBe(shortHash('beta'));
  });
});

describe('makeSentenceId', () => {
  it('assembles the stable coordinate-plus-hash format', () => {
    const id = makeSentenceId('doc-73', 42, 3, 'Model selection is configured at the application level.');
    expect(id).toMatch(/^doc-73:c42:s3#[0-9a-f]{6}$/);
  });

  it('is stable across runs for the same input', () => {
    const a = makeSentenceId('doc-1', 0, 0, 'A sentence.');
    const b = makeSentenceId('doc-1', 0, 0, 'A sentence.');
    expect(a).toBe(b);
  });

  it('changes when the sentence text changes (edit detection)', () => {
    const a = makeSentenceId('doc-1', 0, 0, 'Original text.');
    const b = makeSentenceId('doc-1', 0, 0, 'Edited text.');
    expect(a).not.toBe(b);
  });
});
