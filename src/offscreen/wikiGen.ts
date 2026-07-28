// =============================================================================
// Wiki generation — package a set of pages (typically a knowledge base's
// documents) into one self-contained, offline HTML "wiki": a hero band, a
// sidebar table of contents grouped by folder path, anchored page sections,
// a right rail (quick access + sections), a footer, and client-side
// search/filter — no server, no external assets. Runs in the offscreen
// document (marked/DOMPurify need a DOM). Called from offscreen.ts for the
// `generate_wiki` op behind the agent's create_wiki tool.
//
// Visual structure is modeled directly on github.com/ScottSyms/generatewiki
// (a Ruby/Pandoc script that concatenates hand-written markdown files into
// one browsable file, with a hero band / sidebar+rail shell / footer). Two
// differences: content here comes from an existing repo's indexed documents
// rather than hand-authored markdown/curated rail links, so the rail and
// footer are filled from real page data (recently-added docs, section list)
// instead of a hand-picked "quick access" list; and rendering is done
// client-side with `marked` instead of via Pandoc, since there's no
// Ruby/Pandoc available in a browser extension.
// =============================================================================

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { WikiPage } from '../shared/messages';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Localizes the wiki's own chrome (search box, nav labels, rail/footer copy)
 * — NOT the document content itself, which is rendered as-is from the source
 * repo. Mirrors generatewiki's UI_STRINGS EN/FR pattern.
 */
const STRINGS = {
  en: {
    htmlLang: 'en',
    searchPlaceholder: 'Search titles and content',
    searchAria: 'Search wiki',
    showingAll: 'Showing all pages',
    showingMatches: (n: number) => `Showing ${n} matching page${n === 1 ? '' : 's'}`,
    noDocuments: 'No documents to show.',
    documentsSection: 'Documents',
    navAria: 'Wiki navigation',
    searchChip: 'Search',
    heroStatus: 'Offline edition with live filtering',
    heroBody: (n: number, repo: string) => `A portable, searchable reference generated from ${n} document${n === 1 ? '' : 's'} in “${repo}”.`,
    sidebarBody: (n: number) => `Browse and search ${n} page${n === 1 ? '' : 's'}.`,
    quickAccessTitle: 'Quick access',
    quickAccessBody: 'The most recently added pages.',
    sectionsTitle: 'Sections',
    reportLink: 'Return to top',
    footerSections: 'Sections',
    footerRecent: 'Recently added',
    footerAbout: 'About this file',
    footerAboutBody: (generatedAt: string) =>
      `Single-file offline edition generated on-device from a CANChat Agent knowledge base on ${generatedAt}. Use the built-in search and section navigation to move through it quickly in a browser.`,
  },
  fr: {
    htmlLang: 'fr',
    searchPlaceholder: 'Rechercher dans les titres et le contenu',
    searchAria: 'Rechercher dans le wiki',
    showingAll: 'Toutes les pages sont affichées',
    showingMatches: (n: number) => `${n} page${n === 1 ? '' : 's'} correspondante${n === 1 ? '' : 's'} affichée${n === 1 ? '' : 's'}`,
    noDocuments: 'Aucun document à afficher.',
    documentsSection: 'Documents',
    navAria: 'Navigation du wiki',
    searchChip: 'Recherche',
    heroStatus: 'Édition hors ligne avec filtrage en direct',
    heroBody: (n: number, repo: string) => `Une référence portable et consultable générée à partir de ${n} document${n === 1 ? '' : 's'} de « ${repo} ».`,
    sidebarBody: (n: number) => `Parcourez et recherchez ${n} page${n === 1 ? '' : 's'}.`,
    quickAccessTitle: 'Accès rapide',
    quickAccessBody: 'Les pages ajoutées le plus récemment.',
    sectionsTitle: 'Sections',
    reportLink: 'Retour en haut',
    footerSections: 'Sections',
    footerRecent: 'Ajoutés récemment',
    footerAbout: 'À propos de ce fichier',
    footerAboutBody: (generatedAt: string) =>
      `Édition hors ligne en un seul fichier générée sur l'appareil à partir d'une base de connaissances CANChat Agent le ${generatedAt}. Utilisez la recherche intégrée et la navigation par section pour le parcourir rapidement dans un navigateur.`,
  },
} as const;

export type WikiLang = keyof typeof STRINGS;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

/** Short letters-only wordmark for the topbar (e.g. "My Project Notes" -> "MPN"). */
function wordmarkOf(title: string): string {
  const words = title
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  const initials = words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
  return initials || '📚';
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
  capturedAt?: string;
}

interface WikiSection {
  key: string;
  label: string;
  pages: WikiPageRendered[];
}

/**
 * Drop a leading markdown heading line if it just repeats the page title —
 * otherwise well-formatted docs that start with `# Title` show that title
 * twice (once as the section's own `<h2>`, once from the rendered body).
 */
function stripLeadingTitleHeading(text: string, title: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const m = lines[i]?.match(/^#{1,6}\s+(.*)$/);
  if (m && m[1].trim().toLowerCase() === title.trim().toLowerCase()) {
    return lines.slice(i + 1).join('\n').trimStart();
  }
  return text;
}

/** Group pages by top-level folder (root/no-path pages land in a single "Documents" section). */
function buildSections(pages: WikiPage[], lang: WikiLang): WikiSection[] {
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
      section = { key, label: key || STRINGS[lang].documentsSection, pages: [] };
      grouped.set(key, section);
    }
    const slug = uniqueSlug(slugify(p.path || p.title));
    const title = p.title?.trim() || p.path || 'Untitled';
    const html = DOMPurify.sanitize(marked.parse(stripLeadingTitleHeading(p.text ?? '', title), { async: false }) as string);
    section.pages.push({ slug, title, html, url: p.url, capturedAt: p.capturedAt });
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
export function buildWikiHtml(title: string, pages: WikiPage[], lang: WikiLang = 'en'): string {
  const ui = STRINGS[lang] ?? STRINGS.en;
  const sections = buildSections(pages.filter((p) => (p.text ?? '').trim().length > 0), lang);
  const safeTitle = escapeHtml(title.trim() || 'Wiki');
  const allPages = sections.flatMap((s) => s.pages);
  const pageCount = allPages.length;
  const firstSlug = allPages[0]?.slug;
  const recent = [...allPages].sort((a, b) => (b.capturedAt ?? '').localeCompare(a.capturedAt ?? '')).slice(0, 4);
  const generatedAt = new Date().toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA', { year: 'numeric', month: 'long', day: 'numeric' });

  const quickAccessList = recent
    .map((p) => `<li><a href="#${p.slug}">${escapeHtml(p.title)}</a></li>`)
    .join('');
  const sectionsList = sections
    .map((s) => `<li><a href="#${s.pages[0].slug}">${escapeHtml(s.label)}</a></li>`)
    .join('');

  return `<!doctype html>
<html lang="${ui.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  :root {
    color-scheme: light;
    --page-bg: #f4f5f8;
    --surface: #ffffff;
    --surface-muted: #f0f2f7;
    --surface-strong: #ece8f7;
    --ink: #22253b;
    --ink-soft: #555b73;
    --navy: #1a1730;
    --navy-2: #2a2348;
    --teal: #0f8793;
    --teal-2: #116f79;
    --purple: #5f43b2;
    --purple-2: #9248d6;
    --link: #1459cf;
    --border: #d7dced;
    --max: 1360px;
    --shadow: 0 8px 28px rgba(26, 23, 48, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --page-bg: #14151d;
      --surface: #1c1e29;
      --surface-muted: #262838;
      --surface-strong: #2e2a48;
      --ink: #e7e8f0;
      --ink-soft: #a7a9c0;
      --navy: #e7e8f0;
      --navy-2: #241e3a;
      --teal: #3dd6c9;
      --teal-2: #2fb6ab;
      --purple: #a48fe6;
      --purple-2: #b07de8;
      --link: #7fb0ff;
      --border: #33354a;
      --shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; font-family: "Segoe UI", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: var(--page-bg); color: var(--ink); }
  a { color: var(--link); }
  a:hover { text-decoration: underline; }

  .topbar { background: var(--surface); border-bottom: 1px solid var(--border); }
  .topbar-inner, .shell, .footer-inner, .report-inner { max-width: var(--max); margin: 0 auto; padding-left: 24px; padding-right: 24px; }
  .topbar-inner { min-height: 72px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .wordmark { display: inline-flex; align-items: baseline; color: var(--navy); font-weight: 800; font-size: 2rem; line-height: 1; text-decoration: none; }
  .topbar-tools { display: flex; align-items: center; gap: 12px; color: var(--ink-soft); font-size: 0.95rem; }
  .search-chip { display: inline-flex; align-items: center; padding: 10px 16px; border-radius: 999px; background: var(--surface-muted); color: var(--ink-soft); min-width: 180px; }

  .hero-band { background: linear-gradient(90deg, var(--teal-2) 0%, var(--teal) 58%, var(--teal) 100%); position: relative; overflow: hidden; }
  .hero-band::before, .hero-band::after { content: ""; position: absolute; inset: 0; pointer-events: none; }
  .hero-band::before {
    background:
      radial-gradient(circle at 12% 24%, rgba(255,255,255,0.12), transparent 12%),
      radial-gradient(circle at 22% 64%, rgba(255,255,255,0.1), transparent 14%),
      radial-gradient(circle at 70% 18%, rgba(255,255,255,0.08), transparent 12%);
  }
  .hero-band::after { background: linear-gradient(135deg, rgba(255,255,255,0.04) 0, rgba(255,255,255,0.04) 16%, transparent 16%, transparent 100%); opacity: 0.6; }
  .hero-inner { max-width: var(--max); margin: 0 auto; padding: 28px 24px 0; min-height: 154px; display: flex; justify-content: flex-end; align-items: flex-end; }
  .hero-panel { width: min(100%, 980px); background: var(--navy); color: #fff; padding: 34px 28px; border-radius: 16px 16px 0 0; box-shadow: var(--shadow); }
  .hero-panel h1 { margin: 0 0 10px; font-size: clamp(2rem, 3.6vw, 3.3rem); line-height: 1.05; letter-spacing: -0.02em; }
  .hero-panel p { margin: 0; color: rgba(255,255,255,0.82); font-size: 1.02rem; max-width: 64ch; }
  .status { display: inline-flex; align-items: center; gap: 8px; margin-top: 14px; font-size: 0.9rem; color: rgba(255,255,255,0.82); }
  .status::before { content: ""; width: 10px; height: 10px; border-radius: 999px; background: #7ad0d7; }

  .shell { display: grid; grid-template-columns: 300px minmax(0, 1fr) 280px; gap: 24px; padding-top: 30px; padding-bottom: 36px; align-items: start; }
  .sidebar { position: sticky; top: 16px; align-self: start; max-height: calc(100vh - 32px); overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 18px; box-shadow: var(--shadow); }
  .brand h1 { margin: 0 0 8px; color: var(--navy); font-size: 1.4rem; line-height: 1.2; }
  .brand p { margin: 0 0 16px; color: var(--ink-soft); font-size: 0.95rem; }
  .search { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; background: var(--surface); color: var(--ink); font-size: 0.95rem; margin-bottom: 12px; }
  .search-meta { color: var(--ink-soft); font-size: 0.82rem; margin-bottom: 16px; }
  .sidebar-nav { display: grid; gap: 18px; }
  .nav-group h2 { margin: 0 0 8px; font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--purple); }
  .nav-group ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
  .page-link { display: block; padding: 8px 10px; border-radius: 6px; color: var(--ink); text-decoration: none; }
  .page-link.active, .page-link:hover { background: var(--surface-strong); color: var(--navy); text-decoration: none; }

  .content { min-width: 0; }
  .article { background: var(--surface); color: var(--ink); border-radius: 8px; border: 1px solid var(--border); padding: 34px; box-shadow: var(--shadow); }
  .article h2, .article h3, .article h4, .article h5, .article h6 { color: var(--navy); }
  .page-section { padding: 24px 0 28px; border-top: 1px solid var(--border); }
  .page-section:first-child { border-top: 0; padding-top: 0; }
  .page-section[hidden] { display: none; }
  .page-section h2, .page-section h3, .page-section h4, .page-section h5, .page-section h6 { scroll-margin-top: 24px; }
  .page-section h2 { margin-top: 0; font-size: 1.95rem; }
  .page-source { color: var(--ink-soft); font-size: 0.82rem; word-break: break-all; }
  .page-section p, .page-section li { line-height: 1.65; }
  .page-section ul { padding-left: 1.25rem; }
  .page-section code { background: var(--surface-muted); border: 1px solid var(--border); padding: 0.1rem 0.35rem; border-radius: 6px; font-size: 0.92em; }
  .page-section pre code { display: block; padding: 12px; overflow-x: auto; }
  .page-section table { border-collapse: collapse; width: 100%; }
  .page-section th, .page-section td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  .page-section ul li::marker { color: var(--purple); }
  .empty-note { color: var(--ink-soft); }

  .rail { display: grid; gap: 18px; }
  .rail-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); overflow: hidden; }
  .rail-card h2 { margin: 0; padding: 14px 16px; background: var(--surface-muted); color: var(--navy); font-size: 1.1rem; border-bottom: 1px solid var(--border); }
  .rail-card-body { padding: 16px; color: var(--ink); }
  .rail-card p { margin-top: 0; line-height: 1.55; }
  .rail-card ul { margin: 0; padding-left: 1.2rem; line-height: 1.55; }

  .report-band { background: linear-gradient(90deg, #4632b3 0%, var(--purple-2) 100%); color: #fff; }
  .report-inner { min-height: 68px; display: flex; align-items: center; justify-content: center; gap: 18px; text-align: center; font-weight: 700; }
  .report-link { display: inline-block; background: rgba(0, 0, 0, 0.45); color: #fff; text-decoration: none; padding: 12px 20px; border-radius: 4px; font-weight: 600; box-shadow: 0 6px 18px rgba(0,0,0,0.2); }

  .footer { background: var(--navy-2); color: #fff; }
  .footer-inner { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 36px; padding-top: 44px; padding-bottom: 52px; }
  .footer-section { min-width: 0; }
  .footer-section h2 { margin: 0 0 18px; font-size: 1.05rem; color: #fff; }
  .footer-section ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .footer-section a { color: #d6d9f3; }
  .footer-note { color: #d6d9f3; line-height: 1.6; }

  mark { background: rgba(250, 204, 21, 0.35); color: inherit; padding: 0 0.15em; border-radius: 0.2em; }

  @media (max-width: 1160px) {
    .shell { grid-template-columns: 280px minmax(0, 1fr); }
    .rail { grid-column: 1 / -1; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 900px) {
    .topbar-inner, .hero-inner, .shell, .footer-inner, .report-inner { padding-left: 16px; padding-right: 16px; }
    .topbar-inner { flex-wrap: wrap; padding-top: 12px; padding-bottom: 12px; }
    .shell { grid-template-columns: 1fr; gap: 18px; }
    .hero-inner { min-height: 120px; padding-top: 20px; }
    .hero-panel { padding: 24px 20px; }
    .sidebar { position: static; max-height: none; }
    .article { padding: 22px; }
    .rail { grid-template-columns: 1fr; }
    .footer-inner { grid-template-columns: 1fr 1fr; gap: 26px; }
  }
  @media (max-width: 640px) {
    .wordmark { font-size: 1.7rem; }
    .report-inner { flex-direction: column; padding-top: 18px; padding-bottom: 18px; }
    .footer-inner { grid-template-columns: 1fr; }
  }
  @media print {
    body { background: #fff; }
    .topbar, .rail, .report-band, .footer { display: none; }
    .shell { display: block; padding: 0; max-width: none; }
    .sidebar { display: none; }
    .article, .hero-panel { box-shadow: none; border: 0; background: #fff; }
  }
</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <a href="#${firstSlug ?? ''}" class="wordmark">${escapeHtml(wordmarkOf(title))}</a>
      <div class="topbar-tools">
        <span class="search-chip">${escapeHtml(ui.searchChip)}</span>
      </div>
    </div>
  </header>
  <section class="hero-band">
    <div class="hero-inner">
      <div class="hero-panel">
        <h1>${safeTitle}</h1>
        <p>${escapeHtml(ui.heroBody(pageCount, title.trim() || 'Wiki'))}</p>
        <div class="status">${escapeHtml(ui.heroStatus)}</div>
      </div>
    </div>
  </section>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <h1>${safeTitle}</h1>
        <p>${escapeHtml(ui.sidebarBody(pageCount))}</p>
      </div>
      <input id="search" class="search" type="search" placeholder="${escapeHtml(ui.searchPlaceholder)}" aria-label="${escapeHtml(ui.searchAria)}">
      <div id="search-meta" class="search-meta">${escapeHtml(ui.showingAll)}</div>
      <nav class="sidebar-nav" aria-label="${escapeHtml(ui.navAria)}">
        ${navHtml(sections)}
      </nav>
    </aside>
    <main class="content">
      <article id="wiki-content" class="article">
        ${pageCount === 0 ? `<p class="empty-note">${escapeHtml(ui.noDocuments)}</p>` : contentHtml(sections)}
      </article>
    </main>
    ${
      pageCount > 0
        ? `<aside class="rail">
      <section class="rail-card">
        <h2>${escapeHtml(ui.quickAccessTitle)}</h2>
        <div class="rail-card-body">
          <p>${escapeHtml(ui.quickAccessBody)}</p>
          <ul>${quickAccessList}</ul>
        </div>
      </section>
      <section class="rail-card">
        <h2>${escapeHtml(ui.sectionsTitle)}</h2>
        <div class="rail-card-body">
          <ul>${sectionsList}</ul>
        </div>
      </section>
    </aside>`
        : ''
    }
  </div>
  <section class="report-band">
    <div class="report-inner">
      <a class="report-link" href="#${firstSlug ?? ''}">${escapeHtml(ui.reportLink)}</a>
    </div>
  </section>
  <footer class="footer">
    <div class="footer-inner">
      <section class="footer-section">
        <h2>${escapeHtml(ui.footerSections)}</h2>
        <ul>${sectionsList}</ul>
      </section>
      <section class="footer-section">
        <h2>${escapeHtml(ui.footerRecent)}</h2>
        <ul>${quickAccessList}</ul>
      </section>
      <section class="footer-section">
        <h2>${escapeHtml(ui.footerAbout)}</h2>
        <div class="footer-note">${escapeHtml(ui.footerAboutBody(generatedAt))}</div>
      </section>
    </div>
  </footer>
  <script>
    (() => {
      const isFr = ${lang === 'fr'};
      const showingAll = ${JSON.stringify(ui.showingAll)};
      const showingMatches = (n) => isFr
        ? \`\${n} page\${n === 1 ? '' : 's'} correspondante\${n === 1 ? '' : 's'} affichée\${n === 1 ? '' : 's'}\`
        : \`Showing \${n} matching page\${n === 1 ? '' : 's'}\`;
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
        meta.textContent = query ? showingMatches(shown) : showingAll;
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
