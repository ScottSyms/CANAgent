import { useEffect, useState } from 'preact/hooks';
import type { GraphDocCoverage } from '../shared/docGraph';
import { useModalFocus } from './useModalFocus';

interface DocWindow {
  text: string;
  charCount: number;
  sentenceCount: number;
}

interface WindowsResponse {
  ok: boolean;
  error?: string;
  result?: { windows: DocWindow[] };
}

function windowStatus(index: number, coverage?: GraphDocCoverage): { label: string; color: string } | null {
  if (!coverage) return null;
  if (!coverage.selectedWindows.includes(index)) return { label: 'not selected', color: 'var(--text-dim)' };
  if (coverage.failedWindows.includes(index)) return { label: 'failed', color: 'var(--error)' };
  if (coverage.completedWindows.includes(index)) return { label: 'completed', color: 'var(--ok)' };
  return { label: 'pending', color: 'var(--text-dim)' };
}

/**
 * Shows the exact sentence-tagged text of every extraction window for one
 * document — precisely what buildRepoGraph sent (or would send) the model —
 * so a "the model found nothing to extract" reason can be checked against the
 * actual source text instead of taken on faith. Window N here is window N in
 * `graph.docCoverage[docId]` (both come from the same `windowDocChunks` call),
 * so failed/completed/not-selected status lines up exactly.
 */
export function DocWindowsView({
  repo,
  docId,
  docName,
  coverage,
  onClose,
}: {
  repo: string;
  docId: string;
  docName: string;
  coverage?: GraphDocCoverage;
  onClose: () => void;
}) {
  const [windows, setWindows] = useState<DocWindow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useModalFocus<HTMLDivElement>(onClose);

  useEffect(() => {
    let cancelled = false;
    setWindows(null);
    setError(null);
    void chrome.runtime
      .sendMessage({ type: 'notebook_doc_windows', repo, docId })
      .then((res: WindowsResponse) => {
        if (cancelled) return;
        if (res?.ok && res.result) setWindows(res.result.windows);
        else setError(res?.error ?? 'Could not load this document’s extracted text.');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [repo, docId]);

  return (
    <div class="citation-view-backdrop" onClick={onClose}>
      <div
        ref={viewRef}
        class="citation-view doc-windows-view"
        role="dialog"
        aria-modal="true"
        aria-label="Extracted document text"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="citation-view-head">
          <span class="citation-view-doc" title={docName}>{docName}</span>
          <button class="citation-view-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {error && <p class="settings-note" style={{ color: 'var(--error)' }}>{error}</p>}
        {!error && !windows && <p class="settings-note">Loading extracted text…</p>}
        {!error && windows && windows.length === 0 && (
          <p class="settings-note">No extractable text was found for this document.</p>
        )}
        {!error && windows && windows.map((w, i) => {
          const status = windowStatus(i, coverage);
          return (
            <div key={i} class="doc-window">
              <div class="doc-window-head">
                <strong>Window {i + 1}/{windows.length}</strong>
                <span class="settings-note">{w.sentenceCount} sentence(s), {w.charCount.toLocaleString()} chars</span>
                {status && (
                  <span class="doc-window-status" style={{ color: status.color, borderColor: status.color }}>
                    {status.label}
                  </span>
                )}
              </div>
              <pre class="doc-window-text">{w.text || '(empty window)'}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
