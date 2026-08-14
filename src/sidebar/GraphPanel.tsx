import { useEffect, useRef, useState } from 'preact/hooks';
import type { CommunitySummary, DocGraph, GraphEdge, GraphNode } from '../shared/docGraph';
import type { Citation } from '../shared/types';
import { CitationView } from './CitationView';
import { DocWindowsView } from './DocWindowsView';

// The per-notebook knowledge graph: a Build/Rebuild control with live progress, a
// radial concept map (nodes colored by theme), the extracted themes (graph
// communities, GraphRAG "global" sensemaking), and click-through from any entity
// or theme to the exact source sentences behind it.

// Structurally covers GraphBuildFastProgress/GraphBuildProgress/
// GraphBuildInstantProgress from src/background/graphExtract.ts — declared
// locally (not imported) to keep this UI module decoupled from background
// internals, matching how GetResponse/BuildResponse are already hand-declared
// here rather than imported.
interface BuildProgress {
  docsTotal: number;
  docsDone: number;
  currentDoc?: string;
  nodes?: number;
  edges?: number;
  chunksGathered?: number;
  windowsTotal?: number;
  windowsDone?: number;
}
interface GetResponse {
  ok: boolean;
  graph: DocGraph | null;
  docCount: number;
  docs: Array<{ id: string; name: string }>;
  building: boolean;
  progress?: BuildProgress;
}
interface BuildResponse {
  ok: boolean;
  error?: string;
  graph?: DocGraph;
  warnings?: string[];
}
interface EvidenceResponse {
  ok: boolean;
  citations: Citation[];
}

const MAP_NODES = 24;
const SIZE = 320;
// One color per theme (cycled), from the app's chip palette.
const PALETTE = [
  '--chip-blue-fg',
  '--chip-green-fg',
  '--chip-violet-fg',
  '--chip-amber-fg',
  '--chip-teal-fg',
  '--chip-pink-fg',
  '--chip-red-fg',
  '--chip-slate-fg',
];

function layout(graph: DocGraph): { nodes: GraphNode[]; edges: GraphEdge[]; pos: Map<string, { x: number; y: number }> } {
  const deg = new Map<string, number>();
  for (const e of graph.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  const nodes = [...graph.nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).slice(0, MAP_NODES);
  const shown = new Set(nodes.map((n) => n.id));
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = SIZE / 2 - 44;
  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const a = (i / Math.max(1, nodes.length)) * 2 * Math.PI - Math.PI / 2;
    pos.set(n.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  });
  const edges = graph.edges.filter((e) => shown.has(e.from) && shown.has(e.to));
  return { nodes, edges, pos };
}

/** node id → theme index, for coloring. */
function communityIndex(graph: DocGraph): Map<string, number> {
  const idx = new Map<string, number>();
  (graph.communities ?? []).forEach((c, i) => c.nodeIds.forEach((id) => idx.set(id, i)));
  return idx;
}
const colorForIndex = (i: number | undefined) => (i === undefined ? 'var(--accent-dim)' : `var(${PALETTE[i % PALETTE.length]})`);

export function GraphPanel({ repo }: { repo: string }) {
  const [graph, setGraph] = useState<DocGraph | null>(null);
  const [docCount, setDocCount] = useState(0);
  const [docs, setDocs] = useState<Array<{ id: string; name: string }>>([]);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ title: string; summary: string; color?: string } | null>(null);
  const [evidence, setEvidence] = useState<Citation[]>([]);
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);
  const [entityQuery, setEntityQuery] = useState('');
  const [viewingDocId, setViewingDocId] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = async () => {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'notebook_graph_get', repo })) as GetResponse;
      setGraph(res?.graph ?? null);
      setDocCount(res?.docCount ?? 0);
      setDocs(res?.docs ?? []);
      setBuilding(!!res?.building);
      setProgress(res?.building ? res?.progress ?? null : null);
      return res;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const build = async (mode: 'quick' | 'full' | 'instant', rebuild = false) => {
    setError(null);
    setWarnings([]);
    setBuilding(true);
    setProgress(null);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => void refresh(), 2000) as unknown as number;
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'notebook_graph_build', repo, rebuild, mode })) as BuildResponse;
      if (res?.ok && res.graph) setGraph(res.graph);
      if (res?.ok) setWarnings(res.warnings ?? []);
      else if (res && !res.ok) setError(res.error ?? 'Graph build failed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setBuilding(false);
    setProgress(null);
    void refresh();
  };

  const cancelBuild = async () => {
    await chrome.runtime.sendMessage({ type: 'notebook_graph_cancel', repo });
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setBuilding(false);
    setProgress(null);
  };

  const showEvidence = async (title: string, summary: string, ids: string[], color?: string) => {
    setDetail({ title, summary, color });
    setEvidence([]);
    if (ids.length === 0) return;
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'notebook_graph_evidence', repo, sentenceIds: ids })) as EvidenceResponse;
      setEvidence(res?.citations ?? []);
    } catch {
      setEvidence([]);
    }
  };

  const selectNode = (node: GraphNode, colorIdx?: number) => {
    setSelectedId(node.id);
    void showEvidence(`${node.label} · ${node.type}`, node.summary, node.evidenceSentenceIds, colorForIndex(colorIdx));
  };
  const selectTheme = (c: CommunitySummary, i: number) => {
    setSelectedId(null);
    void showEvidence(c.title, c.summary, c.evidenceSentenceIds, colorForIndex(i));
  };

  const border = '1px solid var(--border)';
  const processed = graph?.processedDocIds.length ?? 0;
  const failedIds = graph?.failedDocIds ?? [];
  const docErrors = graph?.docErrors ?? {};
  const docNameById = new Map(docs.map((d) => [d.id, d.name]));
  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.edges.length ?? 0;
  const communities = graph?.communities ?? [];
  const coverage = Object.values(graph?.docCoverage ?? {});
  const selectedWindows = coverage.reduce((sum, item) => sum + item.selectedWindows.length, 0);
  const completedWindows = coverage.reduce(
    (sum, item) => sum + item.selectedWindows.filter((index) => item.completedWindows.includes(index)).length,
    0,
  );
  const totalWindows = coverage.reduce((sum, item) => sum + item.totalWindows, 0);
  const pendingWindows = selectedWindows - completedWindows;
  const view = graph ? layout(graph) : null;
  const comIdx = graph ? communityIndex(graph) : new Map<string, number>();
  const matchingNodes = graph
    ? graph.nodes.filter((node) => `${node.label} ${node.type} ${node.summary}`.toLowerCase().includes(entityQuery.trim().toLowerCase()))
    : [];

  return (
    <div class="graph-panel" style={{ margin: '6px 0 10px', padding: '10px', border, borderRadius: '8px' }}>
      {activeCitation && <CitationView citation={activeCitation} onClose={() => setActiveCitation(null)} />}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <strong style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-dim)' }}>
          Knowledge graph
        </strong>
        <div style={{ display: 'flex', gap: '6px' }}>
          {building ? (
            <button class="btn btn-small" onClick={() => void cancelBuild()}>Stop build</button>
          ) : (
            <>
              <button
                class="btn btn-small"
                onClick={() => void build('quick')}
                title="On-device NER finds entities and relationships (free, no model calls), then a bounded, fixed-size batch of model calls names each theme and upgrades the most important relationships — call count doesn't grow with document count, so this stays fast even on a large notebook."
              >
                {nodeCount > 0 ? 'Quick update' : 'Quick build'}
              </button>
              <button class="btn btn-small" onClick={() => void build('full')} title="Process every document window; resumable but may use many model calls">
                Full coverage
              </button>
              <button
                class="btn btn-small"
                onClick={() => void build('instant')}
                title="Cluster the embeddings already computed for search — no model calls at all, not even NER. Produces topic clusters (not named entities) with keyword labels; edges just mean 'appears in the same document'. No model configuration needed to use this mode."
              >
                Instant (topics)
              </button>
            </>
          )}
          {(nodeCount > 0 || failedIds.length > 0) && !building && (
            <button class="btn btn-small" onClick={() => void build('full', true)} title="Discard and fully re-extract from scratch">
              Full rebuild
            </button>
          )}
        </div>
      </div>

      {error && <p class="settings-note" style={{ color: 'var(--error)' }}>{error}</p>}

      {!building && warnings.map((w, i) => (
        <p key={i} class="settings-note" style={{ color: 'var(--warn)' }}>{w}</p>
      ))}

      {building && (
        <p class="settings-note">
          {progress ? (
            <>
              {progress.currentDoc ? `Processing "${progress.currentDoc}"… ` : 'Processing… '}
              {progress.docsDone} / {progress.docsTotal || docCount} documents
              {progress.windowsTotal ? ` · ${progress.windowsDone ?? 0}/${progress.windowsTotal} windows` : ''}
              {progress.chunksGathered !== undefined ? ` · ${progress.chunksGathered} chunks gathered` : ''}
              {progress.nodes !== undefined ? ` · ${progress.nodes} entities, ${progress.edges ?? 0} relationships` : ''}
            </>
          ) : (
            <>
              Extracting… {processed} / {docCount} documents
              {selectedWindows > 0 ? ` · ${completedWindows}/${selectedWindows} selected windows` : ''}
              {' · '}{nodeCount} entities, {edgeCount} relationships
            </>
          )}
        </p>
      )}

      {!building && nodeCount === 0 && failedIds.length === 0 && (
        <p class="settings-note">
          No graph yet — build one to extract entities, relationships, and themes from this notebook's documents, each
          grounded to its source sentences.
        </p>
      )}

      {!building && nodeCount === 0 && failedIds.length > 0 && (
        <p class="settings-note">
          Extraction failed for every document — click "Build graph" above to retry, or see details below.
        </p>
      )}

      {!building && failedIds.length > 0 && (
        <details style={{ marginTop: '6px' }}>
          <summary class="settings-note" style={{ cursor: 'pointer' }}>
            {failedIds.length} document(s) failed extraction — details
          </summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
            {failedIds.map((id) => (
              <li key={id} class="settings-note" style={{ fontSize: '12px' }}>
                <button
                  class="link-btn"
                  style={{ font: 'inherit', padding: 0 }}
                  onClick={() => setViewingDocId(id)}
                  title="View the exact text sent for extraction"
                >
                  {docNameById.get(id) ?? id}
                </button>
                : {docErrors[id] ?? 'unknown error'}
              </li>
            ))}
          </ul>
        </details>
      )}

      {viewingDocId && (
        <DocWindowsView
          repo={repo}
          docId={viewingDocId}
          docName={docNameById.get(viewingDocId) ?? viewingDocId}
          coverage={graph?.docCoverage?.[viewingDocId]}
          onClose={() => setViewingDocId(null)}
        />
      )}

      {view && nodeCount > 0 && (
        <>
          <p class="settings-note" style={{ marginTop: '6px' }}>
            {nodeCount} entities · {edgeCount} relationships · {communities.length} themes
            {processed < docCount ? ` · ${processed}/${docCount} docs processed` : ''}
            {graph?.coverageMode ? ` · ${graph.coverageMode} coverage` : ' · legacy coverage'}
            {totalWindows > selectedWindows ? ` · ${selectedWindows}/${totalWindows} windows selected` : ''}
            {pendingWindows > 0 ? ` · ${pendingWindows} window(s) pending` : ''}
          </p>
          <p class="settings-note">Concept map shows {Math.min(MAP_NODES, nodeCount)} of {nodeCount} entities, ranked by connectivity.</p>
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            style={{ width: '100%', maxWidth: `${SIZE}px`, height: 'auto', display: 'block', margin: '4px auto' }}
          >
            {view.edges.map((e) => {
              const a = view.pos.get(e.from);
              const b = view.pos.get(e.to);
              if (!a || !b) return null;
              return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border)" stroke-width="1" />;
            })}
            {view.nodes.map((n) => {
              const p = view.pos.get(n.id)!;
              const isSel = selectedId === n.id;
              const ci = comIdx.get(n.id);
              const color = colorForIndex(ci);
              return (
                <g key={n.id} style={{ cursor: 'pointer' }} onClick={() => selectNode(n, ci)}>
                  <circle cx={p.x} cy={p.y} r={isSel ? 7 : 5} fill={color} stroke={isSel ? 'var(--accent)' : color} stroke-width={isSel ? 2 : 1} />
                  <text x={p.x} y={p.y - 9} text-anchor="middle" style={{ fontSize: '9px', fill: 'var(--text)', pointerEvents: 'none' }}>
                    {n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label}
                  </text>
                </g>
              );
            })}
          </svg>

          <details style={{ marginTop: '6px' }}>
            <summary class="settings-note" style={{ cursor: 'pointer' }}>Browse all {nodeCount} entities</summary>
            <input
              class="input"
              type="search"
              value={entityQuery}
              placeholder="Filter entities"
              onInput={(event) => setEntityQuery((event.currentTarget as HTMLInputElement).value)}
              style={{ width: '100%', margin: '6px 0' }}
            />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {matchingNodes.slice(0, 100).map((node) => {
                const ci = comIdx.get(node.id);
                return (
                  <button
                    key={node.id}
                    class="btn btn-small"
                    style={{ borderLeft: `3px solid ${colorForIndex(ci)}` }}
                    onClick={() => selectNode(node, ci)}
                  >
                    {node.label}
                  </button>
                );
              })}
            </div>
            {matchingNodes.length > 100 && <p class="settings-note">Showing 100 matches. Refine the filter to narrow the list.</p>}
          </details>

          {communities.length > 0 && (
            <div style={{ marginTop: '8px' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-dim)', marginBottom: '4px' }}>Themes</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {communities.map((c, i) => (
                  <button
                    key={c.id}
                    style={{
                      textAlign: 'left',
                      fontSize: '13px',
                      padding: '6px 8px',
                      border,
                      borderRadius: '6px',
                      background: 'var(--bg-card)',
                      color: 'var(--text)',
                      cursor: 'pointer',
                      borderLeft: `3px solid ${colorForIndex(i)}`,
                    }}
                    onClick={() => selectTheme(c, i)}
                  >
                    <strong>{c.title}</strong>
                    <span style={{ color: 'var(--text-dim)' }}> · {c.nodeIds.length} entities</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {detail && (
            <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: border, borderLeft: detail.color ? `3px solid ${detail.color}` : undefined, paddingLeft: detail.color ? '8px' : undefined }}>
              <div style={{ fontWeight: 700, fontSize: '13px' }}>{detail.title}</div>
              {detail.summary && <p class="settings-note" style={{ fontSize: '13px' }}>{detail.summary}</p>}
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-dim)', margin: '6px 0 2px' }}>Evidence</div>
              {evidence.length === 0 ? (
                <p class="settings-note">Loading evidence…</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {evidence.map((c) => (
                    <button
                      key={c.sentenceId}
                      style={{ textAlign: 'left', fontSize: '12px', padding: '5px 7px', border, borderRadius: '6px', background: 'var(--bg-card)', color: 'var(--text)', cursor: 'pointer' }}
                      title={`${c.docName} — click to view in context`}
                      onClick={() => setActiveCitation(c)}
                    >
                      “{c.sentenceText.length > 140 ? c.sentenceText.slice(0, 139) + '…' : c.sentenceText}”
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
