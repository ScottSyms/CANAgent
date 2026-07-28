// =============================================================================
// Wiki generation — package a set of pages (typically a knowledge base's
// documents) into one self-contained, offline HTML "wiki": a sidebar table of
// contents grouped by folder path, anchored page sections, and client-side
// search/filter — no server, no external assets. Runs in the offscreen
// document (marked/DOMPurify need a DOM). Called from offscreen.ts for the
// `generate_wiki` op behind the agent's create_wiki tool.
//
// Modeled on github.com/ScottSyms/generatewiki (a Ruby/Pandoc script that
// concatenates hand-written markdown files into one browsable file) — same
// output shape: sidebar nav grouped by folder, anchored sections, live
// search. Two differences: content here comes from an existing repo's
// indexed documents rather than hand-authored markdown, and rendering is done
// client-side with `marked` instead of via Pandoc, since there's no
// Ruby/Pandoc available in a browser extension.
// =============================================================================

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { WikiPage } from '../shared/messages';

marked.setOptions({ gfm: true, breaks: true });

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

/** Top-level folder segment of a path (e.g. "notes/2024/plan.md" -> "notes"), or '' for root/no path. */
function sectionKeyOf(path: string | undefined): string {
  if (!path || !path.includes('/')) return '';
  return path.split('/')[0];
}

interface WikiPageRendered {
  slug: string;
  title: string;
  html: string;
  url?: string;
}

interface WikiSection {
  key: string;
  label: string;
  pages: WikiPageRendered[];
}

/** Group pages by top-level folder (root/no-path pages land in a single "Documents" section). */
function buildSections(pages: WikiPage[]): WikiSection[] {
  const usedSlugs = new Set<string>();
  const uniqueSlug = (base: string): string => {
    let slug = base;
    let i = 2;
    while (usedSlugs.has(slug)) slug = `${base}-${i++}`;
    usedSlugs.add(slug);
    return slug;
  };

  const grouped = new Map<string, WikiSection>();
  for (const p of pages) {
    const key = sectionKeyOf(p.path);
    let section = grouped.get(key);
    if (!section) {
      section = { key, label: key || 'Documents', pages: [] };
      grouped.set(key, section);
    }
    const slug = uniqueSlug(slugify(p.path || p.title));
    const html = DOMPurify.sanitize(marked.parse(p.text ?? '', { async: false }) as string);
    section.pages.push({ slug, title: p.title?.trim() || p.path || 'Untitled', html, url: p.url });
  }

  // Root/ungrouped section first, then folders alphabetically; pages within a
  // section sorted by title.
  return Array.from(grouped.values())
    .sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : a.key.localeCompare(b.key)))
    .map((s) => ({ ...s, pages: [...s.pages].sort((a, b) => a.title.localeCompare(b.title)) }));
}

function navHtml(sections: WikiSection[]): string {
  return sections
    .map(
      (s) => `
        <section class="nav-group">
          <h2>${escapeHtml(s.label)}</h2>
          <ul>
            ${s.pages
              .map((p) => `<li><a class="page-link" href="#${p.slug}" data-target="${p.slug}">${escapeHtml(p.title)}</a></li>`)
              .join('')}
          </ul>
        </section>`,
    )
    .join('');
}

function contentHtml(sections: WikiSection[]): string {
  return sections
    .flatMap((s) =>
      s.pages.map(
        (p) => `
        <section class="page-section" id="${p.slug}" data-title="${escapeHtml(p.title)}">
          <h2>${escapeHtml(p.title)}</h2>
          ${p.url ? `<p class="page-source"><a href="${escapeHtml(p.url)}">${escapeHtml(p.url)}</a></p>` : ''}
          ${p.html}
        </section>`,
      ),
    )
    .join('');
}

/** Generate a self-contained HTML wiki from a title + pages, returned as an HTML string. */
export function buildWikiHtml(title: string, pages: WikiPage[]): string {
  const sections = buildSections(pages.filter((p) => (p.text ?? '').trim().length > 0));
  const safeTitle = escapeHtml(title.trim() || 'Wiki');
  const pageCount = sections.reduce((n, s) => n + s.pages.length, 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  :root {
    color-scheme: light dark;
    --page-bg: #f4f5f8;
    --surface: #ffffff;
    --surface-muted: #f0f2f7;
    --surface-strong: #ece8f7;
    --ink: #22253b;
    --ink-soft: #555b73;
    --navy: #1a1730;
    --teal: #0f8793;
    --teal-2: #116f79;
    --purple: #5f43b2;
    --link: #1459cf;
    --border: #d7dced;
    --shadow: 0 8px 28px rgba(26, 23, 48, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page-bg: #14151d;
      --surface: #1c1e29;
      --surface-muted: #262838;
      --surface-strong: #2e2a48;
      --ink: #e7e8f0;
      --ink-soft: #a7a9c0;
      --navy: #e7e8f0;
      --teal: #3dd6c9;
      --teal-2: #2fb6ab;
      --purple: #a48fe6;
      --link: #7fb0ff;
      --border: #33354a;
      --shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; font-family: "Segoe UI", Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; background: var(--page-bg); color: var(--ink); }
  a { color: var(--link); }
  .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 18px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .wordmark { font-weight: 800; font-size: 1.3rem; color: var(--navy); }
  .page-count { color: var(--ink-soft); font-size: 0.9rem; }
  .shell { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 24px; max-width: 1200px; margin: 0 auto; padding: 24px; align-items: start; }
  .sidebar { position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; box-shadow: var(--shadow); }
  .search { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; background: var(--surface); color: var(--ink); font-size: 0.9rem; margin-bottom: 8px; }
  .search-meta { color: var(--ink-soft); font-size: 0.78rem; margin-bottom: 14px; }
  .sidebar-nav { display: grid; gap: 16px; }
  .nav-group h2 { margin: 0 0 6px; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--purple); }
  .nav-group ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
  .page-link { display: block; padding: 6px 8px; border-radius: 6px; color: var(--ink); text-decoration: none; font-size: 0.88rem; }
  .page-link.active, .page-link:hover { background: var(--surface-strong); color: var(--navy); }
  .content { min-width: 0; }
  .article { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 30px; box-shadow: var(--shadow); }
  .article h2, .article h3, .article h4, .article h5, .article h6 { color: var(--navy); }
  .page-section { padding: 22px 0 26px; border-top: 1px solid var(--border); }
  .page-section:first-child { border-top: 0; padding-top: 0; }
  .page-section[hidden] { display: none; }
  .page-section h2 { margin-top: 0; font-size: 1.7rem; scroll-margin-top: 20px; }
  .page-source { color: var(--ink-soft); font-size: 0.82rem; word-break: break-all; }
  .page-section p, .page-section li { line-height: 1.6; }
  .page-section code { background: var(--surface-muted); border: 1px solid var(--border); padding: 0.1rem 0.35rem; border-radius: 6px; font-size: 0.92em; }
  .page-section pre code { display: block; padding: 12px; overflow-x: auto; }
  .page-section table { border-collapse: collapse; width: 100%; }
  .page-section th, .page-section td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  mark { background: rgba(250, 204, 21, 0.4); color: inherit; padding: 0 0.15em; border-radius: 0.2em; }
  .empty-note { color: var(--ink-soft); }
  @media (max-width: 780px) {
    .shell { grid-template-columns: 1fr; }
    .sidebar { position: static; max-height: none; }
  }
</style>
</head>
<body>
  <header class="topbar">
    <span class="wordmark">${safeTitle}</span>
    <span class="page-count">${pageCount} page${pageCount === 1 ? '' : 's'}</span>
  </header>
  <div class="shell">
    <aside class="sidebar">
      <input id="search" class="search" type="search" placeholder="Search titles and content" aria-label="Search wiki">
      <div id="search-meta" class="search-meta">Showing all pages</div>
      <nav class="sidebar-nav" aria-label="Wiki navigation">
        ${navHtml(sections)}
      </nav>
    </aside>
    <main class="content">
      <article id="wiki-content" class="article">
        ${pageCount === 0 ? '<p class="empty-note">No documents to show.</p>' : contentHtml(sections)}
      </article>
    </main>
  </div>
  <script>
    (() => {
      const search = document.getElementById('search');
      const meta = document.getElementById('search-meta');
      const sections = Array.from(document.querySelectorAll('.page-section'));
      const links = Array.from(document.querySelectorAll('.page-link'));
      const normalize = (v) => v.toLowerCase().trim();

      const clearMarks = (root) => {
        root.querySelectorAll('mark[data-search-mark]').forEach((mark) => {
          const parent = mark.parentNode;
          parent.replaceChild(document.createTextNode(mark.textContent), mark);
          parent.normalize();
        });
      };

      const markText = (root, query) => {
        if (!query || query.length < 2) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            if (node.parentElement && ['SCRIPT', 'STYLE', 'MARK'].includes(node.parentElement.tagName)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach((node) => {
          const text = node.nodeValue;
          const index = text.toLowerCase().indexOf(query);
          if (index === -1) return;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + query.length);
          const mark = document.createElement('mark');
          mark.dataset.searchMark = 'true';
          range.surroundContents(mark);
        });
      };

      const update = () => {
        const query = normalize(search.value);
        let shown = 0;
        sections.forEach((section) => {
          clearMarks(section);
          const text = normalize(section.innerText);
          const match = !query || text.includes(query);
          section.hidden = !match;
          if (match) {
            shown += 1;
            markText(section, query);
          }
        });
        links.forEach((link) => {
          const target = document.getElementById(link.dataset.target);
          const visible = target && !target.hidden;
          link.parentElement.hidden = !visible;
        });
        document.querySelectorAll('.nav-group').forEach((group) => {
          const visibleItems = Array.from(group.querySelectorAll('li')).some((item) => !item.hidden);
          group.hidden = !visibleItems;
        });
        meta.textContent = query ? \`Showing \${shown} matching page\${shown === 1 ? '' : 's'}\` : 'Showing all pages';
      };

      const setActiveLink = () => {
        const current = sections.find((section) => {
          const rect = section.getBoundingClientRect();
          return rect.top <= 140 && rect.bottom >= 140;
        });
        const currentId = current ? current.id : null;
        links.forEach((link) => link.classList.toggle('active', link.dataset.target === currentId));
      };

      if (search) {
        search.addEventListener('input', update);
        document.addEventListener('scroll', setActiveLink, { passive: true });
        window.addEventListener('hashchange', setActiveLink);
        update();
        setActiveLink();
      }
    })();
  </script>
</body>
</html>
`;
}
