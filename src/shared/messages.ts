// =============================================================================
// Message protocol — the typed contract between the side panel (UI) and the
// background service worker. Three channels:
//   - `SidebarCommand`: UI → background over the long-lived Port (user actions).
//   - `BackgroundEvent`: background → UI over the same Port (state/streaming).
//   - `RuntimeRequest` + matching responses: one-shot request/response calls
//     via `chrome.runtime.sendMessage` (test connection, transcription, repos).
// Plus the offscreen-document request/response shapes for PDF/Office/RAG work.
//
// Keeping these as discriminated unions means the `switch` statements in
// `serviceWorker.ts` and `Sidebar.tsx` are exhaustively type-checked.
// =============================================================================

import type {
  AgentStatus,
  ChatMessageView,
  ConversationLabel,
  PlanView,
  Settings,
  TabContextSummary,
  ToolActivity,
} from './types';
import type { EventTrigger } from './eventTriggers';
import type { Workflow } from './workflows';

/** Commands sent from the sidebar to the background over a long-lived port. */
export type SidebarCommand =
  | { type: 'user_message'; text: string; mentions?: Array<{ kind: 'bookmark' | 'repo'; value: string }> }
  | { type: 'stop_task' }
  | { type: 'clear_conversation' }
  | { type: 'undo_exchange' }
  | { type: 'start_learn_mode' }
  | { type: 'stop_learn_mode' }
  | { type: 'load_conversation'; id: string }
  | { type: 'delete_conversation'; id: string }
  // `record` is a conversation body already validated by parseConversationFile in
  // the UI; typed as unknown to avoid leaking the background StoredConversation type.
  // `labels` carries any label definitions bundled in the file so the runtime can
  // re-register them on import (best-effort portability).
  | { type: 'import_conversation'; record: unknown; labels?: ConversationLabel[] }
  | { type: 'clear_conversations' }
  | { type: 'set_conversation_labels'; id: string; labels: string[] }
  | { type: 'distill_skill' }
  | { type: 'dismiss_distill' }
  | { type: 'pause_agent' }
  | { type: 'resume_agent' }
  | { type: 'approval_response'; requestId: string; approved: boolean; rememberForSession?: boolean }
  | { type: 'include_active_tab' }
  | { type: 'include_all_tabs' }
  | { type: 'refresh_context' }
  | { type: 'attach_snapshot'; dataUrl: string; title: string; url: string }
  | { type: 'discard_snapshots' }
  | { type: 'capture_page' }
  | { type: 'capture_to_repo'; repo: string; scope: 'tab' | 'group' }
  | { type: 'get_state' }
  | { type: 'ping' };

/** Context about a capability's trust level and auth status for approval UX. */
export interface ApprovalContext {
  /** Tool name being approved (e.g. "call_mcp_tool"). */
  toolName: string;
  /** Capability kind when the tool is sourced from a registered capability. */
  capabilityKind?: string;
  /** Capability name when the tool is sourced from a registered capability. */
  capabilityName?: string;
  /** Trust level of the sourcing capability, if applicable. */
  trustLevel?: string;
  /** Auth method of the sourcing capability, if applicable. */
  authMethod?: string;
  /** Whether auth credentials are configured for this capability. */
  authConfigured: boolean;
}

/** Events pushed from the background to every connected sidebar. */
export type BackgroundEvent =
  | { type: 'chat_message'; message: ChatMessageView }
  | { type: 'status'; status: AgentStatus; detail?: string }
  | { type: 'tool_activity'; activity: ToolActivity }
  | { type: 'approval_request'; requestId: string; description: string; detail: string; approvalContext?: ApprovalContext }
  | { type: 'auth_required'; origin: string; message: string }
  | { type: 'permission_required'; origin: string; message: string }
  | { type: 'context_update'; summary: TabContextSummary | null }
  | { type: 'pending_snapshots'; thumbs: string[] }
  | { type: 'plan_update'; plan: PlanView | null }
  | { type: 'distill_offer'; available: boolean }
  | { type: 'undo_available'; available: boolean }
  | { type: 'undo_done'; restoredText: string }
  | { type: 'error'; message: string }
  | {
      type: 'full_state';
      status: AgentStatus;
      messages: ChatMessageView[];
      activities: ToolActivity[];
      context: TabContextSummary | null;
      pendingApproval: { requestId: string; description: string; detail: string; approvalContext?: ApprovalContext } | null;
      authNotice: { origin: string; message: string } | null;
      permissionNotice: { origin: string; message: string } | null;
      pendingSnapshots: string[];
      plan: PlanView | null;
      canDistill: boolean;
      canUndo: boolean;
    };

/** One-shot messages handled by chrome.runtime.onMessage. */
export type RuntimeRequest =
  | { type: 'test_connection'; settings: Settings }
  | { type: 'repo_list' }
  | { type: 'repo_delete'; repo: string }
  | { type: 'repo_docs'; repo: string }
  | { type: 'repo_doc_delete'; repo: string; docId: string }
  | { type: 'repo_export' }
  | { type: 'repo_import'; repos: ExportedRepo[] }
  | { type: 'add_files_to_repo'; repo: string; files: UploadFile[]; kind?: RepoKind }
  // Connect (if needed) and index the user's Office 365 mailbox into a repo via
  // Microsoft Graph; incremental on repeat. Handled in the service worker.
  | { type: 'index_mailbox'; repo: string }
  | { type: 'mailbox_connected' }
  | { type: 'mailbox_disconnect' }
  | { type: 'index_sharepoint_library'; repo: string; libraryUrl: string }
  | { type: 'sharepoint_session'; base?: string }
  | { type: 'transcribe_audio'; audioDataUrl: string }
  | { type: 'learn_record_event'; event: import('./learning').LearnEvent }
  // Probe the signed-in environment (M365 identity, open work systems, locale) to
  // populate memory; only honored when the memory feature is enabled.
  | { type: 'probe_environment' }
  // Graph memory management for the Workspace Memory page and the sidebar's
  // Memory section (add covers manual entries and the environment probe).
  | { type: 'memory_graph_get' }
  | { type: 'memory_graph_add'; text: string; source?: string }
  | { type: 'memory_graph_confirm'; id: string }
  | { type: 'memory_graph_update'; id: string; text: string }
  | { type: 'memory_graph_delete'; id: string }
  // Project CRUD + the single active-project pointer. Scoping is a filter, not a
  // partition — see shared/types.ts Project and shared/memoryGraph.ts visibleToProject.
  | { type: 'project_list' }
  | { type: 'project_get_active' }
  | { type: 'project_create'; name: string; color?: string }
  | { type: 'project_update'; id: string; name?: string; color?: string }
  | { type: 'project_delete'; id: string }
  | { type: 'project_set_active'; id: string | null }
  // Agent platform: the pre-existing scheduled-task system (previously
  // tool-only, no UI) plus the two Phase 6 additions — Workflows (named
  // ordered skill chains) and Event triggers (fire an unattended run on a
  // matching navigation). Firing either reuses AgentRuntime.runScheduledTask,
  // so the existing unattended-approval gate applies unchanged.
  | { type: 'scheduled_tasks_get' }
  | { type: 'scheduled_runs_get' }
  | { type: 'scheduled_task_set_enabled'; id: string; enabled: boolean }
  | { type: 'scheduled_task_delete'; id: string }
  | { type: 'workflow_list' }
  | { type: 'workflow_create'; name: string; skillNames: string[]; description?: string }
  | { type: 'workflow_update'; id: string; patch: Partial<Pick<Workflow, 'name' | 'description' | 'skillNames'>> }
  | { type: 'workflow_delete'; id: string }
  | { type: 'event_trigger_list' }
  | {
      type: 'event_trigger_create';
      name: string;
      hostPattern: string;
      target: EventTrigger['target'];
      cooldownMinutes?: number;
      matchSubPages?: boolean;
    }
  | {
      type: 'event_trigger_update';
      id: string;
      patch: Partial<Pick<EventTrigger, 'name' | 'hostPattern' | 'target' | 'cooldownMinutes' | 'enabled' | 'matchSubPages'>>;
    }
  | { type: 'event_trigger_delete'; id: string }
  | { type: 'trigger_runs_get' }
  // Products: durable OPFS-backed outputs from scheduled tasks/triggers (see
  // productStore.ts) — the service worker owns the offscreen document, so it
  // routes these for the Workspace Products page.
  | { type: 'products_list' }
  | { type: 'product_get'; id: string }
  | { type: 'product_delete'; id: string }
  | { type: 'products_export' }
  | { type: 'products_import'; products: ExportedProduct[] };

/** One picked file on its way into a repository (see shared/uploadFile.ts). */
export interface UploadFile {
  name: string;
  kind: 'text' | 'pdf' | 'office';
  /** Set for `kind:'text'` — the file's text content. */
  text?: string;
  /** Set for `kind:'pdf'|'office'` — a base64 data URL the offscreen extractor fetches. */
  dataUrl?: string;
  /** Folder ingestion: path relative to the indexed root (incremental-sync key). */
  path?: string;
  /** Folder ingestion: source file last-modified epoch ms. */
  mtime?: number;
  /** Folder ingestion: source file size in bytes. */
  size?: number;
}

/** Per-file outcome of an upload, for the uploader's file list. */
export interface AddFileResult {
  name: string;
  ok: boolean;
  chunks?: number;
  error?: string;
}

export interface AddFilesResponse {
  ok: boolean;
  results: AddFileResult[];
  error?: string;
}

export interface TestConnectionResponse {
  ok: boolean;
  detail: string;
}

export interface TranscribeResponse {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface RepoInfo {
  name: string;
  docs: number;
  chunks: number;
  /** `'folder'` for a locally-indexed directory, else page/tab captures. */
  kind?: RepoKind;
  /** Embedder the vectors were built with (e.g. `local:Xenova/all-MiniLM-L6-v2`). */
  embedModel?: string;
}

export type RepoKind = 'page' | 'folder' | 'mail' | 'sharepoint' | 'memory';

export interface RepoDoc {
  id: string;
  name: string;
  url: string;
  capturedAt: string;
  chunkCount: number;
  /** Folder repos: path relative to the indexed root. */
  path?: string;
  /** Folder repos: source file last-modified epoch ms. */
  mtime?: number;
  /** Folder repos: source file size in bytes. */
  size?: number;
}

/** A repo document with its full text reassembled from chunks — see repoAllDocsText. */
export interface RepoDocText extends RepoDoc {
  text: string;
}

/** Request to the offscreen document to parse a PDF (separate sendMessage channel). */
export interface ExtractPdfRequest {
  target: 'offscreen';
  type: 'extract_pdf';
  url: string;
  /** Slice the extracted text to this many chars (omit = whole document). */
  maxChars?: number;
}

export interface ExtractPdfResponse {
  ok: boolean;
  text?: string;
  pageCount?: number;
  truncated?: boolean;
  /** Full extracted length before any maxChars slice. */
  charCount?: number;
  error?: string;
}

export interface ExtractOfficeRequest {
  target: 'offscreen';
  type: 'extract_office';
  url: string;
  /** Slice the extracted text to this many chars (omit = whole document). */
  maxChars?: number;
}

export interface ExtractOfficeResponse {
  ok: boolean;
  text?: string;
  format?: 'docx' | 'pptx' | 'xlsx';
  truncated?: boolean;
  /** Full extracted length before any maxChars slice. */
  charCount?: number;
  error?: string;
}

/**
 * Embed text on-device with the offscreen document's transformers.js model. The
 * offscreen page has the DOM/WASM context the service worker lacks; this keeps
 * the local-RAG embedding path fully on the machine (no /embeddings egress).
 */
export interface EmbedLocalRequest {
  target: 'offscreen';
  type: 'embed_local';
  texts: string[];
  /** transformers.js model id; absent = the offscreen default. */
  model?: string;
}

export interface EmbedLocalResponse {
  ok: boolean;
  /** One vector per input text (row-aligned). */
  vectors?: number[][];
  /** The model id actually used (for the repo model-lock stamp). */
  model?: string;
  error?: string;
}

/** Ask the offscreen document to generate a binary document from markdown. */
export interface GenerateDocumentRequest {
  target: 'offscreen';
  type: 'generate_document';
  /** Output format. Only 'docx' in v1; PDF/XLSX/PPTX can extend this union. */
  format: 'docx';
  title: string;
  markdown: string;
}

export interface GenerateDocumentResponse {
  ok: boolean;
  /** Generated file bytes, base64-encoded. */
  dataBase64?: string;
  mimeType?: string;
  error?: string;
}

/** One slide for create_powerpoint. */
export interface SlideSpec {
  title?: string;
  bullets?: string[];
  notes?: string;
}

/** Ask the offscreen document to generate a .pptx from a structured slide spec. */
export interface GeneratePresentationRequest {
  target: 'offscreen';
  type: 'generate_presentation';
  title: string;
  slides: SlideSpec[];
}

/** One page of a generated wiki (source doc's title/text, plus optional grouping/link metadata). */
export interface WikiPage {
  title: string;
  /** Markdown or plain text body, rendered client-side in the generated HTML. */
  text: string;
  /** Folder-repo relative path — used to group pages into sidebar sections by top-level folder. */
  path?: string;
  /** Original source URL, shown as a footnote link on the page. */
  url?: string;
}

/** Ask the offscreen document to package a set of pages into one self-contained HTML wiki. */
export interface GenerateWikiRequest {
  target: 'offscreen';
  type: 'generate_wiki';
  title: string;
  pages: WikiPage[];
}

/** Requests to the offscreen document's OPFS RAG store. */
/** A single repository serialized for backup (vectors base64-encoded). */
export interface ExportedRepo {
  name: string;
  meta: unknown;
  chunks: unknown;
  vectorsB64: string;
}

export type RepoRequest =
  | {
      target: 'offscreen-repo';
      op: 'add';
      repo: string;
      doc: { name: string; url: string };
      chunks: string[];
      vectors: number[][];
      embedModel?: string;
      kind?: RepoKind;
      docExtra?: { path?: string; mtime?: number; size?: number };
      /** Explicit doc id (instead of an auto-generated one) — lets a caller upsert by a stable external id. */
      docId?: string;
    }
  | {
      target: 'offscreen-repo';
      op: 'search';
      repo: string;
      queryVector: number[];
      queryVectors?: number[][];
      k: number;
      embedModel?: string;
      /** Raw query text, for the lexical (BM25) half of hybrid search. */
      query?: string;
      /** Raw query variants aligned to queryVectors for multi-query lexical fusion. */
      queries?: string[];
      /** Fuse semantic + keyword (RRF). When false/absent, pure semantic. */
      hybrid?: boolean;
    }
  | { target: 'offscreen-repo'; op: 'list' }
  | { target: 'offscreen-repo'; op: 'delete'; repo: string }
  | { target: 'offscreen-repo'; op: 'docs'; repo: string }
  | { target: 'offscreen-repo'; op: 'docsText'; repo: string }
  | { target: 'offscreen-repo'; op: 'deleteDoc'; repo: string; docId: string }
  | { target: 'offscreen-repo'; op: 'export' }
  | { target: 'offscreen-repo'; op: 'import'; repos: ExportedRepo[] }
  | {
      target: 'offscreen-repo';
      op: 'addMany';
      repo: string;
      docs: Array<{
        doc: { name: string; url: string };
        chunks: string[];
        vectors: number[][];
        docExtra?: { path?: string; mtime?: number; size?: number };
        docId?: string;
      }>;
      embedModel?: string;
      kind?: RepoKind;
    };

export interface RepoResponse {
  ok: boolean;
  error?: string;
  result?: unknown;
}

// ----- Products store (offscreen document, OPFS) -----
// Durable outputs from scheduled tasks/triggers (generated files), kept
// browsable/downloadable after the run that produced them — see productStore.ts.

export interface ProductMeta {
  id: string;
  filename: string;
  mimeType: string;
  createdAt: string;
  sizeBytes: number;
  sourceTitle?: string;
  conversationId?: string;
}

/** A single product serialized for backup (blob base64-encoded). */
export interface ExportedProduct {
  meta: ProductMeta;
  dataB64: string;
}

export type ProductRequest =
  | { target: 'offscreen-product'; op: 'save'; filename: string; mimeType: string; dataBase64: string; sourceTitle?: string; conversationId?: string }
  | { target: 'offscreen-product'; op: 'list' }
  | { target: 'offscreen-product'; op: 'get'; id: string }
  | { target: 'offscreen-product'; op: 'delete'; id: string }
  | { target: 'offscreen-product'; op: 'export' }
  | { target: 'offscreen-product'; op: 'import'; products: ExportedProduct[] };

export interface ProductResponse {
  ok: boolean;
  error?: string;
  result?: unknown;
}

/** Requests handled by the injected content script. */
export type ContentRequest =
  | { kind: 'ba_ping' }
  | { kind: 'ba_extract' }
  | { kind: 'ba_app_content' }
  | { kind: 'ba_scroll_step' }
  | { kind: 'ba_element_map' }
  | { kind: 'ba_get_pointer_target' }
  | { kind: 'ba_click'; refIdOrSelector: string }
  | { kind: 'ba_fill'; refIdOrSelector: string; value: string }
  | { kind: 'ba_submit'; refIdOrSelector: string }
  | { kind: 'ba_press_keys'; combo: string; targetRef?: string }
  | { kind: 'ba_wait'; selector: string; state: 'present' | 'visible' | 'enabled'; timeoutMs: number }
  | { kind: 'ba_click_at'; x: number; y: number }
  | { kind: 'ba_drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: 'ba_wheel'; x: number; y: number; deltaY: number };
