// =============================================================================
// Build a downloadable wiki HTML file from a knowledge base's documents.
// Shared by two entry points that need the exact same repo->pages->file
// pipeline: the agent's create_wiki tool (agentRuntime.ts) and the direct
// per-repo "Generate wiki" buttons in Settings (serviceWorker.ts's
// generate_wiki_from_repo handler, driven from RepositoriesSection.tsx).
// =============================================================================

import type { WikiFileResult, WikiPage } from '../shared/messages';
import { generateWiki, repoDocsText } from './offscreenClient';

export function wikiSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'wiki';
}

/** Fetch every document in `repo`, package them into one wiki HTML file. */
export async function buildWikiFromRepo(
  repo: string,
  title?: string,
  lang: 'en' | 'fr' = 'en',
): Promise<WikiFileResult> {
  const docs = await repoDocsText(repo);
  if (docs.length === 0) {
    return { ok: false, error: `Repository "${repo}" has no documents (or doesn't exist).` };
  }
  const pages: WikiPage[] = docs.map((d) => ({ title: d.name, text: d.text, path: d.path, url: d.url, capturedAt: d.capturedAt }));
  const finalTitle = (title || repo).trim();
  const result = await generateWiki(finalTitle, pages, lang);
  if (!result.ok || !result.dataBase64) {
    return { ok: false, error: result.error || 'Could not generate the wiki.' };
  }
  return {
    ok: true,
    dataBase64: result.dataBase64,
    mimeType: result.mimeType ?? 'text/html',
    filename: `${wikiSlug(finalTitle)}.html`,
    pageCount: pages.length,
  };
}
