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
    expect(html).toContain('id="overview"');
  });
});

describe('renderStudioSection', () => {
  it('empty state does not throw and renders nothing', () => {
    expect(renderStudioSection(null)).toBe('');
    expect(renderStudioSection({ outputs: {} })).toBe('');
  });

  it('renders each generated output with its title and cited markdown with anchor links', () => {
    const citation: Citation = {
      sentenceId: 's1',
      docName: 'doc.pdf',
      url: 'file:///doc.pdf',
      sentenceText: 'Some source sentence.',
      chunkText: 'Some source sentence.',
      start: 0,
      end: 10,
    };
    const studio: StudioDoc = {
      outputs: {
        faq: {
          kind: 'faq',
          title: 'FAQ — repo',
          markdown: 'Some FAQ text with [[s1]].',
          citations: [citation],
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    const html = renderStudioSection(studio);
    expect(html).toContain('FAQ');
    expect(html).toContain('Some FAQ text with');
    expect(html).toContain('href="#ref-studio-faq-1"');
    expect(html).toContain('id="ref-studio-faq-1"');
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
    expect(html).toContain('id="knowledge-graph"');
    expect(html).toContain('class="kb-graph-svg"'); // SVG concept map
    expect(html).toContain('Concept Map');
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
    expect(html).toContain('id="ref-node-');
  });
});

describe('exportKnowledgeBaseHtml', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls downloadBlob with TOC and correct section order (Overview -> Studio -> Knowledge Graph)', () => {
    const spy = vi.spyOn(conversationExport, 'downloadBlob').mockImplementation(() => {});
    const overview: NotebookOverview = {
      overviewMarkdown: 'Overview text.',
      keyTopics: ['topic1'],
      suggestedQuestions: [],
      docCount: 1,
      chunkCount: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const studio: StudioDoc = {
      outputs: {
        briefing: {
          kind: 'briefing',
          title: 'Briefing',
          markdown: 'Briefing text.',
          citations: [],
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    const g = emptyDocGraph();
    mergeExtraction(g, { entities: [{ label: 'E1', type: 't', summary: 's', evidence: [] }], relations: [] }, 'doc-1');

    exportKnowledgeBaseHtml('My Repo', { notebook: overview, graph: g, studio });
    expect(spy).toHaveBeenCalledTimes(1);
    const [content, type, filename] = spy.mock.calls[0];
    expect(type).toBe('text/html');
    expect(content).toContain('<!doctype html>');
    expect(content).toContain('Table of Contents');
    expect(content).toContain('href="#overview"');
    expect(content).toContain('href="#studio"');
    expect(content).toContain('href="#knowledge-graph"');

    // Section order check: Overview before Studio before Knowledge Graph
    const overviewIdx = content.indexOf('id="overview"');
    const studioIdx = content.indexOf('id="studio"');
    const graphIdx = content.indexOf('id="knowledge-graph"');
    expect(overviewIdx).toBeGreaterThan(-1);
    expect(studioIdx).toBeGreaterThan(overviewIdx);
    expect(graphIdx).toBeGreaterThan(studioIdx);

    expect(filename).toMatch(/^kb-my-repo-\d{4}-\d{2}-\d{2}\.html$/);
  });

  it('uses AI-generated title as the document heading when available', () => {
    const spy = vi.spyOn(conversationExport, 'downloadBlob').mockImplementation(() => {});
    const overview: NotebookOverview = {
      title: 'Comprehensive Arctic Maritime Strategy',
      overviewMarkdown: 'Overview text.',
      keyTopics: ['topic1'],
      suggestedQuestions: [],
      docCount: 1,
      chunkCount: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };

    exportKnowledgeBaseHtml('repo-folder-name', { notebook: overview, graph: null, studio: null });
    expect(spy).toHaveBeenCalledTimes(1);
    const [content, _type, filename] = spy.mock.calls[0];
    expect(content).toContain('Comprehensive Arctic Maritime Strategy');
    expect(content).toContain('Repository: repo-folder-name');
    expect(filename).toMatch(/^kb-comprehensive-arctic-maritime-strategy-\d{4}-\d{2}-\d{2}\.html$/);
  });
});
