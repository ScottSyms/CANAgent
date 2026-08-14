import { describe, expect, it } from 'vitest';
import {
  coerceExtraction,
  cosineSim,
  emptyDocGraph,
  markDocFailed,
  markDocProcessed,
  mergeExtraction,
  mergeSimilarNodes,
  renderSubgraphForModel,
  retypeEdge,
  selectSubgraph,
  type DocExtraction,
  type GraphNode,
} from './docGraph';

const ids = (...xs: string[]) => new Set(xs);

describe('coerceExtraction', () => {
  it('keeps well-formed entities/relations and only valid evidence ids', () => {
    const obj = {
      entities: [
        { label: 'SSC', type: 'organization', summary: 'A department.', evidence: ['d1:c0:s0#aa', 'fake#zz'] },
        { label: '', type: 'x', summary: 'dropped (no label)', evidence: [] },
      ],
      relations: [
        { from: 'SSC', to: 'Azure', relation: 'uses', evidence: ['d1:c0:s1#bb', 'nope'] },
        { from: 'SSC', to: '', relation: 'uses', evidence: [] }, // dropped
      ],
    };
    const out = coerceExtraction(obj, ids('d1:c0:s0#aa', 'd1:c0:s1#bb'));
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]).toMatchObject({ label: 'SSC', type: 'organization' });
    expect(out.entities[0].evidence).toEqual(['d1:c0:s0#aa']); // fabricated id dropped
    expect(out.relations).toHaveLength(1);
    expect(out.relations[0].evidence).toEqual(['d1:c0:s1#bb']);
  });

  it('tolerates garbage input', () => {
    expect(coerceExtraction(null, ids())).toEqual({ entities: [], relations: [] });
    expect(coerceExtraction({ entities: 'x' }, ids())).toEqual({ entities: [], relations: [] });
  });

  it('drops entities and relations that have no valid source evidence', () => {
    const out = coerceExtraction({
      entities: [{ label: 'Unsupported', type: 'x', summary: 'claim', evidence: ['fabricated'] }],
      relations: [{ from: 'A', to: 'B', relation: 'claims', evidence: [] }],
    }, ids('real'));
    expect(out).toEqual({ entities: [], relations: [] });
  });
});

describe('mergeExtraction', () => {
  it('merges the same entity across documents (case-insensitive) and unions evidence + docs', () => {
    const g = emptyDocGraph();
    const d1: DocExtraction = {
      entities: [{ label: 'Shared Services Canada', type: 'org', summary: 'A department.', evidence: ['s1'] }],
      relations: [],
    };
    const d2: DocExtraction = {
      entities: [{ label: 'shared services canada', type: 'org', summary: '', evidence: ['s2'] }],
      relations: [],
    };
    mergeExtraction(g, d1, 'doc-1');
    mergeExtraction(g, d2, 'doc-2');
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].evidenceSentenceIds).toEqual(['s1', 's2']);
    expect(g.nodes[0].docIds).toEqual(['doc-1', 'doc-2']);
    expect(g.processedDocIds).toEqual(['doc-1', 'doc-2']);
  });

  it('creates nodes for relation endpoints and merges edges by (from,relation,to)', () => {
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [], relations: [{ from: 'SSC', to: 'Azure', relation: 'uses', evidence: ['s1'] }] }, 'doc-1');
    mergeExtraction(g, { entities: [], relations: [{ from: 'SSC', to: 'Azure', relation: 'uses', evidence: ['s2'] }] }, 'doc-2');
    expect(g.nodes.map((n) => n.label).sort()).toEqual(['Azure', 'SSC']);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].evidenceSentenceIds).toEqual(['s1', 's2']);
  });

  it('does not silently discard entities after the former storage ceiling', () => {
    const g = emptyDocGraph();
    mergeExtraction(g, {
      entities: Array.from({ length: 650 }, (_, i) => ({
        label: `Entity ${i}`,
        type: 'item',
        summary: `Summary ${i}`,
        evidence: [`s${i}`],
      })),
      relations: [],
    }, 'doc-1');

    expect(g.nodes).toHaveLength(650);
    expect(g.nodes.at(-1)?.label).toBe('Entity 649');
  });

  it('keeps a richer later summary instead of the first summary', () => {
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [{ label: 'Shared', type: 'x', summary: 'Short.', evidence: ['s1'] }], relations: [] }, 'd1');
    mergeExtraction(g, {
      entities: [{ label: 'Shared', type: 'x', summary: 'A more complete description from another source.', evidence: ['s2'] }],
      relations: [],
    }, 'd2');
    expect(g.nodes[0].summary).toBe('A more complete description from another source.');
  });
});

describe('selectSubgraph + render', () => {
  const g = emptyDocGraph();
  mergeExtraction(
    g,
    {
      entities: [
        { label: 'SSC', type: 'org', summary: 'Runs IT for departments.', evidence: ['s1'] },
        { label: 'Azure OpenAI', type: 'system', summary: 'Cloud model service.', evidence: ['s2'] },
        { label: 'Unrelated', type: 'x', summary: 'nothing here.', evidence: ['s3'] },
      ],
      relations: [{ from: 'SSC', to: 'Azure OpenAI', relation: 'uses', evidence: ['s4'] }],
    },
    'doc-1',
  );

  it('finds a query-matched node and expands one hop to its neighbor', () => {
    const sub = selectSubgraph(g, 'what does SSC use?');
    const labels = sub.nodes.map((n) => n.label).sort();
    expect(labels).toContain('SSC');
    expect(labels).toContain('Azure OpenAI'); // pulled in via the edge
    expect(labels).not.toContain('Unrelated');
  });

  it('renders sentence-tagged lines for the model', () => {
    const sub = selectSubgraph(g, 'SSC');
    const text = renderSubgraphForModel(sub);
    expect(text).toContain('Entities:');
    expect(text).toContain('Relationships:');
    expect(text).toContain('SSC —uses→ Azure OpenAI [[s4]]');
    expect(text).toContain('[[s1]]');
  });
});

describe('mergeExtraction touchedNodeIds', () => {
  it('records every node resolved (created or matched) this call, and only this call', () => {
    const g = emptyDocGraph();
    const first = new Set<string>();
    mergeExtraction(g, { entities: [{ label: 'Alpha', type: 'x', summary: 's', evidence: ['s1'] }], relations: [] }, 'd1', {
      touchedNodeIds: first,
    });
    expect(first.size).toBe(1);
    const alphaId = g.nodes[0].id;
    expect([...first]).toEqual([alphaId]);

    const second = new Set<string>();
    mergeExtraction(
      g,
      { entities: [{ label: 'alpha', type: 'x', summary: 'more', evidence: ['s2'] }], relations: [{ from: 'Alpha', to: 'Beta', relation: 'r', evidence: ['s3'] }] },
      'd2',
      { touchedNodeIds: second },
    );
    // Re-matching Alpha (case-insensitive) and creating Beta both count as touched this round.
    expect(second.size).toBe(2);
    expect(second.has(alphaId)).toBe(true);
  });

  it('is optional — omitting it does not throw', () => {
    const g = emptyDocGraph();
    expect(() => mergeExtraction(g, { entities: [{ label: 'X', type: 'x', summary: '', evidence: ['s1'] }], relations: [] }, 'd')).not.toThrow();
  });
});

describe('cosineSim', () => {
  it('scores identical, orthogonal, and opposite vectors correctly', () => {
    expect(cosineSim([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSim([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    expect(cosineSim([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1);
  });

  it('scores 0 for mismatched dimensions rather than throwing', () => {
    expect(cosineSim([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe('mergeSimilarNodes', () => {
  function nodeFixture(over: Partial<GraphNode>): GraphNode {
    return { id: 'n', type: 'entity', label: 'N', aliases: [], summary: '', evidenceSentenceIds: [], docIds: [], ...over };
  }

  it('merges compatible near-duplicate nodes above the threshold, unioning aliases/evidence/edges', async () => {
    const g = emptyDocGraph();
    g.nodes = [
      nodeFixture({ id: 'n1', label: 'Acme Corp.', summary: 'A vendor.', evidenceSentenceIds: ['s1'], docIds: ['d1'] }),
      nodeFixture({ id: 'n2', label: 'Acme Corporation', summary: 'A longer vendor description.', evidenceSentenceIds: ['s2'], docIds: ['d2'] }),
      nodeFixture({ id: 'n3', label: 'Other', type: 'entity', evidenceSentenceIds: ['s3'] }),
    ];
    g.edges = [{ id: 'e1', from: 'n2', to: 'n3', relation: 'buys from', evidenceSentenceIds: ['s4'] }];
    const embeddings = new Map([
      ['n1', [1, 0, 0]],
      ['n2', [0.99, Math.sqrt(1 - 0.99 * 0.99), 0]],
      ['n3', [0, 1, 0]],
    ]);

    const { mergedCount, idRemap } = await mergeSimilarNodes(g, embeddings, { threshold: 0.9 });

    expect(mergedCount).toBe(1);
    expect(idRemap.get('n2')).toBe('n1');
    expect(g.nodes.map((n) => n.id)).toEqual(['n1', 'n3']);
    const survivor = g.nodes.find((n) => n.id === 'n1')!;
    expect(survivor.summary).toBe('A longer vendor description.'); // richer summary wins
    expect(survivor.aliases).toContain('Acme Corporation');
    expect(survivor.evidenceSentenceIds).toEqual(['s1', 's2']);
    expect(survivor.docIds).toEqual(['d1', 'd2']);
    expect(g.edges).toEqual([{ id: expect.any(String), from: 'n1', to: 'n3', relation: 'buys from', evidenceSentenceIds: ['s4'] }]);
  });

  it('does not merge incompatible types even at high similarity', async () => {
    const g = emptyDocGraph();
    g.nodes = [nodeFixture({ id: 'n1', type: 'person', label: 'Jordan' }), nodeFixture({ id: 'n2', type: 'organization', label: 'Jordan Inc' })];
    const embeddings = new Map([['n1', [1, 0]], ['n2', [1, 0]]]);
    const { mergedCount } = await mergeSimilarNodes(g, embeddings, { threshold: 0.9 });
    expect(mergedCount).toBe(0);
    expect(g.nodes).toHaveLength(2);
  });

  it('does not merge below the similarity threshold', async () => {
    const g = emptyDocGraph();
    g.nodes = [nodeFixture({ id: 'n1', label: 'A' }), nodeFixture({ id: 'n2', label: 'B' })];
    const embeddings = new Map([['n1', [1, 0]], ['n2', [0, 1]]]);
    const { mergedCount } = await mergeSimilarNodes(g, embeddings, { threshold: 0.9 });
    expect(mergedCount).toBe(0);
  });

  it('rewrites dirtyNodeIds in place when an absorbed id is remapped', async () => {
    const g = emptyDocGraph();
    g.nodes = [nodeFixture({ id: 'n1', label: 'Acme Corp.' }), nodeFixture({ id: 'n2', label: 'Acme Corporation' })];
    g.dirtyNodeIds = ['n2'];
    const embeddings = new Map([['n1', [1, 0]], ['n2', [1, 0]]]);
    await mergeSimilarNodes(g, embeddings, { threshold: 0.9 });
    expect(g.dirtyNodeIds).toEqual(['n1']);
  });

  it('drops a self-loop created when a merge collapses both edge endpoints onto the same node', async () => {
    const g = emptyDocGraph();
    g.nodes = [nodeFixture({ id: 'n1', label: 'A' }), nodeFixture({ id: 'n2', label: 'A2' })];
    g.edges = [{ id: 'e1', from: 'n1', to: 'n2', relation: 'relates to', evidenceSentenceIds: ['s1'] }];
    const embeddings = new Map([['n1', [1, 0]], ['n2', [1, 0]]]);
    await mergeSimilarNodes(g, embeddings, { threshold: 0.9 });
    expect(g.edges).toEqual([]);
  });

  it('completes in well under a second at graph-node scale in the low thousands (regression guard against a reintroduced O(n³)/O(n) hidden scan)', async () => {
    const g = emptyDocGraph();
    const NODE_COUNT = 1800;
    const DIM = 384; // matches the production local embedder's dimensionality

    // Deterministic pseudo-random unit vectors. In 384 dimensions, random
    // unit vectors are near-orthogonal with overwhelming probability (mean
    // cosine ~0, stddev ~1/sqrt(384) ~= 0.05) -- 0.9 is ~17 standard
    // deviations out, so across ~1.6M pairs essentially none should merge.
    // This is the worst case for the old bug: the removed find() calls ran
    // unconditionally, before the cheap type/threshold checks that would
    // otherwise skip a non-matching pair.
    function pseudoRandomVector(seed: number, dim: number): number[] {
      let s = seed;
      const next = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      const v = Array.from({ length: dim }, () => next() * 2 - 1);
      const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    }

    const embeddings = new Map<string, number[]>();
    g.nodes = Array.from({ length: NODE_COUNT }, (_, i) => {
      const id = `n${i}`;
      embeddings.set(id, pseudoRandomVector(i + 1, DIM));
      return nodeFixture({ id, label: `Entity ${i}` });
    });

    const start = Date.now();
    const { mergedCount } = await mergeSimilarNodes(g, embeddings, { threshold: 0.9 });
    const elapsedMs = Date.now() - start;

    expect(mergedCount).toBe(0); // near-orthogonal vectors -- nothing should merge
    // Generous bound: true O(n²) at this scale is well under a second; the
    // old O(n³) bug (two extra full-array scans per pair) would blow far past
    // this on 1800 nodes. Loose enough to avoid CI flakiness.
    expect(elapsedMs).toBeLessThan(5000);
  });
});

describe('retypeEdge', () => {
  // Build the initial edge via mergeExtraction (not a hand-rolled fixture) so
  // its id is a real edgeIdFor hash — retypeEdge's whole point is keeping
  // that hash consistent with (from, relation, to), so the test needs a
  // starting id that's actually derived that way.
  function edgeGraph(relation: string): { g: ReturnType<typeof emptyDocGraph> } {
    const g = emptyDocGraph();
    mergeExtraction(
      g,
      {
        entities: [
          { label: 'Alice', type: 'entity', summary: '', evidence: [] },
          { label: 'Acme', type: 'entity', summary: '', evidence: [] },
        ],
        relations: [{ from: 'Alice', to: 'Acme', relation, evidence: ['s1'] }],
      },
      'd1',
    );
    return { g };
  }

  it('recomputes the edge id so a later rebuild regenerating the old relation cannot collide with it', () => {
    const { g } = edgeGraph('co-occurs with');
    const before = g.edges[0].id;
    retypeEdge(g, g.edges[0], 'works for');
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].relation).toBe('works for');
    expect(g.edges[0].id).not.toBe(before);
  });

  it('merges into an existing edge that already has the target relation, dropping the duplicate', () => {
    const { g } = edgeGraph('co-occurs with');
    // Add a second, already-typed edge between the same two nodes the way a
    // real rebuild would: via mergeExtraction, so its id is the same
    // edgeIdFor hash retypeEdge will compute for the upgrade.
    mergeExtraction(
      g,
      { entities: [], relations: [{ from: 'Alice', to: 'Acme', relation: 'works for', evidence: ['s2'] }] },
      'd1',
    );
    expect(g.edges).toHaveLength(2);
    retypeEdge(g, g.edges[0], 'works for');
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].relation).toBe('works for');
    expect(g.edges[0].evidenceSentenceIds.sort()).toEqual(['s1', 's2']);
  });

  it('is a no-op when the new relation hashes to the same id (case/whitespace-insensitive match)', () => {
    const { g } = edgeGraph('co-occurs with');
    const before = g.edges[0].id;
    retypeEdge(g, g.edges[0], 'Co-Occurs With');
    expect(g.edges[0].id).toBe(before);
    expect(g.edges[0].relation).toBe('Co-Occurs With');
  });
});

describe('markDocProcessed / markDocFailed', () => {
  it('markDocProcessed dedupes and does not duplicate processedDocIds', () => {
    const g = emptyDocGraph();
    markDocProcessed(g, 'doc-1');
    markDocProcessed(g, 'doc-1');
    expect(g.processedDocIds).toEqual(['doc-1']);
  });

  it('markDocFailed dedupes and records a reason', () => {
    const g = emptyDocGraph();
    markDocFailed(g, 'doc-1', 'truncated');
    markDocFailed(g, 'doc-1', 'truncated again');
    expect(g.failedDocIds).toEqual(['doc-1']);
    expect(g.docErrors).toEqual({ 'doc-1': 'truncated again' });
    expect(g.processedDocIds).toEqual([]); // failed docs stay out of processedDocIds
  });

  it('a later success clears a prior failure', () => {
    const g = emptyDocGraph();
    markDocFailed(g, 'doc-1', 'truncated');
    markDocProcessed(g, 'doc-1');
    expect(g.processedDocIds).toEqual(['doc-1']);
    expect(g.failedDocIds).toEqual([]);
    expect(g.docErrors).toEqual({});
  });

  it('a later failure removes a previously processed document', () => {
    const g = emptyDocGraph();
    markDocProcessed(g, 'doc-1');
    markDocFailed(g, 'doc-1', 'window failed');
    expect(g.processedDocIds).toEqual([]);
    expect(g.failedDocIds).toEqual(['doc-1']);
  });
});
