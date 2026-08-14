// =============================================================================
// Document parsing via anydoc (https://github.com/firecrawl/anydoc) — a Rust
// core compiled to WebAssembly, running inside the offscreen document (same
// DOM/WASM context localEmbed.ts/localNer.ts use). Replaces the previous
// pdf.js (PDF) and hand-rolled OOXML-unzip (docx/pptx/xlsx) extraction with a
// single library that converts PDF, Word/PowerPoint/Excel (incl. legacy
// .doc/.ppt), OpenDocument, RTF, EPUB, and CSV to GitHub-Flavored Markdown.
// No ML models, no network calls — the whole conversion runs synchronously
// against in-memory bytes.
// =============================================================================

import init, { formatFromBytes, toMarkdownBytes, type Format } from '@firecrawl/anydoc-wasm';

let initPromise: Promise<unknown> | null = null;

/** Load the WASM module once; every caller after the first awaits the same promise. */
function ensureInit(): Promise<unknown> {
  if (!initPromise) initPromise = init();
  return initPromise;
}

export type AnydocFormat = Format;

export interface AnydocResult {
  /** GitHub-Flavored Markdown. */
  text: string;
  format: Format;
}

/**
 * `code` on the `Error` a failed conversion throws (anydoc_wasm.d.ts's
 * `ConvertErrorCode`) — surfaced so callers can give a specific reason
 * instead of a bare "could not parse" message.
 */
export type AnydocErrorCode = 'unsupported' | 'malformed' | 'encrypted' | 'resourceLimit' | 'missingPart';

export class AnydocConvertError extends Error {
  readonly code?: AnydocErrorCode;
  constructor(message: string, code?: AnydocErrorCode) {
    super(message);
    this.name = 'AnydocConvertError';
    this.code = code;
  }
}

/** A short, user-facing reason for each anydoc error code. */
function messageForCode(code: AnydocErrorCode | undefined, detail: string): string {
  switch (code) {
    case 'encrypted':
      return 'This file is password-protected or encrypted and cannot be read.';
    case 'unsupported':
      return 'Unrecognized or unsupported file format (or, for a PDF, it has no extractable text — a scanned PDF needs OCR).';
    case 'malformed':
      return 'The file is structurally unreadable — no usable content could be extracted.';
    case 'resourceLimit':
      return 'The file exceeded a safety limit during conversion (too large or too deeply nested).';
    case 'missingPart':
      return 'The file is missing a part required to read it.';
    default:
      return detail;
  }
}

/**
 * Detect the format from the file's own bytes (signature-based — PDF header,
 * RTF open group, OLE stream names, ZIP package contents). Returns
 * `undefined` for CSV/plain-text formats (no signature) and anything
 * unrecognized — callers that already know the expected format (the PDF vs.
 * Office message-type split in offscreen.ts) can pass it explicitly to
 * `convertToMarkdown` instead of relying on this.
 */
export async function detectFormat(bytes: Uint8Array): Promise<Format | undefined> {
  await ensureInit();
  return formatFromBytes(bytes);
}

/**
 * Convert a document's raw bytes to Markdown. `format`, when given, skips
 * content-based detection (useful when the caller already knows it, or for
 * signature-less formats like CSV that detection can't identify on its own).
 * Throws `AnydocConvertError` with a `code` classifying the failure.
 */
export async function convertToMarkdown(bytes: Uint8Array, format?: Format): Promise<AnydocResult> {
  await ensureInit();
  const resolvedFormat = format ?? formatFromBytes(bytes);
  if (!resolvedFormat) {
    throw new AnydocConvertError(messageForCode('unsupported', 'Unrecognized file format.'), 'unsupported');
  }
  try {
    const text = toMarkdownBytes(bytes, resolvedFormat);
    return { text, format: resolvedFormat };
  } catch (err) {
    const code = (err as { code?: AnydocErrorCode })?.code;
    const detail = err instanceof Error ? err.message : String(err);
    throw new AnydocConvertError(messageForCode(code, detail), code);
  }
}
