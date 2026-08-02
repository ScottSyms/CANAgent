import { describe, expect, it } from 'vitest';
import {
  coerceExtraction,
  emptyDocGraph,
  markDocFailed,
  markDocProcessed,
  mergeExtraction,
  renderSubgraphForModel,
  selectSubgraph,
  type DocExtraction,
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
});
