import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import initAnydoc from '@firecrawl/anydoc-wasm';
import { convertToMarkdown, detectFormat, AnydocConvertError } from './anydocParse';

// anydocParse.ts's ensureInit() calls the package's default `init()` with no
// arguments, which fetches its .wasm binary via `new URL(..., import.meta.url)`
// — correct in the real extension (Vite rewrites that to a chrome-extension://
// URL `fetch()` handles), but Node's `fetch()` doesn't support `file://` URLs
// under vitest. Pre-initializing the SAME module singleton here (both this
// test file and anydocParse.ts import the same '@firecrawl/anydoc-wasm'
// module instance) with the bytes read directly makes anydocParse.ts's own
// later `init()` call a no-op early-return, so the real conversion logic
// under test is unaffected by this workaround.
beforeAll(async () => {
  const wasmPath = new URL('../../node_modules/@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm', import.meta.url);
  await initAnydoc(readFileSync(wasmPath));
});

async function realDocxBytes(): Promise<Uint8Array> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: 'Aviation Safety Report', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun('The system was upgraded in '), new TextRun({ text: '2022', bold: true }), new TextRun('.')] }),
      ],
    }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

describe('anydocParse', () => {
  it('detects docx from real docx bytes and converts to Markdown, preserving structure', async () => {
    const bytes = await realDocxBytes();
    expect(await detectFormat(bytes)).toBe('docx');
    const result = await convertToMarkdown(bytes);
    expect(result.format).toBe('docx');
    expect(result.text).toContain('# Aviation Safety Report');
    expect(result.text).toContain('**2022**');
  });

  it('accepts an explicit format instead of relying on content detection', async () => {
    const bytes = await realDocxBytes();
    const result = await convertToMarkdown(bytes, 'docx');
    expect(result.text).toContain('Aviation Safety Report');
  });

  it('returns undefined from detectFormat for unrecognized bytes', async () => {
    const bytes = new TextEncoder().encode('just some plain text, no signature');
    expect(await detectFormat(bytes)).toBeUndefined();
  });

  it('throws AnydocConvertError with code "unsupported" for unrecognized bytes with no format given', async () => {
    const bytes = new TextEncoder().encode('just some plain text, no signature');
    await expect(convertToMarkdown(bytes)).rejects.toMatchObject({
      name: 'AnydocConvertError',
      code: 'unsupported',
    });
  });

  it('throws AnydocConvertError with a code for a malformed document of a known format', async () => {
    // A docx-shaped ZIP (real PK signature) but with no actual document parts inside.
    const { zipSync } = await import('fflate');
    const bytes = zipSync({ 'not-a-real-part.txt': new TextEncoder().encode('nope') });
    await expect(convertToMarkdown(bytes, 'docx')).rejects.toBeInstanceOf(AnydocConvertError);
  });

  it('reports a specific, actionable message per error code rather than a bare error dump', async () => {
    const bytes = new TextEncoder().encode('unrecognizable');
    try {
      await convertToMarkdown(bytes);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AnydocConvertError);
      expect((err as AnydocConvertError).message).toContain('Unrecognized or unsupported');
    }
  });
});
