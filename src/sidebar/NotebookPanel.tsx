import { useEffect, useState } from 'preact/hooks';
import type { NotebookOverview } from '../shared/types';
import { Markdown } from './Markdown';

// A NotebookLM-style overview for one repository: a synthesized summary, key
// topics, and starter questions, generated on demand from the repo's documents.
// Rendered inside the expanded repo row (workspace Knowledge page). When `onAsk`
// is provided (workspace chat context), a suggested question launches a chat
// scoped to this repository.

interface GetResponse {
  ok: boolean;
  overview: NotebookOverview | null;
  stale: boolean;
}
interface GenResponse {
  ok: boolean;
  overview?: NotebookOverview;
  error?: string;
}

export function NotebookPanel({ repo, onAsk }: { repo: string; onAsk?: (repo: string, question: string) => void }) {
  const [overview, setOverview] = useState<NotebookOverview | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = (await chrome.runtime.sendMessage({ type: 'notebook_overview_get', repo })) as GetResponse;
        if (!alive) return;
        setOverview(res?.overview ?? null);
        setStale(!!res?.stale);
      } catch {
        if (alive) setOverview(null);
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [repo]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'notebook_overview_generate', repo })) as GenResponse;
      if (res?.ok && res.overview) {
        setOverview(res.overview);
        setStale(false);
      } else {
        setError(res?.error ?? 'Could not generate an overview.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setGenerating(false);
  };

  const border = '1px solid var(--border)';

  return (
    <div class="notebook-panel" style={{ margin: '6px 0 10px', padding: '10px', border, borderRadius: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <strong style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-dim)' }}>
          Notebook
        </strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {overview && stale && (
            <span style={{ fontSize: '11px', color: 'var(--warn)' }} title="Documents changed since this was generated">
              out of date
            </span>
          )}
          <button class="btn btn-small" disabled={generating || loading} onClick={() => void generate()}>
            {generating ? 'Generating…' : overview ? 'Regenerate' : 'Generate overview'}
          </button>
        </div>
      </div>

      {error && <p class="settings-note" style={{ color: 'var(--error)' }}>{error}</p>}

      {loading ? (
        <p class="settings-note">Loading…</p>
      ) : !overview ? (
        <p class="settings-note">No overview yet — generate one to see a summary, key topics, and suggested questions.</p>
      ) : (
        <>
          <div style={{ fontSize: '13px', lineHeight: 1.5, marginTop: '8px' }}>
            <Markdown text={overview.overviewMarkdown} />
          </div>

          {overview.keyTopics.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
              {overview.keyTopics.map((topic) => (
                <span
                  key={topic}
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: '10px',
                    // Filled accent pill with background-colored text, so it stays
                    // legible (--accent-dim is a *darker* accent shade, not a light
                    // tint — accent-on-dim washes out).
                    background: 'var(--accent)',
                    color: 'var(--bg)',
                  }}
                >
                  {topic}
                </span>
              ))}
            </div>
          )}

          {overview.suggestedQuestions.length > 0 && (
            <div style={{ marginTop: '10px' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-dim)', marginBottom: '4px' }}>
                Suggested questions
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {overview.suggestedQuestions.map((q) =>
                  onAsk ? (
                    <button
                      key={q}
                      class="notebook-question"
                      style={{
                        textAlign: 'left',
                        fontSize: '13px',
                        padding: '6px 8px',
                        border,
                        borderRadius: '6px',
                        background: 'var(--bg-card)',
                        color: 'var(--text)',
                        cursor: 'pointer',
                      }}
                      onClick={() => onAsk(repo, q)}
                    >
                      {q}
                    </button>
                  ) : (
                    <div key={q} class="settings-note" style={{ fontSize: '13px' }}>
                      • {q}
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
