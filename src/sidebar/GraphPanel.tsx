import { useEffect, useRef, useState } from 'preact/hooks';
import type { DocGraph, GraphEdge, GraphNode } from '../shared/docGraph';
import type { Citation } from '../shared/types';
import { CitationView } from './CitationView';

// The per-notebook knowledge graph: a Build/Rebuild control with live progress,
// a lightweight radial concept map, and a click-through to the exact source
// sentences behind any entity — resolved deterministically via sentence ids.

interface GetResponse {
  ok: boolean;
  graph: DocGraph | null;
  docCount: number;
  building: boolean;
}
interface BuildResponse {
  ok: boolean;
  error?: string;
  graph?: DocGraph;
}
interface EvidenceResponse {
  ok: boolean;
  citations: Citation[];
}

const MAP_NODES = 24;
const SIZE = 320;

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

export function GraphPanel({ repo }: { repo: string }) {
  const [graph, setGraph] = useState<DocGraph | null>(null);
  const [docCount, setDocCount] = useState(0);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [evidence, setEvidence] = useState<Citation[]>([]);
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = async () => {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'notebook_graph_get', repo })) as GetResponse;
      setGraph(res?.graph ?? null);
      setDocCount(res?.docCount ?? 0);
      setBuilding(!!res?.building);
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

  const build = async (rebuild: boolean) => {
    setError(null);
    setBuilding(true);
    // Poll for per-document progress while the (long) build request is in flight.
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => void refresh(), 2000) as unknown as number;
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'notebook_graph_build', repo, rebuild })) as BuildResponse;
      if (res?.ok && res.graph) setGraph(res.graph);
      else if (res && !res.ok) setError(res.error ?? 'Graph build failed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setBuilding(false);
    void refresh();
  };

  const selectNode = async (node: GraphNode) => {
    setSelected(node);
    setEvidence([]);
    if (node.evidenceSentenceIds.length === 0) return;
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'notebook_graph_evidence',
        repo,
        sentenceIds: node.evidenceSentenceIds,
      })) as EvidenceResponse;
      setEvidence(res?.citations ?? []);
    } catch {
      setEvidence([]);
    }
  };

  const border = '1px solid var(--border)';
  const processed = graph?.processedDocIds.length ?? 0;
  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.edges.length ?? 0;
  const view = graph ? layout(graph) : null;

  return (
    <div class="graph-panel" style={{ margin: '6px 0 10px', padding: '10px', border, borderRadius: '8px' }}>
      {activeCitation && <CitationView citation={activeCitation} onClose={() => setActiveCitation(null)} />}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <strong style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-dim)' }}>
          Knowledge graph
        </strong>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button class="btn btn-small" disabled={building} onClick={() => void build(false)}>
            {building ? 'Building…' : nodeCount > 0 ? 'Update' : 'Build graph'}
          </button>
          {nodeCount > 0 && !building && (
            <button class="btn btn-small" onClick={() => void build(true)} title="Discard and re-extract from scratch">
              Rebuild
            </button>
          )}
        </div>
      </div>

      {error && <p class="settings-note" style={{ color: 'var(--error)' }}>{error}</p>}

      {building && (
        <p class="settings-note">
          Extracting… {processed} / {docCount} documents · {nodeCount} entities, {edgeCount} relationships
        </p>
      )}

      {!building && nodeCount === 0 && (
        <p class="settings-note">
          No graph yet — build one to extract entities and relationships from this notebook's documents, each grounded to
          its source sentences.
        </p>
      )}

      {view && nodeCount > 0 && (
        <>
          <p class="settings-note" style={{ marginTop: '6px' }}>
            {nodeCount} entities · {edgeCount} relationships{processed < docCount ? ` · ${processed}/${docCount} docs processed` : ''}
          </p>
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
              const isSel = selected?.id === n.id;
              return (
                <g key={n.id} style={{ cursor: 'pointer' }} onClick={() => void selectNode(n)}>
                  <circle cx={p.x} cy={p.y} r={isSel ? 7 : 5} fill={isSel ? 'var(--accent)' : 'var(--accent-dim)'} stroke="var(--accent)" stroke-width="1" />
                  <text
                    x={p.x}
                    y={p.y - 9}
                    text-anchor="middle"
                    style={{ fontSize: '9px', fill: 'var(--text)', pointerEvents: 'none' }}
                  >
                    {n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label}
                  </text>
                </g>
              );
            })}
          </svg>

          {selected && (
            <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: border }}>
              <div style={{ fontWeight: 700, fontSize: '13px' }}>
                {selected.label} <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· {selected.type}</span>
              </div>
              {selected.summary && <p class="settings-note" style={{ fontSize: '13px' }}>{selected.summary}</p>}
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-dim)', margin: '6px 0 2px' }}>
                Evidence
              </div>
              {evidence.length === 0 ? (
                <p class="settings-note">Loading evidence…</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {evidence.map((c) => (
                    <button
                      key={c.sentenceId}
                      style={{
                        textAlign: 'left',
                        fontSize: '12px',
                        padding: '5px 7px',
                        border,
                        borderRadius: '6px',
                        background: 'var(--bg-card)',
                        color: 'var(--text)',
                        cursor: 'pointer',
                      }}
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
