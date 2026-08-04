import { describe, expect, it } from 'vitest';
import { extractCitationIds, injectCitationChips } from './citations';
import { citableSentences } from './sentenceSplit';

describe('extractCitationIds', () => {
  it('pulls ordered, de-duplicated ids from [[id]] tokens', () => {
    const text = 'Alpha [[doc-1:c0:s0#aaa111]] and beta [[doc-1:c0:s1#bbb222]], again [[doc-1:c0:s0#aaa111]].';
    expect(extractCitationIds(text)).toEqual(['doc-1:c0:s0#aaa111', 'doc-1:c0:s1#bbb222']);
  });

  it('returns [] when there are no tokens', () => {
    expect(extractCitationIds('plain answer, no citations')).toEqual([]);
  });

  it('extracts each id from a grouped model reference', () => {
    const text = 'Claim [[web-337a04-15888c:c0:s34#ce761c], [web-eee3a6-17af11:c0:s10#3108b3]].';
    expect(extractCitationIds(text)).toEqual([
      'web-337a04-15888c:c0:s34#ce761c',
      'web-eee3a6-17af11:c0:s10#3108b3',
    ]);
  });
});

describe('injectCitationChips', () => {
  const numberById = new Map([
    ['doc-1:c0:s0#aaa111', 1],
    ['doc-1:c0:s1#bbb222', 2],
  ]);

  it('replaces known tokens with numbered chips', () => {
    const out = injectCitationChips('Fact one [[doc-1:c0:s0#aaa111]].', numberById);
    expect(out).toContain('<sup class="citation-chip"');
    expect(out).toContain('data-cite-id="doc-1:c0:s0#aaa111"');
    expect(out).toContain('>1</sup>');
    expect(out).not.toContain('[[');
  });

  it('drops unknown tokens entirely (fabricated ids never render)', () => {
    expect(injectCitationChips('Bogus [[doc-9:c9:s9#zzz999]].', numberById)).toBe('Bogus .');
  });

  it('renders grouped references as individual validated chips', () => {
    const out = injectCitationChips(
      'Fact [[doc-1:c0:s0#aaa111], [doc-1:c0:s1#bbb222]].',
      numberById,
    );
    expect(out.match(/citation-chip/g)).toHaveLength(2);
    expect(out).toContain('>1</sup><sup');
    expect(out).toContain('>2</sup>');
    expect(out).not.toContain('[[');
  });
});

// The core provenance contract: tag a chunk's sentences with stable ids, let a
// (simulated) model cite one, and deterministically resolve it back to the exact
// sentence — including rejecting a fabricated id — with no fuzzy matching.
describe('sentence citation round-trip', () => {
  it('resolves a cited id to the exact sentence and rejects a fabricated one', () => {
    const chunkText = 'SSC operates several enterprise cloud services. Generative AI workloads use both commercial and internally hosted models.';
    const sentences = citableSentences('doc-73', 42, chunkText);
    const registry = new Map(sentences.map((s) => [s.id, s]));

    const realId = sentences[1].id;
    const answer = `Generative AI workloads use both model types [[${realId}]] [[doc-73:c42:s9#deadbe]].`;

    const cited = extractCitationIds(answer).filter((id) => registry.has(id));
    expect(cited).toEqual([realId]); // fabricated id filtered out

    const span = registry.get(cited[0])!;
    expect(chunkText.slice(span.start, span.end)).toBe(
      'Generative AI workloads use both commercial and internally hosted models.',
    );
  });
});
