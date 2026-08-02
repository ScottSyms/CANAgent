// Resolve stable sentence ids to full Citations (source doc + exact sentence text
// via offsets). Shared by the agent (grounding search_graph answers) and the
// service worker (the graph UI's evidence panel), so both resolve identically —
// deterministically, no fuzzy matching, no re-embedding.

import type { CitableSentence } from '../shared/sentenceSplit';
import type { Citation } from '../shared/types';
import { docChunks, repoDocs } from './offscreenClient';

/** Resolve `ids` (any subset of a repo's sentence ids) to Citations. */
export async function resolveSentenceCitations(repo: string, ids: string[]): Promise<Citation[]> {
  const want = new Set(ids);
  if (want.size === 0) return [];

  // Group by the doc-id prefix (the id up to its first ':') so each document's
  // chunks are fetched once.
  const byDoc = new Map<string, Set<string>>();
  for (const id of want) {
    const docId = id.split(':')[0];
    if (!docId) continue;
    let set = byDoc.get(docId);
    if (!set) byDoc.set(docId, (set = new Set()));
    set.add(id);
  }

  const docsRes = await repoDocs(repo);
  const docMeta = new Map(
    ((docsRes.ok ? docsRes.result : []) as Array<{ id: string; name: string; url: string }>).map((d) => [d.id, d]),
  );

  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const [docId, wanted] of byDoc) {
    const meta = docMeta.get(docId);
    const chunksRes = await docChunks(repo, docId);
    if (!chunksRes.ok) continue;
    const chunks = chunksRes.result as Array<{ chunkId: string; text: string; sentences: CitableSentence[] }>;
    for (const c of chunks) {
      for (const s of c.sentences) {
        if (!wanted.has(s.id) || seen.has(s.id)) continue;
        seen.add(s.id);
        out.push({
          sentenceId: s.id,
          docName: meta?.name ?? repo,
          url: meta?.url ?? '',
          ...(s.page !== undefined ? { page: s.page } : {}),
          sentenceText: c.text.slice(s.start, s.end),
          chunkText: c.text,
          start: s.start,
          end: s.end,
        });
      }
    }
  }
  return out;
}
