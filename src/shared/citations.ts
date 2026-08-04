// Shared handling of the inline `[[sentence-id]]` citation tokens the model emits
// in an answer and the app renders as clickable chips. Pure + dependency-free so
// the background agent (validation) and the sidebar (chip rendering) agree on the
// exact token grammar. Sentence ids are limited to word chars plus `:#.-` (see
// makeSentenceId in sentenceSplit.ts), so a token never contains markdown- or
// HTML-special characters — it survives sanitization as literal text, which is
// what lets us swap tokens for chips *after* DOMPurify has run.

/** A fresh global-flagged matcher each call (avoids shared `lastIndex` bugs). */
export function citationTokenRe(): RegExp {
  // Accept both [[id]] and the grouped form models sometimes emit:
  // [[id], [id]]. IDs inside the reference are parsed and validated separately.
  return /\[\[([^\r\n]*?)\]\]/g;
}

/** Ids we are willing to reflect into HTML attributes — defensive charset guard. */
const SAFE_ID = /^[\w:#.\-]+$/;

/** Parse individual ids from one normal or model-grouped citation reference. */
export function citationIdsInReference(raw: string): string[] {
  return raw
    .replace(/\]\s*,?\s*\[/g, ',')
    .split(',')
    .map((part) => part.trim().replace(/^\[+|\]+$/g, '').trim())
    .filter((id) => id.length > 0 && SAFE_ID.test(id));
}

/** The ordered, de-duplicated sentence ids cited via `[[id]]` tokens in `text`. */
export function extractCitationIds(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(citationTokenRe())) {
    for (const id of citationIdsInReference(m[1])) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
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
    return citationIdsInReference(rawId)
      .map((id) => {
        const n = numberById.get(id);
        return n ? `<sup class="citation-chip" data-cite-id="${id}" role="button" tabindex="0">${n}</sup>` : '';
      })
      .join('');
  });
}
