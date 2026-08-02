import { useEffect, useState } from 'preact/hooks';
import type { Citation, StudioDoc, StudioKind, StudioOutput } from '../shared/types';
import { CitationView } from './CitationView';
import { Markdown } from './Markdown';

// Notebook "studio": generate grounded documents (briefing / FAQ / study guide)
// from the notebook's knowledge graph. Each renders with inline citation chips
// (same substrate as chat answers) and is persisted per repo, so it survives
// reopening. Clicking a citation opens the exact source sentence.

interface GetResponse {
  ok: boolean;
  doc: StudioDoc;
}
interface GenResponse {
  ok: boolean;
  output?: StudioOutput;
  error?: string;
}

const KINDS: Array<{ kind: StudioKind; label: string }> = [
  { kind: 'briefing', label: 'Briefing' },
  { kind: 'faq', label: 'FAQ' },
  { kind: 'study_guide', label: 'Study guide' },
];

export function StudioPanel({ repo }: { repo: string }) {
  const [outputs, setOutputs] = useState<Partial<Record<StudioKind, StudioOutput>>>({});
  const [active, setActive] = useState<StudioKind>('briefing');
  const [generating, setGenerating] = useState<StudioKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = (await chrome.runtime.sendMessage({ type: 'notebook_studio_get', repo })) as GetResponse;
        if (alive) setOutputs(res?.doc?.outputs ?? {});
      } catch {
        if (alive) setOutputs({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [repo]);

  const generate = async (kind: StudioKind) => {
    setGenerating(kind);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'notebook_studio_generate', repo, kind })) as GenResponse;
      if (res?.ok && res.output) setOutputs((o) => ({ ...o, [kind]: res.output }));
      else setError(res?.error ?? 'Could not generate this document.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setGenerating(null);
  };

  const border = '1px solid var(--border)';
  const current = outputs[active];

  return (
    <div class="studio-panel" style={{ margin: '6px 0 10px', padding: '10px', border, borderRadius: '8px' }}>
      {activeCitation && <CitationView citation={activeCitation} onClose={() => setActiveCitation(null)} />}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <strong style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-dim)' }}>
          Studio
        </strong>
        <button class="btn btn-small" disabled={generating !== null} onClick={() => void generate(active)}>
          {generating === active ? 'Generating…' : current ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {/* Output-kind selector */}
      <div style={{ display: 'flex', gap: '4px', margin: '8px 0' }}>
        {KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            onClick={() => setActive(kind)}
            style={{
              flex: 1,
              fontSize: '12px',
              padding: '4px 6px',
              borderRadius: '6px',
              border,
              cursor: 'pointer',
              // Filled accent pill when active (accent-dim is a darker accent
              // shade, not a light tint — accent-on-dim washes out the text).
              background: active === kind ? 'var(--accent)' : 'var(--bg-card)',
              color: active === kind ? 'var(--bg)' : 'var(--text)',
              fontWeight: active === kind ? 700 : 400,
            }}
          >
            {label}
            {outputs[kind] ? ' ✓' : ''}
          </button>
        ))}
      </div>

      {error && <p class="settings-note" style={{ color: 'var(--error)' }}>{error}</p>}

      {!current ? (
        <p class="settings-note">
          Generate a grounded {KINDS.find((k) => k.kind === active)?.label.toLowerCase()} — synthesized from this
          notebook's knowledge graph, with clickable citations to the exact source sentences. (Build the graph first.)
        </p>
      ) : (
        <div style={{ fontSize: '13px', lineHeight: 1.5 }}>
          <Markdown text={current.markdown} citations={current.citations} onCiteClick={setActiveCitation} />
        </div>
      )}
    </div>
  );
}
