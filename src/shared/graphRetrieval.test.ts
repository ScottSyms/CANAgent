import { describe, expect, it } from 'vitest';
import type { DocGraph } from './docGraph';
import { rankGraphEvidence } from './graphRetrieval';
import type { ChunkInput } from './vectorSearch';

function chunk(id: string, name = `${id}.md`): ChunkInput {
  return {
    name,
    url: `file:///${name}`,
    text: `Evidence for ${id}.`,
    chunkId: `${id}:c0`,
    sentences: [{ id, start: 0, end: 10 }],
  };
}

const graph: DocGraph = {
  version: 1,
  corpusRevision: 1,
  processedDocIds: ['d1', 'd2'],
  updatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    {
      id: 'ssc',
      type: 'organization',
      label: 'SSC',
      aliases: ['Shared Services Canada'],
      summary: 'Provides government technology services.',
      evidenceSentenceIds: ['s-ssc'],
      docIds: ['d1'],
    },
    {
      id: 'azure',
      type: 'platform',
      label: 'Azure OpenAI',
      aliases: [],
      summary: 'Cloud model platform.',
      evidenceSentenceIds: ['s-azure'],
      docIds: ['d2'],
    },
    {
      id: 'other',
      type: 'project',
      label: 'Unrelated Project',
      aliases: [],
      summary: 'A separate initiative.',
      evidenceSentenceIds: ['s-other'],
      docIds: ['d3'],
    },
  ],
  edges: [
    {
      id: 'uses',
      from: 'ssc',
      to: 'azure',
      relation: 'uses',
      evidenceSentenceIds: ['s-edge'],
    },
  ],
  communities: [
    {
      id: 'cloud',
      title: 'Cloud migration',
      summary: 'Adoption of cloud model services.',
      nodeIds: ['ssc', 'azure'],
      evidenceSentenceIds: ['s-community'],
    },
  ],
};

const chunks = [
  chunk('s-ssc', 'ssc.md'),
  chunk('s-azure', 'azure.md'),
  chunk('s-edge', 'relationship.md'),
  chunk('s-community', 'strategy.md'),
  chunk('s-other', 'other.md'),
];

describe('rankGraphEvidence', () => {
  it('ranks an alias match and expands to cross-document neighbor evidence', () => {
    const ranked = rankGraphEvidence(graph, 'How does Shared Services Canada use cloud models?', chunks);
    const indices = ranked.map((item) => item.i);

    expect(indices[0]).toBe(0);
    expect(indices).toContain(1);
    expect(indices).toContain(2);
    expect(indices).not.toContain(4);
  });

  it('surfaces relationship evidence when the query names its endpoints and relation', () => {
    const ranked = rankGraphEvidence(graph, 'How does SSC use Azure OpenAI?', chunks);
    expect(ranked.map((item) => item.i)).toContain(2);
  });

  it('uses relevant community evidence at a lower weight', () => {
    const ranked = rankGraphEvidence(graph, 'What is the cloud migration strategy?', chunks);
    const community = ranked.find((item) => item.i === 3);
    expect(community).toBeDefined();
    expect(community!.score).toBeLessThan(ranked[0].score);
  });

  it('ignores graph evidence that does not resolve to a current chunk', () => {
    const stale: DocGraph = {
      ...graph,
      nodes: [{ ...graph.nodes[0], evidenceSentenceIds: ['deleted-sentence'] }],
      edges: [],
      communities: [],
    };
    expect(rankGraphEvidence(stale, 'SSC', chunks)).toEqual([]);
  });

  it('honors edge and candidate caps', () => {
    const capped = rankGraphEvidence(graph, 'SSC', chunks, { edgeLimitPerSeed: 0, candidateLimit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0].i).toBe(0);
  });

  it('bounds expansion from a high-degree seed', () => {
    const neighborNodes = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      type: 'system',
      label: `Neighbor ${i}`,
      aliases: [],
      summary: 'Connected system.',
      evidenceSentenceIds: [`neighbor-${i}`],
      docIds: [`d${i}`],
    }));
    const highDegree: DocGraph = {
      ...graph,
      nodes: [graph.nodes[0], ...neighborNodes],
      edges: neighborNodes.map((node, i) => ({
        id: `edge-${i}`,
        from: 'ssc',
        to: node.id,
        relation: 'connects',
        evidenceSentenceIds: [`edge-${i}`],
      })),
      communities: [],
    };
    const highDegreeChunks = [
      chunk('s-ssc'),
      ...neighborNodes.map((_, i) => chunk(`neighbor-${i}`)),
      ...neighborNodes.map((_, i) => chunk(`edge-${i}`)),
    ];
    const ranked = rankGraphEvidence(highDegree, 'SSC', highDegreeChunks, { edgeLimitPerSeed: 2 });

    expect(ranked.map((item) => item.i)).toEqual([0, 9, 10, 1, 2]);
  });

  it('is deterministic when chunk scores tie', () => {
    const tied: DocGraph = {
      ...graph,
      nodes: [
        { ...graph.nodes[0], id: 'a', label: 'Cloud A', aliases: [], evidenceSentenceIds: ['s-ssc'] },
        { ...graph.nodes[0], id: 'b', label: 'Cloud B', aliases: [], evidenceSentenceIds: ['s-azure'] },
      ],
      edges: [],
      communities: [],
    };
    expect(rankGraphEvidence(tied, 'cloud', chunks)).toEqual([
      { i: 0, score: 26 },
      { i: 1, score: 26 },
    ]);
  });

  it('returns no candidates for an empty or unmatched query', () => {
    expect(rankGraphEvidence(graph, '', chunks)).toEqual([]);
    expect(rankGraphEvidence(graph, 'zzzz-no-match', chunks)).toEqual([]);
  });
});
