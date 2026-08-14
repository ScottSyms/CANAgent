// =============================================================================
// Local-folder indexer — selects a directory (and its subfolders) and feeds the
// supported files into a "folder" repository via the background
// `add_files_to_repo` handler.
//
// NOTE: this deliberately uses the legacy `<input type="file" webkitdirectory>`
// folder chooser rather than the File System Access API (`showDirectoryPicker`).
// On some Chrome/macOS builds `showDirectoryPicker` deterministically segfaults
// the browser process the instant the picker opens; `webkitdirectory` goes
// through the ordinary file chooser and is unaffected. The tradeoff: no
// persistent directory handle, so a "Refresh" re-opens the chooser (the user
// re-selects the same folder) instead of re-syncing silently.
//
// Incremental sync: each ingested file records its relative path + mtime + size
// in the repo's DocMeta. On a refresh we skip files whose path/mtime/size are
// unchanged, re-ingest changed ones (deleting the stale doc first), and drop
// docs whose file is no longer present in the selection.
// =============================================================================

import type { AddFilesResponse, UploadFile } from '../shared/messages';
import { classifyUpload, MAX_UPLOAD_BYTES } from '../shared/uploadFile';

/** A file chosen from the folder picker, with its path relative to the root. */
export interface PickedFile {
  file: File;
  /** e.g. `Reports/2024/plan.md` — from `webkitRelativePath`. */
  path: string;
}

/** Turn a folder name into a safe repo name (the store keys repos by name). */
export function folderRepoName(rootName: string): string {
  const clean = rootName.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  return `📁 ${clean || 'folder'}`;
}

/**
 * Extract the supported files from a `<input webkitdirectory>` FileList, keeping
 * each file's folder-relative path and reporting the picked root folder's name.
 */
export function filesFromList(list: FileList | File[]): { rootName: string; files: PickedFile[] } {
  const files: PickedFile[] = [];
  let rootName = '';
  for (const file of Array.from(list)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (!rootName && rel.includes('/')) rootName = rel.split('/')[0];
    if (!classifyUpload(file.name)) continue; // skip unsupported types
    files.push({ file, path: rel });
  }
  return { rootName: rootName || 'folder', files };
}

// ----- drag-and-drop folder ingestion (no native picker) -----
// Dropping a folder gives DataTransferItems whose `webkitGetAsEntry()` yields a
// FileSystemEntry tree we can recurse — entirely client-side, never opening the
// OS directory panel that crashes Chrome on some macOS builds.

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?(onok: (f: File) => void, onerr?: (e: unknown) => void): void;
  createReader?(): { readEntries(onok: (entries: FsEntry[]) => void, onerr?: (e: unknown) => void): void };
}

type DirReader = { readEntries(onok: (entries: FsEntry[]) => void, onerr?: (e: unknown) => void): void };

// readEntries returns at most ~100 entries per call; pump until it returns none.
function readAllEntries(reader: DirReader): Promise<FsEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FsEntry[] = [];
    const pump = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(out);
        else {
          out.push(...batch);
          pump();
        }
      }, reject);
    pump();
  });
}

async function walkEntry(entry: FsEntry, acc: PickedFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((res, rej) => entry.file!(res, rej));
    if (classifyUpload(file.name)) acc.push({ file, path: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory && entry.createReader) {
    const entries = await readAllEntries(entry.createReader());
    for (const e of entries) await walkEntry(e, acc);
  }
}

/**
 * Build the picked-file list from a drop's DataTransferItems. The
 * `webkitGetAsEntry()` calls run synchronously (before any await) because the
 * items are only valid during the drop event; recursion then proceeds async.
 */
export async function filesFromDataTransfer(items: DataTransferItemList): Promise<{ rootName: string; files: PickedFile[] }> {
  const roots: FsEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = (items[i] as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  const files: PickedFile[] = [];
  let rootName = '';
  for (const r of roots) {
    if (!rootName && r.isDirectory) rootName = r.name;
    await walkEntry(r, files);
  }
  return { rootName: rootName || 'folder', files };
}

// ----- a doc as the index already knows it (from repo_docs) -----

export interface IndexedDoc {
  id: string;
  path?: string;
  mtime?: number;
  size?: number;
}

export interface FolderSyncProgress {
  phase: 'scanning' | 'indexing' | 'done';
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  failed: number;
  /**
   * Subset of `failed` that couldn't be read at all — typically OneDrive /
   * SharePoint "online-only" (Files On-Demand) placeholders that throw
   * NotReadableError when the dragged reference is touched. Tracked separately so
   * the UI can explain the cause and how to fix it.
   */
  unreadable: number;
  /** Most recent file path touched, for a live status line. */
  current?: string;
}

/** A read failed because the file's bytes aren't actually local (cloud stub). */
function isUnreadable(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotReadableError' || name === 'NotFoundError') return true;
  return /could not be read|not be read|permission/i.test(String((e as { message?: string })?.message ?? e));
}

/**
 * Read a cloud-backed file, retrying once. OneDrive/SharePoint online-only files
 * throw NotReadableError on first touch while the OS hydrates them on demand; a
 * brief pause and a second attempt often succeeds once the download lands.
 */
async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (!isUnreadable(e)) throw e;
    await new Promise((r) => setTimeout(r, 800));
    return read();
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function toUploadFile(
  w: PickedFile,
): Promise<UploadFile | { error: string; name: string; unreadable?: boolean }> {
  const kind = classifyUpload(w.file.name, w.file.type);
  if (!kind) return { error: 'unsupported type', name: w.path };
  if (w.file.size > MAX_UPLOAD_BYTES) return { error: 'too large', name: w.path };
  const base = { name: w.file.name, path: w.path, mtime: w.file.lastModified, size: w.file.size };
  try {
    if (kind === 'text') return { ...base, kind, text: await readWithRetry(() => w.file.text()) };
    return { ...base, kind, dataUrl: await readWithRetry(() => readAsDataUrl(w.file)) };
  } catch (e) {
    return { error: String((e as { message?: string })?.message ?? e), name: w.path, unreadable: isUnreadable(e) };
  }
}

// Files ready to store are grouped into batches of this size before sending
// `add_files_to_repo`, instead of one message (and one repo store write) per
// file — the store write itself is now O(1) amortized per file within a
// batch (see repoStore.repoAddBatch), so a large folder no longer costs O(N²)
// as sync progresses.
const INGEST_BATCH_SIZE = 15;

async function ingestBatch(repo: string, payloads: UploadFile[]): Promise<boolean[]> {
  const back = (await chrome.runtime.sendMessage({
    type: 'add_files_to_repo',
    repo,
    files: payloads,
    kind: 'folder',
  })) as AddFilesResponse;
  return payloads.map((_, i) => Boolean(back?.results?.[i]?.ok));
}

async function deleteDoc(repo: string, docId: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'repo_doc_delete', repo, docId });
}

/**
 * Bring `repo` into sync with the picked file set. `existing` is the repo's
 * current docs (from `repo_docs`); unchanged files are skipped, changed files
 * are re-ingested, and docs whose file is absent from the selection are removed.
 */
export async function syncFolderFiles(
  repo: string,
  picked: PickedFile[],
  existing: IndexedDoc[],
  onProgress?: (p: FolderSyncProgress) => void,
): Promise<FolderSyncProgress> {
  const prog: FolderSyncProgress = { phase: 'indexing', added: 0, updated: 0, skipped: 0, removed: 0, failed: 0, unreadable: 0 };
  const byPath = new Map<string, IndexedDoc>();
  for (const d of existing) if (d.path) byPath.set(d.path, d);
  const seen = new Set<string>();

  // Files ready to store, batched — flushed at INGEST_BATCH_SIZE and at the end.
  const pending: Array<{ payload: UploadFile; isUpdate: boolean }> = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const oks = await ingestBatch(repo, pending.map((p) => p.payload));
    pending.forEach(({ isUpdate }, i) => {
      if (oks[i]) isUpdate ? prog.updated++ : prog.added++;
      else prog.failed++;
    });
    pending.length = 0;
  };

  for (const w of picked) {
    seen.add(w.path);
    const prior = byPath.get(w.path);
    if (prior && prior.mtime === w.file.lastModified && prior.size === w.file.size) {
      prog.skipped++;
      onProgress?.({ ...prog, current: w.path });
      continue;
    }
    onProgress?.({ ...prog, current: w.path });
    const payload = await toUploadFile(w);
    if ('error' in payload) {
      prog.failed++;
      if (payload.unreadable) prog.unreadable++;
      onProgress?.({ ...prog, current: w.path });
      continue;
    }
    if (prior) await deleteDoc(repo, prior.id); // re-ingest cleanly
    pending.push({ payload, isUpdate: Boolean(prior) });
    if (pending.length >= INGEST_BATCH_SIZE) {
      await flush();
      onProgress?.({ ...prog, current: w.path });
    }
  }
  await flush();
  onProgress?.({ ...prog, current: picked[picked.length - 1]?.path });

  // Drop docs whose file is no longer in the selection.
  for (const d of existing) {
    if (d.path && !seen.has(d.path)) {
      await deleteDoc(repo, d.id);
      prog.removed++;
    }
  }

  prog.phase = 'done';
  onProgress?.(prog);
  return prog;
}
