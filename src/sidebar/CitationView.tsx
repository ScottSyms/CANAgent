import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Citation } from '../shared/types';

/** Append `#page=N` for PDF deep-linking, unless the URL already carries a hash. */
function withPage(url: string, page?: number): string {
  if (!page || url.includes('#')) return url;
  return `${url}#page=${page}`;
}

/**
 * Resolve and display one sentence-level citation. The exact sentence is
 * highlighted within its chunk using the stored character offsets — a pure slice,
 * no fuzzy matching (spec §7) — with the rest of the chunk shown as surrounding
 * context. Everything needed is on the Citation, so opening this triggers no
 * search, embedding, or LLM call.
 */
export function CitationView({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const { chunkText, start, end } = citation;
  const before = chunkText.slice(0, start);
  const sentence = chunkText.slice(start, end);
  const after = chunkText.slice(end);
  const viewRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const view = viewRef.current;
    const mark = markRef.current;
    if (!view || !mark) return;
    const viewRect = view.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    const target = view.scrollTop + markRect.top - viewRect.top - (view.clientHeight - markRect.height) / 2;
    const maxScroll = Math.max(0, view.scrollHeight - view.clientHeight);
    view.scrollTop = Math.min(Math.max(0, target), maxScroll);
  }, [citation.sentenceId]);

  return (
    <div class="citation-view-backdrop" onClick={onClose}>
      <div
        ref={viewRef}
        class="citation-view"
        role="dialog"
        aria-label="Citation source"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="citation-view-head">
          <span class="citation-view-doc" title={citation.docName}>{citation.docName}</span>
          <button class="citation-view-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p class="citation-view-chunk">
          {before}
          <mark ref={markRef} class="citation-view-mark">{sentence}</mark>
          {after}
        </p>
        <a
          class="citation-view-link"
          href={withPage(citation.url, citation.page)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open source{citation.page ? ` (page ${citation.page})` : ''}
        </a>
      </div>
    </div>
  );
}
