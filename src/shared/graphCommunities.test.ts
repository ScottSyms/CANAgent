import { describe, expect, it } from 'vitest';
import { emptyDocGraph, mergeExtraction, type CommunitySummary } from './docGraph';
import { detectCommunities, renderCommunitiesForModel, renderCommunityForModel } from './graphCommunities';

// Build a graph with two clearly separate clusters joined by no edges:
//   Cluster 1: A—B—C   Cluster 2: X—Y—Z
function twoClusterGraph() {
  const g = emptyDocGraph();
  mergeExtraction(
    g,
    {
      entities: [],
      relations: [
        { from: 'A', to: 'B', relation: 'r', evidence: ['s1'] },
        { from: 'B', to: 'C', relation: 'r', evidence: ['s2'] },
        { from: 'X', to: 'Y', relation: 'r', evidence: ['s3'] },
        { from: 'Y', to: 'Z', relation: 'r', evidence: ['s4'] },
      ],
    },
    'doc-1',
  );
  return g;
}

describe('detectCommunities', () => {
  it('separates two disconnected clusters', () => {
    const comms = detectCommunities(twoClusterGraph());
    expect(comms).toHaveLength(2);
    const sizes = comms.map((c) => c.nodeIds.length).sort();
    expect(sizes).toEqual([3, 3]);
    // Members of a community are disjoint from the other's.
    const first = new Set(comms[0].nodeIds);
    expect(comms[1].nodeIds.some((id) => first.has(id))).toBe(false);
  });

  it('drops singleton communities below minSize', () => {
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [{ label: 'Lonely', type: 'x', summary: 's', evidence: ['s0'] }], relations: [] }, 'd');
    expect(detectCommunities(g, { minSize: 2 })).toHaveLength(0);
  });

  it('is deterministic across runs', () => {
    const a = detectCommunities(twoClusterGraph()).map((c) => c.nodeIds.slice().sort());
    const b = detectCommunities(twoClusterGraph()).map((c) => c.nodeIds.slice().sort());
    expect(a).toEqual(b);
  });
});

describe('render helpers', () => {
  it('renders a community with tagged evidence for summarization', () => {
    const g = twoClusterGraph();
    const comm = detectCommunities(g)[0];
    const { text, evidenceIds } = renderCommunityForModel(g, comm);
    expect(text).toContain('Relationships:');
    expect(text).toMatch(/\[\[s\d\]\]/);
    expect(evidenceIds.length).toBeGreaterThan(0);
  });

  it('renders community summaries for a global answer', () => {
    const summaries: CommunitySummary[] = [
      { id: 'com0', title: 'Theme One', summary: 'About A/B/C.', nodeIds: [], evidenceSentenceIds: ['s1', 's2'] },
    ];
    const text = renderCommunitiesForModel(summaries);
    expect(text).toContain('## Theme One');
    expect(text).toContain('[[s1]] [[s2]]');
  });
});
