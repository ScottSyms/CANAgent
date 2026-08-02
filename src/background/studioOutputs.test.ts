import { describe, expect, it } from 'vitest';
import { buildStudioContext, cleanCitations } from './studioOutputs';
import { emptyDocGraph, mergeExtraction } from '../shared/docGraph';

describe('buildStudioContext', () => {
  it('includes themes (when present) and top entities, all sentence-tagged', () => {
    const g = emptyDocGraph();
    mergeExtraction(
      g,
      {
        entities: [{ label: 'SSC', type: 'org', summary: 'Runs IT.', evidence: ['s1'] }],
        relations: [{ from: 'SSC', to: 'Azure', relation: 'uses', evidence: ['s2'] }],
      },
      'doc-1',
    );
    g.communities = [{ id: 'com0', title: 'Cloud', summary: 'About cloud.', nodeIds: [], evidenceSentenceIds: ['s3'] }];

    const ctx = buildStudioContext(g);
    expect(ctx).toContain('Themes:');
    expect(ctx).toContain('## Cloud');
    expect(ctx).toContain('SSC —uses→ Azure');
    expect(ctx).toContain('[[s2]]');
  });

  it('works with no communities (entities only)', () => {
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [{ label: 'A', type: 'x', summary: 's', evidence: ['s1'] }], relations: [] }, 'd');
    const ctx = buildStudioContext(g);
    expect(ctx).not.toContain('Themes:');
    expect(ctx).toContain('A (x)');
  });
});

describe('cleanCitations', () => {
  it('keeps resolved ids and strips unresolved ones', () => {
    const md = 'Fact one [[doc:c0:s0#a]] and a bad one [[doc:c9:s9#z]].';
    expect(cleanCitations(md, new Set(['doc:c0:s0#a']))).toBe('Fact one [[doc:c0:s0#a]] and a bad one .');
  });
});
