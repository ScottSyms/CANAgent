import { useEffect, useRef, useState } from 'preact/hooks';
import type { RepoDoc, RepoInfo } from '../shared/messages';
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

type RepoTab = 'repos' | 'upload' | 'folder' | 'm365';
const REPO_TABS: ReadonlyArray<[RepoTab, string]> = [
  ['repos', 'repos.tabRepos'],
  ['upload', 'repos.tabUpload'],
  ['folder', 'repos.tabFolder'],
  ['m365', 'repos.tabM365'],
];

export function RepositoriesSection() {
  const t = useT();
  const [subTab, setSubTab] = useState<RepoTab>('repos');
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [docs, setDocs] = useState<RepoDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState<string | null>(null);
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
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
      return;
    }
    setExpanded(repo);
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

      <div class="settings-tabs" role="tablist">
        {REPO_TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={subTab === key}
            class={`settings-tab ${subTab === key ? 'is-active' : ''}`}
            onClick={() => setSubTab(key)}
          >
            {t(label)}
          </button>
        ))}
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
          <ul class="sites-list">
            {repos.map((r) => (
              <li key={r.name} class="repo-block">
                <div class="site-row">
                  <button
                    class="repo-toggle"
                    title={expanded === r.name ? t('repos.hideDocs') : t('repos.showDocs')}
                    onClick={() => toggle(r.name)}
                  >
                    {expanded === r.name ? '▾' : '▸'} {r.name}
                  </button>
                  <span class="site-desc">
                    {r.docs} {t('repos.docs')}, {r.chunks} {t('repos.chunks')}
                  </span>
                  {r.kind === 'folder' && folderBusy === r.name && <span class="site-desc" title={t('repos.folder.refresh')}>⏳</span>}
                  <button
                    class="icon-btn"
                    aria-label={t('repos.deleteRepo')}
                    title={t('repos.deleteRepo')}
                    onClick={() => (r.kind === 'folder' ? removeFolder(r.name) : remove(r.name))}
                  >
                    ✕
                  </button>
                </div>
                {expanded === r.name && (
                  <ul class="repo-docs">
                    {docsLoading ? (
                      <li class="settings-note">{t('repos.loading')}</li>
                    ) : docs.length === 0 ? (
                      <li class="settings-note">{t('repos.noDocs')}</li>
                    ) : (
                      docs.map((d) => (
                        <li key={d.id} class="repo-doc-row" title={d.url}>
                          <span class="repo-doc-name">{d.name || hostOf(d.url)}</span>
                          <span class="repo-doc-meta">
                            {hostOf(d.url)} · {d.chunkCount} {t('repos.chunks')}
                          </span>
                          <button
                            class="icon-btn"
                            aria-label={t('repos.deleteDoc')}
                            title={t('repos.deleteDoc')}
                            onClick={() => removeDoc(r.name, d.id)}
                          >
                            ✕
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ))}
    </details>
  );
}
