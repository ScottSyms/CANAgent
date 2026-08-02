// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportKnowledgeBaseHtml,
  renderGraphSection,
  renderNotebookSection,
  renderStudioSection,
} from './knowledgeBaseExport';
import { emptyDocGraph, mergeExtraction } from '../shared/docGraph';
import type { Citation, NotebookOverview, StudioDoc } from '../shared/types';
import * as conversationExport from './conversationExport';

describe('renderNotebookSection', () => {
  it('empty state does not throw and renders nothing', () => {
    expect(renderNotebookSection(null)).toBe('');
  });

  it('renders overview markdown, topic chips, and suggested questions', () => {
    const overview: NotebookOverview = {
      overviewMarkdown: '## About\nArctic shipping.',
      keyTopics: ['shipping', 'arctic'],
      suggestedQuestions: ['What routes are covered?'],
      docCount: 1,
      chunkCount: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const html = renderNotebookSection(overview);
    expect(html).toContain('Arctic shipping');
    expect(html).toContain('shipping');
    expect(html).toContain('What routes are covered?');
  });
});

describe('renderStudioSection', () => {
  it('empty state does not throw and renders nothing', () => {
    expect(renderStudioSection(null)).toBe('');
    expect(renderStudioSection({ outputs: {} })).toBe('');
  });

  it('renders each generated output with its title and cited markdown', () => {
    const studio: StudioDoc = {
      outputs: {
        faq: {
          kind: 'faq',
          title: 'FAQ — repo',
          markdown: 'Some FAQ text.',
          citations: [],
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    const html = renderStudioSection(studio);
    expect(html).toContain('FAQ');
    expect(html).toContain('Some FAQ text.');
  });
});

describe('renderGraphSection', () => {
  const g = emptyDocGraph();
  mergeExtraction(
    g,
    {
      entities: [
        { label: 'SSC', type: 'org', summary: 'Runs IT.', evidence: ['s1'] },
        { label: 'Azure OpenAI', type: 'system', summary: 'Cloud model service.', evidence: ['s2'] },
      ],
      relations: [{ from: 'SSC', to: 'Azure OpenAI', relation: 'uses', evidence: ['s3'] }],
    },
    'doc-1',
  );
  g.communities = [{ id: 'com0', title: 'Cloud adoption', summary: 'About cloud use.', nodeIds: g.nodes.map((n) => n.id), evidenceSentenceIds: [] }];

  it('empty state does not throw and renders nothing', () => {
    expect(renderGraphSection(null)).toBe('');
    expect(renderGraphSection(emptyDocGraph())).toBe('');
  });

  it('emits an anchor id per node and internal links for edges', () => {
    const html = renderGraphSection(g);
    const sscNode = g.nodes.find((n) => n.label === 'SSC')!;
    const azureNode = g.nodes.find((n) => n.label === 'Azure OpenAI')!;
    expect(html).toContain(`id="node-${sscNode.id}"`);
    expect(html).toContain(`id="node-${azureNode.id}"`);
    expect(html).toContain(`href="#node-${azureNode.id}"`); // the edge links to the target node's anchor
    expect(html).toContain('Cloud adoption'); // theme rendered
  });

  it('resolves evidence to citation text when provided', () => {
    const citation: Citation = {
      sentenceId: 's1',
      docName: 'doc.pdf',
      url: 'file:///doc.pdf',
      sentenceText: 'SSC runs common IT services.',
      chunkText: 'SSC runs common IT services.',
      start: 0,
      end: 10,
    };
    const html = renderGraphSection(g, [citation]);
    expect(html).toContain('SSC runs common IT services.');
  });
});

describe('exportKnowledgeBaseHtml', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls downloadBlob with a self-contained HTML doc and a repo-derived filename', () => {
    const spy = vi.spyOn(conversationExport, 'downloadBlob').mockImplementation(() => {});
    exportKnowledgeBaseHtml('My Repo', { notebook: null, graph: null, studio: null });
    expect(spy).toHaveBeenCalledTimes(1);
    const [content, type, filename] = spy.mock.calls[0];
    expect(type).toBe('text/html');
    expect(content).toContain('<!doctype html>');
    expect(content).toContain('My Repo');
    expect(filename).toMatch(/^kb-my-repo-\d{4}-\d{2}-\d{2}\.html$/);
  });
});
