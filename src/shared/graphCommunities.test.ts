import { describe, expect, it } from 'vitest';
import { emptyDocGraph, mergeExtraction, type CommunitySummary } from './docGraph';
import {
  detectCommunities,
  extractiveCommunitySummary,
  labelPropagate,
  rankCommunities,
  renderCommunitiesForModel,
  renderCommunityForModel,
} from './graphCommunities';

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

describe('labelPropagate', () => {
  it('clusters an arbitrary node/edge set, not just DocGraph node ids', () => {
    const nodeIds = ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5', 'chunk-6'];
    const edges: Array<[string, string]> = [
      ['chunk-1', 'chunk-2'],
      ['chunk-2', 'chunk-3'],
      ['chunk-4', 'chunk-5'],
      ['chunk-5', 'chunk-6'],
    ];
    const comms = labelPropagate(nodeIds, edges);
    expect(comms).toHaveLength(2);
    const sizes = comms.map((c) => c.nodeIds.length).sort();
    expect(sizes).toEqual([3, 3]);
  });

  it('is deterministic and matches detectCommunities on the same graph shape', () => {
    const g = twoClusterGraph();
    const viaDetect = detectCommunities(g).map((c) => c.nodeIds.slice().sort());
    const viaGeneric = labelPropagate(
      g.nodes.map((n) => n.id),
      g.edges.map((e): [string, string] => [e.from, e.to]),
    ).map((c) => c.nodeIds.slice().sort());
    expect(viaGeneric).toEqual(viaDetect);
  });

  it('drops communities below minSize and respects maxCommunities', () => {
    expect(labelPropagate(['a', 'b'], [], { minSize: 2 })).toHaveLength(0); // no edges -> singletons
    const nodeIds = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const edges: Array<[string, string]> = nodeIds.slice(0, -1).map((id, i) => [id, nodeIds[i + 1]]);
    expect(labelPropagate(nodeIds, edges, { minSize: 2, maxCommunities: 1 })).toHaveLength(1);
  });
});

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

describe('extractiveCommunitySummary', () => {
  it('produces a deterministic, no-model summary titled by the highest-degree members', () => {
    const g = emptyDocGraph();
    mergeExtraction(
      g,
      {
        entities: [
          { label: 'A', type: 'x', summary: 'A connects everything.', evidence: ['s1'] },
          { label: 'B', type: 'x', summary: 'B is a hub too.', evidence: ['s2'] },
          { label: 'C', type: 'x', summary: 'C is peripheral.', evidence: ['s3'] },
        ],
        relations: [
          { from: 'A', to: 'B', relation: 'relates to', evidence: ['s4'] },
          { from: 'B', to: 'C', relation: 'relates to', evidence: ['s5'] },
          { from: 'A', to: 'C', relation: 'relates to', evidence: ['s6'] },
        ],
      },
      'doc-1',
    );
    const comm = detectCommunities(g)[0];

    const summary = extractiveCommunitySummary(g, comm);

    expect(summary.method).toBe('extractive');
    expect(summary.id).toBe(comm.id);
    expect(summary.nodeIds).toEqual(comm.nodeIds);
    expect(summary.title.length).toBeGreaterThan(0);
    expect(summary.summary).toContain('A connects everything.');
    expect(summary.evidenceSentenceIds.length).toBeGreaterThan(0);
  });

  it('is deterministic across repeated calls on the same graph', () => {
    const g = emptyDocGraph();
    mergeExtraction(g, {
      entities: [],
      relations: [
        { from: 'X', to: 'Y', relation: 'r', evidence: ['s1'] },
        { from: 'Y', to: 'Z', relation: 'r', evidence: ['s2'] },
        { from: 'X', to: 'Z', relation: 'r', evidence: ['s3'] },
      ],
    }, 'd');
    const comm = detectCommunities(g)[0];
    expect(extractiveCommunitySummary(g, comm)).toEqual(extractiveCommunitySummary(g, comm));
  });

  it('falls back to relation phrases when members have no extracted summary text', () => {
    const g = emptyDocGraph();
    mergeExtraction(g, {
      entities: [],
      relations: [
        { from: 'X', to: 'Y', relation: 'relates to', evidence: ['s1'] },
        { from: 'Y', to: 'Z', relation: 'relates to', evidence: ['s2'] },
        { from: 'X', to: 'Z', relation: 'relates to', evidence: ['s3'] },
      ],
    }, 'd');
    const comm = detectCommunities(g)[0];
    const summary = extractiveCommunitySummary(g, comm);
    expect(summary.summary).toContain('relates to'); // node summaries are empty; falls back to relation phrases
  });
});

describe('rankCommunities', () => {
  function thematicGraph() {
    const g = emptyDocGraph();
    g.nodes = [
      {
        id: 'identity',
        type: 'system',
        label: 'Microsoft Entra ID',
        aliases: ['Azure AD'],
        summary: 'Provides authentication and identity governance.',
        evidenceSentenceIds: ['s1'],
        docIds: ['d1'],
      },
      {
        id: 'budget',
        type: 'process',
        label: 'Financial planning',
        aliases: [],
        summary: 'Forecasting budgets and expenditures.',
        evidenceSentenceIds: ['s2'],
        docIds: ['d2'],
      },
    ];
    g.edges = [{ id: 'e1', from: 'identity', to: 'identity', relation: 'authenticates', evidenceSentenceIds: ['s1'] }];
    g.communities = [
      { id: 'security', title: 'Identity security', summary: 'Authentication controls.', nodeIds: ['identity'], evidenceSentenceIds: ['s1'] },
      { id: 'finance', title: 'Budget planning', summary: 'Financial forecasts.', nodeIds: ['budget'], evidenceSentenceIds: ['s2'] },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `other-${i}`,
        title: `Other topic ${i}`,
        summary: 'Unrelated material.',
        nodeIds: [],
        evidenceSentenceIds: [`o${i}`],
      })),
    ];
    return g;
  }

  it('ranks titles, member aliases, and internal relations against the query', () => {
    const ranked = rankCommunities(thematicGraph(), 'How does Azure AD authenticate users?');
    expect(ranked.map((community) => community.id)).toEqual(['security']);
    expect(rankCommunities(thematicGraph(), 'authenticates').map((community) => community.id)).toEqual(['security']);
  });

  it('returns only communities with support for a specific query', () => {
    const ranked = rankCommunities(thematicGraph(), 'budget forecast');
    expect(ranked.map((community) => community.id)).toEqual(['finance']);
    expect(rankCommunities(thematicGraph(), 'quantum biology')).toEqual([]);
  });

  it('returns the first five communities for a generic corpus-level request', () => {
    const ranked = rankCommunities(thematicGraph(), 'What are the main themes in the whole collection?');
    expect(ranked).toHaveLength(5);
    expect(ranked.map((community) => community.id)).toEqual(['security', 'finance', 'other-0', 'other-1', 'other-2']);
  });

  it('uses original community order as a deterministic tie-break', () => {
    const g = thematicGraph();
    g.communities = [
      { id: 'first', title: 'Cloud one', summary: '', nodeIds: [], evidenceSentenceIds: [] },
      { id: 'second', title: 'Cloud two', summary: '', nodeIds: [], evidenceSentenceIds: [] },
    ];
    expect(rankCommunities(g, 'cloud').map((community) => community.id)).toEqual(['first', 'second']);
  });
});
