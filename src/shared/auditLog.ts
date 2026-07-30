// =============================================================================
// Append-only audit log over OPFS. One JSONL file per conversation under
// /audit/, plus a lightweight `ba_audit_index` catalogue in chrome.storage.local
// (same catalogue pattern as ba_conv_index) so the Audit UI can list without
// opening every file. Audit is the one collection that is unbounded and
// write-once, which is exactly why it belongs in OPFS rather than a
// whole-key-rewrite storage.local blob (see specification.md §8.1/§8.2).
//
// Context-agnostic: writes come from the background service worker, reads from
// the workspace page. Both share the extension's origin, so both reach the same
// OPFS via navigator.storage — no message round-trip needed. Append-only means a
// concurrent reader always sees a valid prefix.
// =============================================================================

import type { AuditEvent } from './audit';

export interface AuditIndexEntry {
  conversationId: string;
  count: number;
  bytes: number;
  firstTs: string;
  lastTs: string;
}

const AUDIT_INDEX_KEY = 'ba_audit_index';
const AUDIT_DIR = 'audit';

function safeName(conversationId: string | null): string {
  // Conversation ids are UUIDs, but guard anyway so a stray value can't escape
  // the audit directory.
  return (conversationId ?? 'unassigned').replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function auditDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(AUDIT_DIR, { create: true });
}

/**
 * Append one event as a JSON line. Writes at the current file size with
 * `keepExistingData` (the same append idiom repoStore uses for vectors.bin), so
 * the file only ever grows. Best-effort: a failed audit write must never break
 * a tool call, so callers `void` this.
 */
export async function appendAuditEvent(event: AuditEvent): Promise<void> {
  const dir = await auditDir();
  const name = `${safeName(event.conversationId)}.jsonl`;
  const line = `${JSON.stringify(event)}\n`;
  const bytes = new TextEncoder().encode(line);

  const handle = await dir.getFileHandle(name, { create: true });
  const existing = (await handle.getFile()).size;
  const w = await handle.createWritable({ keepExistingData: true });
  await w.write({ type: 'write', position: existing, data: bytes as unknown as BufferSource });
  await w.close();

  await bumpIndex(event, bytes.byteLength);
}

async function bumpIndex(event: AuditEvent, addedBytes: number): Promise<void> {
  const id = event.conversationId ?? 'unassigned';
  const result = await chrome.storage.local.get(AUDIT_INDEX_KEY);
  const index = (result[AUDIT_INDEX_KEY] as AuditIndexEntry[] | undefined) ?? [];
  const existing = index.find((e) => e.conversationId === id);
  if (existing) {
    existing.count += 1;
    existing.bytes += addedBytes;
    existing.lastTs = event.timestamp;
  } else {
    index.push({
      conversationId: id,
      count: 1,
      bytes: addedBytes,
      firstTs: event.timestamp,
      lastTs: event.timestamp,
    });
  }
  await chrome.storage.local.set({ [AUDIT_INDEX_KEY]: index });
}

/** The audit catalogue, newest-activity-first. Read by the Audit workspace page. */
export async function getAuditIndex(): Promise<AuditIndexEntry[]> {
  const result = await chrome.storage.local.get(AUDIT_INDEX_KEY);
  const index = (result[AUDIT_INDEX_KEY] as AuditIndexEntry[] | undefined) ?? [];
  return [...index].sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
}

/** Read every event for one conversation, oldest-first. Tolerates a torn final line. */
export async function readAuditEvents(conversationId: string | null): Promise<AuditEvent[]> {
  const dir = await auditDir();
  const name = `${safeName(conversationId)}.jsonl`;
  let text: string;
  try {
    const handle = await dir.getFileHandle(name);
    text = await (await handle.getFile()).text();
  } catch {
    return []; // no file yet
  }
  const events: AuditEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      // A concurrent append can leave the last line partial; skip it.
    }
  }
  return events;
}

/** Delete one conversation's audit file and its index row (used by deleteConversation). */
export async function deleteAuditLog(conversationId: string | null): Promise<void> {
  const id = conversationId ?? 'unassigned';
  try {
    const dir = await auditDir();
    await dir.removeEntry(`${safeName(conversationId)}.jsonl`);
  } catch {
    // no file — fine
  }
  const result = await chrome.storage.local.get(AUDIT_INDEX_KEY);
  const index = (result[AUDIT_INDEX_KEY] as AuditIndexEntry[] | undefined) ?? [];
  await chrome.storage.local.set({ [AUDIT_INDEX_KEY]: index.filter((e) => e.conversationId !== id) });
}
