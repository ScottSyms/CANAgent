import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RepoDoc, RepoInfo, WikiFileResult } from '../shared/messages';
import { saveFile } from './download';
import {
  filesFromDataTransfer,
  filesFromList,
  folderRepoName,
  syncFolderFiles,
  type FolderSyncProgress,
  type IndexedDoc,
  type PickedFile,
} from './folderIndex';
import { MailboxSection } from './MailboxSection';
import { RepoUpload } from './RepoUpload';
import { SharePointSection } from './SharePointSection';
import { UploadBanner } from './UploadBanner';
import { useT } from './i18n';

// Coalesce per-file progress callbacks to ~5/sec. A folder with hundreds of
// files would otherwise fire a synchronous state update (→ Preact re-render →
// paint → compositor work) per file, churning the GPU compositor. The terminal
// 'done' update always passes through so the final count is never dropped.
function throttleProgress(
  fn: (p: FolderSyncProgress) => void,
  everyMs = 200,
): (p: FolderSyncProgress) => void {
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (p.phase === 'done' || now - last >= everyMs) {
      last = now;
      fn(p);
    }
  };
}

function summarizeSync(t: ReturnType<typeof useT>, p: FolderSyncProgress): string {
  const base = t('repos.folder.synced', {
    added: String(p.added),
    updated: String(p.updated),
    skipped: String(p.skipped),
    removed: String(p.removed),
    failed: String(p.failed),
  });
  // Most folder-index failures in practice are OneDrive/SharePoint online-only
  // files; tell the user how to make them indexable rather than leaving a bare
  // "N failed" count.
  return p.unreadable > 0 ? `${base} ${t('repos.folder.unreadableHint', { n: String(p.unreadable) })}` : base;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

const FILE_GLYPH = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

type RepoTab = 'repos' | 'upload' | 'folder' | 'm365';
const REPO_TABS: ReadonlyArray<[RepoTab, string, string]> = [
  ['repos', 'repos.tabRepos', '📚'],
  ['upload', 'repos.tabUpload', '📤'],
  ['folder', 'repos.tabFolder', '📁'],
  ['m365', 'repos.tabM365', '🏢'],
];

export function RepositoriesSection() {
  const t = useT();
  const [subTab, setSubTab] = useState<RepoTab>('repos');
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [repoFilter, setRepoFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [docs, setDocs] = useState<RepoDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docFilter, setDocFilter] = useState('');
  const [banner, setBanner] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState<string | null>(null);
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [wikiBusy, setWikiBusy] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = (await chrome.runtime.sendMessage({ type: 'repo_list' })) as RepoInfo[];
      setRepos(Array.isArray(list) ? list : []);
    } catch {
      setRepos([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const filteredRepos = useMemo(() => {
    const q = repoFilter.trim().toLowerCase();
    return q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;
  }, [repos, repoFilter]);

  const filteredDocs = useMemo(() => {
    const q = docFilter.trim().toLowerCase();
    return q ? docs.filter((d) => (d.name || d.url).toLowerCase().includes(q)) : docs;
  }, [docs, docFilter]);

  const loadDocs = async (repo: string) => {
    setDocsLoading(true);
    try {
      const list = (await chrome.runtime.sendMessage({ type: 'repo_docs', repo })) as RepoDoc[];
      setDocs(Array.isArray(list) ? list : []);
    } catch {
      setDocs([]);
    }
    setDocsLoading(false);
  };

  const toggle = async (repo: string) => {
    if (expanded === repo) {
      setExpanded(null);
      setDocs([]);
      setDocFilter('');
      return;
    }
    setExpanded(repo);
    setDocFilter('');
    await loadDocs(repo);
  };

  const remove = async (name: string) => {
    await chrome.runtime.sendMessage({ type: 'repo_delete', repo: name });
    if (expanded === name) {
      setExpanded(null);
      setDocs([]);
    }
    void load();
  };

  const removeDoc = async (repo: string, docId: string) => {
    await chrome.runtime.sendMessage({ type: 'repo_doc_delete', repo, docId });
    await loadDocs(repo);
    void load(); // refresh doc/chunk counts
  };

  const generateWiki = async (repo: string, lang: 'en' | 'fr') => {
    setBanner(null);
    setWikiBusy(`${repo}:${lang}`);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'generate_wiki_from_repo', repo, lang })) as WikiFileResult;
      if (!res?.ok || !res.dataBase64 || !res.filename) {
        setBanner(t('repos.wikiError', { msg: res?.error ?? 'unknown error' }));
        return;
      }
      saveFile(base64ToBlob(res.dataBase64, res.mimeType ?? 'text/html'), res.filename);
      setBanner(t('repos.wikiDone'));
    } catch (e) {
      setBanner(t('repos.wikiError', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setWikiBusy(null);
    }
  };

  // Shared indexer: sync `files` into `repo` (re-fetching existing docs when this
  // is a refresh of an existing folder repo) and report progress.
  const indexFiles = async (repo: string, files: PickedFile[], busyKey: string, isRefresh: boolean) => {
    if (files.length === 0) {
      setFolderStatus(t('repos.folder.emptyDrop'));
      return;
    }
    setFolderBusy(busyKey);
    setFolderStatus(t('repos.folder.scanning'));
    try {
      let existing: IndexedDoc[] = [];
      if (isRefresh) {
        const docs = ((await chrome.runtime.sendMessage({ type: 'repo_docs', repo })) as RepoDoc[]) || [];
        existing = docs.map((d) => ({ id: d.id, path: d.path, mtime: d.mtime, size: d.size }));
      }
      const result = await syncFolderFiles(
        repo,
        files,
        existing,
        throttleProgress((p) =>
          setFolderStatus(p.phase === 'done' ? summarizeSync(t, p) : t('repos.folder.indexing', { file: p.current ?? '' })),
        ),
      );
      setBanner(summarizeSync(t, result));
      setFolderStatus(null);
      if (isRefresh && expanded === repo) await loadDocs(repo);
      void load();
    } catch (err) {
      setFolderStatus(t('repos.folder.error', { msg: err instanceof Error ? err.message : String(err) }));
    }
    setFolderBusy(null);
  };

  // Drag-and-drop a folder onto the drop zone — never opens the native picker.
  const onFolderDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer?.items;
    if (!items || items.length === 0) return;
    const { rootName, files } = await filesFromDataTransfer(items);
    const repo = folderRepoName(rootName);
    // Re-dropping a folder already indexed → incremental refresh (idempotent),
    // not a duplicate import.
    const exists = repos.some((r) => r.name === repo && r.kind === 'folder');
    await indexFiles(repo, files, exists ? repo : 'new', exists);
  };

  const removeFolder = async (name: string) => {
    await remove(name);
  };

  // Native folder picker (webkitdirectory) — the drag-and-drop zone below covers
  // the same ground, but a picker is the more discoverable path on its own tab.
  const onFolderPick = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const list = input.files;
    input.value = '';
    if (!list || list.length === 0) return;
    const { rootName, files } = filesFromList(list);
    const repo = folderRepoName(rootName);
    const exists = repos.some((r) => r.name === repo && r.kind === 'folder');
    await indexFiles(repo, files, exists ? repo : 'new', exists);
  };

  return (
    <details class="sites-section settings-acc" open>
      <summary class="settings-header settings-acc-summary">
        <strong>{t('repos.title')}</strong>
        <span class="sites-count">{repos.length}</span>
      </summary>
      <p class="settings-note">{t('repos.note')}</p>

      <div class="repo-subtabs">
        <div class="ws-nav" role="tablist">
          {REPO_TABS.map(([key, label, icon]) => (
            <button
              key={key}
              role="tab"
              aria-selected={subTab === key}
              class={`ws-nav-btn ${subTab === key ? 'is-active' : ''}`}
              onClick={() => setSubTab(key)}
            >
              <span aria-hidden="true">{icon}</span> {t(label)}
            </button>
          ))}
        </div>
      </div>

      {banner && <UploadBanner text={banner} onDismiss={() => setBanner(null)} />}

      {subTab === 'upload' && (
        <RepoUpload
          onDone={(s) => {
            setBanner(t('repos.upload.done', { n: String(s.added), repo: s.repo }));
            void load();
          }}
        />
      )}

      {subTab === 'folder' && (
        <>
          <p class="settings-note">{t('repos.folder.hint')}</p>
          <div class="repo-folder-row">
            <button class="btn" disabled={folderBusy !== null} onClick={() => folderInputRef.current?.click()}>
              {t('repos.folder.pick')}
            </button>
          </div>
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error webkitdirectory isn't in the DOM lib's input typings
            webkitdirectory=""
            style="display:none"
            onChange={(e) => void onFolderPick(e)}
          />
          <div
            class={`repo-folder-drop${dragOver ? ' repo-folder-drop--over' : ''}${folderBusy !== null ? ' repo-folder-drop--busy' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (folderBusy === null) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => folderBusy === null && void onFolderDrop(e)}
          >
            <strong>{folderBusy !== null ? t('repos.folder.working') : t('repos.folder.dropTitle')}</strong>
            <span class="settings-note">{t('repos.folder.dropHint')}</span>
          </div>
          {folderStatus && <p class="settings-note repo-folder-status">{folderStatus}</p>}
        </>
      )}

      {subTab === 'm365' && (
        <>
          <SharePointSection onChanged={() => void load()} />
          <MailboxSection onChanged={() => void load()} />
        </>
      )}

      {subTab === 'repos' &&
        (loading ? (
          <p class="settings-note">{t('repos.loading')}</p>
        ) : repos.length === 0 ? (
          <p class="settings-note">{t('repos.empty')}</p>
        ) : (
          <>
            {repos.length > 4 && (
              <input
                type="search"
                class="ws-memory-search repo-search"
                placeholder={t('repos.searchPlaceholder')}
                value={repoFilter}
                onInput={(e) => setRepoFilter((e.target as HTMLInputElement).value)}
              />
            )}
            {filteredRepos.length === 0 ? (
              <p class="settings-note">{t('repos.noMatches', { q: repoFilter })}</p>
            ) : (
              <ul class="ws-item-list">
                {filteredRepos.map((r) => (
                  <li key={r.name} class="ws-item ws-item--stack">
                    <div class="repo-item-head">
                      <div class="ws-item-main">
                        <button
                          class="repo-toggle ws-item-title"
                          title={expanded === r.name ? t('repos.hideDocs') : t('repos.showDocs')}
                          onClick={() => toggle(r.name)}
                        >
                          <span aria-hidden="true">{expanded === r.name ? '▾' : '▸'}</span> {r.name}
                        </button>
                        <span class="ws-item-meta">
                          {r.docs} {t('repos.docs')}, {r.chunks} {t('repos.chunks')}
                          {r.kind === 'folder' && folderBusy === r.name ? ` · ${t('repos.folder.refresh')} ⏳` : ''}
                        </span>
                      </div>
                      <div class="ws-item-actions">
                        <button
                          class="btn btn-small"
                          title={t('repos.wikiEnHint')}
                          disabled={wikiBusy !== null}
                          onClick={() => void generateWiki(r.name, 'en')}
                        >
                          {wikiBusy === `${r.name}:en` ? '…' : t('repos.wikiEn')}
                        </button>
                        <button
                          class="btn btn-small"
                          title={t('repos.wikiFrHint')}
                          disabled={wikiBusy !== null}
                          onClick={() => void generateWiki(r.name, 'fr')}
                        >
                          {wikiBusy === `${r.name}:fr` ? '…' : t('repos.wikiFr')}
                        </button>
                        <button
                          class="icon-btn"
                          aria-label={t('repos.deleteRepo')}
                          title={t('repos.deleteRepo')}
                          onClick={() => (r.kind === 'folder' ? removeFolder(r.name) : remove(r.name))}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    {expanded === r.name && (
                      <div class="repo-docs-panel">
                        {docs.length > 6 && (
                          <input
                            type="search"
                            class="ws-memory-search repo-search"
                            placeholder={t('repos.docSearchPlaceholder')}
                            value={docFilter}
                            onInput={(e) => setDocFilter((e.target as HTMLInputElement).value)}
                          />
                        )}
                        {docsLoading ? (
                          <p class="settings-note">{t('repos.loading')}</p>
                        ) : docs.length === 0 ? (
                          <p class="settings-note">{t('repos.noDocs')}</p>
                        ) : filteredDocs.length === 0 ? (
                          <p class="settings-note">{t('repos.noDocMatches', { q: docFilter })}</p>
                        ) : (
                          <ul class="ws-item-list">
                            {filteredDocs.map((d) => (
                              <li key={d.id} class="ws-item ws-item--nested" title={d.url}>
                                <span class="ws-file-glyph ws-file-glyph--sm" aria-hidden="true">
                                  {FILE_GLYPH}
                                </span>
                                <div class="ws-item-main">
                                  <span class="ws-item-title">{d.name || hostOf(d.url)}</span>
                                  <span class="ws-item-meta">
                                    {hostOf(d.url)} · {d.chunkCount} {t('repos.chunks')}
                                  </span>
                                </div>
                                <div class="ws-item-actions">
                                  <button
                                    class="icon-btn"
                                    aria-label={t('repos.deleteDoc')}
                                    title={t('repos.deleteDoc')}
                                    onClick={() => removeDoc(r.name, d.id)}
                                  >
                                    ✕
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        ))}
    </details>
  );
}
