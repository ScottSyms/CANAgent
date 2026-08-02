// Shared handling of the inline `[[sentence-id]]` citation tokens the model emits
// in an answer and the app renders as clickable chips. Pure + dependency-free so
// the background agent (validation) and the sidebar (chip rendering) agree on the
// exact token grammar. Sentence ids are limited to word chars plus `:#.-` (see
// makeSentenceId in sentenceSplit.ts), so a token never contains markdown- or
// HTML-special characters — it survives sanitization as literal text, which is
// what lets us swap tokens for chips *after* DOMPurify has run.

/** A fresh global-flagged matcher each call (avoids shared `lastIndex` bugs). */
export function citationTokenRe(): RegExp {
  return /\[\[([^[\]\r\n]+?)\]\]/g;
}

/** Ids we are willing to reflect into HTML attributes — defensive charset guard. */
const SAFE_ID = /^[\w:#.\-]+$/;

/** The ordered, de-duplicated sentence ids cited via `[[id]]` tokens in `text`. */
export function extractCitationIds(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(citationTokenRe())) {
    const id = m[1].trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Replace `[[id]]` tokens in already-sanitized answer HTML with numbered
 * superscript citation chips. `numberById` maps a valid sentence id to its
 * 1-based citation number; tokens whose id is unknown or unsafe are removed.
 */
export function injectCitationChips(html: string, numberById: Map<string, number>): string {
  return html.replace(citationTokenRe(), (_whole, rawId: string) => {
    const id = rawId.trim();
    const n = numberById.get(id);
    if (!n || !SAFE_ID.test(id)) return '';
    return `<sup class="citation-chip" data-cite-id="${id}" role="button" tabindex="0">${n}</sup>`;
  });
}
