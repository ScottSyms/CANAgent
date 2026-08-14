import { describe, expect, it } from 'vitest';
import { classifyUpload, MAX_UPLOAD_BYTES } from './uploadFile';

describe('classifyUpload', () => {
  it('routes PDFs and Office files by extension', () => {
    expect(classifyUpload('report.pdf')).toBe('pdf');
    expect(classifyUpload('Brief.DOCX')).toBe('office');
    expect(classifyUpload('deck.pptx')).toBe('office');
    expect(classifyUpload('data.xlsx')).toBe('office');
  });

  it('routes the wider format set anydoc converts (legacy binary Word/PowerPoint, macro-enabled OOXML, OpenDocument, RTF, EPUB)', () => {
    expect(classifyUpload('old.doc')).toBe('office');
    expect(classifyUpload('macro.docm')).toBe('office');
    expect(classifyUpload('old.ppt')).toBe('office');
    expect(classifyUpload('macro.pptm')).toBe('office');
    expect(classifyUpload('slideshow.ppsx')).toBe('office');
    expect(classifyUpload('macro.xlsm')).toBe('office');
    expect(classifyUpload('doc.odt')).toBe('office');
    expect(classifyUpload('sheet.ods')).toBe('office');
    expect(classifyUpload('slides.odp')).toBe('office');
    expect(classifyUpload('note.rtf')).toBe('office');
    expect(classifyUpload('book.epub')).toBe('office');
  });

  it('does not classify legacy binary Excel (.xls/.xlsb) as office -- despite the extension naming a "modern" sibling, it is a different, non-zip binary format anydoc does not actually convert', () => {
    expect(classifyUpload('old.xls')).toBeNull();
    expect(classifyUpload('big.xlsb')).toBeNull();
  });

  it('routes text-like files by extension', () => {
    expect(classifyUpload('notes.txt')).toBe('text');
    expect(classifyUpload('README.md')).toBe('text');
    expect(classifyUpload('rows.csv')).toBe('text');
  });

  it('falls back to MIME when the extension is unknown', () => {
    expect(classifyUpload('payload', 'text/plain')).toBe('text');
    expect(classifyUpload('blob', 'application/pdf')).toBe('pdf');
    expect(classifyUpload('config', 'application/json')).toBe('text');
  });

  it('returns null for unsupported types', () => {
    expect(classifyUpload('photo.png', 'image/png')).toBeNull();
    expect(classifyUpload('archive.zip')).toBeNull();
    expect(classifyUpload('noext')).toBeNull();
  });

  it('exposes a sane size cap', () => {
    expect(MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
  });
});
