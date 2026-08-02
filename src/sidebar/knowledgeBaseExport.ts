// Single-file HTML export of a notebook's Knowledge Base artifacts: the
// overview, generated studio documents (briefing/FAQ/study guide), and the
// extracted knowledge graph (with internal anchor links between related entities).
// Reuses the standalone-HTML pattern from conversationExport.ts —
// this module is a pure renderer (no chrome.* calls); the caller fetches the
// data and passes it in, matching how exportConversationHtml is invoked.

import type { CommunitySummary, DocGraph, GraphEdge, GraphNode } from '../shared/docGraph';
import type { Citation, NotebookOverview, StudioDoc, StudioKind } from '../shared/types';
import { escapeHtml, renderMarkdown, downloadBlob } from './conversationExport';
import { citationTokenRe } from '../shared/citations';

const SAFE_ID = /^[\w:#.\-]+$/;

const STUDIO_TITLES: Record<StudioKind, string> = {
  briefing: 'Briefing',
  faq: 'FAQ',
  study_guide: 'Study guide',
};

/** A stable, HTML-id-safe anchor for a graph node. Node ids are already the safe `n_<hash>` form. */
function nodeAnchor(nodeId: string): string {
  return `node-${escapeHtml(nodeId)}`;
}

/** Replace `[[id]]` citation tokens in markdown HTML with clickable anchor links `<a href="#ref-...">`. */
function injectCitationHyperlinks(html: string, numberById: Map<string, number>, prefix: string): string {
  return html.replace(citationTokenRe(), (_whole, rawId: string) => {
    const id = rawId.trim();
    const n = numberById.get(id);
    if (!n || !SAFE_ID.test(id)) return '';
    return `<a href="#ref-${prefix}-${n}" class="cite-link" title="Jump to reference ${n}"><sup class="cite-chip">${n}</sup></a>`;
  });
}

/** Render a numbered footnote list of citations with target anchor ids (`id="ref-..."`). */
export function renderCitationsWithAnchors(citations: Citation[], prefix: string): string {
  const items = citations
    .map((c, i) => {
      const page = c.page ? ` (p.${c.page})` : '';
      const href = c.page && !c.url.includes('#') ? `${c.url}#page=${c.page}` : c.url;
      const refId = `ref-${prefix}-${i + 1}`;
      return (
        `<li id="${refId}"><span class="cite-n">${i + 1}</span> ` +
        `“${escapeHtml(c.sentenceText)}” — ` +
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.docName)}${escapeHtml(page)}</a></li>`
      );
    })
    .join('');
  return `<ol class="export-citations">${items}</ol>`;
}

export function renderNotebookSection(overview: NotebookOverview | null): string {
  if (!overview) return '';
  const topics = overview.keyTopics.length
    ? `<div class="kb-chips">${overview.keyTopics.map((t) => `<span class="kb-chip">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  const questions = overview.suggestedQuestions.length
    ? `<ul class="kb-questions-list">${overview.suggestedQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`
    : '';
  return (
    `<section class="kb-section" id="overview">` +
    `<div class="kb-section-header"><h2>1. Overview</h2></div>` +
    `<div class="kb-card">` +
    `<div class="md">${renderMarkdown(overview.overviewMarkdown)}</div>` +
    topics +
    (questions ? `<div class="kb-suggested"><h3>Suggested questions</h3>${questions}</div>` : '') +
    `</div>` +
    `</section>`
  );
}

/**
 * Render a claim's markdown with its [[id]] citation tokens turned into
 * hyperlinked numbered chips, plus the numbered evidence list with anchor targets.
 */
function renderCitedMarkdown(markdown: string, citations: Citation[], prefix: string): string {
  let html = renderMarkdown(markdown);
  if (citations.length > 0) {
    const numberById = new Map(citations.map((c, i) => [c.sentenceId, i + 1] as const));
    html = injectCitationHyperlinks(html, numberById, prefix);
  }
  const cites = citations.length > 0 ? renderCitationsWithAnchors(citations, prefix) : '';
  return `<div class="md">${html}</div>${cites}`;
}

export function renderStudioSection(studio: StudioDoc | null): string {
  if (!studio) return '';
  const outputs = Object.values(studio.outputs).filter((o) => !!o);
  if (outputs.length === 0) return '';
  const parts = outputs.map(
    (o) =>
      `<article class="kb-studio-doc">` +
      `<h3>${escapeHtml(STUDIO_TITLES[o!.kind])}</h3>` +
      renderCitedMarkdown(o!.markdown, o!.citations, `studio-${o!.kind}`) +
      `</article>`,
  );
  return (
    `<section class="kb-section" id="studio">` +
    `<div class="kb-section-header"><h2>2. Studio Artifacts</h2></div>` +
    parts.join('') +
    `</section>`
  );
}

/**
 * Render one graph node: anchor id, label/type/summary, and its evidence citations with anchor links.
 */
function renderNode(node: GraphNode, evidenceById: Map<string, Citation>): string {
  const evidence = node.evidenceSentenceIds
    .map((id) => evidenceById.get(id))
    .filter((c): c is Citation => !!c);
  const evidenceHtml =
    evidence.length > 0
      ? renderCitationsWithAnchors(evidence, `node-${node.id}`)
      : node.evidenceSentenceIds.length > 0
        ? `<p class="kb-note">Evidence: ${node.evidenceSentenceIds.map(escapeHtml).join(', ')}</p>`
        : '';
  return (
    `<section class="kb-node" id="${nodeAnchor(node.id)}">` +
    `<h4>${escapeHtml(node.label)} <span class="kb-type">${escapeHtml(node.type)}</span></h4>` +
    (node.summary ? `<p>${escapeHtml(node.summary)}</p>` : '') +
    evidenceHtml +
    `</section>`
  );
}

function renderEdges(edges: GraphEdge[], nodesById: Map<string, GraphNode>): string {
  if (edges.length === 0) return '';
  const items = edges
    .map((e) => {
      const from = nodesById.get(e.from);
      const to = nodesById.get(e.to);
      if (!from || !to) return '';
      return (
        `<li><a href="#${nodeAnchor(from.id)}" class="node-link">${escapeHtml(from.label)}</a> ` +
        `<span class="edge-rel">&mdash;${escapeHtml(e.relation)}&rarr;</span> ` +
        `<a href="#${nodeAnchor(to.id)}" class="node-link">${escapeHtml(to.label)}</a></li>`
      );
    })
    .join('');
  return `<h3>Relationships</h3><ul class="kb-edges">${items}</ul>`;
}

function renderCommunities(communities: CommunitySummary[], nodesById: Map<string, GraphNode>): string {
  if (communities.length === 0) return '';
  const items = communities
    .map((c) => {
      const members = c.nodeIds
        .map((id) => nodesById.get(id))
        .filter((n): n is GraphNode => !!n)
        .map((n) => `<a href="#${nodeAnchor(n.id)}" class="node-link">${escapeHtml(n.label)}</a>`)
        .join(', ');
      return (
        `<article class="kb-theme">` +
        `<h4>${escapeHtml(c.title)}</h4>` +
        `<p>${escapeHtml(c.summary)}</p>` +
        (members ? `<p class="kb-note">Entities: ${members}</p>` : '') +
        `</article>`
      );
    })
    .join('');
  return `<h3>Thematic Communities</h3>${items}`;
}

/**
 * Render the knowledge graph: Themes, Entities with resolved evidence, and Relationships.
 */
export function renderGraphSection(graph: DocGraph | null, evidence: Citation[] = []): string {
  if (!graph || graph.nodes.length === 0) return '';
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const evidenceById = new Map(evidence.map((c) => [c.sentenceId, c]));
  return (
    `<section class="kb-section" id="knowledge-graph">` +
    `<div class="kb-section-header"><h2>3. Knowledge Graph</h2></div>` +
    renderCommunities(graph.communities ?? [], nodesById) +
    `<h3>Entities & Provenance</h3>` +
    graph.nodes.map((n) => renderNode(n, evidenceById)).join('') +
    renderEdges(graph.edges, nodesById) +
    `</section>`
  );
}

function renderTableOfContents(hasOverview: boolean, hasStudio: boolean, hasGraph: boolean): string {
  const items: string[] = [];
  if (hasOverview) items.push(`<li><a href="#overview"><span class="toc-num">1</span> Overview</a></li>`);
  if (hasStudio) items.push(`<li><a href="#studio"><span class="toc-num">2</span> Studio Artifacts</a></li>`);
  if (hasGraph) items.push(`<li><a href="#knowledge-graph"><span class="toc-num">3</span> Knowledge Graph</a></li>`);

  if (items.length === 0) return '';
  return (
    `<nav class="kb-toc">` +
    `<div class="kb-toc-title">Table of Contents</div>` +
    `<ul class="kb-toc-list">${items.join('')}</ul>` +
    `</nav>`
  );
}

const KB_STYLE = `
  html { scroll-behavior: smooth; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1e293b;
    background: #f8fafc;
    margin: 0;
    padding: 0;
  }
  .wrap {
    max-width: 880px;
    margin: 32px auto;
    padding: 32px 40px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
  }
  .doc-head {
    margin-bottom: 28px;
    padding-bottom: 16px;
    border-bottom: 2px solid #e2e8f0;
  }
  .doc-head h1 {
    margin: 0 0 6px;
    font-size: 26px;
    font-weight: 800;
    color: #0f172a;
    letter-spacing: -0.02em;
  }
  .doc-head .meta {
    font-size: 13px;
    color: #64748b;
  }

  /* Table of Contents */
  .kb-toc {
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 14px 20px;
    margin-bottom: 32px;
  }
  .kb-toc-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #475569;
    margin-bottom: 8px;
  }
  .kb-toc-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
  }
  .kb-toc-list a {
    color: #2563eb;
    text-decoration: none;
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .kb-toc-list a:hover {
    text-decoration: underline;
  }
  .toc-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #dbeafe;
    color: #1d4ed8;
    font-size: 11px;
    font-weight: 700;
  }

  /* Sections & Cards */
  .kb-section {
    margin: 36px 0;
    scroll-margin-top: 20px;
  }
  .kb-section-header {
    border-bottom: 2px solid #e2e8f0;
    padding-bottom: 8px;
    margin-bottom: 16px;
  }
  .kb-section h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: #0f172a;
  }
  .kb-section h3 {
    margin: 20px 0 10px;
    font-size: 15px;
    font-weight: 700;
    color: #334155;
  }

  .kb-card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 20px;
  }

  .kb-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 16px 0 8px;
  }
  .kb-chip {
    font-size: 12px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 12px;
    background: #eff6ff;
    color: #1d4ed8;
    border: 1px solid #bfdbfe;
  }

  .kb-suggested {
    margin-top: 18px;
    padding-top: 12px;
    border-top: 1px solid #f1f5f9;
  }
  .kb-questions-list {
    padding-left: 1.2em;
    margin: 6px 0;
    font-size: 13.5px;
    color: #334155;
  }
  .kb-questions-list li {
    margin-bottom: 4px;
  }

  .kb-studio-doc {
    margin: 16px 0;
    padding: 20px;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    background: #ffffff;
  }
  .kb-studio-doc h3 {
    margin: 0 0 12px;
    font-size: 16px;
    font-weight: 700;
    color: #1e293b;
  }

  /* Knowledge Graph Items */
  .kb-theme {
    margin: 12px 0;
    padding: 14px 16px;
    border-left: 4px solid #2563eb;
    background: #f8fafc;
    border-radius: 0 8px 8px 0;
  }
  .kb-theme h4 {
    margin: 0 0 4px;
    font-size: 15px;
    color: #0f172a;
  }
  .kb-theme p {
    margin: 0 0 6px;
    font-size: 13.5px;
    color: #334155;
  }

  .kb-node {
    margin: 12px 0;
    padding: 14px 16px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    background: #ffffff;
    scroll-margin-top: 16px;
  }
  .kb-node h4 {
    margin: 0 0 6px;
    font-size: 15px;
    color: #0f172a;
  }
  .kb-type {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #64748b;
    background: #f1f5f9;
    padding: 2px 6px;
    border-radius: 4px;
    margin-left: 6px;
  }

  .kb-edges {
    padding-left: 1.2em;
    font-size: 13.5px;
  }
  .kb-edges li {
    margin-bottom: 6px;
  }
  .edge-rel {
    color: #64748b;
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .node-link {
    color: #2563eb;
    text-decoration: none;
    font-weight: 600;
  }
  .node-link:hover {
    text-decoration: underline;
  }

  /* Citations & Footnotes */
  .cite-link {
    text-decoration: none;
  }
  .cite-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    font-size: 10px;
    font-weight: 700;
    color: #1d4ed8;
    background: #dbeafe;
    border-radius: 8px;
    margin: 0 2px;
    vertical-align: super;
    line-height: 1;
    transition: background 0.12s, color 0.12s;
  }
  .cite-link:hover .cite-chip {
    background: #2563eb;
    color: #ffffff;
  }

  .export-citations {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid #f1f5f9;
    padding-left: 1.4em;
    font-size: 12.5px;
    color: #475569;
  }
  .export-citations li {
    margin-bottom: 6px;
    scroll-margin-top: 20px;
  }
  .export-citations li:target {
    background: #fef3c7;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .cite-n {
    font-weight: 700;
    color: #1d4ed8;
  }
  .export-citations a {
    color: #2563eb;
    text-decoration: none;
  }
  .export-citations a:hover {
    text-decoration: underline;
  }

  .kb-note {
    font-size: 12px;
    color: #64748b;
    margin-top: 4px;
  }

  /* Print Stylesheet */
  @media print {
    body { background: #ffffff; }
    .wrap { border: none; box-shadow: none; padding: 0; margin: 0; max-width: 100%; }
    .kb-section { page-break-inside: avoid; }
    .kb-toc { display: none; }
  }
`;

export interface KnowledgeBaseExportData {
  notebook: NotebookOverview | null;
  graph: DocGraph | null;
  studio: StudioDoc | null;
  /** Resolved citations for the graph's node/edge/theme evidence sentence ids. */
  graphEvidence?: Citation[];
}

/** A filename-safe slug for a repo/notebook name. */
function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'notebook';
}

/** Clean up raw repo names when an AI title is not present (strips emoji/prefixes/underscores). */
function cleanTitleFallback(repo: string): string {
  let name = repo.replace(/^(?:☁|📁|📧|📄|\u2601|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDDFF])\s*/u, '');
  name = name.replace(/^(?:SharePoint\s*-\s*|Mailbox\s*-\s*)/i, '');
  name = name.replace(/[_-]+/g, ' ').trim();
  if (name) {
    return name.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return repo;
}

/** Build a standalone HTML document for a notebook's Knowledge Base artifacts and download it. */
export function exportKnowledgeBaseHtml(repo: string, data: KnowledgeBaseExportData): void {
  const now = new Date();

  const aiTitle = data.notebook?.title?.trim();
  const displayTitle = aiTitle || cleanTitleFallback(repo);

  const hasOverview = Boolean(data.notebook && data.notebook.overviewMarkdown);
  const hasStudio = Boolean(data.studio && Object.values(data.studio.outputs).some((o) => !!o));
  const hasGraph = Boolean(data.graph && data.graph.nodes.length > 0);

  const toc = renderTableOfContents(hasOverview, hasStudio, hasGraph);

  // Requested order: Overview -> Studio -> Knowledge Graph
  const sections =
    renderNotebookSection(data.notebook) +
    renderStudioSection(data.studio) +
    renderGraphSection(data.graph, data.graphEvidence ?? []);

  const body = sections ? `${toc}${sections}` : '<p class="kb-note">Nothing has been generated for this notebook yet.</p>';

  const subtitleMeta = `<div class="meta">Repository: ${escapeHtml(repo)} &bull; Exported ${escapeHtml(now.toLocaleString())}</div>`;

  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(displayTitle)} &mdash; Knowledge Base export</title>\n` +
    `<style>${KB_STYLE}</style>\n</head>\n<body>\n<div class="wrap">\n` +
    `<div class="doc-head"><h1>${escapeHtml(displayTitle)}</h1>` +
    `${subtitleMeta}</div>\n` +
    body +
    `\n</div>\n</body>\n</html>\n`;

  downloadBlob(html, 'text/html', `kb-${slug(displayTitle)}-${now.toISOString().slice(0, 10)}.html`);
}
