// Sentence-level provenance for the on-device RAG store. Pure functions, no
// chrome.* / OPFS / DOM — so both the extension's offscreen repo store
// (src/offscreen/repoStore.ts) and the Word add-in can share how a chunk's text
// is split into stable, citable sentences.
//
// Design (see the sentence-level evidence amendment): chunks stay the unit of
// retrieval; sentences are the unit of evidence. A sentence is never given its
// own embedding — it's a span *within* a chunk's text, identified by character
// offsets so it can be reconstructed deterministically (chunk.text.slice) with
// no fuzzy matching. Segmentation is a pure function of the chunk text, so IDs
// stay stable as long as that text is unchanged and legacy repos (indexed before
// this feature) can compute their sentences on read without re-ingesting.

/** A sentence occupying `[start, end)` of the chunk text it was split from. */
export interface SentenceSpan {
  /** 0-based position of this sentence within its chunk. */
  index: number;
  /** Inclusive start offset into the chunk text. */
  start: number;
  /** Exclusive end offset into the chunk text. `text.slice(start, end)` === the sentence. */
  end: number;
  /** The sentence text (trimmed). Not persisted on disk — reconstructed from offsets. */
  text: string;
}

/**
 * A citable sentence: a stable id plus the `[start, end)` span it occupies in
 * its chunk's text. This is the id-bearing shape persisted on disk and carried
 * through retrieval — the canonical text is *not* stored, it is reconstructed via
 * `chunkText.slice(start, end)`. `page` is populated only where a source format
 * exposes it (best-effort; usually absent for flattened PDF/HTML today).
 */
export interface CitableSentence {
  id: string;
  start: number;
  end: number;
  page?: number;
}

interface RawSegment {
  segment: string;
  index: number;
}

/**
 * Segment `text` into raw sentence pieces (whitespace still attached), preferring
 * the browser-native `Intl.Segmenter` and falling back to a punctuation regex
 * where it is unavailable or throws. Both paths agree on boundaries for ordinary
 * prose; the regex is a safety net, not the primary path.
 */
function rawSegments(text: string): RawSegment[] {
  const Segmenter = (Intl as unknown as { Segmenter?: unknown }).Segmenter;
  if (typeof Segmenter === 'function') {
    try {
      const seg = new (Segmenter as new (locale: undefined, opts: { granularity: string }) => {
        segment(input: string): Iterable<RawSegment>;
      })(undefined, { granularity: 'sentence' });
      return Array.from(seg.segment(text));
    } catch {
      // fall through to the regex splitter
    }
  }
  return regexSegments(text);
}

/** Fallback splitter: a run up to and including terminal punctuation, else a final remainder. */
function regexSegments(text: string): RawSegment[] {
  const out: RawSegment[] = [];
  const re = /[^.!?]*[.!?]+[\])'"`]*\s*|[^.!?]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++; // guard against a zero-width match stalling the loop
      continue;
    }
    out.push({ segment: m[0], index: m.index });
  }
  return out;
}

/**
 * Split chunk `text` into trimmed sentence spans. Offsets are into `text`, so
 * `text.slice(span.start, span.end) === span.text` for every span, and
 * whitespace-only segments are dropped.
 */
export function splitSentences(text: string): SentenceSpan[] {
  if (!text) return [];
  const out: SentenceSpan[] = [];
  for (const raw of rawSegments(text)) {
    const lead = raw.segment.length - raw.segment.trimStart().length;
    const trimmed = raw.segment.trim();
    if (!trimmed) continue;
    const start = raw.index + lead;
    out.push({ index: out.length, start, end: start + trimmed.length, text: trimmed });
  }
  return out;
}

/**
 * A short, stable content hash of a sentence — 6 hex chars of FNV-1a over the
 * normalized text (collapsed whitespace, trimmed, lowercased). Combined with the
 * structural coordinates it lets an unchanged sentence be recognized across
 * ingestion runs (spec §11) and guards a citation against a chunk edit.
 */
export function shortHash(text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

/**
 * Build a stable, document-unique sentence identifier of the form
 * `${docId}:c${localChunkIdx}:s${sentIdx}#${hash6}`. `localChunkIdx` is the
 * chunk's index *within its document* (globalChunkIdx − doc.chunkStart) so it
 * survives other documents being deleted from the repo.
 */
export function makeSentenceId(docId: string, localChunkIdx: number, sentIdx: number, text: string): string {
  return `${docId}:c${localChunkIdx}:s${sentIdx}#${shortHash(text)}`;
}

/**
 * Derive the citable sentences for a chunk from its text and structural
 * coordinates. Single source of truth used both when a chunk is first indexed
 * (cached into the store) and as the read-time fallback for chunks indexed
 * before this feature — both paths yield identical ids for identical text.
 */
export function citableSentences(docId: string, localChunkIdx: number, chunkText: string): CitableSentence[] {
  return splitSentences(chunkText).map((s) => ({
    id: makeSentenceId(docId, localChunkIdx, s.index, s.text),
    start: s.start,
    end: s.end,
  }));
}
