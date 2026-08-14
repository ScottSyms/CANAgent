// =============================================================================
// Shared domain types used across the UI, the service worker, and the offscreen
// document. Pure data shapes only — no behaviour — so both ends of the message
// protocol agree on what they're exchanging. Persisted shapes (Settings,
// SiteEntry, Skill, MemoryEntry) are also what Backup & Restore serializes.
// =============================================================================

export interface TabSummary {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  /** Chrome tab-group id, if the tab is in a group. */
  groupId?: number;
  /** Tab-group title, if the tab is in a named group. */
  group?: string;
}

export interface LinkSummary {
  text: string;
  href: string;
}

export interface HeadingSummary {
  level: number;
  text: string;
}

export type ExtractionStatus = 'ok' | 'partial' | 'blocked' | 'auth_required' | 'unsupported';

export interface PageContent {
  tabId: number;
  url: string;
  title: string;
  text: string;
  html?: string;
  metadata: Record<string, string>;
  links: LinkSummary[];
  headings: HeadingSummary[];
  extractionStatus: ExtractionStatus;
  capturedAt: string;
}

export interface ElementRef {
  refId: string;
  tagName: string;
  /** Effective ARIA role (explicit or implicit from the tag). */
  role?: string;
  ariaLabel?: string;
  /** Computed accessible name (accname algorithm, simplified). */
  name?: string;
  text?: string;
  /** ARIA states, e.g. ['expanded','selected','disabled']. */
  states?: string[];
  /** Nearest landmark/container, e.g. 'dialog "Compose"'. */
  group?: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
  /** Viewport-coordinate bounding box, for coordinate gestures. */
  rect?: { x: number; y: number; width: number; height: number };
}

export type AuthStatus = 'authenticated' | 'auth_required' | 'unknown' | 'blocked';

export interface AuthState {
  status: AuthStatus;
  reason?: string;
  loginUrl?: string;
  detectedProvider?: string;
}

export interface NavigationResult {
  tabId: number;
  url: string;
  title: string;
  status: 'complete' | 'timeout' | 'error';
  error?: string;
}

export interface ActionResult {
  ok: boolean;
  detail?: string;
}

export interface PageStateResult {
  tabId: number;
  state: 'complete' | 'timeout';
  url: string;
}

/** A user-curated known site (or MCP server) the agent can consult when planning tasks. */
export interface SiteEntry {
  id: string;
  name: string;
  /** Website URL. Optional when this entry is an MCP server (mcpUrl set). */
  url: string;
  description: string;
  /** Optional deep-link search URL containing a {query} placeholder. */
  searchUrlTemplate?: string;
  /** When set, this hint is an MCP server: its HTTP (Streamable-HTTP) endpoint. */
  mcpUrl?: string;
  /** Optional bearer token for the MCP server. */
  mcpToken?: string;
}

/** A reusable named procedure the agent can apply to tasks (Claude Code-style). */
export interface Skill {
  id: string;
  /** Lowercase-kebab slug; users invoke it by typing /name in the chat. */
  name: string;
  /** One-liner shown to the model in every task for auto-triggering. */
  description: string;
  /** Full markdown instructions, loaded on demand via the use_skill tool. */
  body: string;
  /**
   * Optional site binding. When set (a normalized hostname like
   * "marinetraffic.com"), the skill is an app playbook: its body auto-injects
   * whenever the active tab's host matches.
   */
  origin?: string;
  /** When true, show a quick-launch button for this skill in the toolbar. */
  showButton?: boolean;
  /** Display text for the quick-launch button; falls back to /name if empty. */
  buttonLabel?: string;
  /** Optional project scope. Unset = global (visible regardless of active project). */
  projectId?: string;
  /**
   * Semver (e.g. "1.2.0"), so a re-install (JSON/URL/zip) or a re-distillation
   * of an already-saved skill can decide whether the incoming copy is actually
   * newer rather than always blindly overwriting. Absent = untracked (the
   * historical behavior: any re-install of the same name just replaces it).
   */
  version?: string;
  /**
   * Tools/capabilities this skill's instructions call for (parsed from a
   * SKILL.md `allowed-tools:` frontmatter field, or set by the agent when it
   * distills a skill from its own tool-use transcript). Informational only —
   * shown in the editor so a user can judge a skill before trusting it; not
   * enforced as an actual permission gate (the browser's normal approval flow
   * on state-changing tools is the real gate, unaffected by this list).
   */
  declaredTools?: string[];
  /** Where this skill came from, and (reserved) a future hosted registry. */
  source?: SkillSource;
}

export interface SkillSource {
  kind: 'manual' | 'url' | 'zip' | 'generated';
  /**
   * Reserved for a future hosted skill registry — no server exists yet
   * (Phase 5 is local-install only: SKILL.md URL, zip, or agent-generated).
   */
  registryUrl?: string;
  installedAt?: string;
}

/**
 * A named workspace that scopes conversations, memory, skills, capabilities, and
 * knowledge bases. Scoping is a *filter*, not a partition: records without a
 * `projectId` stay global and remain visible under every project, so nothing
 * needs to be migrated when this feature is introduced. Stored under `ba_projects`;
 * the currently active one lives separately under `ba_active_project` (a plain id
 * string, or absent/null for "no project" — everything global-only).
 */
export interface Project {
  id: string;
  name: string;
  /** Palette key (see shared/labelColors.ts), never a raw hex. */
  color?: string;
  createdAt: string;
}

/** One durable fact about the user, kept only when memory is enabled. */
export interface MemoryEntry {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

/** One durable agent-behavior lesson learned from prior tasks. */
export interface LessonEntry {
  id: string;
  /** Concise instruction to apply on similar future tasks. */
  text: string;
  /** Keywords/phrases used to match future tasks. */
  triggers: string[];
  /** Optional normalized site host for site-specific lessons. */
  origin?: string;
  /** Tool names associated with the lesson. */
  tools?: string[];
  /** Number of times a matching lesson was reinforced/merged. */
  uses: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Default on-device embedding model (LiteRT.js): 384-d MiniLM, ~23 MB int8,
 * WebGPU-accelerated with a WASM/XNNPACK fallback. A custom conversion of
 * sentence-transformers/all-MiniLM-L6-v2 (see
 * scripts/convert-litert-embed-model/), distinct from the old
 * transformers.js/ONNX id so existing repos correctly detect the embedder
 * change and prompt a re-index instead of mixing incompatible vectors.
 * Declared here (dependency-free) so the service worker can derive the
 * embedder identity without importing the LiteRT runtime.
 */
export const DEFAULT_LOCAL_EMBED_MODEL = 'all-MiniLM-L6-v2-litert';

/**
 * Default on-device NER model (transformers.js token-classification) for the
 * graph builder's "fast tier" (no LLM calls). Multilingual (10 languages incl.
 * English and French, PER/ORG/LOC) rather than an English-only model, since
 * this app's UI itself ships bilingual EN/FR (see src/sidebar/i18n.tsx).
 */
export const DEFAULT_LOCAL_NER_MODEL = 'Xenova/bert-base-multilingual-cased-ner-hrl';

/**
 * The feature prompts a user may override (src/shared/promptDefaults.ts). Named
 * after the feature they drive, not the underlying constant, so the mapping
 * stays stable even if a background module's internal constant name changes.
 */
export type PromptKey =
  | 'notebookOverview'
  | 'graphExtraction'
  | 'graphExtractionSentence'
  | 'graphExtractionGleaning'
  | 'graphRelationTyping'
  | 'communitySummary'
  | 'studioBriefing'
  | 'studioFaq'
  | 'studioStudyGuide';

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Which wire protocol `baseUrl` speaks. `'chat-completions'` (default,
   * absent = this) covers any OpenAI-compatible /chat/completions endpoint —
   * DeepSeek, GLM, MiniMax, Kimi, Ollama, vLLM, Azure OpenAI. `'responses'` is
   * OpenAI's /responses API (GPT-5.x, Grok). `'anthropic-messages'` is
   * Anthropic's /v1/messages API (Claude, Qwen deployments that mirror it).
   * `'gemini-native'` is Gemini's generateContent endpoint. See
   * src/background/adapters/ for the per-protocol request/response translation.
   */
  protocol?: ModelProtocol;
  /** Optional Ideogram API key used by the image-generation tool. */
  ideogramApiKey?: string;
  /**
   * Azure OpenAI's required api-version (e.g. "2024-02-01"). When set, the
   * adapter switches to Azure mode for every service: it appends
   * ?api-version=… to each request URL and authenticates with the `api-key`
   * header instead of `Authorization: Bearer`. Blank = standard OpenAI shape.
   */
  apiVersion?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Override for the knowledge-graph extractor's per-window input budget
   * (chars), normally `PER_DOC_BUDGET_CHARS` in graphExtract.ts (6000).
   * Only meaningful when resolved for the `knowledgeGraph` role — shrink this
   * for a small/low-context local model so one window's input plus its
   * requested output together fit inside the model server's context window;
   * `maxTokens` alone doesn't help if the constraint is the server's total
   * context rather than the requested output length. Absent = unchanged
   * (today's default budget).
   */
  graphWindowChars?: number;
  /**
   * Knowledge-graph extraction strategy. `'window'` (default, absent = this)
   * groups many sentences into one `graphWindowChars`-sized call, same as
   * today. `'sentence'` extracts one target sentence per call, with a few
   * neighboring sentences supplied only as read-only context for resolving
   * pronouns/references — never as additional extraction targets. Bounds a
   * small model's per-call reasoning to the smallest possible unit, at the
   * cost of far more (much smaller/faster) calls per document. See
   * `graphContextBefore`/`graphContextAfter` for the neighbor-window size.
   */
  graphExtractionStrategy?: 'window' | 'sentence';
  /** Sentence-mode only: how many preceding sentences to include as context. Absent = 1. */
  graphContextBefore?: number;
  /** Sentence-mode only: how many following sentences to include as context. Absent = 1. */
  graphContextAfter?: number;
  /**
   * Window-mode only ("gleaning", GraphRAG's technique): after a window's
   * first successful extraction, send one follow-up "did you miss anything?"
   * call continuing that same exchange, to recover entities/relations a small
   * model skipped on its first pass without needing a bigger window. Adds at
   * most one extra call per window that succeeded outright (never applies to
   * a window recovered via the truncation-retry split, and never runs after a
   * failed extraction). Absent = enabled (this is worth the extra call by
   * default); set `false` to disable for a cost/latency-sensitive setup.
   */
  graphGleaningEnabled?: boolean;
  /** Default number of passages a repository search returns (search_repo k). Absent = 6. */
  repoSearchK?: number;
  /**
   * Hybrid retrieval for repository search: fuse dense semantic ranking with a
   * BM25 keyword ranking (Reciprocal Rank Fusion) so exact tokens — IDs, codes,
   * surnames — surface alongside semantic matches. Default **on**; set to
   * `false` for pure semantic search. No re-indexing needed either way.
   */
  hybridSearch?: boolean;
  /** Fuse fresh knowledge-graph evidence into hybrid repository retrieval. Default on. */
  graphAssistedSearch?: boolean;
  /**
   * Max tool-iteration steps per task (the soft budget). Absent = 20. The plan
   * extension and hard ceiling scale from it: extension = round(maxSteps/2),
   * ceiling = maxSteps * 2 — so 20 preserves the 20/10/40 defaults.
   */
  maxSteps?: number;
  /** Optional user instructions appended to the built-in system prompt. */
  systemPrompt?: string;
  /**
   * Per-feature prompt overrides — REPLACE (not append) the named default
   * prompt when set. Covers only the notebook/graph/studio synthesis prompts
   * (src/shared/promptDefaults.ts); the core agent system prompt and
   * tool-behavior prompts (rerank, query-variant, reflection) are not
   * user-editable, to avoid silently breaking tool-calling/citation behavior.
   * A blank/whitespace-only override falls back to the default.
   */
  promptOverrides?: Partial<Record<PromptKey, string>>;
  /** Optional SharePoint base URL for the cookie-auth search tool. */
  sharepointBaseUrl?: string;
  /**
   * Azure AD app **client ID** for mail/calendar/draft — Microsoft Graph OAuth
   * (auth-code + PKCE via chrome.identity). The app needs the delegated scopes
   * `Mail.Read`, `Mail.ReadWrite` (required even just to create a draft — Graph
   * has no narrower "draft only" scope), and `Calendars.Read`; in most
   * enterprise tenants this needs admin consent. Absent = mail/calendar/draft
   * and mailbox indexing are all disconnected (SharePoint/OneDrive file search
   * is unaffected — it stays on the cookie session).
   */
  graphClientId?: string;
  /** Graph OAuth tenant: `organizations` (default) or a specific tenant id. */
  graphTenant?: string;
  /**
   * Keep the mailbox repo current automatically via an hourly `chrome.alarms`
   * refresh, riding the same Graph connection as a manual index. Default
   * **off** (opt-in) — only takes effect once the mailbox has been indexed at
   * least once; a background refresh never runs the initial full index.
   * Silently no-ops (recorded, not surfaced as an error banner) if the Graph
   * connection has expired past silent refresh.
   */
  mailAutoRefresh?: boolean;
  /**
   * URL of a hosted playbook index (JSON listing installable SKILL.md files).
   * Absent = the bundled default (DEFAULT_PLAYBOOK_INDEX_URL). The App playbook
   * library polls this to offer one-click installs of remote skills.
   */
  playbookIndexUrl?: string;
  /**
   * Which embedder produces RAG vectors. `'local'` (default) runs a small
   * transformers.js model on-device in the offscreen document — nothing leaves
   * the machine. `'external'` POSTs chunk text to the configured /embeddings
   * endpoint. Switching this invalidates existing repos (different model ⇒
   * incompatible vectors), so a repo records the model it was built with and
   * refuses cross-model queries until re-indexed.
   */
  embedder?: 'local' | 'external';
  /** transformers.js model id for the local embedder. Absent = the bundled default. */
  localEmbedModel?: string;
  /** Optional separate model id for the /embeddings route (external RAG). */
  embeddingModel?: string;
  /** Optional separate endpoint base URL for embeddings; blank = use baseUrl. */
  embeddingBaseUrl?: string;
  /** Optional separate API key for embeddings; blank = use apiKey. */
  embeddingApiKey?: string;
  /** Optional speech-to-text model id for the /audio/transcriptions route (voice prompts). */
  transcriptionModel?: string;
  /** Optional separate endpoint base URL for transcription; blank = use baseUrl. */
  transcriptionBaseUrl?: string;
  /** Optional separate API key for transcription; blank = use apiKey. */
  transcriptionApiKey?: string;
  /**
   * Automatically back off and retry transient model-endpoint failures (HTTP 429
   * rate limits and transient 5xx), honoring a Retry-After header. Absent = on;
   * set false to surface those errors immediately instead.
   */
  retryOnRateLimit?: boolean;
  /**
   * Summarize old tool outputs (with a cheap model call) when compacting a long
   * conversation, instead of blanking them — preserves salient facts/URLs the
   * findings list may have missed. Absent = on; set false to skip the extra call
   * and fall back to a static placeholder.
   */
  summarizeObservations?: boolean;
  /**
   * Run one self-check pass over a tool-free final answer before accepting it,
   * giving the agent a chance to fix an incomplete or unverified result. Absent =
   * on; set false to skip the extra call and accept the first answer.
   */
  verifyAnswers?: boolean;
  /**
   * Named alternate endpoints for background/utility model calls — the main
   * chat loop always uses the top-level baseUrl/apiKey/model above. Optional;
   * absent = every role falls back to the main model (today's behavior).
   */
  modelProfiles?: ModelProfile[];
  /** Maps a non-'main' role to a `ModelProfile.id`. Absent role = falls back to main. */
  roleProfiles?: Partial<Record<Exclude<ModelRole, 'main'>, string>>;
  /**
   * Privacy gate: when true, role resolution skips any profile tagged
   * `privacyTier: 'cloud'` and falls back to the main model instead — so
   * background/reflection work never leaves the device to a hosted service
   * even if a cloud profile is assigned to that role. Absent = off.
   */
  restrictBackgroundToLocal?: boolean;
}

/**
 * What kind of call a `complete()` request represents, for routing to a
 * different `ModelProfile` than the main chat model. `'main'` is the primary
 * user-facing chat loop (plan/tool-use turns and the final answer) and is
 * never role-routed — it always uses the top-level Settings fields.
 */
export type ModelRole = 'main' | 'utility' | 'knowledgeGraph' | 'reflection' | 'plan' | 'vision';

/**
 * The wire protocol a connection (top-level Settings or a ModelProfile)
 * speaks. See the `Settings.protocol` doc comment above for what each value
 * covers and src/background/adapters/ for the implementation.
 */
export type ModelProtocol = 'chat-completions' | 'responses' | 'anthropic-messages' | 'gemini-native';

/**
 * An alternate named endpoint a role can be routed to — e.g. a small local
 * model (Ollama) for cheap background work (titles, reflection, RAG
 * paraphrase/rerank) while the main chat loop stays on a stronger model.
 * Mirrors the shape of the top-level Settings connection fields so routing
 * is a straightforward field swap (see llmProvider.ts resolveModelForRole).
 */
export interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Wire protocol this profile's baseUrl speaks. Absent = 'chat-completions' (today's behavior). */
  protocol?: ModelProtocol;
  apiVersion?: string;
  temperature?: number;
  maxTokens?: number;
  /** See Settings.graphWindowChars — only meaningful when this profile is assigned to the Knowledge Graph role. */
  graphWindowChars?: number;
  /** See Settings.graphExtractionStrategy — only meaningful when this profile is assigned to the Knowledge Graph role. */
  graphExtractionStrategy?: 'window' | 'sentence';
  /** See Settings.graphContextBefore. */
  graphContextBefore?: number;
  /** See Settings.graphContextAfter. */
  graphContextAfter?: number;
  /** See Settings.graphGleaningEnabled. */
  graphGleaningEnabled?: boolean;
  /**
   * 'local' = a private/on-device-reachable endpoint (e.g. Ollama on
   * localhost or a LAN host); 'cloud' = a hosted third-party service. Purely
   * user-declared (there's no way to verify this from the URL alone) — it
   * only feeds `restrictBackgroundToLocal`. Absent = treated as 'cloud' (the
   * conservative default: the gate only skips what it can confirm is local).
   */
  privacyTier?: 'local' | 'cloud';
  /** User-written note explaining what this profile is for. */
  description?: string;
  /** Declared model capabilities, used for UI badges and validation. */
  capabilities?: {
    vision?: boolean;
    audio?: boolean;
    video?: boolean;
  };
}

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'acting'
  | 'paused'
  | 'awaiting_approval'
  | 'auth_required'
  | 'error';

export interface ToolActivity {
  id: string;
  tool: string;
  argsSummary: string;
  status: 'running' | 'ok' | 'error' | 'denied';
  detail?: string;
  timestamp: string;
}

/** A structured table the agent produced, downloadable as CSV/JSON. */
export interface DataExport {
  title: string;
  filename: string;
  columns: string[];
  rows: string[][];
}

/**
 * A validated sentence-level citation attached to an assistant answer. Fully
 * resolved at answer time (chunk text + offsets included) so the UI can display
 * and highlight the exact supporting sentence deterministically — no second
 * search, embedding, or LLM call, and no fuzzy string matching (spec §6/§7).
 */
export interface Citation {
  /** Stable sentence id the model cited, e.g. `doc-73:c42:s3#8f31ca`. */
  sentenceId: string;
  /** Source document/page display name. */
  docName: string;
  /** Source URL (opened in a tab; `#page=N` appended when `page` is known). */
  url: string;
  /** Provenance family. Absent on legacy repository citations. */
  sourceKind?: 'repository' | 'web' | 'pdf' | 'office';
  /** 1-based page number, when the source format exposed one. */
  page?: number;
  /** The exact cited sentence (`chunkText.slice(start, end)`). */
  sentenceText: string;
  /** The full chunk the sentence lives in, for surrounding context + highlight. */
  chunkText: string;
  /** Offsets of the sentence within `chunkText`. */
  start: number;
  end: number;
}

export interface ChatMessageView {
  role: 'user' | 'assistant' | 'notice';
  text: string;
  timestamp: string;
  /** Data URLs of attached snapshot images, for thumbnail rendering. */
  images?: string[];
  /** A downloadable table attached to this message. */
  dataExport?: DataExport;
  /** A downloadable binary file (e.g. a generated .docx) attached to this message. */
  fileArtifact?: FileArtifact;
  /** Sentence-level citations the assistant referenced via [[id]] tokens in `text`. */
  citations?: Citation[];
}

/**
 * A synthesized "notebook" view of one repository (NotebookLM-style): an overview
 * of the corpus, its key topics, and starter questions. Derived from the repo's
 * documents and cached per repo; `docCount`/`chunkCount` snapshot what it was
 * generated from so the UI can detect when it is stale.
 */
export interface NotebookOverview {
  /** Optional AI-generated all-encompassing title for the notebook collection. */
  title?: string;
  overviewMarkdown: string;
  keyTopics: string[];
  suggestedQuestions: string[];
  docCount: number;
  chunkCount: number;
  /** ISO timestamp of generation. */
  generatedAt: string;
}

/** A notebook "studio" output kind (NotebookLM-style). */
export type StudioKind = 'briefing' | 'faq' | 'study_guide';

/**
 * A generated "studio" output for a notebook: grounded Markdown synthesized from
 * the repository's knowledge graph, with sentence-level citations resolved for
 * click-through (same substrate as chat answers).
 */
export interface StudioOutput {
  kind: StudioKind;
  title: string;
  /** Markdown body with inline [[sentence-id]] citation tokens. */
  markdown: string;
  citations: Citation[];
  generatedAt: string;
}

/** All studio outputs generated for one notebook (persisted per repo). */
export interface StudioDoc {
  outputs: Partial<Record<StudioKind, StudioOutput>>;
  /** Repository corpus revision these graph-derived outputs were generated from. */
  corpusRevision?: number;
}

/** A generated binary document offered to the user as a download. */
export interface FileArtifact {
  filename: string;
  mimeType: string;
  /** File bytes, base64-encoded (binary can't cross the message port directly). */
  dataBase64: string;
}

/** Element under the user's pointer (Alt+hover). */
export interface PointerTarget {
  tag: string;
  selector: string;
  text?: string;
  role?: string;
  ariaLabel?: string;
  rect?: { x: number; y: number; width: number; height: number };
  href?: string;
}

/**
 * Lightweight history-list entry for a saved conversation. Lives in the
 * `ba_conv_index` array so the History overlay can render without loading every
 * (potentially image-heavy) conversation body. The full body — including the
 * `LlmMessage[]` model context needed to resume — is keyed separately as
 * `ba_conv_<id>` and typed in storage.ts.
 */
export interface ConversationSummary {
  id: string;
  /** First user message, clipped; empty when only an image was sent. */
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Short snippet of the latest message, for the list row (fallback). */
  preview: string;
  /** Model-written 1–2 sentence summary of the conversation, shown in the list row when present. */
  summary?: string;
  /** Ids of the labels assigned to this conversation (see ConversationLabel). */
  labels?: string[];
  /** Project this conversation was started under. Unset = global/no project. */
  projectId?: string;
}

/**
 * A user-defined, colored label for organizing the History list. Stored as a
 * small registry under `ba_conv_labels`; conversations reference labels by id.
 * `color` is a palette *key* (see shared/labelColors.ts), never a raw hex, so
 * theming stays in CSS.
 */
export interface ConversationLabel {
  id: string;
  name: string;
  color: string;
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface PlanView {
  steps: { text: string; status: PlanStepStatus }[];
}

export type ContextScope = 'active' | 'selected' | 'all';

export interface TabContextSnapshot {
  snapshotId: string;
  scope: ContextScope;
  tabs: PageContent[];
  createdAt: string;
}

/** Lightweight view of the snapshot for the sidebar. */
export interface TabContextSummary {
  snapshotId: string;
  scope: ContextScope;
  createdAt: string;
  tabs: Array<{
    tabId: number;
    title: string;
    url: string;
    extractionStatus: ExtractionStatus;
    capturedAt: string;
  }>;
}
