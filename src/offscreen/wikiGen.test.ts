import { describe, expect, it, vi } from 'vitest';
import type { WikiPage } from '../shared/messages';

// buildWikiHtml's own logic is section-grouping/slugging/templating — actual
// markdown rendering and sanitization are marked/DOMPurify's job (and
// DOMPurify needs a real DOM, which this Node test environment doesn't have),
// so both are mocked to a simple pass-through.
vi.mock('marked', () => ({
  marked: {
    setOptions: vi.fn(),
    parse: (text: string) => `<p>${text}</p>`,
  },
}));
vi.mock('dompurify', () => ({
  default: { sanitize: (html: string) => html },
}));

import { buildWikiHtml } from './wikiGen';

function page(overrides: Partial<WikiPage> = {}): WikiPage {
  return { title: 'Untitled', text: 'body text', ...overrides };
}

describe('buildWikiHtml', () => {
  it('groups pages by top-level folder path into sidebar sections, root pages under "Documents"', () => {
    const html = buildWikiHtml('My KB', [
      page({ title: 'Root page', text: 'root', path: 'root.md' }),
      page({ title: 'Plan', text: 'plan body', path: 'notes/2024/plan.md' }),
      page({ title: 'Recipe', text: 'recipe body', path: 'notes/recipe.md' }),
      page({ title: 'Budget', text: 'budget body', path: 'finance/budget.md' }),
    ]);
    expect(html).toContain('<h2>Documents</h2>');
    expect(html).toContain('<h2>notes</h2>');
    expect(html).toContain('<h2>finance</h2>');
    // Root section listed before the alphabetically-sorted folder sections.
    expect(html.indexOf('<h2>Documents</h2>')).toBeLessThan(html.indexOf('<h2>finance</h2>'));
    expect(html.indexOf('<h2>finance</h2>')).toBeLessThan(html.indexOf('<h2>notes</h2>'));
  });

  it('dedupes slugs when two pages would otherwise collide', () => {
    const html = buildWikiHtml('KB', [page({ title: 'Same', text: 'a' }), page({ title: 'Same', text: 'b' })]);
    expect(html).toContain('id="same"');
    expect(html).toContain('id="same-2"');
  });

  it('renders each page\'s title as a heading and its body via marked', () => {
    const html = buildWikiHtml('KB', [page({ title: 'Hello World', text: 'the body' })]);
    expect(html).toContain('<h2>Hello World</h2>');
    expect(html).toContain('<p>the body</p>');
  });

  it('escapes HTML-unsafe characters in titles used as attribute values', () => {
    const html = buildWikiHtml('KB', [page({ title: '<script>alert(1)</script>', text: 'x' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('links to the source URL when provided', () => {
    const html = buildWikiHtml('KB', [page({ title: 'P', text: 'x', url: 'https://example.com/doc' })]);
    expect(html).toContain('href="https://example.com/doc"');
  });

  it('drops pages with empty or whitespace-only text', () => {
    const html = buildWikiHtml('KB', [page({ title: 'Empty', text: '   ' }), page({ title: 'Real', text: 'content' })]);
    expect(html).not.toContain('id="empty"');
    expect(html).toContain('id="real"');
    expect(html).toContain('1 page<');
  });

  it('shows an empty-state note and 0-page count when there are no documents', () => {
    const html = buildWikiHtml('Empty KB', []);
    expect(html).toContain('No documents to show.');
    expect(html).toContain('0 pages<');
  });

  it('escapes the wiki title used in the <title> tag and header', () => {
    const html = buildWikiHtml('<b>KB</b>', [page()]);
    expect(html).not.toContain('<title><b>KB</b></title>');
    expect(html).toContain('&lt;b&gt;KB&lt;/b&gt;');
  });
});
