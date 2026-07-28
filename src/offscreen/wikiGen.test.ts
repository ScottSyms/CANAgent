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
    expect(html).toContain('Browse and search 1 page.');
  });

  it('shows an empty-state note and a 0-page count when there are no documents', () => {
    const html = buildWikiHtml('Empty KB', []);
    expect(html).toContain('No documents to show.');
    expect(html).toContain('Browse and search 0 pages.');
  });

  it('escapes the wiki title used in the <title> tag and header', () => {
    const html = buildWikiHtml('<b>KB</b>', [page()]);
    expect(html).not.toContain('<title><b>KB</b></title>');
    expect(html).toContain('&lt;b&gt;KB&lt;/b&gt;');
  });

  it('defaults to English chrome when no lang is given', () => {
    const html = buildWikiHtml('KB', [page()]);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('placeholder="Search titles and content"');
  });

  it('localizes the wiki chrome to French without translating document content', () => {
    const html = buildWikiHtml('KB', [page({ title: 'Hello World', text: 'the body' })], 'fr');
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('placeholder="Rechercher dans les titres et le contenu"');
    expect(html).toContain('Toutes les pages sont affichées');
    // Document content itself is not machine-translated — only the chrome is.
    expect(html).toContain('<h2>Hello World</h2>');
    expect(html).toContain('<p>the body</p>');
  });

  it('shows the French empty-state note when there are no documents', () => {
    const html = buildWikiHtml('Empty KB', [], 'fr');
    expect(html).toContain('Aucun document à afficher.');
  });

  it('falls back to the localized "Documents" section label for root/no-path pages', () => {
    const html = buildWikiHtml('KB', [page({ title: 'Root', text: 'x' })], 'fr');
    expect(html).toContain('<h2>Documents</h2>'); // identical spelling in both languages
  });

  it('lists the most recently added pages in the Quick access rail card, newest first', () => {
    const html = buildWikiHtml('KB', [
      page({ title: 'Oldest', text: 'a', capturedAt: '2024-01-01T00:00:00Z' }),
      page({ title: 'Newest', text: 'b', capturedAt: '2024-03-01T00:00:00Z' }),
      page({ title: 'Middle', text: 'c', capturedAt: '2024-02-01T00:00:00Z' }),
    ]);
    expect(html).toContain('<h2>Quick access</h2>');
    const railStart = html.indexOf('Quick access');
    const railSection = html.slice(railStart, html.indexOf('</aside>', railStart));
    expect(railSection.indexOf('Newest')).toBeLessThan(railSection.indexOf('Middle'));
    expect(railSection.indexOf('Middle')).toBeLessThan(railSection.indexOf('Oldest'));
  });

  it('lists every section with a link to its first page in the Sections rail card and footer', () => {
    const html = buildWikiHtml('KB', [
      page({ title: 'Plan', text: 'x', path: 'notes/plan.md' }),
      page({ title: 'Budget', text: 'x', path: 'finance/budget.md' }),
    ]);
    expect(html).toContain('<h2>Sections</h2>');
    expect(html).toContain('href="#notes-plan-md"');
    expect(html).toContain('href="#finance-budget-md"');
  });

  it('omits the rail entirely when there are no documents (nothing to show quick access or sections for)', () => {
    const html = buildWikiHtml('Empty KB', []);
    expect(html).not.toContain('<aside class="rail">');
  });

  it('includes a hero band with the wiki title and a generated document-count summary', () => {
    const html = buildWikiHtml('My Notes', [page(), page({ title: 'Two', text: 'y' })]);
    expect(html).toContain('<h1>My Notes</h1>');
    expect(html).toContain('generated from 2 documents in “My Notes”');
  });

  it('derives a short letters-only wordmark from the title for the topbar', () => {
    const html = buildWikiHtml('📁 Project Notes', [page()]);
    expect(html).toContain('class="wordmark">PN<');
  });

  it('drops a leading markdown heading that just repeats the page title, avoiding a duplicate heading', () => {
    const html = buildWikiHtml('KB', [page({ title: 'Getting Started', text: '# Getting Started\n\nBody text.' })]);
    expect(html).toContain('<h2>Getting Started</h2>');
    // The mocked marked.parse wraps whatever text it receives in <p>...</p> —
    // if the heading line wasn't stripped, it would show up again in the body.
    expect(html).not.toContain('<p># Getting Started');
    expect(html).toContain('<p>Body text.</p>');
  });

  it('keeps a leading heading that differs from the page title', () => {
    const html = buildWikiHtml('KB', [page({ title: 'Getting Started', text: '# Introduction\n\nBody text.' })]);
    expect(html).toContain('<h2>Getting Started</h2>');
    expect(html).toContain('# Introduction');
  });
});
