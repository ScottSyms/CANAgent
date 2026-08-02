import { useEffect, useRef, useState } from 'preact/hooks';
import type { ExportedRepo, RepoDoc, RepoInfo } from '../shared/messages';
import { downloadBlob } from '../sidebar/conversationExport';
import {
  filesFromDataTransfer,
  folderRepoName,
  syncFolderFiles,
  type FolderSyncProgress,
  type IndexedDoc,
  type PickedFile,
} from '../sidebar/folderIndex';
import { exportKnowledgeBaseHtml } from '../sidebar/knowledgeBaseExport';
import { GraphPanel } from '../sidebar/GraphPanel';
import { MailboxSection } from '../sidebar/MailboxSection';
import { NotebookPanel } from '../sidebar/NotebookPanel';
import { RepoUpload } from '../sidebar/RepoUpload';
import { SharePointSection } from '../sidebar/SharePointSection';
import { StudioPanel } from '../sidebar/StudioPanel';
import { UploadBanner } from '../sidebar/UploadBanner';
import type { Citation, NotebookOverview, StudioDoc } from '../shared/types';
import type { DocGraph } from '../shared/docGraph';
import { useT } from '../sidebar/i18n';

type NotebookTab = 'notebooks' | 'indexing';
type DetailSubTab = 'overview' | 'graph' | 'studio' | 'docs';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

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
  return p.unreadable > 0 ? `${base} ${t('repos.folder.unreadableHint', { n: String(p.unreadable) })}` : base;
}

function getRepoIcon(repo: RepoInfo): string {
  if (repo.kind === 'folder') return '📁';
  if (repo.name.toLowerCase().includes('sharepoint')) return '☁️';
  if (repo.name.toLowerCase().includes('mailbox') || repo.name.toLowerCase().includes('mail')) return '📧';
  return '📄';
}

function getRepoBadge(repo: RepoInfo): string {
  if (repo.kind === 'folder') return 'Local Folder';
  if (repo.name.toLowerCase().includes('sharepoint')) return 'SharePoint';
  if (repo.name.toLowerCase().includes('mailbox') || repo.name.toLowerCase().includes('mail')) return 'O365 Mailbox';
  return 'Uploaded Files';
}

export function NotebooksWorkspace() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<NotebookTab>('notebooks');
  const [selectedRepoName, setSelectedRepoName] = useState<string | null>(null);
  const [detailSubTab, setDetailSubTab] = useState<DetailSubTab>('overview');
  const [searchQuery, setSearchQuery] = useState('');
  const [docSearchQuery, setDocSearchQuery] = useState('');

  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [docs, setDocs] = useState<RepoDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [folderBusy, setFolderBusy] = useState<string | null>(null);
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const archiveInputRef = useRef<HTMLInputElement | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = (await chrome.runtime.sendMessage({ type: 'repo_list' })) as RepoInfo[];
      const repoList = Array.isArray(list) ? list : [];
      setRepos(repoList);
      
      // Auto-select first repo if none is selected
      if (repoList.length > 0) {
        setSelectedRepoName((current) => {
          if (current && repoList.some((r) => r.name === current)) return current;
          return repoList[0].name;
        });
      } else {
        setSelectedRepoName(null);
      }
    } catch {
      setRepos([]);
      setSelectedRepoName(null);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const loadDocs = async (repoName: string) => {
    setDocsLoading(true);
    try {
      const list = (await chrome.runtime.sendMessage({ type: 'repo_docs', repo: repoName })) as RepoDoc[];
      setDocs(Array.isArray(list) ? list : []);
    } catch {
      setDocs([]);
    }
    setDocsLoading(false);
  };

  useEffect(() => {
    if (selectedRepoName) {
      void loadDocs(selectedRepoName);
    } else {
      setDocs([]);
    }
  }, [selectedRepoName]);

  const selectRepo = (name: string) => {
    setSelectedRepoName(name);
  };

  const removeRepo = async (name: string) => {
    if (!confirm(`Are you sure you want to delete the notebook "${name}"?`)) return;
    await chrome.runtime.sendMessage({ type: 'repo_delete', repo: name });
    if (selectedRepoName === name) {
      setSelectedRepoName(null);
      setDocs([]);
    }
    void load();
  };

  const removeDoc = async (repoName: string, docId: string) => {
    await chrome.runtime.sendMessage({ type: 'repo_doc_delete', repo: repoName, docId });
    await loadDocs(repoName);
    void load();
  };

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
        const docsList = ((await chrome.runtime.sendMessage({ type: 'repo_docs', repo })) as RepoDoc[]) || [];
        existing = docsList.map((d) => ({ id: d.id, path: d.path, mtime: d.mtime, size: d.size }));
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
      if (isRefresh && selectedRepoName === repo) await loadDocs(repo);
      void load();
    } catch (err) {
      setFolderStatus(t('repos.folder.error', { msg: err instanceof Error ? err.message : String(err) }));
    }
    setFolderBusy(null);
  };

  const onFolderDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer?.items;
    if (!items || items.length === 0) return;
    const { rootName, files } = await filesFromDataTransfer(items);
    const repo = folderRepoName(rootName);
    const exists = repos.some((r) => r.name === repo && r.kind === 'folder');
    await indexFiles(repo, files, exists ? repo : 'new', exists);
  };

  const exportKb = async (repoName: string) => {
    setExportBusy(repoName);
    try {
      let overviewRes = (await chrome.runtime.sendMessage({ type: 'notebook_overview_get', repo: repoName })) as { ok: boolean; overview: NotebookOverview | null };
      if (!overviewRes?.overview?.title) {
        try {
          const genRes = (await chrome.runtime.sendMessage({ type: 'notebook_overview_generate', repo: repoName })) as { ok: boolean; overview?: NotebookOverview };
          if (genRes?.ok && genRes.overview) {
            overviewRes = { ok: true, overview: genRes.overview };
          }
        } catch {
          // If overview generation fails (e.g. model offline), continue with existing data
        }
      }

      const [graphRes, studioRes] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'notebook_graph_get', repo: repoName }) as Promise<{ ok: boolean; graph: DocGraph | null }>,
        chrome.runtime.sendMessage({ type: 'notebook_studio_get', repo: repoName }) as Promise<{ ok: boolean; doc: StudioDoc }>,
      ]);
      const graph = graphRes?.graph ?? null;
      const evidenceIds = graph
        ? [
            ...new Set([
              ...graph.nodes.flatMap((n: { evidenceSentenceIds: string[] }) => n.evidenceSentenceIds),
              ...graph.edges.flatMap((e: { evidenceSentenceIds: string[] }) => e.evidenceSentenceIds),
              ...(graph.communities ?? []).flatMap((c: { evidenceSentenceIds: string[] }) => c.evidenceSentenceIds),
            ]),
          ]
        : [];
      const evidenceRes = evidenceIds.length
        ? ((await chrome.runtime.sendMessage({ type: 'notebook_graph_evidence', repo: repoName, sentenceIds: evidenceIds })) as {
            ok: boolean;
            citations: Citation[];
          })
        : null;
      exportKnowledgeBaseHtml(repoName, {
        notebook: overviewRes?.overview ?? null,
        graph,
        studio: studioRes?.doc ?? null,
        graphEvidence: evidenceRes?.citations ?? [],
      });
    } finally {
      setExportBusy(null);
    }
  };

  const saveArchive = async (repoName: string) => {
    setExportBusy(repoName);
    try {
      const expRes = (await chrome.runtime.sendMessage({
        type: 'repo_export_one',
        repo: repoName,
      })) as { ok: boolean; result?: ExportedRepo };

      if (!expRes || !expRes.result) {
        setBanner(`Could not export archive for "${repoName}".`);
        return;
      }

      const archive = {
        app: 'CANChat Agent',
        kind: 'knowledge-base-archive',
        version: 1,
        exportedAt: new Date().toISOString(),
        repo: expRes.result,
      };

      const filenameSlug = repoName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'notebook';
      downloadBlob(
        JSON.stringify(archive, null, 2),
        'application/json',
        `kb-archive-${filenameSlug}.kb.json`,
      );
      setBanner(t('notebooks.archiveSaved', { name: repoName }));
    } catch (e) {
      setBanner(t('notebooks.archiveError', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setExportBusy(null);
    }
  };

  const triggerArchivePicker = () => {
    if (archiveInputRef.current) archiveInputRef.current.click();
  };

  const handleArchiveFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      let repoData: ExportedRepo | null = null;
      if (parsed && typeof parsed === 'object') {
        if (parsed.kind === 'knowledge-base-archive' && parsed.repo) {
          repoData = parsed.repo as ExportedRepo;
        } else if (parsed.name && parsed.meta && parsed.vectorsB64) {
          repoData = parsed as ExportedRepo;
        }
      }

      if (!repoData || !repoData.name) {
        setBanner(t('notebooks.archiveError', { msg: 'Invalid archive format.' }));
        return;
      }

      let targetName = repoData.name;
      if (repos.some((r) => r.name === targetName)) {
        const answer = prompt(
          `A notebook named "${targetName}" already exists. Enter a name to save it as:`,
          `${targetName} (Imported)`,
        );
        if (!answer) return; // User cancelled
        targetName = answer.trim();
      }

      const res = (await chrome.runtime.sendMessage({
        type: 'repo_import_one',
        repoData,
        targetName,
      })) as { ok: boolean; name: string };

      if (res?.ok) {
        setBanner(t('notebooks.archiveLoaded', { name: res.name || targetName }));
        await load();
        setSelectedRepoName(res.name || targetName);
        setActiveTab('notebooks');
      } else {
        setBanner(t('notebooks.archiveError', { msg: 'Failed to import repository.' }));
      }
    } catch (e) {
      setBanner(t('notebooks.archiveError', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  const handleArchiveSelect = (e: Event) => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      void handleArchiveFile(input.files[0]);
    }
    input.value = '';
  };

  const filteredRepos = repos.filter((r) =>
    r.name.toLowerCase().includes(searchQuery.trim().toLowerCase()),
  );

  const selectedRepo = repos.find((r) => r.name === selectedRepoName) ?? null;

  const filteredDocs = docs.filter((d) =>
    (d.name || d.url || '').toLowerCase().includes(docSearchQuery.trim().toLowerCase()),
  );

  const handleAsk = (_repoName: string, _question: string) => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html#chat') });
  };

  return (
    <div class="ws-notebooks-page">
      <input
        type="file"
        ref={archiveInputRef}
        accept=".kb.json,.json"
        style={{ display: 'none' }}
        onChange={handleArchiveSelect}
      />
      <header class="ws-notebooks-header">
        <h2>{t('repos.title')}</h2>
        <p class="settings-note">{t('repos.note')}</p>
        <div class="ws-nav" style={{ marginTop: '12px' }}>
          <button
            class={`ws-nav-btn ${activeTab === 'notebooks' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('notebooks')}
          >
            {t('notebooks.tabNotebooks')}{repos.length > 0 ? ` (${repos.length})` : ''}
          </button>
          <button
            class={`ws-nav-btn ${activeTab === 'indexing' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('indexing')}
          >
            {t('notebooks.tabIndexing')}
          </button>
        </div>
      </header>

      {banner && <UploadBanner text={banner} onDismiss={() => setBanner(null)} />}

      {activeTab === 'indexing' && (
        <div class="ws-indexing-grid">
          <div class="ws-indexing-card">
            <h3>📁 Local Files & Folders</h3>
            <p class="settings-note">Add individual files or drop an entire folder to embed on-device.</p>
            <RepoUpload
              onDone={(s) => {
                setBanner(t('repos.upload.done', { n: String(s.added), repo: s.repo }));
                void load();
              }}
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
          </div>

          <div class="ws-indexing-card">
            <h3>☁️ SharePoint & OneDrive</h3>
            <p class="settings-note">Index team document libraries directly into searchable notebooks.</p>
            <SharePointSection onChanged={() => void load()} />
          </div>

          <div class="ws-indexing-card">
            <h3>📧 Office 365 Mailbox</h3>
            <p class="settings-note">Connect via Microsoft Graph to index email correspondence.</p>
            <MailboxSection onChanged={() => void load()} />
          </div>

          <div class="ws-indexing-card">
            <h3>📥 Knowledge Base Archive</h3>
            <p class="settings-note">Restore or import a shared .kb.json notebook archive file.</p>
            <div class="repo-folder-row" style={{ marginTop: '8px' }}>
              <button class="btn btn-primary" onClick={triggerArchivePicker}>
                Choose .kb.json Archive…
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'notebooks' && (
        <div class="ws-notebook-layout">
          {/* Master List Column */}
          <aside class="ws-notebook-master">
            <div class="ws-notebook-master-head">
              <input
                type="text"
                class="ws-notebook-search"
                placeholder="Filter notebooks…"
                value={searchQuery}
                onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
              />
              <button
                class="btn btn-small btn-primary"
                title="Add new sources"
                onClick={() => setActiveTab('indexing')}
              >
                + Add
              </button>
              <button
                class="btn btn-small"
                title="Reload/Import a .kb.json notebook archive"
                onClick={triggerArchivePicker}
              >
                📥 Reload
              </button>
            </div>

            {loading ? (
              <p class="settings-note" style={{ padding: '12px' }}>{t('repos.loading')}</p>
            ) : repos.length === 0 ? (
              <div class="ws-empty-state" style={{ padding: '16px', textAlign: 'center' }}>
                <p class="settings-note">{t('repos.empty')}</p>
                <button
                  class="btn btn-small btn-primary"
                  style={{ marginTop: '10px' }}
                  onClick={() => setActiveTab('indexing')}
                >
                  + Ingest Sources &rarr;
                </button>
              </div>
            ) : filteredRepos.length === 0 ? (
              <p class="settings-note" style={{ padding: '12px' }}>No matching notebooks found.</p>
            ) : (
              <ul class="ws-notebook-list">
                {filteredRepos.map((r) => {
                  const isSelected = r.name === selectedRepoName;
                  return (
                    <li key={r.name}>
                      <button
                        class={`ws-notebook-card ${isSelected ? 'is-active' : ''}`}
                        onClick={() => selectRepo(r.name)}
                      >
                        <span class="ws-notebook-card-icon">{getRepoIcon(r)}</span>
                        <div class="ws-notebook-card-info">
                          <div class="ws-notebook-card-title">{r.name}</div>
                          <div class="ws-notebook-card-meta">
                            {r.docs} {t('repos.docs')} · {r.chunks} {t('repos.chunks')}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          {/* Detail Workspace Column */}
          <main class="ws-notebook-detail">
            {!selectedRepo ? (
              <div class="ws-placeholder">
                <p>No notebook selected. Choose one from the list or add new sources.</p>
              </div>
            ) : (
              <>
                <div class="ws-notebook-detail-header">
                  <div>
                    <div class="ws-notebook-detail-title-row">
                      <h3 class="ws-notebook-detail-title">{selectedRepo.name}</h3>
                      <span class="ws-notebook-badge">{getRepoBadge(selectedRepo)}</span>
                    </div>
                    <div class="ws-notebook-detail-meta">
                      {selectedRepo.docs} {t('repos.docs')}, {selectedRepo.chunks} {t('repos.chunks')}
                    </div>
                  </div>

                  <div class="ws-notebook-actions">
                    {selectedRepo.kind !== 'memory' && (
                      <>
                        <button
                          class="btn btn-small"
                          disabled={exportBusy === selectedRepo.name}
                          onClick={() => void saveArchive(selectedRepo.name)}
                        >
                          💾 Save Archive (.kb.json)
                        </button>
                        <button
                          class="btn btn-small"
                          disabled={exportBusy === selectedRepo.name}
                          onClick={() => void exportKb(selectedRepo.name)}
                        >
                          {exportBusy === selectedRepo.name ? 'Exporting…' : 'Export Knowledge Base (HTML)'}
                        </button>
                      </>
                    )}
                    <button
                      class="btn btn-small btn-danger"
                      onClick={() => void removeRepo(selectedRepo.name)}
                      title={t('repos.deleteRepo')}
                    >
                      Delete Notebook
                    </button>
                  </div>
                </div>

                {/* Selected Notebook Sub-Tabs */}
                {selectedRepo.kind !== 'memory' && (
                  <nav class="ws-notebook-subtabs">
                    <button
                      class={`ws-notebook-subtab ${detailSubTab === 'overview' ? 'is-active' : ''}`}
                      onClick={() => setDetailSubTab('overview')}
                    >
                      📄 Overview
                    </button>
                    <button
                      class={`ws-notebook-subtab ${detailSubTab === 'graph' ? 'is-active' : ''}`}
                      onClick={() => setDetailSubTab('graph')}
                    >
                      🕸️ Concept Graph
                    </button>
                    <button
                      class={`ws-notebook-subtab ${detailSubTab === 'studio' ? 'is-active' : ''}`}
                      onClick={() => setDetailSubTab('studio')}
                    >
                      🎓 Studio Artifacts
                    </button>
                    <button
                      class={`ws-notebook-subtab ${detailSubTab === 'docs' ? 'is-active' : ''}`}
                      onClick={() => setDetailSubTab('docs')}
                    >
                      📁 Documents ({docs.length})
                    </button>
                  </nav>
                )}

                {/* Sub-Tab Content */}
                <div class="ws-notebook-subcontent">
                  {selectedRepo.kind === 'memory' ? (
                    <p class="settings-note">Personal memory graph repository.</p>
                  ) : (
                    <>
                      {detailSubTab === 'overview' && (
                        <NotebookPanel repo={selectedRepo.name} onAsk={handleAsk} />
                      )}
                      {detailSubTab === 'graph' && <GraphPanel repo={selectedRepo.name} />}
                      {detailSubTab === 'studio' && <StudioPanel repo={selectedRepo.name} />}
                      {detailSubTab === 'docs' && (
                        <div>
                          <div style={{ marginBottom: '12px' }}>
                            <input
                              type="text"
                              class="ws-notebook-search"
                              style={{ width: '100%', maxWidth: '360px' }}
                              placeholder="Filter documents…"
                              value={docSearchQuery}
                              onInput={(e) => setDocSearchQuery((e.target as HTMLInputElement).value)}
                            />
                          </div>
                          {docsLoading ? (
                            <p class="settings-note">{t('repos.loading')}</p>
                          ) : filteredDocs.length === 0 ? (
                            <p class="settings-note">{t('repos.noDocs')}</p>
                          ) : (
                            <ul class="repo-docs" style={{ marginTop: '0' }}>
                              {filteredDocs.map((d) => (
                                <li key={d.id} class="repo-doc-row" title={d.url}>
                                  <span class="repo-doc-name">{d.name || hostOf(d.url)}</span>
                                  <span class="repo-doc-meta">
                                    {hostOf(d.url)} · {d.chunkCount} {t('repos.chunks')}
                                  </span>
                                  <button
                                    class="icon-btn"
                                    aria-label={t('repos.deleteDoc')}
                                    title={t('repos.deleteDoc')}
                                    onClick={() => void removeDoc(selectedRepo.name, d.id)}
                                  >
                                    ✕
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
