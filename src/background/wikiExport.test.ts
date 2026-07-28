import { afterEach, describe, expect, it, vi } from 'vitest';

const generateWiki = vi.fn();
const repoDocsText = vi.fn();
vi.mock('./offscreenClient', () => ({
  generateWiki: (...a: unknown[]) => generateWiki(...a),
  repoDocsText: (...a: unknown[]) => repoDocsText(...a),
}));

import { buildWikiFromRepo, wikiSlug } from './wikiExport';

afterEach(() => {
  vi.restoreAllMocks();
  generateWiki.mockReset();
  repoDocsText.mockReset();
});

describe('wikiSlug', () => {
  it('lowercases, replaces unsafe characters, and trims dashes', () => {
    expect(wikiSlug('  My Knowledge Base! ')).toBe('my-knowledge-base');
  });

  it('falls back to "wiki" for a title with no safe characters', () => {
    expect(wikiSlug('###')).toBe('wiki');
  });
});

describe('buildWikiFromRepo', () => {
  it('maps repo documents to wiki pages and returns the generated file', async () => {
    repoDocsText.mockResolvedValue([
      { id: 'd1', name: 'a', url: 'file:///a', capturedAt: 't', chunkCount: 1, path: 'notes/a.md', text: 'alpha' },
      { id: 'd2', name: 'b', url: 'file:///b', capturedAt: 't', chunkCount: 1, text: 'beta' },
    ]);
    generateWiki.mockResolvedValue({ ok: true, dataBase64: 'QUJD', mimeType: 'text/html' });

    const result = await buildWikiFromRepo('notes', 'My Notes', 'fr');

    expect(generateWiki).toHaveBeenCalledWith(
      'My Notes',
      [
        { title: 'a', text: 'alpha', path: 'notes/a.md', url: 'file:///a' },
        { title: 'b', text: 'beta', path: undefined, url: 'file:///b' },
      ],
      'fr',
    );
    expect(result).toEqual({
      ok: true,
      dataBase64: 'QUJD',
      mimeType: 'text/html',
      filename: 'my-notes.html',
      pageCount: 2,
    });
  });

  it('defaults the title to the repo name when none is given', async () => {
    repoDocsText.mockResolvedValue([{ id: 'd1', name: 'a', url: 'file:///a', capturedAt: 't', chunkCount: 1, text: 'x' }]);
    generateWiki.mockResolvedValue({ ok: true, dataBase64: 'QQ==', mimeType: 'text/html' });

    const result = await buildWikiFromRepo('📁 notes');

    expect(generateWiki).toHaveBeenCalledWith('📁 notes', expect.any(Array), 'en');
    expect(result.filename).toBe('notes.html');
  });

  it('fails without calling generateWiki when the repo has no documents', async () => {
    repoDocsText.mockResolvedValue([]);
    const result = await buildWikiFromRepo('empty');
    expect(result).toEqual({ ok: false, error: 'Repository "empty" has no documents (or doesn\'t exist).' });
    expect(generateWiki).not.toHaveBeenCalled();
  });

  it('propagates a generation failure', async () => {
    repoDocsText.mockResolvedValue([{ id: 'd1', name: 'a', url: 'file:///a', capturedAt: 't', chunkCount: 1, text: 'x' }]);
    generateWiki.mockResolvedValue({ ok: false, error: 'offscreen unavailable' });
    const result = await buildWikiFromRepo('notes');
    expect(result).toEqual({ ok: false, error: 'offscreen unavailable' });
  });
});
