// Single-file HTML export of a notebook's Knowledge Base artifacts: the
// overview, the extracted knowledge graph (with internal anchor links between
// related entities), and any generated studio documents (briefing/FAQ/study
// guide). Reuses the standalone-HTML pattern from conversationExport.ts —
// this module is a pure renderer (no chrome.* calls); the caller fetches the
// data and passes it in, matching how exportConversationHtml is invoked.

import type { CommunitySummary, DocGraph, GraphEdge, GraphNode } from '../shared/docGraph';
import type { Citation, NotebookOverview, StudioDoc, StudioKind } from '../shared/types';
import { escapeHtml, renderCitations, renderMarkdown, STYLE, downloadBlob } from './conversationExport';
import { injectCitationChips } from '../shared/citations';

const STUDIO_TITLES: Record<StudioKind, string> = {
  briefing: 'Briefing',
  faq: 'FAQ',
  study_guide: 'Study guide',
};

/** A stable, HTML-id-safe anchor for a graph node. Node ids are already the safe `n_<hash>` form. */
function nodeAnchor(nodeId: string): string {
  return `node-${escapeHtml(nodeId)}`;
}

export function renderNotebookSection(overview: NotebookOverview | null): string {
  if (!overview) return '';
  const topics = overview.keyTopics.length
    ? `<div class="kb-chips">${overview.keyTopics.map((t) => `<span class="kb-chip">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  const questions = overview.suggestedQuestions.length
    ? `<ul>${overview.suggestedQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`
    : '';
  return (
    `<section class="kb-section"><h2>Overview</h2>` +
    `<div class="md">${renderMarkdown(overview.overviewMarkdown)}</div>` +
    topics +
    (questions ? `<h3>Suggested questions</h3>${questions}` : '') +
    `</section>`
  );
}

/**
 * Render a claim's markdown with its [[id]] citation tokens turned into
 * numbered chips, plus the numbered evidence list — the same rendering the
 * chat UI uses for an answer, so the export looks and behaves consistently.
 */
function renderCitedMarkdown(markdown: string, citations: Citation[]): string {
  let html = renderMarkdown(markdown);
  if (citations.length > 0) {
    const numberById = new Map(citations.map((c, i) => [c.sentenceId, i + 1] as const));
    html = injectCitationChips(html, numberById);
  }
  const cites = citations.length > 0 ? renderCitations(citations) : '';
  return `<div class="md">${html}</div>${cites}`;
}

export function renderStudioSection(studio: StudioDoc | null): string {
  if (!studio) return '';
  const outputs = Object.values(studio.outputs).filter((o) => !!o);
  if (outputs.length === 0) return '';
  const parts = outputs.map(
    (o) => `<article class="kb-studio-doc"><h3>${escapeHtml(STUDIO_TITLES[o!.kind])}</h3>${renderCitedMarkdown(o!.markdown, o!.citations)}</article>`,
  );
  return `<section class="kb-section"><h2>Studio</h2>${parts.join('')}</section>`;
}

/**
 * Render one graph node: anchor id, label/type/summary, and its evidence —
 * resolved sentence citations, when supplied (raw sentence ids are otherwise
 * shown as-is, so the export never silently omits provenance).
 */
function renderNode(node: GraphNode, evidenceById: Map<string, Citation>): string {
  const evidence = node.evidenceSentenceIds
    .map((id) => evidenceById.get(id))
    .filter((c): c is Citation => !!c);
  const evidenceHtml =
    evidence.length > 0
      ? renderCitations(evidence)
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
        `<li><a href="#${nodeAnchor(from.id)}">${escapeHtml(from.label)}</a> —${escapeHtml(e.relation)}→ ` +
        `<a href="#${nodeAnchor(to.id)}">${escapeHtml(to.label)}</a></li>`
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
        .map((n) => `<a href="#${nodeAnchor(n.id)}">${escapeHtml(n.label)}</a>`)
        .join(', ');
      return `<article class="kb-theme"><h4>${escapeHtml(c.title)}</h4><p>${escapeHtml(c.summary)}</p>${members ? `<p class="kb-note">${members}</p>` : ''}</article>`;
    })
    .join('');
  return `<h3>Themes</h3>${items}`;
}

/**
 * Render the knowledge graph: a Themes section (when present), then every
 * entity with its evidence, then a relationships list — all internally
 * anchor-linked via each node's stable id, so the file is browsable offline
 * with no external requests.
 */
export function renderGraphSection(graph: DocGraph | null, evidence: Citation[] = []): string {
  if (!graph || graph.nodes.length === 0) return '';
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const evidenceById = new Map(evidence.map((c) => [c.sentenceId, c]));
  return (
    `<section class="kb-section"><h2>Knowledge graph</h2>` +
    renderCommunities(graph.communities ?? [], nodesById) +
    `<h3>Entities</h3>` +
    graph.nodes.map((n) => renderNode(n, evidenceById)).join('') +
    renderEdges(graph.edges, nodesById) +
    `</section>`
  );
}

const KB_STYLE = `
  ${STYLE}
  .kb-section { margin: 24px 0; }
  .kb-section h2 { font-size: 16px; border-bottom: 1px solid #d8dbe0; padding-bottom: 6px; }
  .kb-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .kb-chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: #eef0f3; color: #2563eb; }
  .kb-studio-doc { margin: 12px 0; padding: 12px; border: 1px solid #e3e6ea; border-radius: 8px; }
  .kb-node { margin: 10px 0; padding: 10px 12px; border: 1px solid #e3e6ea; border-radius: 8px; scroll-margin-top: 12px; }
  .kb-node h4 { margin: 0 0 4px; }
  .kb-type { font-size: 11px; font-weight: 400; color: #6b7280; }
  .kb-theme { margin: 8px 0; padding: 10px 12px; border-left: 3px solid #2563eb; background: #f5f6f8; }
  .kb-edges { padding-left: 1.2em; }
  .kb-note { font-size: 12px; color: #6b7280; }
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

/** Build a standalone HTML document for a notebook's Knowledge Base artifacts and download it. */
export function exportKnowledgeBaseHtml(repo: string, data: KnowledgeBaseExportData): void {
  const now = new Date();
  const sections =
    renderNotebookSection(data.notebook) +
    renderGraphSection(data.graph, data.graphEvidence ?? []) +
    renderStudioSection(data.studio);
  const body = sections || '<p class="kb-note">Nothing has been generated for this notebook yet.</p>';
  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(repo)} — Knowledge Base export</title>\n` +
    `<style>${KB_STYLE}</style>\n</head>\n<body>\n<div class="wrap">\n` +
    `<div class="doc-head"><h1>${escapeHtml(repo)}</h1>` +
    `<div class="meta">Exported ${escapeHtml(now.toLocaleString())}</div></div>\n` +
    body +
    `\n</div>\n</body>\n</html>\n`;

  downloadBlob(html, 'text/html', `kb-${slug(repo)}-${now.toISOString().slice(0, 10)}.html`);
}
