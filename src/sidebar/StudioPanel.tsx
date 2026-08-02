import { useState } from 'preact/hooks';
import type { Briefing, Citation } from '../shared/types';
import { CitationView } from './CitationView';
import { Markdown } from './Markdown';

// Notebook "studio": generate a grounded briefing document from the notebook's
// knowledge graph. The briefing renders with inline citation chips (same
// substrate as chat answers) — clicking one opens the exact source sentence.

interface GenResponse {
  ok: boolean;
  briefing?: Briefing;
  error?: string;
}

export function StudioPanel({ repo }: { repo: string }) {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'notebook_briefing_generate', repo })) as GenResponse;
      if (res?.ok && res.briefing) setBriefing(res.briefing);
      else setError(res?.error ?? 'Could not generate a briefing.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setGenerating(false);
  };

  const border = '1px solid var(--border)';

  return (
    <div class="studio-panel" style={{ margin: '6px 0 10px', padding: '10px', border, borderRadius: '8px' }}>
      {activeCitation && <CitationView citation={activeCitation} onClose={() => setActiveCitation(null)} />}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <strong style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-dim)' }}>
          Studio
        </strong>
        <button class="btn btn-small" disabled={generating} onClick={() => void generate()}>
          {generating ? 'Generating…' : briefing ? 'Regenerate briefing' : 'Generate briefing'}
        </button>
      </div>

      {error && <p class="settings-note" style={{ color: 'var(--error)' }}>{error}</p>}

      {!briefing && !error && (
        <p class="settings-note">
          Generate a grounded briefing document — a readable summary of this notebook synthesized from its knowledge
          graph, with clickable citations to the exact source sentences.
        </p>
      )}

      {briefing && (
        <div style={{ marginTop: '8px', fontSize: '13px', lineHeight: 1.5 }}>
          <Markdown text={briefing.markdown} citations={briefing.citations} onCiteClick={setActiveCitation} />
        </div>
      )}
    </div>
  );
}
