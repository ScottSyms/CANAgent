// =============================================================================
// Persistence — thin typed accessors over `chrome.storage.local` for the four
// durable collections (settings, hints/sites, skills, memory). These `ba_*`
// keys are exactly what Backup & Restore exports/imports. Everything is
// device-local and never synced; the API key in particular never leaves here.
// =============================================================================

import { pruneIndex } from '../shared/conversationMeta';
import type { CapabilityRegistryEntry } from '../shared/capabilities';
import { migrateSitesToCapabilities } from '../shared/capabilities';
import { emptyMemoryGraph, migrateFlatEntries, pruneGraph, type MemoryGraph } from '../shared/memoryGraph';
import type {
  ChatMessageView,
  ConversationLabel,
  ConversationSummary,
  LessonEntry,
  MemoryEntry,
  PlanStepStatus,
  Project,
  Settings,
  SiteEntry,
  Skill,
} from '../shared/types';
import type { LlmMessage } from './llmProvider';
import { getVaultState, isVaultUnlocked, vaultDecrypt, vaultEncrypt } from './vault';

const SETTINGS_KEY = 'ba_settings';
const SITES_KEY = 'ba_sites';
const CAPABILITIES_KEY = 'ba_capabilities';
const SKILLS_KEY = 'ba_skills';
const MEMORY_KEY = 'ba_memory';
const MEMORY_ENABLED_KEY = 'ba_memory_enabled';
const MEMORY_MIN_CONFIDENCE_KEY = 'ba_memory_min_confidence';
const MEMORY_GRAPH_KEY = 'ba_memory_graph';
const LESSONS_KEY = 'ba_lessons';
const PROJECTS_KEY = 'ba_projects';
const ACTIVE_PROJECT_KEY = 'ba_active_project';

export const LESSON_MAX_ENTRIES = 50;

// --- saved conversations (auto-history) ---------------------------------------
// One lightweight index array plus one body record per conversation. Splitting
// them keeps the History list cheap to render and lets autosave rewrite a single
// body instead of one giant blob.
export const CONVERSATION_INDEX_KEY = 'ba_conv_index';
export const CONVERSATION_KEY_PREFIX = 'ba_conv_';
export const CONVERSATION_LABELS_KEY = 'ba_conv_labels';
export const ACTIVE_CONVERSATION_KEY = 'ba_active_conversation';
export const MAX_SAVED_CONVERSATIONS = 100;

/** Storage key for a conversation body. Index entries are keyed by id alone. */
export function conversationKey(id: string): string {
  return `${CONVERSATION_KEY_PREFIX}${id}`;
}

/**
 * Full saved conversation. Carries both the visible transcript and the complete
 * `LlmMessage[]` model context, so `AgentRuntime.loadConversation` can restore
 * the agent's full memory and the user can truly continue the thread.
 */
export interface StoredConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessageView[];
  conversation: LlmMessage[];
  /** True once an LLM topic title has been generated, so autosave stops re-deriving the heuristic. */
  autoTitled?: boolean;
  /** Ids of the labels assigned to this conversation (mirrors the index entry). */
  labels?: string[];
  /** Best-effort working state, so a resumed thread keeps its plan/findings. */
  plan?: { text: string; status: PlanStepStatus }[];
  findings?: string[];
  lastTaskUrl?: string;
  /** Model-written 1–2 sentence summary, mirrored into the history index row. */
  summary?: string;
  /** Name of this conversation's tab group, so restore can recreate it by name. */
  groupName?: string;
  /** Pages in the conversation's tab group, reopened on restore so they stay queryable. */
  groupUrls?: { url: string; title: string }[];
  /** Project this conversation was started under, stamped once at creation. */
  projectId?: string;
}

// chrome.storage.local only — the API key must never sync across devices.
// When an encryption vault is configured (see vault.ts), secret fields are
// stored as `enc:v1:` envelopes; getSettings transparently decrypts them, and a
// *locked* vault yields null so the agent stays inert until the user unlocks.
// Optional per-service secret overrides, encrypted at rest alongside `apiKey`.
// `apiKey` is handled separately because it is required and drives the
// locked⇒null behavior.
export const OPTIONAL_SECRET_FIELDS = ['ideogramApiKey', 'embeddingApiKey', 'transcriptionApiKey'] as const;

export async function getSettings(): Promise<Settings | null> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = result[SETTINGS_KEY] as Settings | undefined;
  if (!settings || !settings.model) return null;
  if (settings.subscriptionProvider) {
    const out: Settings = { ...settings, apiKey: '' };
    for (const f of OPTIONAL_SECRET_FIELDS) {
      if (settings[f]) out[f] = (await vaultDecrypt(settings[f]!)) ?? undefined;
    }
    return out;
  }
  if (!settings.baseUrl || !settings.apiKey) return null;
  const apiKey = await vaultDecrypt(settings.apiKey);
  if (apiKey === null) return null; // encrypted but vault locked/erased
  const out: Settings = { ...settings, apiKey };
  for (const f of OPTIONAL_SECRET_FIELDS) {
    if (settings[f]) out[f] = (await vaultDecrypt(settings[f]!)) ?? undefined;
  }
  return out;
}

/**
 * Decrypted settings for the editor UI — no completeness gate, and it reports
 * whether the vault is locked so the form can prompt for unlock instead of
 * showing (and later overwriting) blank secrets.
 */
export async function getSettingsForEdit(): Promise<{ settings: Settings; locked: boolean }> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = (result[SETTINGS_KEY] as Settings | undefined) ?? { baseUrl: '', apiKey: '', model: '' };
  if (settings.apiKey) {
    const dec = await vaultDecrypt(settings.apiKey);
    if (dec === null) return { settings: { ...settings, apiKey: '' }, locked: true };
    settings.apiKey = dec;
  }
  for (const f of OPTIONAL_SECRET_FIELDS) {
    if (settings[f]) settings[f] = (await vaultDecrypt(settings[f]!)) ?? undefined;
  }
  return { settings, locked: false };
}

export async function saveSettings(settings: Settings): Promise<void> {
  // A locked vault must not be written through — vaultEncrypt would pass the
  // secret through in plaintext and clobber the ciphertext. Callers gate on this.
  if ((await getVaultState()) === 'locked') {
    throw new Error('The encryption vault is locked. Unlock it before saving connection settings.');
  }
  const toStore: Settings = { ...settings, apiKey: await vaultEncrypt(settings.apiKey) };
  for (const f of OPTIONAL_SECRET_FIELDS) {
    if (settings[f]) toStore[f] = await vaultEncrypt(settings[f]!);
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: toStore });
}

/**
 * Re-store the current settings so their secrets become ciphertext under a
 * newly-unlocked vault. Called right after a vault is created, to seal a key the
 * user had entered while still in plaintext.
 */
export async function sealSecretsAtRest(): Promise<void> {
  const { settings, locked } = await getSettingsForEdit();
  if (locked || !settings.apiKey) return;
  await saveSettings(settings);
}

export async function getCapabilities(): Promise<CapabilityRegistryEntry[]> {
  const result = await chrome.storage.local.get([CAPABILITIES_KEY, SITES_KEY]);
  const caps = result[CAPABILITIES_KEY];
  if (Array.isArray(caps) && caps.length > 0) return caps as CapabilityRegistryEntry[];
  const sites = result[SITES_KEY];
  if (Array.isArray(sites) && sites.length > 0) {
    const migrated = migrateSitesToCapabilities(sites as SiteEntry[]);
    await chrome.storage.local.set({ [CAPABILITIES_KEY]: migrated });
    return migrated;
  }
  return [];
}

export async function migrateLegacySites(): Promise<void> {
  const result = await chrome.storage.local.get([CAPABILITIES_KEY, SITES_KEY]);
  if (result[CAPABILITIES_KEY] !== undefined) return;
  const sites = result[SITES_KEY];
  if (!Array.isArray(sites) || sites.length === 0) return;
  const migrated = migrateSitesToCapabilities(sites as SiteEntry[]);
  await chrome.storage.local.set({ [CAPABILITIES_KEY]: migrated });
}

// --- Auth token storage (session-scoped, cleared on SW restart) ---------------

const AUTH_TOKENS_KEY = 'ba_auth_tokens';
const SESSION_APPROVALS_KEY = 'ba_session_approvals';

export async function getAuthTokens(): Promise<Record<string, string>> {
  try {
    const result = await chrome.storage.session.get(AUTH_TOKENS_KEY);
    return (result[AUTH_TOKENS_KEY] as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

// --- Session-level approval tracking (allow for session) ----------------------
// Stores tool names that the user has approved for the current session.
// Cleared on service worker restart.

export async function getSessionApprovals(): Promise<Set<string>> {
  try {
    const result = await chrome.storage.session.get(SESSION_APPROVALS_KEY);
    const arr = result[SESSION_APPROVALS_KEY] as string[] | undefined;
    return new Set(arr ?? []);
  } catch {
    return new Set();
  }
}

export async function addSessionApproval(toolName: string): Promise<void> {
  const approvals = await getSessionApprovals();
  approvals.add(toolName);
  await chrome.storage.session.set({ [SESSION_APPROVALS_KEY]: [...approvals] });
}

export async function getSkills(): Promise<Skill[]> {
  const result = await chrome.storage.local.get(SKILLS_KEY);
  const skills = result[SKILLS_KEY];
  return Array.isArray(skills) ? (skills as Skill[]) : [];
}

export async function saveSkills(skills: Skill[]): Promise<void> {
  await chrome.storage.local.set({ [SKILLS_KEY]: skills });
}

export async function getProjects(): Promise<Project[]> {
  const result = await chrome.storage.local.get(PROJECTS_KEY);
  const projects = result[PROJECTS_KEY];
  return Array.isArray(projects) ? (projects as Project[]) : [];
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
}

/** The one active project, or null when no project is active (everything global-only). */
export async function getActiveProjectId(): Promise<string | null> {
  const result = await chrome.storage.local.get(ACTIVE_PROJECT_KEY);
  const id = result[ACTIVE_PROJECT_KEY];
  return typeof id === 'string' && id ? id : null;
}

export async function setActiveProjectId(id: string | null): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_PROJECT_KEY]: id });
}

export async function getMemoryEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(MEMORY_ENABLED_KEY);
  return result[MEMORY_ENABLED_KEY] === true; // off by default
}

/**
 * The minimum confidence (0-1) an automatically-extracted candidate must meet
 * to be saved by reflection. Does not apply to explicit `save_memory` calls
 * (e.g. "remember that...") or the environment probe, which always save at
 * confidence 1. Defaults to 0 (no filtering) so existing installs keep their
 * current behavior until the user opts into a stricter bar.
 */
export async function getMemoryMinConfidence(): Promise<number> {
  const result = await chrome.storage.local.get(MEMORY_MIN_CONFIDENCE_KEY);
  const v = result[MEMORY_MIN_CONFIDENCE_KEY];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Load the graph memory store, lazily migrating the legacy flat `MemoryEntry[]`
 * (`ba_memory`) into graph nodes the first time this is called. `ba_memory`
 * itself is left untouched (read-only fallback for Backup/Restore compat with
 * older exports) — only `ba_memory_graph` is written going forward.
 */
export async function getMemoryGraph(): Promise<MemoryGraph> {
  const result = await chrome.storage.local.get([MEMORY_GRAPH_KEY, MEMORY_KEY]);
  const existing = result[MEMORY_GRAPH_KEY] as MemoryGraph | undefined;
  if (existing && Array.isArray(existing.nodes) && Array.isArray(existing.edges)) return existing;

  const flat = result[MEMORY_KEY];
  const graph: MemoryGraph = Array.isArray(flat) && flat.length > 0
    ? pruneGraph({ nodes: migrateFlatEntries(flat as MemoryEntry[]), edges: [], version: 1 })
    : emptyMemoryGraph();
  await chrome.storage.local.set({ [MEMORY_GRAPH_KEY]: graph });
  return graph;
}

export async function saveMemoryGraph(graph: MemoryGraph): Promise<void> {
  await chrome.storage.local.set({ [MEMORY_GRAPH_KEY]: pruneGraph(graph) });
}

export async function getLessons(): Promise<LessonEntry[]> {
  const result = await chrome.storage.local.get(LESSONS_KEY);
  const entries = result[LESSONS_KEY];
  return Array.isArray(entries) ? (entries as LessonEntry[]) : [];
}

export async function saveLessons(entries: LessonEntry[]): Promise<void> {
  await chrome.storage.local.set({ [LESSONS_KEY]: entries.slice(0, LESSON_MAX_ENTRIES) });
}

// --- conversation encryption at rest -----------------------------------------
// When a vault is unlocked, a conversation BODY is stored as a single `{ __enc }`
// envelope and the index's human-readable fields (title/preview/summary) are
// encrypted, so neither the transcript nor the History list leaks content on
// disk. Structural index fields (id, timestamps, counts, labels, project) stay
// plaintext so the list still renders — with "🔒 Locked" placeholders — while
// the vault is locked. No vault ⇒ everything is plaintext, exactly as before.
//
// Mutations operate on the RAW (still-encrypted) index and never decrypt-then-
// re-encrypt, so a delete/label change made while the vault is locked can't
// clobber the real (encrypted) titles with locked placeholders.

const LOCKED_PLACEHOLDER = '🔒 Locked';

interface EncryptedEnvelope {
  __enc: string;
}
function isEnvelope(v: unknown): v is EncryptedEnvelope {
  return !!v && typeof v === 'object' && typeof (v as EncryptedEnvelope).__enc === 'string';
}

/** The index exactly as stored (encrypted strings when a vault is/was active). */
async function getConversationIndexRaw(): Promise<ConversationSummary[]> {
  const result = await chrome.storage.local.get(CONVERSATION_INDEX_KEY);
  const index = result[CONVERSATION_INDEX_KEY];
  return Array.isArray(index) ? (index as ConversationSummary[]) : [];
}

async function setConversationIndexRaw(entries: ConversationSummary[]): Promise<void> {
  await chrome.storage.local.set({ [CONVERSATION_INDEX_KEY]: entries });
}

async function encryptIndexEntry(e: ConversationSummary): Promise<ConversationSummary> {
  return {
    ...e,
    title: await vaultEncrypt(e.title),
    preview: await vaultEncrypt(e.preview),
    ...(e.summary !== undefined ? { summary: await vaultEncrypt(e.summary) } : {}),
  };
}

async function decryptIndexEntry(e: ConversationSummary): Promise<ConversationSummary> {
  const title = await vaultDecrypt(e.title);
  const preview = await vaultDecrypt(e.preview);
  const summary = e.summary !== undefined ? await vaultDecrypt(e.summary) : undefined;
  return {
    ...e,
    title: title ?? LOCKED_PLACEHOLDER,
    preview: preview ?? '',
    summary: summary === null ? undefined : summary,
  };
}

async function writeConversationBody(record: StoredConversation): Promise<void> {
  const value = (await isVaultUnlocked()) ? { __enc: await vaultEncrypt(JSON.stringify(record)) } : record;
  await chrome.storage.local.set({ [conversationKey(record.id)]: value });
}

/** The History list, newest-first, with content fields decrypted for display. */
export async function getConversationIndex(): Promise<ConversationSummary[]> {
  return Promise.all((await getConversationIndexRaw()).map(decryptIndexEntry));
}

/** Load one full conversation body, decrypted. Null if missing, or if a vault-
 *  encrypted body can't be read (locked/erased). */
export async function getConversation(id: string): Promise<StoredConversation | null> {
  const key = conversationKey(id);
  const result = await chrome.storage.local.get(key);
  const raw = result[key];
  if (raw === undefined || raw === null) return null;
  if (isEnvelope(raw)) {
    const json = await vaultDecrypt(raw.__enc);
    if (json === null) return null; // vault locked or erased
    try {
      return JSON.parse(json) as StoredConversation;
    } catch {
      return null;
    }
  }
  return raw as StoredConversation; // legacy plaintext body
}

/**
 * Upsert a conversation: write its body, refresh its index entry, then prune the
 * index back to MAX_SAVED_CONVERSATIONS (deleting the evicted bodies too). The
 * caller supplies the summary fields it derived from the transcript. Reads the
 * raw index (structural fields are plaintext) and encrypts only the new entry's
 * strings, leaving other entries' stored ciphertext untouched.
 */
export async function saveConversation(
  record: StoredConversation,
  summary: Omit<ConversationSummary, 'id' | 'createdAt'>,
): Promise<void> {
  await writeConversationBody(record);

  const index = await getConversationIndexRaw();
  const existing = index.find((c) => c.id === record.id);
  const entry = await encryptIndexEntry({
    id: record.id,
    createdAt: existing?.createdAt ?? record.createdAt,
    ...summary,
    // Label assignments are owned by the UI, not the autosave summary — preserve
    // whatever is already on the index entry (or the record) so a per-turn
    // autosave of the active conversation never wipes them.
    labels: existing?.labels ?? record.labels ?? [],
    // The project a conversation was started under is stamped once and never
    // changes on later autosaves, same reasoning as labels above.
    projectId: existing?.projectId ?? record.projectId,
  });
  const next = [...index.filter((c) => c.id !== record.id), entry];
  const { kept, evicted } = pruneIndex(next, MAX_SAVED_CONVERSATIONS);
  await setConversationIndexRaw(kept);
  if (evicted.length > 0) {
    await chrome.storage.local.remove(evicted.map(conversationKey));
  }
}

/** The label registry: every user-defined label. Editable directly by the UI. */
export async function getConversationLabels(): Promise<ConversationLabel[]> {
  const result = await chrome.storage.local.get(CONVERSATION_LABELS_KEY);
  const labels = result[CONVERSATION_LABELS_KEY];
  return Array.isArray(labels) ? (labels as ConversationLabel[]) : [];
}

export async function saveConversationLabels(labels: ConversationLabel[]): Promise<void> {
  await chrome.storage.local.set({ [CONVERSATION_LABELS_KEY]: labels });
}

/**
 * Assign labels to one conversation: rewrite its index entry's `labels` and, if
 * the body record still exists, the body's `labels` too (so file export/import
 * carries the assignment). Routed through the runtime to avoid racing autosave.
 */
export async function setConversationLabels(id: string, labels: string[]): Promise<void> {
  // Operate on the raw index: labels are structural (plaintext) so this never
  // needs to touch — or risk clobbering — the encrypted title/preview/summary.
  const index = await getConversationIndexRaw();
  await setConversationIndexRaw(index.map((c) => (c.id === id ? { ...c, labels } : c)));

  // Mirror onto the body only if it is readable (writeConversationBody re-encrypts
  // it when the vault is unlocked). A locked vault skips this; the index is the
  // source of truth for display anyway.
  const body = await getConversation(id);
  if (body) {
    await writeConversationBody({ ...body, labels });
  }
}

/** Remove a conversation's body and its index entry. */
export async function deleteConversation(id: string): Promise<void> {
  const index = await getConversationIndexRaw();
  await setConversationIndexRaw(index.filter((c) => c.id !== id));
  await chrome.storage.local.remove(conversationKey(id));
}

/** The id of the conversation currently shown in the panel (restored after SW eviction). */
export async function getActiveConversationId(): Promise<string | null> {
  const r = await chrome.storage.local.get(ACTIVE_CONVERSATION_KEY);
  const v = r[ACTIVE_CONVERSATION_KEY];
  return typeof v === 'string' && v ? v : null;
}

export async function setActiveConversationId(id: string | null): Promise<void> {
  if (id) await chrome.storage.local.set({ [ACTIVE_CONVERSATION_KEY]: id });
  else await chrome.storage.local.remove(ACTIVE_CONVERSATION_KEY);
}

/** Remove every saved conversation: all body records and the index itself. */
export async function clearAllConversations(): Promise<void> {
  const index = await getConversationIndexRaw();
  await chrome.storage.local.remove([
    CONVERSATION_INDEX_KEY,
    ACTIVE_CONVERSATION_KEY,
    ...index.map((c) => conversationKey(c.id)),
  ]);
}

// --- portable backup (decrypt on export, re-encrypt on import) ----------------
// A backup must be readable on another install, so vault-encrypted content is
// decrypted on export (like the RAG store already does) and re-sealed under the
// destination's vault on import. Repos/products go through their own export/import
// paths; these two cover the conversation store.

/**
 * Conversation storage for a portable backup — index, label registry, and every
 * body, all DECRYPTED. Throws if a vault is locked, since the content can't be
 * read to make it portable.
 */
export async function exportConversationsForBackup(): Promise<Record<string, unknown>> {
  if ((await getVaultState()) === 'locked') {
    throw new Error('Unlock the encryption vault to include conversations in the backup.');
  }
  const index = await getConversationIndex(); // decrypted display fields
  const out: Record<string, unknown> = {
    [CONVERSATION_INDEX_KEY]: index,
    [CONVERSATION_LABELS_KEY]: await getConversationLabels(),
  };
  for (const entry of index) {
    const body = await getConversation(entry.id); // decrypted body
    if (body) out[conversationKey(entry.id)] = body;
  }
  return out;
}

/**
 * Restore conversations from a (plaintext, portable) backup, re-encrypting each
 * under the destination's vault when one is unlocked (saveConversation does the
 * sealing). No vault ⇒ stored plaintext, as before.
 */
export async function importConversationsFromBackup(storage: Record<string, unknown>): Promise<void> {
  const idx = storage[CONVERSATION_INDEX_KEY];
  if (!Array.isArray(idx)) return;
  const index = idx as ConversationSummary[];
  if (Array.isArray(storage[CONVERSATION_LABELS_KEY])) {
    await saveConversationLabels(storage[CONVERSATION_LABELS_KEY] as ConversationLabel[]);
  }
  for (const entry of index) {
    const body = storage[conversationKey(entry.id)] as StoredConversation | undefined;
    if (!body) continue;
    await saveConversation(body, {
      title: entry.title,
      updatedAt: entry.updatedAt,
      messageCount: entry.messageCount,
      preview: entry.preview,
      summary: entry.summary,
    });
    if (entry.labels?.length) await setConversationLabels(entry.id, entry.labels);
  }
}

/** The conversation storage keys a backup carries (so the UI can separate them
 *  from the bulk config keys it restores directly). */
export function conversationBackupKeys(storage: Record<string, unknown>): string[] {
  const idx = storage[CONVERSATION_INDEX_KEY];
  const ids = Array.isArray(idx) ? (idx as ConversationSummary[]).map((c) => conversationKey(c.id)) : [];
  return [CONVERSATION_INDEX_KEY, CONVERSATION_LABELS_KEY, ...ids];
}

/** Seed example skills on first install only (key unset). */
export async function seedSkillsIfEmpty(): Promise<void> {
  const result = await chrome.storage.local.get(SKILLS_KEY);
  if (result[SKILLS_KEY] !== undefined) return;
  const examples: Skill[] = [
    {
      id: 'skill-example-research',
      name: 'research',
      description:
        'Research a question on the web: search, read multiple sources, cross-check, and cite.',
      body: [
        '1. If a known site from the directory plausibly covers the topic, start there; otherwise call search_web with a focused query.',
        '2. Read the results page with get_tab_content and pick the 2-3 most credible, relevant results.',
        '3. Navigate to each and extract the relevant facts.',
        '4. Cross-check: note where sources agree and disagree. Do not present a single source as settled fact.',
        '5. If results are thin, refine the query once and search again before giving up.',
        '6. Answer concisely, flag uncertainty explicitly, and end with the "Source tabs:" citation list with URLs.',
      ].join('\n'),
    },
    {
      id: 'skill-example-search-sharepoint',
      name: 'search-sharepoint',
      description:
        'Search your SharePoint and OneDrive files via the microsoft365_search tool (REST over the signed-in session) — defaults to recent content files, with filters for document type, site, author, and date.',
      body: [
        'Goal: answer a SharePoint/OneDrive file question accurately using the microsoft365_search tool, which calls the SharePoint/Microsoft Search REST API over your signed-in session (no setup or token; covers SharePoint sites AND OneDrive).',
        '',
        'Step 1 — Call microsoft365_search with source:\'files\' and map the request to its parameters (let the tool build the query — do not hand-write KQL):',
        '- topic words → query',
        '- document type → fileType (docx | xlsx | pptx | pdf)',
        '- a specific site/library → sitePath (its URL, e.g. https://contoso.sharepoint.com/sites/Finance)',
        '- "files I edited" / "my files" → editedByMe:true (the tool resolves your identity)',
        '- a date window → since / until (YYYY-MM-DD); file searches default to orderBy:\'date\' (most recent first), use orderBy:\'relevance\' only when explicitly requested',
        '- how many → top (default 10, max 25)',
        '',
        'Step 2 — Resolve the site URL when the user names a site but not its address: ask, or use an open *.sharepoint.com tab. The tenant base comes from Settings or an open SharePoint tab automatically.',
        '',
        'Step 3 — Read the response: results are under "files" (or "filesError" if it failed). If filesError says there is no base URL, tell the user to set the SharePoint base URL in Settings (or open a SharePoint tab) and retry.',
        '',
        'Step 4 — If results are empty or weak, loosen once (drop fileType, or simplify the terms) and retry before reporting nothing.',
        '',
        'Step 5 — Present each hit as: **Title** (linked to its url) — file type, last modified, editor; one-line snippet. End with the standard "Source tabs:" list of the result URLs. Never invent files not in the results.',
        '',
        'Note: this is REST over your cookie session, not the Graph bearer-token API. By default it searches user-content file types (Office docs, PDFs, text/html, images, audio, video), not executables/components like DLLs. The simpler sharepoint_search tool (files only) is an alternative if needed. To read a file\'s full contents, pass its url to read_office_document or read_pdf.',
      ].join('\n'),
    },
    {
      id: 'skill-example-search-mail',
      name: 'search-mail',
      description:
        'Search your Outlook mail via the microsoft365_search endpoint tool (REST over the signed-in session) — filter by sender, time, and keywords. Use Outlook web UI only if the endpoint fails.',
      body: [
        'Goal: answer an email question using the microsoft365_search endpoint tool, which calls Outlook-on-the-web\'s REST endpoint over your signed-in session and returns messages directly (no setup or token). Do NOT open Outlook or use page automation first.',
        '',
        'Step 1 — Always call microsoft365_search with source:\'mail\' first and map the request to its parameters:',
        '- sender → from (name or email, e.g. "Brian Ray")',
        '- topic words → query (matches subject + body)',
        '- a date window → since / until (YYYY-MM-DD)',
        '- "latest" / "most recent" / "last N" → orderBy:\'date\' and top:N (e.g. top:5 for "last five")',
        '',
        'Step 2 — Read the response: messages are under "mail" (or "mailError" if it failed). Each is {subject, from, received, url, preview}.',
        '',
        'Step 3 — Present each match as: **Subject** — sender, date; one-line preview, linked to its url. End with a "Source tabs:" list of the message URLs. Never invent messages. If results are thin, loosen the query once (drop the tightest filter) and retry.',
        '',
        'Fallback — ONLY if the response has a "mailError" or session error: explain that the endpoint could not establish an Outlook/Microsoft 365 session and ask the user to sign in once, then retry. If it still fails, drive the Outlook web UI. Open https://outlook.office.com/mail/ (the task pauses for sign-in if a login wall appears; if an outlook-owa / outlook-live playbook is active, follow it). Focus the search box (press_keys "/", else fill_input it), type a keyword query (e.g. from:"Brian Ray" received>=2024-01-01), press_keys "Enter", then read the list with get_tab_content. These page actions are approval-gated — give a clear reason like "search your mailbox for X".',
      ].join('\n'),
    },
  ];
  await chrome.storage.local.set({ [SKILLS_KEY]: examples });
}
