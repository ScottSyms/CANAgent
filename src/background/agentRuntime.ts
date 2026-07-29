// =============================================================================
// AgentRuntime — the agent loop and the brain of the extension.
//
// One instance lives in the service worker (created in `serviceWorker.ts`) and
// drives a single conversation. The core is `runLoop`: it repeatedly asks the
// model (`llmProvider.complete`) what to do, executes any tool calls it returns
// (dispatching to `browserToolAdapter`, `mcpClient`, the offscreen RAG store,
// etc.), feeds the results back, and stops when the model returns a tool-free
// answer or the step budget is exhausted.
//
// Cross-cutting concerns this class owns:
//   - Working state injected into the model each step (active tab, plan,
//     findings, remaining budget) — see `buildStateBlock`/`withWorkingState`.
//   - Human-in-the-loop gates: approval for state-changing tools, pause/stop,
//     and login waits — see `executeToolCall` and the `*Wait` fields.
//   - Step budgeting to bound cost (`SOFT_STEP_BUDGET` → `HARD_STEP_CEILING`).
//   - Context compaction so long tasks don't overflow the model window.
//
// It never touches `chrome.*` for output: every UI update is emitted through the
// `emit` callback the service worker supplies (`broadcast`), keeping the runtime
// testable in principle and decoupled from the panel.
// =============================================================================

import type { ApprovalContext } from '../shared/messages';
import type { CapabilityRegistryEntry } from '../shared/capabilities';
import { isTrustedForAutoApproval, resolveAuth } from '../shared/capabilities';
import type { BackgroundEvent } from '../shared/messages';
import { MEMORY_TOOL_DEFINITIONS, TOOL_DEFINITIONS } from '../shared/schemas';
import { LANGUAGE_STORAGE_KEY, resolveLang, translate, type LangPref } from '../sidebar/i18n';
import type {
  AgentStatus,
  AuthState,
  ChatMessageView,
  PageContent,
  PlanStepStatus,
  PlanView,
  ToolActivity,
} from '../shared/types';
import type {
  ConversationLabel,
  DataExport,
  FileArtifact,
  LessonEntry,
  Settings,
  Skill,
  SkillSource,
} from '../shared/types';
import { bumpSkillVersion } from '../shared/skillImport';
import { collectGroupUrls, documentKindForUrl, hostMatches, normalizeHost } from '../shared/url';
import {
  emptyMemoryGraph,
  filterByMinConfidence,
  MEMORY_NODE_CAP,
  mergeNodes,
  nodeSimilarity,
  parseReflection,
  parseSupersedeVerdict,
  rankCoreMemoryNodes,
  renderCoreMemoryBlock,
  renderRelevantMemoryBlock,
  shouldAdjudicate,
  visibleToProject,
  type MemoryGraph,
  type MemoryNode,
  type MemoryNodeKind,
  type ParsedMemoryCandidate,
} from '../shared/memoryGraph';
import { memoryIndexRemove, memoryIndexSearch, memoryIndexUpsert, rebuildMemoryIndex } from './memoryIndex';
import { eventMatchesQuery, parseCalendarView, buildCalendarViewUrl } from '../shared/graphCalendar';
import { buildGraphDraftMessage, createMessageUrl, parseGraphDraftResponse } from '../shared/graphMail';
import type { ScheduledTaskRecurrence } from '../shared/scheduledTasks';
import * as browser from './browserToolAdapter';
import type { M365SearchFilters } from '../shared/microsoftSearch';
import { captureFullPage } from './fullPageCapture';
import { mcpCallTool, mcpListTools } from './mcpClient';
import { complete, embedChunks, embedderId, LLM_TIMEOUT_MS, resolveModelForRole, type ContentPart, type LlmMessage, type LlmToolCall } from './llmProvider';
import { deriveStepBudget, findSimilarLesson, parseLesson, parseReflectionVerdict, parseSummaryArray, relevantLessons, repairToolPairing, withMergedSystemState } from './loopHelpers';
import { generateDocument, generatePresentation, productSave, repoDeleteDoc, repoDocs, repoList, repoSearch } from './offscreenClient';
import { normalizeSlides } from '../shared/slides';
import type { SearchHit } from '../shared/vectorSearch';
import { ingestTab } from './repoIngest';
import { getAccessToken } from './graphAuth';
import { graphGet, graphPostJson } from './graphClient';
import { normalizeUrl } from '../shared/repoChunk';
import {
  addSessionApproval,
  clearAllConversations,
  deleteConversation as deleteStoredConversation,
  getActiveProjectId,
  getCapabilities,
  getConversation,
  getConversationLabels,
  getLessons,
  getMemoryEnabled,
  getMemoryGraph,
  getMemoryMinConfidence,
  getSessionApprovals,
  getSettings,
  getSkills,
  LESSON_MAX_ENTRIES,
  saveConversation,
  saveConversationLabels,
  saveLessons,
  saveMemoryGraph,
  saveSkills,
  setConversationLabels as setStoredConversationLabels,
  type StoredConversation,
} from './storage';
import { deriveSummary, deriveTitle, derivePreview, parseConversationMeta } from '../shared/conversationMeta';
import * as tabContext from './tabContextManager';
import {
  cancelScheduledTask,
  createScheduledTask,
  getScheduledTasks,
  summarizeScheduledTasks,
} from './scheduler';

const SOFT_STEP_BUDGET = 20; // default tool-iteration budget per task
const STEP_BUDGET_EXTENSION = 10; // granted when the plan still has work left
const HARD_STEP_CEILING = 40; // absolute cap to bound cost
const SITES_PROMPT_LIMIT = 25;
// LLM_TIMEOUT_MS now lives in llmProvider (applied per request attempt) and is
// imported for the "timed out" message below.
/** Resolve the UI language for background-generated notice strings. */
async function currentLang() {
  const r = await chrome.storage.local.get(LANGUAGE_STORAGE_KEY);
  return resolveLang(r[LANGUAGE_STORAGE_KEY] as LangPref | undefined);
}

const SINGLE_TAB_CHARS = 12000;
// Size cap for a downloaded generated image (was shared/dataFile's MAX_DATA_BYTES
// before the DuckDB data engine was removed).
const MAX_IMAGE_BYTES = 64 * 1024 * 1024; // 64 MB
const MULTI_TAB_CHARS = 5000;
const CONVERSATION_CHAR_BUDGET = 90000; // compact older tool output beyond this

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function normalizeCalendarDate(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function clampCalendarTop(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 25;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  const s = String(value ?? '').trim();
  return s ? [s] : [];
}

function emailBodyType(value: unknown): 'Text' | 'HTML' {
  return value === 'HTML' ? 'HTML' : 'Text';
}

function emailImportance(value: unknown): 'Low' | 'Normal' | 'High' {
  return value === 'Low' || value === 'High' ? value : 'Normal';
}

function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const raw = fenced ?? text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found.');
  return JSON.parse(raw.slice(start, end + 1));
}

function uniqueQueries(original: string, variants: unknown): string[] {
  const out: string[] = [];
  for (const q of [original, ...(Array.isArray(variants) ? variants : [])]) {
    const s = String(q ?? '').trim().replace(/\s+/g, ' ');
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}
const FINDINGS_SHOWN = 20;

// Single-word animal names for each conversation's tab group — a bilingual mix
// of English and French (Canadian wildlife), fitting the bilingual context.
const GROUP_NAMES = [
  'Wolf', 'Loutre', 'Falcon', 'Héron', 'Moose', 'Corbeau', 'Seal', 'Renard',
  'Hawk', 'Castor', 'Elk', 'Huard', 'Marten', 'Ours', 'Owl', 'Truite',
  'Badger', 'Carcajou', 'Eagle', 'Harfang', 'Otter', 'Faucon', 'Raven', 'Phoque',
  'Fox', 'Loup', 'Crane', 'Hibou', 'Bison', 'Lièvre', 'Lynx', 'Écureuil',
  'Beaver', 'Balbuzard', 'Caribou', 'Geai',
];

interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

function sanitizeTextFilename(filename: string): string {
  return filename
    .replace(/[\\/]/g, '_')
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

function mimeTypeForTextFile(filename: string): string {
  switch (fileExtension(filename)) {
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'txt':
    case 'log':
      return 'text/plain';
    case 'csv':
      return 'text/csv';
    case 'json':
      return 'application/json';
    case 'yaml':
    case 'yml':
      return 'text/yaml';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'xml':
      return 'application/xml';
    default:
      return 'text/plain';
  }
}

function imageExtensionForMimeType(mimeType: string): string {
  switch ((mimeType || '').split(';')[0].trim().toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/png':
    default:
      return 'png';
  }
}

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Tools that mutate page or browser state and therefore need user approval. */
const APPROVAL_REQUIRED = new Set([
  'click_element',
  'fill_input',
  'submit_form',
  'run_javascript', // arbitrary code in the page — always gated
  'press_keys', // keyboard input can submit/trigger — gated
  'click_at', // coordinate click can commit actions — gated
  'drag', // drag can reorder/drop — gated
  'save_app_playbook', // persists a reusable playbook — confirm before storing
  'save_as_skill', // persists a new reusable skill from this task — confirm before storing
  'get_all_tab_contents', // reading all tabs needs explicit approval per spec
  'call_mcp_tool', // invokes an external MCP method — gated like any outbound action
  'call_webmcp_tool', // invokes an in-page tool with the user's session — gated
  'draft_email', // creates a server-side Outlook draft — confirm first
  'schedule_task', // creates persistent background automation — confirm first
  'cancel_scheduled_task', // deletes persistent automation — confirm first
]);

/**
 * Tools that stay frictionless in an attended chat (not in APPROVAL_REQUIRED)
 * but must never run unattended. Empty since the DuckDB data engine (whose
 * query_data ran model-authored SQL) was removed; kept as the gate for any
 * future tool with the same "fine attended, not fine silent" shape.
 */
const UNATTENDED_BLOCKED_TOOLS = new Set<string>([]);

/** Read-only / local tools that are safe to run concurrently within one turn. */
const READ_ONLY_TOOLS = new Set([
  'list_tabs',
  'get_active_tab',
  'get_tab_content',
  'get_element_map',
  'detect_auth_state',
  'wait_for_element',
  'search_known_sites',
  'list_mcp_tools',
  'list_webmcp_tools',
  'sharepoint_search',
  'microsoft365_search',
  'calendar_search',
  'list_scheduled_tasks',
  'read_tab_group',
  'search_repo',
  'list_repos',
  'use_skill',
  'set_plan',
  'update_plan',
  'record_finding',
  'export_data',
  'create_file',
  'create_image',
  'create_word_document',
  'read_pdf',
  'read_office_document',
  'get_video_transcript',
  'read_app_content',
  'query_pointer_target',
]);

const SCOPED_SUBTASK_ALLOWED = new Set([
  'get_active_tab',
  'get_tab_content',
  'read_app_content',
  'open_url',
  'search_web',
  'read_pdf',
  'read_office_document',
  'get_video_transcript',
  'list_repos',
  'search_repo',
  'microsoft365_search',
  'calendar_search',
]);

const SCOPED_SUBTASK_TOOLS = TOOL_DEFINITIONS.filter((t) => SCOPED_SUBTASK_ALLOWED.has(t.function.name));

interface ScopedSubtaskInput {
  id: string;
  objective: string;
  tabId?: number;
  url?: string;
  context?: string;
}

interface ScopedSubtaskResult {
  id: string;
  conclusion: string;
  sources: string[];
  stepsUsed: number;
  error?: string;
}

/** Turn inserted @bookmark / #repo mentions into an explicit, act-on-it directive. */
/** Base64-encode bytes in chunks (avoids a huge spread that overflows the stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function buildMentionDirective(
  mentions?: Array<{ kind: 'bookmark' | 'repo'; value: string }>,
): string {
  if (!mentions || mentions.length === 0) return '';
  const lines = mentions.map((m) => {
    const v = m.value.replace(/"/g, '');
    return m.kind === 'repo'
      ? `- Local repository "${v}": call search_repo with repo="${v}" to answer this request; that repository is the intended source.`
      : `- Web page ${v}: open it with open_url (or navigate) and read it directly to answer — this is the exact page the user means; do not web-search for it.`;
  });
  return `\n\n[The user referenced these with @/# — act on them directly for this request:]\n${lines.join('\n')}`;
}

const SYSTEM_PROMPT = `You are a browser agent running in a Chrome extension side panel. The browser is your primary tool environment.

Decision policy:
- Answer from your own knowledge when the question is general and stable and browser access would not materially improve the answer.
- Use browser tools when the user asks about the current page, open tabs, recent or site-specific information, data on websites, or authenticated systems (Jira, dashboards, etc.).
- Whenever an operation can be done through the browser, do it through the browser.
- When the user refers to "the page", "this article", "the site", "this tab", or a web page without saying which one, assume they mean the currently active tab: call get_active_tab, then get_tab_content on it. ALWAYS fetch it fresh for each such request — do NOT reuse page text fetched earlier in the conversation, and do NOT reuse a tabId from earlier in the conversation (it may now point at a closed or different tab). If a tool reports that a tab no longer exists, do not give up — call get_active_tab to get the current tab id and retry on it. The user surfs between pages in the same tab without starting a new thread, so earlier page content in this conversation may be from a different URL than the tab now shows; the live URL is in the working-state block's "Active tab" line.

Planning multi-step tasks:
- For any task that needs more than two or three tool calls, FIRST call set_plan with an ordered list of steps. Keep exactly one step in_progress (update_plan), and mark steps done as you finish them. Revise with set_plan if the situation changes.
- Once you set a plan, EXECUTE it — do not give a final answer while it still has pending or in_progress steps. If a step turns out to be unnecessary, mark it done or skipped with update_plan first; only then answer.
- Size the plan to the actual work: use as few or as many steps as the task genuinely needs — a 2-step plan for something small, 8+ for something involved. Do NOT pad to a fixed number, and skip planning entirely for trivial one-shot tasks.
- As you discover important intermediate results, call record_finding to save them. Do not rely on scrolling back through history — older tool output gets compacted away, but findings and the plan stay in view in the working-state block.
- A live working-state block (active tab, plan, findings, step budget) is provided as a status update at the END of the conversation and refreshed every step — always read the latest one. Watch the remaining step budget and pace yourself; when it runs low, record what matters and produce your best answer.
- You can issue several independent read-only tool calls in one turn — they run in parallel (e.g. get_tab_content on several tabs at once).
- Before giving your final answer, verify the goal is actually met (re-read the page or re-check the result) rather than assuming an action worked.
- When the task is to collect structured information (one row per item, often across several pages), gather it as you go and call export_data with columns and rows — the user gets a downloadable CSV/JSON table.
- When the user wants a text or markdown file, call create_file with a filename and full content — they get a downloadable .txt/.md card.
- When the user wants a generated image, call create_image with a detailed prompt — they get a downloadable image card.
- When the user wants a Word document, report, or formatted write-up to keep, call create_word_document with a title and markdown body — they get a downloadable .docx.
- When the user wants a slide deck or presentation, call create_powerpoint with a title and an ordered slides array (each slide: title, bullets, optional speaker notes) — they get a downloadable .pptx.
Working method:
- Use search_web for open-web searches; it opens the browser's default search engine. Read the results with get_tab_content, then navigate to the most relevant result.
- Tabs you open (search_web, open_url) are collected into this conversation's named tab group. When you want to gather several pages for comparison or synthesis, open each in its own tab with open_url rather than reusing one tab with navigate. Read every page in the group at once with read_tab_group. Mention the group's name to the user when you first create it (e.g. "I've collected these in the Wolf group"); the user may later refer to the group by that name.
- For multi-source work shaped like "read/compare/summarize these pages" (roughly 3+ pages/sources), prefer run_subtasks: create one focused subtask per page/source, let each mini-loop inspect only that source, then synthesize from the compact returned conclusions. This keeps the main context clean.
- NEVER use the "site:" operator (or other search-engine operators) in a search_web query — not under any circumstances. It returns stale, poorly-ranked results. To search WITHIN a specific site, always go to the site itself: (1) if a known site has a search template for that domain, use it; (2) otherwise navigate to the site and use its own search — fill_input its search box and press_keys "Enter", or load its search URL pattern directly. search_web is only for plain open-web keyword queries with no site restriction.
- Before clicking, filling, or submitting anything, call get_element_map and act on refIds. State-changing actions require user approval; the runtime handles asking.
- Every action that needs approval (click_element, fill_input, submit_form, run_javascript, get_all_tab_contents, save_app_playbook) takes a required "reason" argument. Always set it to a clear, plain-language explanation, written for the user, of what the action does and why it helps the task — this is what they read to decide. No jargon or refIds.
- A run_javascript tool runs JavaScript in the page's own context for tasks the other tools can't express — reading app/framework state or computing over page data. It requires user approval; prefer the dedicated tools when they suffice.
- Choosing a control method: for apps with a usable JavaScript API (maps, charts), driving the page's own object via run_javascript (e.g. a Leaflet map's setView) is the most reliable — prefer it. For ordinary UI, use get_element_map (it sees into shadow DOM and same-origin iframes, and returns each element's accessible name, effective ARIA role, states, group, and rect) then click_element/fill_input on refIds. Use press_keys for Enter/shortcuts, wait_for_element before acting on content that loads asynchronously, and click_at/drag/scroll_wheel (with coordinates from element rects) for canvas or map content that has no clickable element.
- The element map is accessibility-aware: identify controls by their role + accessible name (e.g. menuitem "Insert", tab "Inbox") rather than guessing selectors — names are more stable across app updates — and use states (only expand a control that is "collapsed", etc.). This is the reliable way to operate complex apps like Office 365 / Outlook web and the menus/toolbars of Google apps.
- If get_tab_content returns little on an app page (canvas-rendered apps like Google Docs/Sheets), call read_app_content; if that also returns nothing, use snapshot + vision.
- As a last resort for an opaque page whose content none of the text tools can reach, call capture_full_page to screenshot the whole page top-to-bottom and read the frames visually. It needs a vision-capable model and is token-heavy, so try the text tools first.
- App playbooks: when you are on a site the user has taught you, its playbook appears automatically above as an "Active app playbook" — follow it to operate that app. The user teaches a new app by typing /learn, which has you explore the site and save a playbook with save_app_playbook.
- If the user explicitly asks you to save/turn the current (or a just-completed) task into a reusable skill, call save_as_skill once the task itself is done — don't call it speculatively for ordinary tasks that weren't asked to become a skill.
- If a page requires login, the task pauses automatically and the user is asked to sign in. After they resume, re-fetch the page content.
- The user may attach snapshots (screenshots of tabs). Read charts, tables, and figures directly from those images — they usually exist because DOM extraction could not see that content.
- To read a PDF — including one open in the current tab — call read_pdf, not get_tab_content; the page tools cannot see PDF text.
- To read a Microsoft Office file (.docx Word, .pptx PowerPoint, .xlsx Excel) — including one the browser just downloaded instead of displaying — call read_office_document, not get_tab_content.
- Never open_url/navigate to a URL ending in .docx/.pptx/.xlsx/.pdf — the browser downloads the file and you get nothing useful. Pass that URL to read_office_document (Office) or read_pdf (PDF) instead.
- To work with a video (YouTube or any captioned video on the page) — summarize it, answer about it, find a moment — call get_video_transcript; it reads the page's existing captions instantly. Do not try to watch or listen to the video. If it reports no captions, say so.
- Some web pages expose their own in-page tools via WebMCP (navigator.modelContext). On the active tab, call list_webmcp_tools to discover them; when one matches the task, prefer call_webmcp_tool over hand-driving the page UI.
- Local repositories: the user can save pages into named on-device repositories (OPFS). Use add_to_repo to capture the current page or this conversation's tab group into a repo, and search_repo to retrieve relevant passages from a repo and answer from them — cite each passage's page name and URL. Prefer search_repo for questions about pages the user has saved; list_repos shows what exists.
- The user can reference a repository (typing #) or a bookmarked page (typing @) in their message; when they do, an explicit instruction is attached — act on it directly: search_repo that exact repository, or open and read that exact URL rather than web-searching for it.
- Endpoint-first Microsoft 365 rule: for Outlook mail, Outlook calendar, Teams meeting, SharePoint, and OneDrive retrieval, ALWAYS use the dedicated endpoint-backed tools before browser/page automation. Do not use search_web, open_url, get_tab_content, Outlook/Office web UI playbooks, or DOM automation for these data sources unless the endpoint tool returns an explicit endpoint/auth error. Mail, calendar, and draft creation are backed by Microsoft Graph (OAuth) and need a one-time Connect in Settings → Knowledge bases → Mailbox; SharePoint/OneDrive files remain a direct cookie-session call needing no separate connect step.
- For questions about the user's own Microsoft 365 email AND/OR files, call microsoft365_search first — source ('mail'|'files'|'both'), from (sender), fileType, sitePath, editedByMe, since/until (YYYY-MM-DD), orderBy ('relevance'|'date'), top. For mail-only questions, set source:'mail'. Mail search matches on subject and sender substrings plus a date range — it does not search the message body, so a body-only phrase may miss; prefer read_office_document/read_pdf-style narrowing (recipient, subject keyword, date window) over a vague free-text query. For SharePoint/OneDrive file questions, assume the user wants the most recently modified content files unless they explicitly ask otherwise: omit orderBy or use orderBy:'date', and do not search for executables/components (the tool defaults to Office docs, PDFs, text/html, images, audio, and video unless a fileType is supplied). E.g. "last five emails from Brian Ray" → {source:'mail', from:'Brian Ray', orderBy:'date', top:5}; "the last Word file I edited on my SharePoint site" → {source:'files', fileType:'docx', editedByMe:true, top:1}. Cite each result's url. If the response has a mailError, explain that the mailbox isn't connected (or the connection expired) and ask the user to open Settings → Mailbox → Connect, then retry; only then may you fall back to the /search-mail skill or Outlook web UI. To read a file's full contents beyond its snippet, pass its url to read_office_document (Office) or read_pdf (PDFs) — do not navigate to it (that downloads it).
- For Outlook calendar/schedule/Teams meeting questions, call calendar_search first. It is the direct endpoint-backed calendar tool. Do not navigate to Outlook or use page automation for calendar reads unless calendar_search returns an explicit error. If it does (mailbox not connected or the connection expired), explain that and ask the user to open Settings → Mailbox → Connect, then retry; only then may you fall back to page automation. For meeting prep ("pull docs I need", "prep me for meetings"), first call calendar_search, then call list_repos/search_repo separately with each meeting's subject, organizer, attendees, and agenda terms; cite both meeting URLs and repository source URLs.
- When the user asks you to draft an email, use draft_email. It creates a saved Outlook draft only — it does NOT send. Never claim an email was sent. For requests to send an email, create a draft and tell the user to review/send it manually unless a future send tool exists. If it errors because the mailbox isn't connected, ask the user to open Settings → Mailbox → Connect, then retry. Always provide a clear approval reason naming the recipients and subject.
- When the user asks to schedule a future or recurring task/workflow, call schedule_task with a concrete future runAt or recurrence. Scheduled tasks run unattended in the background; they may use read-only tools, but approval-gated tools will not run unattended and will be recorded as needing approval. Use list_scheduled_tasks/cancel_scheduled_task for management.
- For files-only retrieval you can also use sharepoint_search (the simpler SharePoint-only tool): pass sortBy:'modified' + editedByMe:true for "recent files"/"files I edited"; cite the URLs.
- If a tool reports missing permissions, tell the user which sidebar button to use (e.g. "Use all tabs") and stop.

Answer format:
- Format answers in Markdown (headings, lists, tables, links) — the sidebar renders it.
- Be concise. When your answer draws on tabs or pages, end with a source list in exactly this form, one markdown link per line with the full URL:
Source tabs:
[1] [Jira - Project Board](https://jira.example.com/board)
[2] [Example News Site - Article title](https://news.example.com/article)
- For multi-tab summaries, distinguish findings common across tabs, findings unique to single tabs, and tabs that were inaccessible or blocked by authentication.`;

function formatCapability(c: CapabilityRegistryEntry): string {
  return (
    `- ${c.name} — ${c.url ?? c.mcpUrl ?? ''}\n  ${c.description}` +
    (c.searchUrlTemplate ? `\n  Search template: ${c.searchUrlTemplate}` : '')
  );
}

function capabilitiesPromptBlock(capabilities: CapabilityRegistryEntry[]): string {
  if (capabilities.length === 0) return '';
  if (capabilities.length > SITES_PROMPT_LIMIT) {
    return `\n\nKnown sites: the user maintains a directory of ${capabilities.length} known sites. When a task needs data, call search_known_sites first; prefer a matching known site over a generic web search.`;
  }
  return (
    `\n\nKnown sites — a user-curated directory of WHERE THE USER'S DATA LIVES. This is high-priority: before you call search_web, you MUST scan this list, and if any entry's description matches the data the task needs, START THERE rather than web-searching. Go to the site by navigating to its URL, or — if it has a search template — substitute {query} (URL-encoded) into the template and navigate straight to the results. Only fall back to search_web when no entry plausibly fits:\n` +
    capabilities.filter(c => c.kind === 'bookmark' || c.kind === 'mcp').map(formatCapability).join('\n')
  );
}

function skillsPromptBlock(skills: Skill[], activeHost: string): string {
  if (skills.length === 0) return '';
  // An origin-bound skill matching the current tab is an active app playbook:
  // inject its full body so the agent knows how to operate this app.
  const activePlaybooks = skills.filter((s) => s.origin && activeHost && hostMatches(activeHost, s.origin));
  let block =
    `\n\nSkills — reusable procedures the user has saved. When a task matches a skill's description, call use_skill with its name and follow the returned instructions. The user can also force one by typing /name. Teach a new app with /learn.\n` +
    skills
      .map((s) => `- ${s.name}${s.origin ? ` [app: ${s.origin}]` : ''} — ${s.description}`)
      .join('\n');
  for (const p of activePlaybooks) {
    block += `\n\nActive app playbook for ${p.origin} (you are on this site now — use it to operate the app):\n${p.body}`;
  }
  return block;
}

function lessonsPromptBlock(entries: LessonEntry[]): string {
  if (entries.length === 0) return '';
  return (
    `\n\nLessons from prior tasks — apply these when relevant, but defer to current user instructions and fresh tool output:\n` +
    entries.map((e) => `- ${e.text}${e.origin ? ` (site: ${e.origin})` : ''}`).join('\n')
  );
}

function buildLearnTask(focus: string, existing?: Skill): string {
  const existingBlock = existing
    ? `\nYou already have a playbook for this site (name: "${existing.name}"). REFINE and improve it rather than starting over, and when you save, reuse the name "${existing.name}" so it replaces the current one. Current playbook:\n${existing.body}\n`
    : '';
  return (
    `The user wants you to LEARN how to operate the web app in the current tab and save a reusable playbook. Work through these steps:\n` +
    `1. Call get_active_tab to get the current URL and host (this host is the playbook's origin).\n` +
    `2. Call get_element_map to catalog the interactive controls (search boxes, buttons, toggles).\n` +
    `3. Use run_javascript to introspect the app's live JavaScript and find objects you can drive directly. Probe for common libraries, especially maps:\n` +
    `   - Leaflet: typeof L, and objects with setView/flyTo/getCenter/getZoom.\n` +
    `   - Mapbox/MapLibre GL: objects with jumpTo/flyTo/getCenter.\n` +
    `   - OpenLayers (ol.Map) and Google Maps (google.maps.Map).\n` +
    `   - Scan window for objects exposing those methods; check __NEXT_DATA__ or framework state for data.\n` +
    `4. Call snapshot to capture the interface visually for context.\n` +
    `5. Synthesize a concise playbook: the concrete way to perform this app's key actions (navigate/pan/zoom, search, read data) using code snippets and/or element references, plus gotchas (e.g. CSP blocking eval, login required). Note which control method works best for each action — run_javascript on the app's own objects, element refs (click_element/fill_input), keyboard shortcuts (press_keys), or coordinate gestures (click_at/drag/scroll_wheel). If run_javascript is blocked by CSP, base the playbook on get_element_map + click/fill/press_keys instead.\n` +
    `6. Call save_app_playbook with the origin from step 1, a short kebab name, a one-line description, and the playbook body. The user will be asked to approve the save.\n` +
    `7. Briefly tell the user what you learned and saved.\n` +
    existingBlock +
    (focus ? `\nFocus the exploration on: ${focus}\n` : '') +
    `\nDo not perform destructive actions while exploring; prefer read-only inspection.`
  );
}

function mcpPromptBlock(capabilities: CapabilityRegistryEntry[]): string {
  const servers = capabilities.filter((c) => c.kind === 'mcp' && c.mcpUrl);
  if (servers.length === 0) return '';
  return (
    `\n\nMCP servers — tool providers the user has registered (hints with an MCP endpoint). When a task matches one, call list_mcp_tools with its name to discover its methods, then call_mcp_tool to invoke the right method (its arguments must match the method's inputSchema). Prefer these for the capabilities they describe:\n` +
    servers.map((s) => `- ${s.name} — ${s.description}`).join('\n')
  );
}

/** Resolve an MCP server reference (hint name or raw URL) to its endpoint + token. */
function resolveMcpServer(capabilities: CapabilityRegistryEntry[], server: string): { endpoint: string; token?: string } | null {
  const ref = server.trim();
  if (!ref) return null;
  const byName = capabilities.find((c) => c.kind === 'mcp' && c.mcpUrl && c.name.toLowerCase() === ref.toLowerCase());
  if (byName) return { endpoint: byName.mcpUrl!, token: byName.mcpToken };
  if (/^https?:\/\//i.test(ref)) {
    const byUrl = capabilities.find((c) => c.kind === 'mcp' && c.mcpUrl === ref);
    return { endpoint: ref, token: byUrl?.mcpToken };
  }
  return null;
}

function searchKnownSites(capabilities: CapabilityRegistryEntry[], query: string): string {
  if (capabilities.length === 0) {
    return 'The known-sites directory is empty. Fall back to search_web or ask the user.';
  }
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const scored = capabilities
    .map((c) => {
      const haystack = `${c.name} ${c.description} ${c.url ?? ''}`.toLowerCase();
      const score = terms.filter((t) => haystack.includes(t)).length;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (scored.length === 0) {
    return `No matches among ${capabilities.length} known sites. Fall back to search_web or ask the user.`;
  }
  return JSON.stringify(scored.map(({ c }) => c));
}

interface PendingApproval {
  requestId: string;
  description: string;
  detail: string;
  approvalContext?: ApprovalContext;
  resolve: (approved: boolean) => void;
}

interface AuthWait {
  origin: string;
  message: string;
  resolve: () => void;
}

interface PermissionWait {
  origin: string;
  message: string;
  resolve: () => void;
}

export class AgentRuntime {
  private conversation: LlmMessage[] = [];
  private messages: ChatMessageView[] = [];
  private activities: ToolActivity[] = [];
  private status: AgentStatus = 'idle';
  private running = false;
  private stopRequested = false;
  // Monotonic token identifying the active task. stop()/clearConversation bump
  // it to "orphan" a loop that's stuck in a non-cancellable tool call: when that
  // tool finally resolves, the loop sees a stale epoch and bails instead of
  // mutating state or continuing. This is what makes Stop / New chat reliable
  // even while a browser/network tool is hung.
  private taskEpoch = 0;
  private pauseRequested = false;
  private pauseWaiter: (() => void) | null = null;
  private pendingApproval: PendingApproval | null = null;
  private unattended = false;
  private unattendedApprovalBlocked = false;
  /** The scheduled task/trigger title driving the current unattended run, for tagging Products with their source. */
  private unattendedTaskTitle: string | null = null;
  private authWait: AuthWait | null = null;
  private permissionWait: PermissionWait | null = null;
  private abortController: AbortController | null = null;
  private pendingSnapshots: Array<{ dataUrl: string; title: string; url: string }> = [];
  // Images captured by a tool mid-task, injected as a user image message next turn.
  private pendingToolImages: string[] = [];
  private activityCounter = 0;
  // --- agent-core working state (plan, findings, step budget) ---
  private plan: PlanStep[] | null = null;
  private findings: string[] = [];
  private stepsUsed = 0;
  private stepBudget = SOFT_STEP_BUDGET;
  // Derived per task from settings.maxSteps (see deriveStepBudget); defaults reproduce
  // the historical 20/10/40 constants.
  private stepExtension = STEP_BUDGET_EXTENSION;
  private stepCeiling = HARD_STEP_CEILING;
  private toolCallCount = 0;
  // How many times the answer-verification gate has sent the task back for a fix
  // this turn. Capped at 1 so a self-check can't loop indefinitely.
  private reflectionsDone = 0;
  private reflectionIssues: string[] = [];
  // How many times the plan-execution guard has pushed the task back for trying
  // to finish over an unstarted plan. Capped at 1.
  private planNudgesDone = 0;
  // Origins we already paused on for sign-in and then resumed. If the same origin
  // still trips the auth detector after the user resumed, it is almost certainly a
  // false positive (site chrome with a "Sign in" link), so we proceed instead of
  // re-pausing — otherwise pagination loops pause/re-fetch forever, burning budget.
  private authResumedOrigins = new Set<string>();
  private canDistill = false;
  private lastUserText = '';
  private taskConversationStart = 0;
  private taskActivityStart = 0;
  private activeHost = '';
  private activeTabLabel = '';
  // Active-tab URL captured at the previous user turn, to detect navigation
  // within a thread (so the agent re-reads a tab the user has surfed away from).
  private lastTaskUrl = '';
  private systemBase = '';
  private knownSiteNames: string[] = [];
  // The active project (if any), read once per user turn (see handleUserMessage).
  // Scopes which capabilities/skills/memory nodes are visible and which project
  // a newly-created conversation/memory/skill gets stamped with. A filter, not a
  // partition — see shared/memoryGraph.ts visibleToProject.
  private activeProjectId: string | null = null;
  // Graph memory loaded for the current task (mirrors systemBase's lifecycle:
  // loaded once per task, mutated in place by save/update/delete_memory and by
  // reflection, and persisted back to storage after each mutation).
  private memoryGraph: MemoryGraph = emptyMemoryGraph();
  // Working-state (relevant-subgraph) tier: computed once per user turn (not
  // per agent step) and appended to the mutable trailing message, never the
  // byte-stable systemBase — see runLoop and buildStateBlock.
  private relevantMemoryBlock = '';
  // Per-conversation tab group (reset only on clearConversation).
  private groupName: string | null = null;
  private groupId: number | null = null;
  // Stable id for the conversation currently in memory. Allocated on the first
  // user message after a clear/load, reused across turns so autosave updates one
  // record. Null means "the next message starts a fresh history entry".
  private currentConversationId: string | null = null;
  // Stamped once at conversation creation from the then-active project; never
  // changed on later turns, even if the user switches projects mid-thread.
  private currentConversationProjectId: string | undefined = undefined;
  private conversationCreatedAt = '';
  // Conversation title state. `titleIsAuto` flips true once an LLM topic title
  // has been generated, locking it; until then autosave uses the heuristic and
  // each settled turn retries generation (so a failed offline attempt recovers).
  private currentConversationTitle: string | null = null;
  private titleIsAuto = false;
  // Model-written summary for the history list, plus the message count when it
  // was last generated (so it's refreshed only after the thread grows). Unlike
  // the title, the summary is regenerated as the conversation evolves.
  private currentConversationSummary: string | null = null;
  private summaryAtCount = 0;
  private metaInFlight = false;
  // Label ids assigned to the active conversation. Kept in memory so a per-turn
  // autosave re-emits them on the record; the UI mutates them via
  // `setConversationLabels`.
  private currentConversationLabels: string[] = [];
  // Per-turn checkpoints for "Undo last exchange": each entry records the array
  // lengths (and working state) just before a user turn, so undo can truncate
  // both threads back to that point. In-memory only — cleared on new/load/import
  // and lost on service-worker eviction (undo is a live-session affordance).
  private undoStack: Array<{
    conv: number;
    msgs: number;
    plan: PlanStep[] | null;
    findings: string[];
    lastTaskUrl: string;
  }> = [];

  constructor(private emit: (event: BackgroundEvent) => void) {}

  // ----- state for newly connected sidebars -----

  fullState(): BackgroundEvent {
    return {
      type: 'full_state',
      status: this.status,
      messages: this.messages,
      activities: this.activities.slice(-50),
      context: tabContext.toSummary(tabContext.getSnapshot()),
      pendingApproval: this.pendingApproval
        ? {
            requestId: this.pendingApproval.requestId,
            description: this.pendingApproval.description,
            detail: this.pendingApproval.detail,
            approvalContext: this.pendingApproval.approvalContext,
          }
        : null,
      authNotice: this.authWait ? { origin: this.authWait.origin, message: this.authWait.message } : null,
      permissionNotice: this.permissionWait
        ? { origin: this.permissionWait.origin, message: this.permissionWait.message }
        : null,
      pendingSnapshots: this.pendingSnapshots.map((s) => s.dataUrl),
      plan: this.planView(),
      canDistill: this.canDistill,
      canUndo: this.undoStack.length > 0,
    };
  }

  private emitUndoState(): void {
    this.emit({ type: 'undo_available', available: this.undoStack.length > 0 });
  }

  private planView(): PlanView | null {
    return this.plan ? { steps: this.plan.map((s) => ({ text: s.text, status: s.status })) } : null;
  }

  attachSnapshot(dataUrl: string, title: string, url: string): void {
    this.pendingSnapshots.push({ dataUrl, title, url });
    this.emit({ type: 'pending_snapshots', thumbs: this.pendingSnapshots.map((s) => s.dataUrl) });
    this.pushChat({
      role: 'notice',
      text: `Snapshot of "${title}" attached — it will be sent with your next message.`,
      timestamp: new Date().toISOString(),
      images: [dataUrl],
    });
  }

  discardSnapshots(): void {
    if (this.pendingSnapshots.length === 0) return;
    this.pendingSnapshots = [];
    this.emit({ type: 'pending_snapshots', thumbs: [] });
    this.notice('Snapshots discarded.');
  }

  // ----- sidebar commands -----

  /**
   * Entry point for a user turn (called by the service worker on a
   * `user_message` command). Rejects if a task is already running, expands any
   * leading `/skill` slash command and inserted @/# mentions into the task
   * text, records the user message, then hands off to `runLoop`. The `mentions`
   * come from the composer's bookmark/repository chips and become explicit
   * directives so the agent acts on the exact target the user picked.
   */
  async handleUserMessage(
    text: string,
    mentions?: Array<{ kind: 'bookmark' | 'repo'; value: string }>,
  ): Promise<void> {
    if (this.running) {
      this.emit({ type: 'error', message: 'A task is already running. Stop it first or wait for it to finish.' });
      return;
    }
    const settings = await getSettings();
    if (!settings) {
      this.emit({
        type: 'error',
        message: 'No model configured. Open Settings and enter an endpoint, API key, and model first.',
      });
      return;
    }
    this.activeProjectId = await getActiveProjectId();

    // Slash-command skill invocation: /name [args] forces a skill.
    let taskText = text;
    const slash = /^\/([a-z0-9-]+)\s*([\s\S]*)$/i.exec(text.trim());
    if (slash) {
      const skills = this.scopedSkills(await getSkills());
      const name = slash[1].toLowerCase();
      // Built-in /learn: explore the current app and save an origin-scoped playbook.
      if (name === 'learn' && !skills.some((s) => s.name.toLowerCase() === 'learn')) {
        // Find an existing playbook for the current site so /learn refines it
        // instead of creating a duplicate.
        let existing: Skill | undefined;
        try {
          const host = normalizeHost((await browser.getActiveTab()).url);
          existing = skills.find((s) => s.origin && hostMatches(host, s.origin));
        } catch {
          // No active tab; proceed without an existing playbook.
        }
        taskText = buildLearnTask(slash[2].trim(), existing);
      } else {
        const skill = skills.find((s) => s.name.toLowerCase() === name);
        if (!skill) {
          const available =
            ['/learn', ...skills.map((s) => `/${s.name}`)].join(', ');
          this.emit({
            type: 'error',
            message: `No skill named "/${slash[1]}". Available: ${available}`,
          });
          return;
        }
        taskText =
          `The user invoked the skill "${skill.name}". Skill instructions:\n${skill.body}\n\n` +
          `User input: ${slash[2].trim() || '(none)'}`;
      }
    }

    // Inserted @bookmark / #repo mentions become an explicit directive so the
    // agent acts on them directly (open that page / search that repo).
    const directive = buildMentionDirective(mentions);
    if (directive) taskText += directive;

    // Consume any pending snapshots: shown on the user's message and sent
    // to the model as image content parts.
    const snapshots = this.pendingSnapshots;
    this.pendingSnapshots = [];
    if (snapshots.length > 0) this.emit({ type: 'pending_snapshots', thumbs: [] });

    // Open a new history entry on the first message of a conversation; later
    // turns reuse the same id so autosave updates one growing record.
    if (!this.currentConversationId) {
      this.currentConversationId = crypto.randomUUID();
      this.currentConversationProjectId = this.activeProjectId ?? undefined;
      this.conversationCreatedAt = new Date().toISOString();
      this.currentConversationTitle = null;
      this.titleIsAuto = false;
      this.currentConversationSummary = null;
      this.summaryAtCount = 0;
      this.currentConversationLabels = [];
    }

    // Checkpoint the thread BEFORE this turn so "Undo last exchange" can roll it
    // back. Captures the prior end-of-turn lengths and working state (plan,
    // findings still hold last turn's values; reset below).
    this.undoStack.push({
      conv: this.conversation.length,
      msgs: this.messages.length,
      plan: this.plan ? this.plan.map((s) => ({ ...s })) : null,
      findings: [...this.findings],
      lastTaskUrl: this.lastTaskUrl,
    });
    if (this.undoStack.length > 20) this.undoStack.shift();
    this.emitUndoState();

    this.pushChat({
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
      images: snapshots.length > 0 ? snapshots.map((s) => s.dataUrl) : undefined,
    });
    this.running = true;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.abortController = new AbortController();
    const epoch = ++this.taskEpoch;
    // Reset per-task working state.
    this.lastUserText = text;
    this.plan = null;
    this.findings = [];
    this.pendingToolImages = [];
    this.stepsUsed = 0;
    const budget = deriveStepBudget(settings.maxSteps);
    this.stepBudget = budget.soft;
    this.stepExtension = budget.extension;
    this.stepCeiling = budget.ceiling;
    this.toolCallCount = 0;
    this.reflectionsDone = 0;
    this.reflectionIssues = [];
    this.planNudgesDone = 0;
    this.authResumedOrigins.clear();
    this.setDistill(false);
    this.emit({ type: 'plan_update', plan: null });
    this.taskConversationStart = this.conversation.length;
    this.taskActivityStart = this.activities.length;

    try {
      await this.runLoop(taskText, snapshots, epoch);
    } catch (err) {
      // A stale epoch means the task was stopped/cleared while a tool was
      // mid-flight; swallow whatever that orphaned work throws.
      const stale = this.taskEpoch !== epoch;
      if (stale || (err instanceof DOMException && err.name === 'AbortError' && this.stopRequested)) {
        // User stopped or cleared the task; the abort is expected.
      } else {
        const message =
          err instanceof DOMException && err.name === 'TimeoutError'
            ? `Model request timed out after ${LLM_TIMEOUT_MS / 1000}s.`
            : err instanceof Error
              ? err.message
              : String(err);
        this.setStatus('error', message);
        this.emit({ type: 'error', message });
      }
    } finally {
      // Only the current task owns the shared running/abort/status state. An
      // orphaned loop (stale epoch — stop() already reset things, and a new task
      // may be under way) must not touch it.
      if (this.taskEpoch === epoch) {
        this.abortController = null;
        this.running = false;
        if (this.status !== 'error') this.setStatus('idle');
        // Autosave every settled turn (including errored ones) so the thread
        // survives service-worker eviction and shows up in History.
        void this.persistCurrentConversation();
        void this.maybeLearnLesson(settings, epoch);
        void this.reflectMemories(settings, epoch);
        // Once the first exchange exists, generate a descriptive topic title.
        // Fire-and-forget so it never delays the user's next message; retries on
        // later turns until it succeeds, then locks (see titleIsAuto).
        void this.maybeGenerateMeta();
      }
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async runScheduledTask(
    title: string,
    prompt: string,
  ): Promise<{ ok: boolean; response?: string; error?: string; needsApproval?: boolean; conversationId?: string; fileArtifactNames?: string[] }> {
    if (this.running) return { ok: false, error: 'Agent is already running.' };
    const before = this.messages.length;
    this.unattended = true;
    this.unattendedApprovalBlocked = false;
    this.unattendedTaskTitle = title;
    try {
      await this.handleUserMessage(`[Scheduled task: ${title}]\n${prompt}`);
      const turnMessages = this.messages.slice(before);
      const response = [...turnMessages].reverse().find((m) => m.role === 'assistant')?.text;
      // Files generated unattended are saved to the Products store (see
      // pushChat) since no sidebar is open to click the card's Download
      // button — surface their names here so the run record (and its
      // notification) can say where they went.
      const fileArtifactNames = turnMessages.filter((m) => m.fileArtifact).map((m) => m.fileArtifact!.filename);
      const conversationId = this.currentConversationId ?? undefined;
      if (this.unattendedApprovalBlocked) {
        return { ok: false, response, error: 'Scheduled task needs user approval for a state-changing tool.', needsApproval: true, conversationId, fileArtifactNames };
      }
      return { ok: Boolean(response), response, error: response ? undefined : 'Scheduled task produced no response.', conversationId, fileArtifactNames };
    } finally {
      this.unattended = false;
      this.unattendedTaskTitle = null;
    }
  }

  /**
   * Snapshot the in-memory conversation to storage under its stable id. Called
   * from `handleUserMessage`'s finally block after each turn. Title comes from
   * the first user message; the body carries the full LlmMessage[] so the thread
   * can be truly resumed later.
   */
  private async persistCurrentConversation(): Promise<void> {
    if (!this.currentConversationId || this.messages.length === 0) return;
    const id = this.currentConversationId;
    const firstUser = this.messages.find((m) => m.role === 'user');
    const last = this.messages[this.messages.length - 1];
    const updatedAt = new Date().toISOString();
    // Prefer the generated LLM title once we have one; otherwise the heuristic.
    const title = this.currentConversationTitle ?? deriveTitle(firstUser?.text ?? '');
    // Snapshot the conversation's tab-group pages so restore can reopen them.
    const groupUrls = await this.snapshotGroupTabs();
    const record: StoredConversation = {
      id,
      title,
      createdAt: this.conversationCreatedAt || updatedAt,
      updatedAt,
      messages: this.messages,
      conversation: this.conversation,
      autoTitled: this.titleIsAuto,
      labels: this.currentConversationLabels.length > 0 ? this.currentConversationLabels : undefined,
      plan: this.plan ?? undefined,
      findings: this.findings.length > 0 ? this.findings : undefined,
      lastTaskUrl: this.lastTaskUrl || undefined,
      summary: this.currentConversationSummary ?? undefined,
      groupName: groupUrls.length > 0 ? this.groupName ?? undefined : undefined,
      groupUrls: groupUrls.length > 0 ? groupUrls : undefined,
      projectId: this.currentConversationProjectId,
    };
    try {
      await saveConversation(record, {
        title: record.title,
        updatedAt,
        messageCount: this.messages.length,
        preview: derivePreview(last?.text ?? ''),
        summary: this.currentConversationSummary ?? undefined,
      });
    } catch {
      // A failed autosave must never break the chat; the next turn retries.
    }
  }

  /** Live http(s) pages in this conversation's tab group (for save/restore). Empty when no group. */
  private async snapshotGroupTabs(): Promise<Array<{ url: string; title: string }>> {
    if (this.groupId === null) return [];
    try {
      const tabs = await chrome.tabs.query({ groupId: this.groupId });
      return collectGroupUrls(tabs.map((t) => ({ url: t.url, title: t.title })));
    } catch {
      return [];
    }
  }

  /**
   * Generate the conversation's history-list metadata — a short topic title and a
   * 1–2 sentence summary — in one cheap model call, then re-persist. The title is
   * generated once and locked (`titleIsAuto`); the summary is (re)generated when
   * the thread has grown materially since the last one, so it stays current on
   * long conversations. Best-effort — any failure is swallowed so the chat is
   * unaffected and the heuristic title + snippet preview stand in.
   */
  private async maybeGenerateMeta(): Promise<void> {
    if (this.metaInFlight) return;
    const id = this.currentConversationId;
    if (!id) return;
    const firstUser = this.messages.find((m) => m.role === 'user');
    const firstAssistant = this.messages.find((m) => m.role === 'assistant');
    // Need a real exchange to work against.
    if (!firstUser?.text || !firstAssistant?.text) return;

    const needTitle = !this.titleIsAuto;
    const needSummary = !this.currentConversationSummary || this.messages.length - this.summaryAtCount >= 4;
    if (!needTitle && !needSummary) return;

    this.metaInFlight = true;
    try {
      const settings = await getSettings();
      if (!settings) return;
      // Compact digest (opening ask + latest exchange + findings), not the whole
      // transcript, so the summary is cheap regardless of conversation length.
      const lastUser = [...this.messages].reverse().find((m) => m.role === 'user');
      const lastAssistant = [...this.messages].reverse().find((m) => m.role === 'assistant');
      const digest =
        `Opening request:\n${firstUser.text.slice(0, 500)}\n\n` +
        (lastUser && lastUser !== firstUser ? `Latest request:\n${lastUser.text.slice(0, 300)}\n\n` : '') +
        `Latest answer:\n${(lastAssistant?.text ?? firstAssistant.text).slice(0, 800)}` +
        (this.findings.length > 0 ? `\n\nKey findings:\n${this.findings.slice(-10).join('\n').slice(0, 600)}` : '');
      const prompt: LlmMessage[] = [
        {
          role: 'system',
          content:
            'You label a conversation for a history list. Reply with ONLY JSON: {"title":"<3–6 word topic, no trailing punctuation>","summary":"<1–2 plain sentences on what was asked and what was resolved>"}. No preamble, no code fence.',
        },
        { role: 'user', content: digest },
      ];
      const reply = await complete({ ...resolveModelForRole(settings, 'utility'), maxTokens: 150, temperature: 0 }, prompt);
      const meta = parseConversationMeta(typeof reply.content === 'string' ? reply.content : '');
      // Re-check the id: the user may have cleared or loaded another thread while
      // we were awaiting the model.
      if (this.currentConversationId !== id) return;
      let changed = false;
      if (needTitle && meta.title) {
        const title = deriveTitle(meta.title.replace(/^["'\s]+|["'\s]+$/g, ''));
        if (title) {
          this.currentConversationTitle = title;
          this.titleIsAuto = true;
          changed = true;
        }
      }
      if (needSummary && meta.summary) {
        this.currentConversationSummary = deriveSummary(meta.summary);
        this.summaryAtCount = this.messages.length;
        changed = true;
      }
      if (changed) await this.persistCurrentConversation();
    } catch {
      // Metadata is optional; leave the heuristics and retry on a later turn.
    } finally {
      this.metaInFlight = false;
    }
  }

  private async maybeLearnLesson(settings: Settings, epoch: number): Promise<void> {
    if (this.taskEpoch !== epoch || this.stopRequested || this.unattended) return;
    if (!(await getMemoryEnabled())) return;
    const taskMessages = this.conversation.slice(this.taskConversationStart);
    const toolOutputs = taskMessages
      .filter((m) => m.role === 'tool' && typeof m.content === 'string')
      .map((m) => String(m.content));
    const toolOutputErrors = toolOutputs.filter((o) => /^Error\b|Error from\b|.*\berror\b/i.test(o)).slice(-6);
    const taskActivities = this.activities.slice(this.taskActivityStart);
    const failedActivities = taskActivities
      .filter((a) => a.status === 'error' || a.status === 'denied')
      .slice(-8);
    const substantial = (this.plan?.length ?? 0) >= 3 || this.toolCallCount >= 4;
    const corrected = this.reflectionsDone > 0 || this.planNudgesDone > 0;
    if (!substantial && !corrected && failedActivities.length === 0 && toolOutputErrors.length === 0) return;

    const finalAnswer = [...this.messages].reverse().find((m) => m.role === 'assistant')?.text ?? '';
    const planText = this.plan?.map((s, i) => `${i + 1}. [${s.status}] ${s.text}`).join('\n') ?? '(no plan)';
    const tools = [...new Set(taskActivities.map((a) => a.tool))].slice(0, 12);
    const prompt: LlmMessage[] = [
      {
        role: 'system',
        content:
          'Distill ONE reusable browser-agent lesson from this completed task. Save only actionable behavior that would prevent a repeated mistake or preserve a successful site/tool strategy. Do not save user facts, secrets, credentials, or page content. If there is no durable lesson, return confidence below 0.7. Reply ONLY JSON: {"lesson":"<one concise imperative>","triggers":["<future task keyword>"],"tools":["<tool names>"],"origin":"<host or null>","confidence":0-1}.',
      },
      {
        role: 'user',
        content:
          `Request:\n${this.lastUserText}\n\n` +
          `Active host:\n${this.activeHost || '(none)'}\n\n` +
          `Plan:\n${planText}\n\n` +
          `Self-check revisions:\n${this.reflectionIssues.join('\n') || '(none)'}\n\n` +
          `Plan nudges: ${this.planNudgesDone}\n\n` +
          `Tools used:\n${tools.join(', ') || '(none)'}\n\n` +
          `Tool failures/errors:\n${[
            ...failedActivities.map((a) => `${a.tool}: ${a.detail ?? a.status}`),
            ...toolOutputErrors.map((e) => e.slice(0, 500)),
          ].join('\n') || '(none)'}\n\n` +
          `Findings:\n${this.findings.slice(-10).join('\n') || '(none)'}\n\n` +
          `Final answer excerpt:\n${finalAnswer.slice(0, 1200)}`,
      },
    ];
    try {
      const reply = await complete({ ...resolveModelForRole(settings, 'reflection'), maxTokens: 300, temperature: 0 }, prompt, undefined, undefined, this.rateLimitNotice);
      if (this.taskEpoch !== epoch) return;
      const parsed = parseLesson(typeof reply.content === 'string' ? reply.content : '');
      if (!parsed) return;
      const now = new Date().toISOString();
      const origin = parsed.origin ? normalizeHost(parsed.origin) : this.activeHost || undefined;
      const lessons = await getLessons();
      const existing = findSimilarLesson(lessons, { ...parsed, origin });
      if (existing) {
        existing.text = parsed.lesson.length < existing.text.length || existing.uses < 2 ? parsed.lesson : existing.text;
        existing.triggers = [...new Set([...existing.triggers, ...parsed.triggers])].slice(0, 12);
        existing.tools = [...new Set([...(existing.tools ?? []), ...parsed.tools])].slice(0, 12);
        existing.origin = existing.origin ?? origin;
        existing.uses = (existing.uses ?? 0) + 1;
        existing.updatedAt = now;
      } else {
        const entry: LessonEntry = {
          id: `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: parsed.lesson,
          triggers: parsed.triggers,
          tools: parsed.tools.length > 0 ? parsed.tools : undefined,
          origin,
          uses: 1,
          createdAt: now,
          updatedAt: now,
        };
        lessons.unshift(entry);
      }
      lessons.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      await saveLessons(lessons.slice(0, LESSON_MAX_ENTRIES));
    } catch {
      // Automatic lessons are opportunistic; never affect the completed task.
    }
  }

  /**
   * The most recent page read during this task (via get_tab_content /
   * read_app_content), for citing a source when reflection extracts
   * article/page knowledge. `role:'tool'` conversation entries carry no tool
   * name of their own, so each is cross-referenced against the assistant
   * tool_call that produced it (matched by `tool_call_id`).
   */
  private findRecentPageSource(sinceIndex: number): { url: string; title: string; text: string } | null {
    const slice = this.conversation.slice(sinceIndex);
    const callNames = new Map<string, string>();
    for (const m of slice) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const c of m.tool_calls) callNames.set(c.id, c.function.name);
      }
    }
    let found: { url: string; title: string; text: string } | null = null;
    for (const m of slice) {
      if (m.role !== 'tool' || typeof m.content !== 'string' || !m.tool_call_id) continue;
      const toolName = callNames.get(m.tool_call_id);
      if (toolName !== 'get_tab_content' && toolName !== 'read_app_content') continue;
      try {
        const parsed = JSON.parse(m.content) as { url?: string; title?: string; text?: string };
        if (parsed.text) found = { url: parsed.url ?? '', title: parsed.title ?? '', text: parsed.text };
      } catch {
        // Not JSON (an error string, etc.) — skip.
      }
    }
    return found;
  }

  /**
   * Post-conversation reflection: extract durable knowledge from this turn
   * into graph memory — both facts about the user, and named entities/facts/
   * events/relationships from any page the user asked to remember or
   * discussed substantively (e.g. an article). Fires after every settled
   * turn alongside `maybeLearnLesson` (same trigger conditions) — the common
   * case is an empty candidate list, so most turns cost one cheap LLM call
   * and nothing else. Every call here is a plain `complete()` with no tools,
   * so this is safe to run unattended in principle; it currently shares
   * `maybeLearnLesson`'s `!this.unattended` guard for consistency with the
   * existing lesson-learning behavior.
   */
  private async reflectMemories(settings: Settings, epoch: number): Promise<void> {
    if (this.taskEpoch !== epoch || this.stopRequested || this.unattended) return;
    if (!(await getMemoryEnabled())) return;
    const finalAnswer = [...this.messages].reverse().find((m) => m.role === 'assistant')?.text ?? '';
    const pageSource = this.findRecentPageSource(this.taskConversationStart);
    if (!this.lastUserText.trim() && !finalAnswer.trim() && !pageSource) return;

    const pageBlock = pageSource
      ? `\n\nPage read this turn:\nTitle: ${pageSource.title}\nURL: ${pageSource.url}\nContent:\n${pageSource.text.slice(0, 3000)}`
      : '';
    const prompt: LlmMessage[] = [
      {
        role: 'system',
        content:
          'Extract durable knowledge from this exchange for a personal knowledge graph. Capture two kinds of things: ' +
          '(1) durable facts about the USER — identity, role, projects, interests, preferences, ongoing work; ' +
          '(2) if a page was read and the user asked to remember it or discussed it substantively, named entities, facts, events, and relationships FROM THAT PAGE — people, organizations, places, dates, what happened, and how things relate (e.g. "works_at", "announced", "located_in"). ' +
          'Use "entity" for people/organizations/places, "event" for things that happened, "fact" for standalone claims, "preference" for user opinions/likes. ' +
          'Not durable: task minutiae (which button was clicked, tool mechanics), secrets, credentials, or page content the user only glanced at without asking to remember. ' +
          'Empty is the common, correct answer for most exchanges — only extract what is worth recalling weeks from now. ' +
          'Reply ONLY JSON: {"memories":[{"kind":"entity"|"fact"|"preference"|"event","subject":"<who/what, short>","label":"<short name>","summary":"<the fact, third person>","relations":[{"to":"<related subject>","relation":"<verb phrase>"}],"confidence":0-1,"durability":0-1,"evidence":"<verbatim excerpt, max 200 chars>"}]}. ' +
          'durability: identity/preference facts and well-sourced article facts ~0.6-0.9; situational/one-off facts ~0.2-0.4.',
      },
      {
        role: 'user',
        content: `User said:\n${this.lastUserText.slice(0, 1200)}\n\nAssistant replied:\n${finalAnswer.slice(0, 1200)}${pageBlock}`,
      },
    ];
    try {
      const reply = await complete({ ...resolveModelForRole(settings, 'reflection'), maxTokens: 700, temperature: 0 }, prompt, undefined, undefined, this.rateLimitNotice);
      if (this.taskEpoch !== epoch) return;
      const minConfidence = await getMemoryMinConfidence();
      const candidates = filterByMinConfidence(parseReflection(typeof reply.content === 'string' ? reply.content : ''), minConfidence);
      if (candidates.length === 0) return;

      let graph = this.memoryGraph;
      const now = new Date().toISOString();
      const conversationId = this.currentConversationId ?? '';
      const toUpsert: MemoryNode[] = [];
      const toRemoveFromIndex: string[] = [];
      const newId = () => `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      for (const cand of candidates) {
        if (this.taskEpoch !== epoch) return; // aborted mid-reflection (new task started)
        const prov = {
          conversationId,
          excerpt: cand.evidence || cand.summary.slice(0, 200),
          at: now,
          ...(pageSource ? { sourceUrl: pageSource.url, sourceTitle: pageSource.title } : {}),
        };
        // Only merge into a node visible under the active project — reflection in
        // project A must never silently absorb project B's similarly-worded node.
        let target = graph.nodes.find(
          (n) => n.status === 'active' && visibleToProject(n.projectId, this.activeProjectId) && nodeSimilarity(n, cand) >= 0.5,
        );
        if (!target) {
          const hits = await memoryIndexSearch(settings, `${cand.label}: ${cand.summary}`, 3);
          target = hits
            ?.map((h) => graph.nodes.find((n) => n.id === h.nodeId))
            .find((n) => n?.status === 'active' && visibleToProject(n.projectId, this.activeProjectId));
        }
        if (target && shouldAdjudicate(target, cand)) {
          const supersedes = await this.adjudicateSupersede(settings, target, cand, epoch);
          if (supersedes) {
            const oldId = target.id;
            const replacement: MemoryNode = {
              id: newId(),
              kind: cand.kind,
              label: cand.label,
              summary: cand.summary,
              confidence: cand.confidence,
              durability: cand.durability,
              status: 'active',
              projectId: this.activeProjectId ?? undefined,
              createdAt: now,
              updatedAt: now,
              lastConfirmedAt: now,
              provenance: [prov],
            };
            graph = {
              ...graph,
              nodes: [
                ...graph.nodes.map((n) => (n.id === oldId ? { ...n, status: 'superseded' as const, supersededBy: replacement.id, updatedAt: now } : n)),
                replacement,
              ],
            };
            toUpsert.push(replacement);
            toRemoveFromIndex.push(oldId);
            continue;
          }
          // Adjudicated as reinforcement despite low text overlap — fall through to merge.
        }
        if (target) {
          const merged = mergeNodes(target, cand, prov, now);
          graph = { ...graph, nodes: graph.nodes.map((n) => (n.id === target!.id ? merged : n)) };
          toUpsert.push(merged);
        } else {
          const node: MemoryNode = {
            id: newId(),
            kind: cand.kind,
            label: cand.label,
            summary: cand.summary,
            confidence: cand.confidence,
            durability: cand.durability,
            status: 'active',
            projectId: this.activeProjectId ?? undefined,
            createdAt: now,
            updatedAt: now,
            lastConfirmedAt: now,
            provenance: [prov],
          };
          graph = { ...graph, nodes: [...graph.nodes, node] };
          toUpsert.push(node);
        }
      }

      this.memoryGraph = graph;
      await saveMemoryGraph(graph);
      if (toRemoveFromIndex.length > 0) await memoryIndexRemove(toRemoveFromIndex);
      if (toUpsert.length > 0) await this.upsertMemoryIndex(settings, toUpsert);
    } catch {
      // Reflection is opportunistic; never affect the completed task.
    }
  }

  /** One adjudication call: does `candidate` supersede `existing`, or merely restate it? Fails closed (false) on any error. */
  private async adjudicateSupersede(settings: Settings, existing: MemoryNode, candidate: ParsedMemoryCandidate, epoch: number): Promise<boolean> {
    const prompt: LlmMessage[] = [
      {
        role: 'system',
        content:
          'Two memory facts about the same subject were matched but their text differs. Decide whether the NEW fact supersedes (replaces/updates) the EXISTING one, or is just a differently-worded restatement/addition that should be merged instead. ' +
          'Reply ONLY JSON: {"supersedes": true|false}.',
      },
      { role: 'user', content: `EXISTING: ${existing.label}: ${existing.summary}\n\nNEW: ${candidate.label}: ${candidate.summary}` },
    ];
    try {
      const reply = await complete({ ...resolveModelForRole(settings, 'reflection'), maxTokens: 20, temperature: 0 }, prompt, undefined, undefined, this.rateLimitNotice);
      if (this.taskEpoch !== epoch) return false;
      return parseSupersedeVerdict(typeof reply.content === 'string' ? reply.content : '');
    } catch {
      return false;
    }
  }

  /**
   * Restore a saved conversation into the runtime so the user can continue it.
   * Replaces the in-memory thread; the previously active one was already
   * autosaved each turn, so nothing is lost. Refuses while a task is running.
   */
  async loadConversation(id: string): Promise<void> {
    if (this.running) {
      this.emit({ type: 'error', message: 'Finish or stop the current task before loading another conversation.' });
      return;
    }
    const record = await getConversation(id);
    if (!record) {
      this.emit({ type: 'error', message: 'That conversation could not be found (it may have been deleted).' });
      return;
    }
    this.conversation = record.conversation ?? [];
    this.messages = record.messages ?? [];
    this.plan = record.plan ?? null;
    this.findings = record.findings ?? [];
    this.lastTaskUrl = record.lastTaskUrl ?? '';
    this.currentConversationId = record.id;
    this.currentConversationProjectId = record.projectId;
    this.conversationCreatedAt = record.createdAt;
    this.currentConversationLabels = record.labels ?? [];
    // Keep the saved title; only re-title if it was never auto-generated.
    this.currentConversationTitle = record.title || null;
    this.titleIsAuto = record.autoTitled ?? false;
    // Keep the saved summary; only refresh it once the resumed thread grows.
    this.currentConversationSummary = record.summary ?? null;
    this.summaryAtCount = this.messages.length;
    // Fresh tab group for the resumed thread; old tabs are left as-is.
    this.groupName = null;
    this.groupId = null;
    this.activities = [];
    this.pendingSnapshots = [];
    this.pendingToolImages = [];
    this.undoStack = [];
    this.stepsUsed = 0;
    this.toolCallCount = 0;
    this.canDistill = false;
    this.setStatus('idle');
    this.emit({ type: 'plan_update', plan: this.planView() });
    this.emit(this.fullState());
    // Reopen the pages this conversation used so they're queryable again
    // (non-blocking; the transcript is already on screen).
    void this.reopenConversationTabs(record);
  }

  /**
   * On restore, reopen the conversation's pages so they can be queried again: its
   * tab group (collapsed, named as before) plus the active tab. Deduped against
   * already-open tabs so a restore won't pile duplicates. Best-effort — a tab
   * failure never breaks the restore.
   */
  private async reopenConversationTabs(record: StoredConversation): Promise<void> {
    try {
      const open = await browser.openTabUrls();
      const groupPages = (record.groupUrls ?? []).filter((p) => !open.has(normalizeUrl(p.url)));
      let openedGroup = 0;
      if (groupPages.length > 0) {
        this.groupName = record.groupName ?? this.groupName;
        this.groupId = null;
        const results = await Promise.all(groupPages.map((p) => browser.openUrl(p.url)));
        for (const r of results) {
          if (r.tabId > 0) {
            await this.addToConversationGroup(r.tabId);
            open.add(normalizeUrl(r.url));
            openedGroup++;
          }
        }
        if (this.groupId !== null) await browser.setGroupCollapsed(this.groupId, true);
      }
      // Reopen the active tab (focused) when it isn't already open / in the group.
      let openedActive = 0;
      const activeUrl = record.lastTaskUrl ?? '';
      if (/^https?:\/\//i.test(activeUrl) && !open.has(normalizeUrl(activeUrl))) {
        const r = await browser.openUrl(activeUrl);
        if (r.tabId > 0) {
          try {
            await chrome.tabs.update(r.tabId, { active: true });
          } catch {
            // couldn't focus it; the tab still opened
          }
          openedActive++;
        }
      }
      const total = openedGroup + openedActive;
      if (total > 0) {
        const where = this.groupName && openedGroup > 0 ? ` into the "${this.groupName}" group` : '';
        this.notice(`Reopened ${total} page${total === 1 ? '' : 's'} from this conversation${where} — ready to query.`);
      }
    } catch {
      // Reopening is a convenience; never let it break a restore.
    }
  }

  /** Delete a saved conversation; if it is the active one, detach so a new id is allocated next. */
  async deleteConversation(id: string): Promise<void> {
    await deleteStoredConversation(id);
    if (this.currentConversationId === id) {
      this.currentConversationId = null;
      this.currentConversationProjectId = undefined;
      this.conversationCreatedAt = '';
      this.currentConversationTitle = null;
      this.titleIsAuto = false;
      this.currentConversationSummary = null;
      this.summaryAtCount = 0;
      this.currentConversationLabels = [];
    }
  }

  /**
   * Assign labels to a saved conversation. Routed through the runtime (rather than
   * a direct UI storage write) so it can't race the active conversation's autosave:
   * if `id` is the active thread, the in-memory label set is updated too.
   */
  async setConversationLabels(id: string, labels: string[]): Promise<void> {
    await setStoredConversationLabels(id, labels);
    if (this.currentConversationId === id) {
      this.currentConversationLabels = labels;
    }
  }

  /**
   * Import a conversation from a "Load from file" payload: store it under a fresh
   * id (so it never clobbers an existing thread), then open it via the normal
   * resume path so it appears on screen and is continuable. `record` was already
   * shape-checked by `parseConversationFile` in the UI; we re-verify defensively.
   */
  async importConversation(record: unknown, labelDefs?: ConversationLabel[]): Promise<void> {
    if (this.running) {
      this.emit({ type: 'error', message: 'Finish or stop the current task before loading a conversation.' });
      return;
    }
    const body = record as Partial<StoredConversation> | null;
    if (!body || !Array.isArray(body.messages) || !Array.isArray(body.conversation)) {
      this.emit({ type: 'error', message: 'That file is not a valid conversation.' });
      return;
    }
    // Re-register any label definitions bundled in the file so the imported
    // thread's chips resolve to a colour/name on this device. Merge by id;
    // existing local labels win (we don't clobber the user's own names/colours).
    if (labelDefs && labelDefs.length > 0) {
      const existing = await getConversationLabels();
      const known = new Set(existing.map((l) => l.id));
      const merged = [...existing, ...labelDefs.filter((l) => l && l.id && !known.has(l.id))];
      if (merged.length !== existing.length) await saveConversationLabels(merged);
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const messages = body.messages as ChatMessageView[];
    const firstUser = messages.find((m) => m.role === 'user');
    const last = messages[messages.length - 1];
    const title = body.title || deriveTitle(firstUser?.text ?? '');
    const stored: StoredConversation = {
      id,
      title,
      createdAt: body.createdAt || now,
      updatedAt: now, // surface the freshly imported thread at the top of History
      messages,
      conversation: body.conversation as LlmMessage[],
      autoTitled: body.autoTitled ?? false,
      labels: Array.isArray(body.labels) ? body.labels : undefined,
      plan: body.plan,
      findings: body.findings,
      lastTaskUrl: body.lastTaskUrl,
      summary: body.summary,
      groupName: body.groupName,
      groupUrls: body.groupUrls,
    };
    await saveConversation(stored, {
      title,
      updatedAt: now,
      messageCount: messages.length,
      preview: derivePreview(last?.text ?? ''),
      summary: stored.summary,
    });
    // Reuse the resume path to load it into memory and repaint the panel.
    await this.loadConversation(id);
  }

  /** Wipe all saved conversations. The on-screen chat is left intact (re-saves on its next turn). */
  async clearConversations(): Promise<void> {
    await clearAllConversations();
  }

  stop(): void {
    this.stopRequested = true;
    // Cancel any in-flight model request so the loop exits its await promptly.
    this.abortController?.abort();
    if (this.pendingApproval) {
      const pending = this.pendingApproval;
      this.pendingApproval = null;
      pending.resolve(false);
    }
    if (this.authWait) {
      const wait = this.authWait;
      this.authWait = null;
      wait.resolve();
    }
    if (this.permissionWait) {
      const wait = this.permissionWait;
      this.permissionWait = null;
      wait.resolve();
    }
    if (this.pauseWaiter) {
      const w = this.pauseWaiter;
      this.pauseWaiter = null;
      w();
    }
    // Free the UI immediately rather than waiting for the loop to unwind — a
    // browser/network tool call can't be cancelled and may still be hanging.
    // Bumping the epoch orphans that loop (its eventual result is discarded),
    // so Stop / New chat always take effect even mid-tool.
    if (this.running) {
      this.taskEpoch++;
      this.running = false;
      this.abortController = null;
      if (this.status !== 'error') this.setStatus('idle');
      this.notice('Task stopped.');
      // Snapshot the partial thread to History now (captures array refs
      // synchronously, so a following clearConversation can't blank it).
      void this.persistCurrentConversation();
    }
  }

  /**
   * Remove the last user turn and its response, rolling both threads back to the
   * checkpoint taken before that turn and restoring the prior plan/findings. The
   * removed prompt is sent back so the composer can be repopulated for editing.
   * Refuses while a task is running.
   */
  undoLastExchange(): void {
    if (this.running) {
      this.emit({ type: 'error', message: 'Stop the current task before undoing the last exchange.' });
      return;
    }
    const checkpoint = this.undoStack.pop();
    if (!checkpoint) {
      this.notice('Nothing to undo.');
      return;
    }
    // The removed prompt is this turn's user message (the first one dropped).
    const restoredText = this.messages.slice(checkpoint.msgs).find((m) => m.role === 'user')?.text ?? '';
    // Roll both threads back and restore the prior working state.
    this.conversation.length = Math.min(this.conversation.length, checkpoint.conv);
    this.messages.length = Math.min(this.messages.length, checkpoint.msgs);
    this.plan = checkpoint.plan;
    this.findings = checkpoint.findings;
    this.lastTaskUrl = checkpoint.lastTaskUrl;
    this.activities = [];
    this.setDistill(false);
    // Keep History in sync with the trimmed thread (no-op when it's now empty).
    void this.persistCurrentConversation();
    this.emit({ type: 'plan_update', plan: this.planView() });
    this.emit(this.fullState());
    this.emit({ type: 'undo_done', restoredText });
    this.emitUndoState();
  }

  clearConversation(): void {
    this.stop();
    this.conversation = [];
    this.messages = [];
    this.activities = [];
    this.pendingSnapshots = [];
    this.pendingToolImages = [];
    this.undoStack = [];
    this.plan = null;
    this.findings = [];
    this.stepsUsed = 0;
    this.toolCallCount = 0;
    this.canDistill = false;
    this.lastTaskUrl = '';
    // Detach from the saved record: the next message opens a new history entry.
    // The previous conversation stays in storage (Clear = "new chat", not delete).
    this.currentConversationId = null;
    this.currentConversationProjectId = undefined;
    this.conversationCreatedAt = '';
    this.currentConversationTitle = null;
    this.titleIsAuto = false;
    this.currentConversationSummary = null;
    this.summaryAtCount = 0;
    this.currentConversationLabels = [];
    // New conversation ⇒ fresh tab group (old group/tabs are left open).
    this.groupName = null;
    this.groupId = null;
    this.setStatus('idle');
    this.emit({ type: 'plan_update', plan: null });
    this.emit(this.fullState());
  }

  private setDistill(available: boolean): void {
    this.canDistill = available;
    this.emit({ type: 'distill_offer', available });
  }

  dismissDistill(): void {
    this.setDistill(false);
  }

  /**
   * Turn the current task's transcript (request/plan/findings) into a reusable
   * skill and save it — the one packaging step shared by the UI's "Save as
   * skill" button (`distillSkill`, below) and the agent-callable `save_as_skill`
   * tool (so a user asking mid-task "make this a skill" doesn't need to wait
   * for the task to end and click a button). Never checks `this.running`: the
   * tool path calls this *during* a run, which is the whole point.
   *
   * Re-distilling an existing skill of the same name patch-bumps its version
   * (`bumpSkillVersion`) rather than leaving it untracked, so a
   * version-aware re-install later knows this local copy has moved on.
   */
  private async packageTaskAsSkill(source: SkillSource): Promise<{ ok: boolean; name?: string; error?: string }> {
    const settings = await getSettings();
    if (!settings) return { ok: false, error: 'No model configured.' };
    try {
      const planText = this.plan?.map((s, i) => `${i + 1}. ${s.text}`).join('\n') ?? '(no explicit plan)';
      const prompt: LlmMessage[] = [
        {
          role: 'system',
          content:
            'You convert a completed browser task into a reusable skill for a browser agent. Respond with ONLY a JSON object: {"name": "<lowercase-kebab>", "description": "<one line: when to use this>", "body": "<numbered markdown steps naming the agent tools used, generalized so it works for similar future tasks>"}. No prose, no code fence.',
        },
        {
          role: 'user',
          content: `Original request:\n${this.lastUserText}\n\nPlan that was followed:\n${planText}\n\nKey findings:\n${this.findings.join('\n') || '(none)'}\n\nProduce the skill JSON.`,
        },
      ];
      const reply = await complete(resolveModelForRole(settings, 'utility'), prompt, undefined, this.makeSignal(), this.rateLimitNotice);
      const raw = (reply.content ?? '').trim().replace(/^```(?:json)?|```$/g, '').trim();
      const parsed = JSON.parse(raw) as { name?: string; description?: string; body?: string };
      if (!parsed.name || !parsed.description || !parsed.body) {
        throw new Error('Incomplete skill.');
      }
      const name = parsed.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      const skills = await getSkills();
      // Only overwrite an existing skill of this name if it's visible under the
      // active project — otherwise distilling from project A could silently
      // clobber project B's same-named skill.
      const existing = this.scopedSkills(skills).find((s) => s.name.toLowerCase() === name && !s.origin);
      const idx = existing ? skills.findIndex((s) => s.id === existing.id) : -1;
      const skill: Skill = {
        id: idx >= 0 ? skills[idx].id : `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        description: parsed.description.trim(),
        body: parsed.body.trim(),
        projectId: this.activeProjectId ?? undefined,
        version: bumpSkillVersion(existing?.version),
        source,
      };
      if (idx >= 0) skills[idx] = skill;
      else skills.push(skill);
      await saveSkills(skills);
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** UI entry point for the "Save as skill" button shown after a substantial task. */
  async distillSkill(): Promise<void> {
    if (this.running || !this.canDistill) return;
    this.setDistill(false);
    this.setStatus('thinking', 'Distilling a skill…');
    const result = await this.packageTaskAsSkill({ kind: 'generated', installedAt: new Date().toISOString() });
    if (result.ok) {
      this.notice(`Saved skill /${result.name} — edit it in Settings → Skills.`);
    } else {
      this.emit({ type: 'error', message: `Could not distill a skill: ${result.error}` });
    }
    if (this.status !== 'error') this.setStatus('idle');
  }

  pause(): void {
    if (this.running) this.pauseRequested = true;
  }

  resume(): void {
    this.pauseRequested = false;
    if (this.authWait) {
      const wait = this.authWait;
      this.authWait = null;
      this.emit({ type: 'auth_required', origin: '', message: '' });
      wait.resolve();
      return;
    }
    if (this.permissionWait) {
      const wait = this.permissionWait;
      this.permissionWait = null;
      this.emit({ type: 'permission_required', origin: '', message: '' });
      wait.resolve();
      return;
    }
    if (this.pauseWaiter) {
      const w = this.pauseWaiter;
      this.pauseWaiter = null;
      w();
    }
  }

  approvalResponse(requestId: string, approved: boolean, rememberForSession?: boolean): void {
    if (this.pendingApproval?.requestId === requestId) {
      const pending = this.pendingApproval;
      this.pendingApproval = null;
      if (approved && rememberForSession && pending.approvalContext?.toolName) {
        void addSessionApproval(pending.approvalContext.toolName);
      }
      pending.resolve(approved);
    }
  }

  async includeTabContext(scope: 'active' | 'all'): Promise<void> {
    try {
      const snapshot = await tabContext.buildSnapshot(scope);
      this.emit({ type: 'context_update', summary: tabContext.toSummary(snapshot) });
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async refreshContext(): Promise<void> {
    if (!tabContext.getSnapshot()) return;
    try {
      const snapshot = await tabContext.refreshSnapshot();
      this.emit({ type: 'context_update', summary: tabContext.toSummary(snapshot) });
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  // ----- agent loop -----

  /**
   * The agent loop. Builds the system message (instructions + live working
   * state), appends the user turn, then iterates: ask the model, and either
   * finish (no tool calls) or run the requested tools and loop again. Each
   * iteration first checks the stop/pause flags and the step budget, refreshes
   * the active-tab label, and compacts old tool output. Extends the budget
   * while the plan still has open steps, up to `HARD_STEP_CEILING`; past that it
   * forces a final answer via `wrapUp`.
   */
  /** True once this task has been stopped/cleared or superseded by a newer one. */
  private aborted(epoch: number): boolean {
    return this.stopRequested || this.taskEpoch !== epoch;
  }

  /** Capabilities visible under the active project: global ones plus that project's own. */
  private scopedCapabilities(all: CapabilityRegistryEntry[]): CapabilityRegistryEntry[] {
    return all.filter((c) => visibleToProject(c.projectId, this.activeProjectId));
  }

  /** Skills visible under the active project: global ones plus that project's own. */
  private scopedSkills(all: Skill[]): Skill[] {
    return all.filter((s) => visibleToProject(s.projectId, this.activeProjectId));
  }

  private async runLoop(
    userText: string,
    snapshots: Array<{ dataUrl: string; title: string; url: string }> = [],
    epoch: number = this.taskEpoch,
  ): Promise<void> {
    const settings = (await getSettings())!;

    // (Re)build the system message each task so directory/skill/memory edits apply immediately.
    const memoryEnabled = await getMemoryEnabled();
    const tools = memoryEnabled ? [...TOOL_DEFINITIONS, ...MEMORY_TOOL_DEFINITIONS] : TOOL_DEFINITIONS;
    const customInstructions = settings.systemPrompt?.trim()
      ? `\n\nUser instructions — the user has configured these standing instructions; follow them within the safety rules above:\n${settings.systemPrompt.trim()}`
      : '';
    // Active tab host drives app-playbook auto-activation.
    this.activeHost = '';
    this.activeTabLabel = '';
    // Detect navigation since the previous user turn: if the active tab has
    // moved to a new URL, any page text already in this thread is stale and the
    // agent must re-read before answering about "this page".
    let navigationNotice = '';
    try {
      const tab = await browser.getActiveTab();
      this.activeHost = normalizeHost(tab.url);
      this.activeTabLabel = `${tab.url} "${tab.title}"`;
      if (this.lastTaskUrl && this.lastTaskUrl !== tab.url) {
        navigationNotice =
          `[The active tab has navigated to ${tab.url} "${tab.title}" since your previous ` +
          `message. Any page content earlier in this conversation is from a different page and ` +
          `is now stale — call get_tab_content on the active tab before answering anything about ` +
          `"this page"/"this tab".]\n\n`;
      }
      this.lastTaskUrl = tab.url;
    } catch {
      // No active tab (or restricted); playbooks just won't auto-activate.
    }
    // The base system prompt is fixed for the task; the live state block is
    // merged into it only for outgoing model calls (see withWorkingState).
    const capabilities = this.scopedCapabilities(await getCapabilities());
    this.knownSiteNames = capabilities.map((c) => c.name);
    this.memoryGraph = memoryEnabled ? await getMemoryGraph() : emptyMemoryGraph();
    this.relevantMemoryBlock = memoryEnabled ? await this.computeRelevantMemoryBlock(settings, userText) : '';
    const lessonEntries = memoryEnabled ? relevantLessons(await getLessons(), userText, this.activeHost, 3) : [];
    this.systemBase =
      SYSTEM_PROMPT +
      capabilitiesPromptBlock(capabilities) +
      mcpPromptBlock(capabilities) +
      skillsPromptBlock(this.scopedSkills(await getSkills()), this.activeHost) +
      (memoryEnabled ? renderCoreMemoryBlock(this.memoryGraph, this.activeProjectId) + lessonsPromptBlock(lessonEntries) : '') +
      customInstructions;
    // Keep conversation[0] = the byte-stable system base (no volatile state).
    // The live working-state is folded into that system message only at call time
    // (see withWorkingState), so history remains free of volatile state.
    if (this.conversation.length === 0) {
      this.conversation.push({ role: 'system', content: this.systemBase });
    } else {
      this.conversation[0] = { role: 'system', content: this.systemBase };
    }

    const contextBlock = this.buildContextBlock();
    let textContent = contextBlock ? `${contextBlock}\n\n${userText}` : userText;
    if (navigationNotice) textContent = `${navigationNotice}${textContent}`;
    if (snapshots.length === 0) {
      this.conversation.push({ role: 'user', content: textContent });
    } else {
      textContent +=
        '\n\n' +
        snapshots
          .map((s, i) => `Attached snapshot ${i + 1}: "${s.title}" — ${s.url}`)
          .join('\n');
      const parts: ContentPart[] = [
        { type: 'text', text: textContent },
        ...snapshots.map(
          (s): ContentPart => ({ type: 'image_url', image_url: { url: s.dataUrl } }),
        ),
      ];
      this.conversation.push({ role: 'user', content: parts });
    }

    for (;;) {
      if (this.aborted(epoch)) return;
      await this.waitIfPaused();
      if (this.aborted(epoch)) return;

      // Budget: extend if the plan still has open steps, else wrap up gracefully.
      if (this.stepsUsed >= this.stepBudget) {
        if (this.planHasOpenSteps() && this.stepBudget < this.stepCeiling) {
          this.stepBudget = Math.min(this.stepCeiling, this.stepBudget + this.stepExtension);
          this.notice(`Extending the step budget to ${this.stepBudget} to finish the plan.`);
        } else {
          await this.wrapUp(settings);
          return;
        }
      }

      await this.refreshActiveTabLabel();
      await this.compactConversation(settings);

      this.setStatus('thinking');
      const reply = await complete(settings, this.withWorkingState(), tools, this.makeSignal(), this.rateLimitNotice);
      if (this.aborted(epoch)) return;

      if (!reply.tool_calls || reply.tool_calls.length === 0) {
        const text = reply.content ?? '(no response)';
        // Plan-execution guard (deterministic, runs before the self-check): if the
        // model tries to finish while its plan is untouched (open steps, none done)
        // and budget remains, push it back once to actually work the plan. Targets
        // the "Plan (0/N) but answered anyway" failure.
        if (
          this.planUnstarted() &&
          this.planNudgesDone < 1 &&
          this.stepsUsed < this.stepBudget &&
          text.trim() &&
          text !== '(no response)'
        ) {
          this.planNudgesDone++;
          this.conversation.push({ role: 'assistant', content: text });
          this.conversation.push({
            role: 'user',
            content:
              'Your plan still has unfinished steps and none are marked done. Carry out the steps now using ' +
              'tools, or if a step no longer applies mark it done/skipped with update_plan — then give your final answer.',
          });
          this.notice('The plan still has unfinished steps — continuing to work it…');
          continue;
        }
        // Self-check gate: before accepting a tool-free answer, optionally verify
        // it actually satisfies the request. On "revise", keep the draft and loop
        // once more with the critique attached; capped at one cycle and only while
        // budget remains. A skipped, "ok", or failed check finalizes unchanged.
        if (
          (settings.verifyAnswers ?? true) &&
          this.reflectionsDone < 1 &&
          this.stepsUsed < this.stepBudget &&
          text.trim() &&
          text !== '(no response)'
        ) {
          const verdict = await this.reflect(settings, text);
          if (this.aborted(epoch)) return;
          if (verdict.revise) {
            this.reflectionsDone++;
            if (verdict.issues) this.reflectionIssues.push(verdict.issues);
            this.conversation.push({ role: 'assistant', content: text });
            this.conversation.push({
              role: 'user',
              content:
                `[Self-check] Your draft answer may be incomplete or unverified: ${verdict.issues || 'verify it actually satisfies the request'}. ` +
                'Verify and fix it — call tools if needed — then give your final answer.',
            });
            this.notice('Self-checking the answer and refining it…');
            continue;
          }
        }
        this.conversation.push({ role: 'assistant', content: text });
        this.pushChat({ role: 'assistant', text, timestamp: new Date().toISOString() });
        this.maybeOfferDistill();
        return;
      }

      this.conversation.push({
        role: 'assistant',
        content: reply.content,
        tool_calls: reply.tool_calls,
      });
      if (reply.content) {
        // Surface the model's visible reasoning summary alongside tool use.
        this.pushChat({ role: 'notice', text: reply.content, timestamp: new Date().toISOString() });
      }

      this.stepsUsed++;
      await this.executeToolCalls(reply.tool_calls, epoch);
      if (this.aborted(epoch)) return;
      this.flushToolImages();
    }
  }

  /** Inject any tool-captured images into the conversation as a user message. */
  private flushToolImages(): void {
    if (this.pendingToolImages.length === 0) return;
    const images = this.pendingToolImages;
    this.pendingToolImages = [];
    this.conversation.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Full-page capture frames, top to bottom:' },
        ...images.map((url): ContentPart => ({ type: 'image_url', image_url: { url } })),
      ],
    });
    this.pushChat({
      role: 'notice',
      text: `Captured ${images.length} page frame(s) for analysis.`,
      timestamp: new Date().toISOString(),
      images,
    });
  }

  /** Sidebar "Capture page" button: capture and queue frames for the next message. */
  async capturePageToThread(): Promise<void> {
    if (this.running) {
      this.emit({ type: 'error', message: 'Wait for the current task to finish before capturing.' });
      return;
    }
    try {
      const active = await browser.getActiveTab();
      this.setStatus('acting', 'Capturing page…');
      const result = await captureFullPage(active.tabId, 12);
      this.setStatus('idle');
      if (result.error) {
        this.emit({ type: 'error', message: result.error });
        return;
      }
      for (const frame of result.frames) {
        this.attachSnapshot(frame, active.title, active.url);
      }
      if (result.frames.length === 0) {
        this.emit({ type: 'error', message: 'No frames captured.' });
      }
    } catch (err) {
      this.setStatus('idle');
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  // The task's cancellation signal (Stop / clear). The per-request timeout now
  // lives in llmProvider so it bounds each retry attempt, not the whole sequence.
  private makeSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  // Passed to complete() as onRetry: tells the user a transient failure (429 /
  // 5xx) is being backed off and retried, so a busy endpoint looks like patience
  // rather than a stall.
  private rateLimitNotice = (info: { attempt: number; delayMs: number; status: number }): void => {
    const secs = Math.max(1, Math.round(info.delayMs / 1000));
    // Fire-and-forget: the language read is async but the notice is advisory.
    void currentLang().then((lang) =>
      this.notice(translate(lang, 'notice.busyRetry', { status: info.status, secs, attempt: info.attempt })),
    );
  };

  // Add an agent-opened tab to this conversation's tab group, creating it
  // (with a single-word name) on first use. Non-fatal on failure.
  private async addToConversationGroup(tabId: number): Promise<void> {
    if (tabId < 0) return;
    if (!this.groupName) {
      const shuffled = [...GROUP_NAMES].sort(() => Math.random() - 0.5);
      let chosen = shuffled[0];
      for (const candidate of shuffled) {
        if (!(await browser.groupTitleTaken(candidate))) {
          chosen = candidate;
          break;
        }
      }
      this.groupName = chosen;
    }
    try {
      this.groupId = await browser.groupTab(tabId, this.groupName, this.groupId);
    } catch {
      // grouping unavailable — leave the tab ungrouped
    }
  }

  private async refreshActiveTabLabel(): Promise<void> {
    try {
      const tab = await browser.getActiveTab();
      this.activeTabLabel = `${tab.url} "${tab.title}"`;
    } catch {
      // keep the previous label
    }
  }

  /** Run a turn's tool calls: read-only ones concurrently, the rest in order. */
  /**
   * Run the tool calls from one model turn. Read-only tools (per
   * `READ_ONLY_TOOLS`) run concurrently for speed; the rest run sequentially in
   * declared order so state-changing actions stay deterministic. Results are
   * appended to the conversation in the model's original call order regardless
   * of completion order, which the chat-completions protocol requires.
   */
  private async executeToolCalls(calls: LlmToolCall[], epoch: number = this.taskEpoch): Promise<void> {
    this.toolCallCount += calls.length;
    const results = new Map<string, string>();
    const run = async (call: LlmToolCall) => {
      results.set(call.id, this.aborted(epoch) ? 'Task stopped by user.' : await this.executeToolCall(call));
    };
    await Promise.all(calls.filter((c) => READ_ONLY_TOOLS.has(c.function.name)).map(run));
    for (const c of calls.filter((c) => !READ_ONLY_TOOLS.has(c.function.name))) {
      await run(c);
    }
    // If the task was stopped/superseded while a tool was running, don't push
    // its results — the conversation now belongs to a different (or cleared) task.
    if (this.aborted(epoch)) return;
    // Preserve original call order in the conversation.
    for (const c of calls) {
      this.conversation.push({ role: 'tool', tool_call_id: c.id, content: results.get(c.id) ?? '' });
    }
  }

  /** Force a final, tools-disabled answer when the budget is exhausted. */
  private async wrapUp(settings: Settings): Promise<void> {
    this.notice('Step budget reached — composing a final answer from what I have.');
    this.conversation.push({
      role: 'user',
      content:
        'You have reached your step budget — do not call any more tools. Using your findings and what you already know, give the user your best final answer now, clearly noting anything you could not verify.',
    });
    this.setStatus('thinking');
    const reply = await complete(settings, this.withWorkingState(), undefined, this.makeSignal(), this.rateLimitNotice);
    if (this.stopRequested) return;
    const text = reply.content ?? '(no answer)';
    this.conversation.push({ role: 'assistant', content: text });
    this.pushChat({ role: 'assistant', text, timestamp: new Date().toISOString() });
    this.maybeOfferDistill();
  }

  /**
   * One self-check pass over a draft final answer. Asks the model whether the
   * request is actually satisfied and nothing is claimed-but-unverified, given the
   * task, plan, and findings. Best-effort and fail-open: any error/abort returns
   * "don't revise" so a flaky check never blocks the user's answer.
   */
  private async reflect(settings: Settings, draft: string): Promise<{ revise: boolean; issues: string }> {
    try {
      const planText = this.plan?.map((s, i) => `${i + 1}. [${s.status}] ${s.text}`).join('\n') ?? '(no plan)';
      const prompt: LlmMessage[] = [
        {
          role: 'system',
          content:
            "You are a strict reviewer of a browser agent's draft answer. Decide whether it actually satisfies the user's request and whether it claims anything the tools/findings did not verify. Reply with ONLY {\"verdict\":\"ok\"|\"revise\",\"issues\":\"<short reason if revise>\"}. Use \"revise\" only for a concrete, fixable gap (missing or unverified information, an unanswered part of the request); otherwise \"ok\". No prose, no code fence.",
        },
        {
          role: 'user',
          content:
            `Request:\n${this.lastUserText || '(unknown)'}\n\n` +
            `Plan:\n${planText}\n\n` +
            `Findings:\n${this.findings.join('\n') || '(none)'}\n\n` +
            `Draft answer:\n${draft}`,
        },
      ];
      const reply = await complete(
        { ...resolveModelForRole(settings, 'utility'), maxTokens: 200, temperature: 0 },
        prompt,
        undefined,
        this.makeSignal(),
        this.rateLimitNotice,
      );
      return parseReflectionVerdict(typeof reply.content === 'string' ? reply.content : '');
    } catch {
      return { revise: false, issues: '' };
    }
  }

  private async runScopedSubtasks(args: Record<string, unknown>): Promise<string> {
    const settings = await getSettings();
    if (!settings) return 'Error: no model configured.';
    const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
    const tasks = rawTasks
      .slice(0, 12)
      .map((raw, i): ScopedSubtaskInput | null => {
        const t = raw as Record<string, unknown> | null;
        if (!t || typeof t !== 'object') return null;
        const objective = String(t.objective ?? '').trim();
        if (!objective) return null;
        const id = String(t.id ?? `task-${i + 1}`).trim() || `task-${i + 1}`;
        const tabId = Number(t.tabId);
        return {
          id,
          objective,
          ...(Number.isFinite(tabId) ? { tabId } : {}),
          ...(typeof t.url === 'string' && t.url.trim() ? { url: t.url.trim() } : {}),
          ...(typeof t.context === 'string' && t.context.trim() ? { context: t.context.trim() } : {}),
        };
      })
      .filter((t): t is ScopedSubtaskInput => t !== null);
    if (tasks.length === 0) return 'Error: run_subtasks needs at least one task with an objective.';
    const maxSteps = Math.min(8, Math.max(1, Math.floor(Number(args.maxSteps) || 4)));
    const results = await this.mapWithConcurrency(tasks, 3, (task) => this.runScopedSubtask(settings, task, maxSteps));
    return JSON.stringify({ results });
  }

  private async mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return out;
  }

  private async runScopedSubtask(settings: Settings, task: ScopedSubtaskInput, maxSteps: number): Promise<ScopedSubtaskResult> {
    const fallbackSources = [task.url, task.tabId !== undefined ? `tab:${task.tabId}` : undefined].filter((s): s is string => Boolean(s));
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          'You are a scoped sub-agent running inside a larger browser task. Solve ONLY the assigned subtask. Keep your context small. Use only the provided tools to inspect the assigned page/source; do not perform state-changing actions. When done, reply ONLY JSON: {"conclusion":"<compact answer with key facts>","sources":["<url or source id>"]}. No prose or code fence.',
      },
      {
        role: 'user',
        content:
          `Subtask id: ${task.id}\n` +
          `Objective: ${task.objective}\n` +
          (task.tabId !== undefined ? `Existing tabId: ${task.tabId}\nStart by reading this tab with get_tab_content unless another reader is clearly better.\n` : '') +
          (task.url ? `URL: ${task.url}\nOpen/read this URL if needed. For PDF/Office URLs, use read_pdf/read_office_document directly.\n` : '') +
          (task.context ? `Parent context:\n${task.context.slice(0, 2000)}\n` : ''),
      },
    ];
    const scopedSettings = { ...resolveModelForRole(settings, 'plan'), maxTokens: Math.min(settings.maxTokens ?? 800, 800), temperature: 0 };
    let stepsUsed = 0;
    try {
      for (; stepsUsed < maxSteps; stepsUsed++) {
        if (this.stopRequested) return { id: task.id, conclusion: '', sources: fallbackSources, stepsUsed, error: 'Task stopped by user.' };
        const reply = await complete(scopedSettings, messages, SCOPED_SUBTASK_TOOLS, this.makeSignal());
        if (!reply.tool_calls || reply.tool_calls.length === 0) {
          return this.parseScopedSubtaskResult(task.id, reply.content ?? '', stepsUsed, fallbackSources);
        }
        messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls });
        for (const call of reply.tool_calls) {
          const result = await this.executeScopedSubtaskTool(call);
          messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
      }
      messages.push({ role: 'user', content: 'Step budget reached. Return your best final JSON conclusion now with no tool calls.' });
      const reply = await complete(scopedSettings, messages, undefined, this.makeSignal());
      return this.parseScopedSubtaskResult(task.id, reply.content ?? '', stepsUsed, fallbackSources);
    } catch (e) {
      return { id: task.id, conclusion: '', sources: fallbackSources, stepsUsed, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async executeScopedSubtaskTool(call: LlmToolCall): Promise<string> {
    const name = call.function.name;
    if (!SCOPED_SUBTASK_ALLOWED.has(name)) return `Error: tool ${name} is not available inside scoped subtasks.`;
    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return `Error: could not parse arguments for ${name}.`;
    }
    try {
      return await this.dispatchTool(name, args);
    } catch (e) {
      return `Error from ${name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private parseScopedSubtaskResult(id: string, text: string, stepsUsed: number, fallbackSources: string[]): ScopedSubtaskResult {
    const raw = String(text ?? '').trim();
    try {
      const obj = extractJsonObject(raw) as { conclusion?: unknown; sources?: unknown };
      const conclusion = String(obj.conclusion ?? '').trim();
      const sources = Array.isArray(obj.sources) ? obj.sources.map(String).map((s) => s.trim()).filter(Boolean) : [];
      return { id, conclusion: conclusion || raw, sources: sources.length ? sources : fallbackSources, stepsUsed };
    } catch {
      return { id, conclusion: raw || '(no conclusion)', sources: fallbackSources, stepsUsed };
    }
  }

  /** Rough char count of a message's content (string or multimodal parts). */
  private static messageLen(m: LlmMessage): number {
    if (typeof m.content === 'string') return m.content.length;
    if (Array.isArray(m.content)) {
      return m.content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 1200), 0);
    }
    return 0;
  }

  // Placeholder left in place of an evicted tool output we don't (or can't)
  // summarize; its prefix is also the marker that a message was already evicted.
  private static readonly COMPACT_PLACEHOLDER = '[compacted — important results are in Findings]';
  // Only outputs bigger than this are worth a summarization call; tinier ones
  // just get the placeholder.
  private static readonly SUMMARIZE_MIN_CHARS = 1500;

  /**
   * Keep the conversation under `CONVERSATION_CHAR_BUDGET` by evicting the
   * oldest, bulkiest tool outputs. With `summarizeObservations` on (default), the
   * larger evicted outputs are replaced by a cheap LLM digest that preserves
   * their salient facts/URLs; otherwise (or on any summarizer failure) they get a
   * short static placeholder. Safe either way because the plan + findings are
   * re-injected every step in the working-state block, and the most recent few
   * messages are left intact so the model retains immediate context.
   */
  private async compactConversation(settings: Settings): Promise<void> {
    let total = this.conversation.reduce((n, m) => n + AgentRuntime.messageLen(m), 0);
    if (total <= CONVERSATION_CHAR_BUDGET) return;
    const protectedTail = 6; // leave the most recent messages intact
    // Pick the oldest not-yet-evicted tool outputs, in order, until back under budget.
    const victims: number[] = [];
    for (let i = 1; i < this.conversation.length - protectedTail && total > CONVERSATION_CHAR_BUDGET; i++) {
      const m = this.conversation[i];
      if (
        m.role === 'tool' &&
        typeof m.content === 'string' &&
        !m.content.startsWith('[compacted') &&
        !m.content.startsWith('[summary]')
      ) {
        victims.push(i);
        total -= m.content.length - AgentRuntime.COMPACT_PLACEHOLDER.length;
      }
    }
    if (victims.length === 0) return;

    // Summarize the worthwhile (large) victims in one batched call; tiny ones and
    // any we couldn't summarize fall back to the static placeholder.
    const toSummarize = (settings.summarizeObservations ?? true)
      ? victims.filter((i) => (this.conversation[i].content as string).length > AgentRuntime.SUMMARIZE_MIN_CHARS)
      : [];
    const digestByIndex = new Map<number, string>();
    if (toSummarize.length > 0) {
      const digests = await this.summarizeEvicted(
        settings,
        toSummarize.map((i) => this.conversation[i].content as string),
      );
      if (digests) toSummarize.forEach((i, k) => digestByIndex.set(i, digests[k]));
    }
    for (const i of victims) {
      const digest = digestByIndex.get(i);
      this.conversation[i].content = digest ? `[summary] ${digest}` : AgentRuntime.COMPACT_PLACEHOLDER;
    }
  }

  /**
   * Summarize a batch of evicted tool outputs in a single cheap model call.
   * Returns one digest per input (order preserved), or null on any failure so the
   * caller falls back to the static placeholder. Best-effort: never throws, and
   * aborts with the task.
   */
  private async summarizeEvicted(settings: Settings, outputs: string[]): Promise<string[] | null> {
    try {
      const numbered = outputs
        .map((o, i) => `--- Tool output ${i + 1} ---\n${o.slice(0, 8000)}`)
        .join('\n\n');
      const prompt: LlmMessage[] = [
        {
          role: 'system',
          content:
            "You compress a browser agent's old tool outputs to save context. For each numbered tool output, write a digest of ONLY the facts that matter for the user's task — keep URLs, names, numbers, and dates; drop boilerplate. 1–3 sentences each. Reply with ONLY a JSON array of strings, one digest per tool output, in the same order. No prose, no code fence.",
        },
        {
          role: 'user',
          content: `User's task:\n${this.lastUserText || '(unknown)'}\n\n${numbered}`,
        },
      ];
      const reply = await complete(
        { ...resolveModelForRole(settings, 'utility'), maxTokens: 600, temperature: 0 },
        prompt,
        undefined,
        this.makeSignal(),
        this.rateLimitNotice,
      );
      return parseSummaryArray(typeof reply.content === 'string' ? reply.content : '', outputs.length);
    } catch {
      return null;
    }
  }

  /** Sidebar "Add to repo" button: capture into a repo and report in the chat. */
  async captureToRepo(repo: string, scope: 'tab' | 'group'): Promise<void> {
    if (this.running) {
      this.emit({ type: 'error', message: 'Wait for the current task to finish before capturing.' });
      return;
    }
    if (!repo.trim()) {
      this.emit({ type: 'error', message: 'Enter a repository name first.' });
      return;
    }
    const summary = await this.ingestIntoRepo(repo, scope);
    this.notice(summary);
    this.setStatus('idle');
  }

  /** Capture a tab (or the conversation's tab group) into a named OPFS repo. */
  private async ingestIntoRepo(repo: string, scope: 'tab' | 'group'): Promise<string> {
    const name = repo.trim();
    if (!name) return 'Error: a repository name is required.';
    const settings = await getSettings();
    if (!settings) return 'Error: no model configured.';

    let tabs: Array<{ tabId: number; title: string; url: string }>;
    if (scope === 'group') {
      if (this.groupId === null) {
        return 'Error: this conversation has no tab group yet (open or search for pages first).';
      }
      const groupTabs = await chrome.tabs.query({ groupId: this.groupId });
      tabs = groupTabs
        .filter((t) => t.id !== undefined)
        .map((t) => ({ tabId: t.id!, title: t.title ?? '', url: t.url ?? '' }));
    } else {
      const active = await browser.getActiveTab();
      tabs = [{ tabId: active.tabId, title: active.title, url: active.url }];
    }
    if (tabs.length === 0) return 'Error: no tabs to capture.';

    // Detect duplicates by normalized URL (ignoring ?query/#hash) against the
    // repo's existing documents, so re-adding a page can replace it rather than
    // silently piling up duplicate copies.
    const existing = await repoDocs(name);
    const urlToDocIds = new Map<string, string[]>();
    if (existing.ok && Array.isArray(existing.result)) {
      for (const d of existing.result as Array<{ id: string; url: string }>) {
        const key = normalizeUrl(d.url);
        const ids = urlToDocIds.get(key) ?? [];
        ids.push(d.id);
        urlToDocIds.set(key, ids);
      }
    }
    const dupTabs = tabs.filter((t) => urlToDocIds.has(normalizeUrl(t.url)));

    // One combined prompt covering every duplicate page in this batch.
    let replaceDuplicates = false;
    if (dupTabs.length > 0) {
      const titles = dupTabs.map((t) => `• ${t.title || t.url}`).join('\n');
      const n = dupTabs.length;
      replaceDuplicates = await this.requestApproval(
        `Replace ${n} page${n === 1 ? '' : 's'} already in "${name}"?`,
        `${n === 1 ? 'This page is' : 'These pages are'} already in the repository:\n${titles}\n\n` +
          'Approve to replace the existing copy; decline to keep the original and add nothing for it.',
      );
    }

    // OCR fallback only works on the active tab (captureVisibleTab limitation).
    const allowOcr = scope === 'tab';
    let ingested = 0;
    let replaced = 0;
    let chunks = 0;
    const skipped: string[] = [];
    const alreadyPresent: string[] = [];
    for (const t of tabs) {
      const dupIds = urlToDocIds.get(normalizeUrl(t.url));
      if (dupIds) {
        if (!replaceDuplicates) {
          alreadyPresent.push(t.title || t.url);
          continue; // decline → keep original, add nothing
        }
        // Replace: remove the existing copy/copies first, then re-ingest.
        for (const id of dupIds) await repoDeleteDoc(name, id);
      }
      this.setStatus('acting', `Adding "${t.title || t.url}" to ${name}…`);
      const result = await ingestTab(settings, name, t.tabId, t.title, t.url, allowOcr);
      if (result.ok) {
        if (dupIds) replaced++;
        else ingested++;
        chunks += result.chunks ?? 0;
      } else {
        skipped.push(`${t.title || t.url}${result.needsOcr ? ' (no extractable text)' : ` (${result.error})`}`);
      }
    }
    const parts = [`Added ${ingested} page(s) (${chunks} chunks) to repository "${name}".`];
    if (replaced) parts.push(`Replaced ${replaced} existing page(s).`);
    if (alreadyPresent.length) parts.push(`Already present (kept): ${alreadyPresent.join('; ')}.`);
    if (skipped.length) parts.push(`Skipped: ${skipped.join('; ')}.`);
    return parts.join(' ');
  }

  /**
   * After a task finishes, offer to save it as a reusable skill — but only if it
   * was substantial enough to be worth generalizing. "Substantial" = a real plan
   * (3+ steps) or at least 4 tool calls; trivial one-shot answers don't prompt.
   */
  private maybeOfferDistill(): void {
    const substantial = (this.plan?.length ?? 0) >= 3 || this.toolCallCount >= 4;
    if (substantial) this.setDistill(true);
  }

  /**
   * Execute a single tool call and return its result as the string the model
   * will see. This is the central dispatch switch — one `case` per tool in
   * `TOOL_DEFINITIONS`, mostly delegating to `browserToolAdapter`, `mcpClient`,
   * or the offscreen RAG store. Before running, it logs a UI activity row and,
   * for any tool in `APPROVAL_REQUIRED`, blocks on `requestApproval` using the
   * model-supplied `reason` (declining returns a sentinel the model can react
   * to). Tools return strings, never throw, so the loop always gets a result.
   */
  private async executeToolCall(call: LlmToolCall): Promise<string> {
    const name = call.function.name;
    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return `Error: could not parse arguments for ${name}.`;
    }

    const activity = this.startActivity(name, args);

    // Resolve capability context for tools sourced from registered capabilities.
    let approvalContext: ApprovalContext | undefined;
    const capabilities = this.scopedCapabilities(await getCapabilities());
    if (name === 'call_mcp_tool' || name === 'list_mcp_tools') {
      const serverName = String(args.server ?? '');
      const capability = capabilities.find((c) =>
        c.name.toLowerCase() === serverName.toLowerCase() || c.mcpUrl === serverName,
      );
      if (capability) {
        approvalContext = {
          toolName: name,
          capabilityKind: capability.kind,
          capabilityName: capability.name,
          trustLevel: capability.trustLevel,
          authMethod: capability.authMethod,
          authConfigured: !!resolveAuth(capability),
        };
      }
    } else if (name === 'call_webmcp_tool' || name === 'list_webmcp_tools') {
      approvalContext = {
        toolName: name,
        capabilityKind: 'webmcp',
        capabilityName: undefined,
        trustLevel: 'public',
        authMethod: 'browser-session',
        authConfigured: true,
      };
    }

    if (this.unattended && UNATTENDED_BLOCKED_TOOLS.has(name)) {
      this.unattendedApprovalBlocked = true;
      this.finishActivity(activity, 'denied', 'Not permitted to run unattended');
      return `Error: tool "${name}" is not permitted to run unattended in a scheduled task or trigger.`;
    }

    // Trust gating: low-trust capabilities' tools always require approval,
    // even if the tool is normally read-only.
    const needsApproval = APPROVAL_REQUIRED.has(name) ||
      (approvalContext && !isTrustedForAutoApproval(approvalContext.capabilityKind as any, approvalContext.trustLevel as any));

    // Session-level approval persistence: skip approval for tools the user
    // already approved for this session.
    let skipApproval = false;
    if (needsApproval) {
      const sessionApproved = await getSessionApprovals();
      if (sessionApproved.has(name)) skipApproval = true;
    }

    if (needsApproval && !skipApproval) {
      if (this.unattended) {
        this.unattendedApprovalBlocked = true;
        this.finishActivity(activity, 'denied', 'Approval-gated tool cannot run unattended');
        return `Error: tool "${name}" requires user approval and cannot run unattended in a scheduled task.`;
      }
      const reason =
        typeof args.reason === 'string' && args.reason.trim()
          ? args.reason.trim()
          : 'The agent wants to perform this action.';
      const approved = await this.requestApproval(reason, this.describeAction(name, args), approvalContext);
      if (!approved) {
        this.finishActivity(activity, 'denied', 'User denied this action');
        return 'The user denied this action. Do not retry it; ask the user how to proceed or finish with what you have.';
      }
    }

    this.setStatus('acting', name);
    try {
      const result = await this.dispatchTool(name, args);
      this.finishActivity(activity, 'ok');
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.finishActivity(activity, 'error', message);
      return `Error from ${name}: ${message}`;
    }
  }

  private async dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tabId = Number(args.tabId);
    switch (name) {
      case 'list_tabs':
        return JSON.stringify(await browser.listTabs());
      case 'get_active_tab':
        return JSON.stringify(await browser.getActiveTab());
      case 'get_tab_content': {
        let content = await browser.getTabContent(tabId);
        // Self-heal a stale tabId: if the referenced tab is gone (e.g. the user
        // navigated or closed it since it was last read), re-resolve the current
        // active tab and read that, so "summarize the current page" succeeds on
        // the first try instead of failing until the model re-runs get_active_tab.
        if (
          content.extractionStatus === 'unsupported' &&
          content.metadata['ba:note'] === 'Tab no longer exists.'
        ) {
          try {
            const active = await browser.getActiveTab();
            if (active.tabId !== tabId) {
              content = await browser.getTabContent(active.tabId);
              content.metadata['ba:note'] =
                `The originally referenced tab was gone; showing the current active tab (${active.url}).`;
            }
          } catch {
            // No active tab to fall back to; keep the original "tab gone" result.
          }
        }
        if (content.extractionStatus === 'blocked' && content.metadata['ba:origin']) {
          // Pause so the user can grant access from the sidebar, then retry once.
          await this.pauseForPermission(content.metadata['ba:origin']);
          if (!this.stopRequested) content = await browser.getTabContent(content.tabId);
        }
        await this.pauseIfAuthRequired(content);
        return this.serializeContent(content, SINGLE_TAB_CHARS);
      }
      case 'get_all_tab_contents': {
        const contents = await browser.getAllTabContents();
        return JSON.stringify(contents.map((c) => this.contentForModel(c, MULTI_TAB_CHARS)));
      }
      case 'navigate': {
        const url = String(args.url);
        // Navigating to an Office/PDF file makes the browser download it (nothing
        // to render), leaving nothing to process — read it directly instead.
        const docRead = await this.maybeReadDocumentUrl(url);
        if (docRead) return docRead;
        return JSON.stringify(await browser.navigate(tabId, url));
      }
      case 'search_web': {
        const result = await browser.searchWeb(String(args.query), this.unattended);
        if (result.tabId > 0) await this.addToConversationGroup(result.tabId);
        return JSON.stringify({ ...result, group: this.groupName });
      }
      case 'open_url': {
        const url = String(args.url);
        // Same guardrail as navigate: read document URLs rather than downloading them.
        const docRead = await this.maybeReadDocumentUrl(url);
        if (docRead) return docRead;
        const result = await browser.openUrl(url);
        if (result.tabId > 0) await this.addToConversationGroup(result.tabId);
        return JSON.stringify({ ...result, group: this.groupName });
      }
      case 'read_tab_group':
        return browser.readTabGroup(args.name ? String(args.name) : undefined, this.groupId);
      case 'run_subtasks':
        return this.runScopedSubtasks(args);
      case 'add_to_repo':
        return this.ingestIntoRepo(String(args.repo), args.scope === 'group' ? 'group' : 'tab');
      case 'search_repo': {
        const settings = await getSettings();
        if (!settings) return 'Error: no model configured.';
        const query = String(args.query);
        const finalK = Number(args.k) || settings.repoSearchK || 6;
        const candidateK = Math.max(20, finalK * 3);
        const queries = await this.repoQueryVariants(settings, query);
        let queryVec: number[][];
        try {
          queryVec = await embedChunks(settings, queries, this.makeSignal());
        } catch (e) {
          return `Error embedding the query: ${e instanceof Error ? e.message : String(e)}`;
        }
        const res = await repoSearch(
          String(args.repo),
          queryVec[0],
          candidateK,
          embedderId(settings),
          { query, queryVectors: queryVec, queries, hybrid: settings.hybridSearch !== false },
        );
        if (!res.ok) return `Error: ${res.error}`;
        const result = res.result as { results?: SearchHit[] } | undefined;
        const hits = Array.isArray(result?.results) ? result.results : [];
        const reranked = await this.rerankRepoHits(settings, query, hits, finalK);
        return JSON.stringify({ results: reranked, queries, candidateCount: hits.length });
      }
      case 'list_repos': {
        const res = await repoList();
        return res.ok ? JSON.stringify(res.result) : `Error: ${res.error}`;
      }
      case 'search_known_sites':
        return searchKnownSites(this.scopedCapabilities(await getCapabilities()), String(args.query));
      case 'list_mcp_tools': {
        const caps = this.scopedCapabilities(await getCapabilities());
        const resolved = resolveMcpServer(caps, String(args.server));
        if (!resolved) {
          return `Error: no MCP server hint named "${String(args.server)}". Add one in Settings → Hints (set an MCP endpoint URL), or pass the full MCP URL.`;
        }
        // Use auth config from capability when available.
        const mcpCap = caps.find((c) => c.mcpUrl === resolved.endpoint || c.name.toLowerCase() === String(args.server).toLowerCase());
        const mcpAuth = mcpCap ? resolveAuth(mcpCap) : null;
        const token = mcpAuth?.method === 'token' ? mcpAuth.token : resolved.token;
        try {
          let tools = await mcpListTools(resolved.endpoint, token);
          const q = String(args.query ?? '').trim().toLowerCase();
          if (q) {
            const terms = q.split(/\s+/).filter((t) => t.length > 1);
            tools = tools
              .map((t) => {
                const hay = `${t.name} ${t.description ?? ''}`.toLowerCase();
                return { t, score: terms.filter((term) => hay.includes(term)).length };
              })
              .filter((x) => x.score > 0)
              .sort((a, b) => b.score - a.score)
              .map((x) => x.t);
          }
          if (tools.length === 0) return 'The MCP server exposed no matching methods.';
          return JSON.stringify(tools);
        } catch (err) {
          return `Error listing MCP methods: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      case 'call_mcp_tool': {
        const caps = this.scopedCapabilities(await getCapabilities());
        const resolved = resolveMcpServer(caps, String(args.server));
        if (!resolved) return `Error: no MCP server "${String(args.server)}".`;
        const mcpCap = caps.find((c) => c.mcpUrl === resolved.endpoint || c.name.toLowerCase() === String(args.server).toLowerCase());
        const mcpAuth = mcpCap ? resolveAuth(mcpCap) : null;
        const token = mcpAuth?.method === 'token' ? mcpAuth.token : resolved.token;
        const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;
        try {
          return await mcpCallTool(resolved.endpoint, token, String(args.name), toolArgs);
        } catch (err) {
          return `Error calling MCP method "${String(args.name)}": ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      case 'list_webmcp_tools': {
        const tabId = args.tabId !== undefined ? Number(args.tabId) : (await browser.getActiveTab()).tabId;
        return browser.listWebmcpTools(tabId);
      }
      case 'call_webmcp_tool': {
        const tabId = args.tabId !== undefined ? Number(args.tabId) : (await browser.getActiveTab()).tabId;
        const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;
        return browser.callWebmcpTool(tabId, String(args.name), toolArgs);
      }
      case 'sharepoint_search': {
        const settings = await getSettings();
        let base = settings?.sharepointBaseUrl?.trim();
        if (!base) {
          try {
            const u = new URL((await browser.getActiveTab()).url);
            if (/\.sharepoint\.com$/i.test(u.hostname)) base = u.origin;
          } catch {
            // no usable active tab
          }
        }
        if (!base) {
          return 'Error: no SharePoint base URL. Ask the user to set it in Settings (e.g. https://contoso.sharepoint.com) or to open a SharePoint tab, then retry.';
        }
        return browser.sharepointSearch(base, {
          query: args.query ? String(args.query) : undefined,
          top: Number(args.top) || 10,
          sortBy: args.sortBy === 'modified' ? 'modified' : 'relevance',
          editedByMe: Boolean(args.editedByMe),
        });
      }
      case 'calendar_search': {
        const settings = await getSettings();
        if (!settings) return 'Error: no model configured.';
        const since = normalizeCalendarDate(args.since, startOfTodayIso());
        const until = normalizeCalendarDate(args.until, addDaysIso(since, 7));
        try {
          const token = await getAccessToken(settings.graphClientId ?? '', settings.graphTenant || 'organizations');
          const data = await graphGet(buildCalendarViewUrl(since, until, args.includeBody !== false), token);
          const events = parseCalendarView(data)
            .filter((event) => eventMatchesQuery(event, args.query ? String(args.query) : undefined))
            .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
            .slice(0, clampCalendarTop(args.top));
          return JSON.stringify({ since, until, count: events.length, events });
        } catch (e) {
          return `Error reading Outlook calendar: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      case 'schedule_task': {
        const recurrenceArg = args.recurrence as Record<string, unknown> | undefined;
        const recurrence: ScheduledTaskRecurrence | undefined = recurrenceArg
          ? {
              kind: recurrenceArg.kind === 'weekly' || recurrenceArg.kind === 'interval' ? recurrenceArg.kind : 'daily',
              timeOfDay: recurrenceArg.timeOfDay ? String(recurrenceArg.timeOfDay) : undefined,
              daysOfWeek: Array.isArray(recurrenceArg.daysOfWeek) ? recurrenceArg.daysOfWeek.map(Number) : undefined,
              intervalMinutes: recurrenceArg.intervalMinutes ? Number(recurrenceArg.intervalMinutes) : undefined,
            }
          : undefined;
        try {
          const task = await createScheduledTask({
            title: String(args.title ?? ''),
            prompt: String(args.prompt ?? ''),
            runAt: args.runAt ? String(args.runAt) : undefined,
            recurrence,
          });
          return JSON.stringify({ ok: true, task: { ...task, nextRunAtIso: new Date(task.nextRunAt).toISOString() } });
        } catch (e) {
          return `Error scheduling task: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      case 'list_scheduled_tasks': {
        const tasks = await getScheduledTasks();
        return JSON.stringify({ tasks: summarizeScheduledTasks(tasks) });
      }
      case 'cancel_scheduled_task': {
        const id = String(args.id ?? '').trim();
        if (!id) return 'Error: cancel_scheduled_task needs an id.';
        const ok = await cancelScheduledTask(id);
        return JSON.stringify({ ok, id, error: ok ? undefined : 'No scheduled task with that id.' });
      }
      case 'draft_email': {
        const settings = await getSettings();
        if (!settings) return 'Error: no model configured.';
        const to = stringArray(args.to);
        const cc = stringArray(args.cc);
        const bcc = stringArray(args.bcc);
        const subject = String(args.subject ?? '').trim();
        const body = String(args.body ?? '').trim();
        if (to.length === 0) return 'Error: draft_email needs at least one recipient.';
        if (!subject) return 'Error: draft_email needs a subject.';
        if (!body) return 'Error: draft_email needs a body.';
        try {
          const token = await getAccessToken(settings.graphClientId ?? '', settings.graphTenant || 'organizations');
          const message = buildGraphDraftMessage({
            to,
            cc,
            bcc,
            subject,
            body,
            bodyType: emailBodyType(args.bodyType),
            importance: emailImportance(args.importance),
          });
          const data = await graphPostJson(createMessageUrl(), token, message);
          const draft = parseGraphDraftResponse(data);
          return JSON.stringify({ ok: true, draft, to, cc, bcc, subject, sent: false });
        } catch (e) {
          return `Error creating Outlook draft: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      case 'microsoft365_search': {
        const settings = await getSettings();
        const source =
          args.source === 'mail' || args.source === 'files' ? args.source : 'both';
        const filters: M365SearchFilters = {
          query: args.query ? String(args.query) : undefined,
          from: args.from ? String(args.from) : undefined,
          fileType: args.fileType ? String(args.fileType) : undefined,
          sitePath: args.sitePath ? String(args.sitePath) : undefined,
          editedByMe: Boolean(args.editedByMe),
          since: args.since ? String(args.since) : undefined,
          until: args.until ? String(args.until) : undefined,
          orderBy: args.orderBy === 'relevance' ? 'relevance' : 'date',
          top: Number(args.top) || 10,
        };

        const resolveSpBase = async (): Promise<string | undefined> => {
          let base = settings?.sharepointBaseUrl?.trim();
          if (!base) {
            try {
              const u = new URL((await browser.getActiveTab()).url);
              if (/\.sharepoint\.com$/i.test(u.hostname)) base = u.origin;
            } catch {
              // no usable active tab
            }
          }
          return base;
        };

        const wantFiles = source === 'files' || source === 'both';
        const wantMail = source === 'mail' || source === 'both';
        const [fileOut, mailOut] = await Promise.all([
          wantFiles
            ? (async () => {
                const base = await resolveSpBase();
                if (!base) {
                  return {
                    error:
                      'No SharePoint base URL. Set it in Settings (e.g. https://contoso.sharepoint.com) or open a SharePoint tab.',
                  };
                }
                return browser.fileSearch(base, filters);
              })()
            : Promise.resolve(null),
          wantMail
            ? browser.graphMailSearch(settings?.graphClientId ?? '', settings?.graphTenant || 'organizations', filters)
            : Promise.resolve(null),
        ]);

        const payload: Record<string, unknown> = { source };
        if (fileOut) {
          if ('error' in fileOut) payload.filesError = fileOut.error;
          else payload.files = fileOut.results;
        }
        if (mailOut) {
          if ('error' in mailOut) payload.mailError = mailOut.error;
          else payload.mail = mailOut.results;
        }
        return JSON.stringify(payload);
      }
      case 'export_data':
        return this.exportData(args);
      case 'create_file':
        return this.createFile(args);
      case 'create_image':
        return this.createImage(args);
      case 'create_word_document':
        return this.createWordDocument(args);
      case 'create_powerpoint':
        return this.createPowerpoint(args);
      case 'set_plan':
        return this.setPlan(Array.isArray(args.steps) ? (args.steps as string[]).map(String) : []);
      case 'update_plan':
        return this.updatePlan(Number(args.step), args.status as PlanStepStatus);
      case 'record_finding':
        return this.recordFinding(String(args.text));
      case 'save_memory': {
        if (this.memoryGraph.nodes.length >= MEMORY_NODE_CAP) {
          return `Error: memory is full (${MEMORY_NODE_CAP} entries). Consolidate or delete entries before saving more.`;
        }
        const settings = await getSettings();
        if (!settings) return 'Error: no LLM connection configured, so the memory cannot be embedded.';
        const now = new Date().toISOString();
        const text = String(args.text).trim();
        const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
        const sourceUrl = typeof args.sourceUrl === 'string' ? args.sourceUrl.trim() : '';
        const sourceTitle = typeof args.sourceTitle === 'string' ? args.sourceTitle.trim() : '';
        const kind: MemoryNodeKind = ['entity', 'fact', 'preference', 'event'].includes(String(args.kind))
          ? (args.kind as MemoryNodeKind)
          : 'fact';
        const node: MemoryNode = {
          id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind,
          label: subject || text.split(/\s+/).slice(0, 6).join(' '),
          summary: text,
          confidence: 1,
          durability: 0.7,
          status: 'active',
          projectId: this.activeProjectId ?? undefined,
          createdAt: now,
          updatedAt: now,
          lastConfirmedAt: now,
          provenance: this.currentConversationId
            ? [
                {
                  conversationId: this.currentConversationId,
                  excerpt: text.slice(0, 200),
                  at: now,
                  ...(sourceUrl ? { sourceUrl } : {}),
                  ...(sourceTitle ? { sourceTitle } : {}),
                },
              ]
            : [],
        };
        this.memoryGraph = { ...this.memoryGraph, nodes: [...this.memoryGraph.nodes, node] };
        await saveMemoryGraph(this.memoryGraph);
        await this.upsertMemoryIndex(settings, [node]);
        return `Saved memory [${node.id}]: ${node.summary}`;
      }
      case 'update_memory': {
        const settings = await getSettings();
        if (!settings) return 'Error: no LLM connection configured, so the memory cannot be re-embedded.';
        const id = String(args.id);
        const existing = this.memoryGraph.nodes.find((n) => n.id === id);
        if (!existing) return `Error: no memory entry with id ${id}.`;
        const now = new Date().toISOString();
        const updated: MemoryNode = { ...existing, summary: String(args.text).trim(), status: 'active', updatedAt: now, lastConfirmedAt: now };
        this.memoryGraph = { ...this.memoryGraph, nodes: this.memoryGraph.nodes.map((n) => (n.id === id ? updated : n)) };
        await saveMemoryGraph(this.memoryGraph);
        await this.upsertMemoryIndex(settings, [updated]);
        return `Updated memory [${id}]: ${updated.summary}`;
      }
      case 'delete_memory': {
        const id = String(args.id);
        if (!this.memoryGraph.nodes.some((n) => n.id === id)) return `Error: no memory entry with id ${id}.`;
        this.memoryGraph = {
          ...this.memoryGraph,
          nodes: this.memoryGraph.nodes.filter((n) => n.id !== id),
          edges: this.memoryGraph.edges.filter((e) => e.from !== id && e.to !== id),
        };
        await saveMemoryGraph(this.memoryGraph);
        await memoryIndexRemove([id]);
        return `Deleted memory [${id}].`;
      }
      case 'save_as_skill': {
        const result = await this.packageTaskAsSkill({ kind: 'generated', installedAt: new Date().toISOString() });
        if (!result.ok) return `Error: could not save a skill from this task: ${result.error}`;
        this.setDistill(false); // the "Save as skill" button would now duplicate this
        return `Saved skill /${result.name} from this task — edit it in Settings → Skills.`;
      }
      case 'save_app_playbook': {
        const origin = normalizeHost(String(args.origin));
        if (!origin) return 'Error: a site origin is required to save an app playbook.';
        const skills = await getSkills();
        const playbook: Skill = {
          id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: String(args.name).trim() || 'playbook',
          description: String(args.description).trim(),
          body: String(args.body).trim(),
          origin,
          projectId: this.activeProjectId ?? undefined,
        };
        // One playbook per site: replace any existing playbook bound to this
        // origin, regardless of name, so re-learning updates rather than duplicates.
        // Only a playbook visible under the active project counts as "existing" —
        // otherwise re-learning a site from project A would silently overwrite
        // project B's playbook for that same origin.
        const existing = this.scopedSkills(skills).find((s) => s.origin === origin);
        const idx = existing ? skills.findIndex((s) => s.id === existing.id) : -1;
        const replaced = idx >= 0;
        if (replaced) {
          playbook.id = skills[idx].id;
          skills[idx] = playbook;
        } else {
          skills.push(playbook);
        }
        await saveSkills(skills);
        return `${replaced ? 'Updated' : 'Saved'} app playbook "${playbook.name}" for ${origin}. It will auto-activate on that site.`;
      }
      case 'use_skill': {
        const skills = this.scopedSkills(await getSkills());
        const wanted = String(args.name).toLowerCase().replace(/^\//, '');
        const skill = skills.find((s) => s.name.toLowerCase() === wanted);
        if (!skill) {
          const available = skills.map((s) => s.name).join(', ') || '(none defined)';
          return `Error: no skill named "${wanted}". Available skills: ${available}`;
        }
        return `Skill "${skill.name}" loaded. Follow these instructions for the current task:\n\n${skill.body}`;
      }
      case 'get_element_map':
        return JSON.stringify((await browser.getElementMap(tabId)).slice(0, 120));
      case 'query_pointer_target':
        return browser.queryPointerTarget(tabId);
      case 'read_app_content':
        return browser.readAppContent(tabId);
      case 'capture_full_page': {
        const active = await browser.getActiveTab();
        const result = await captureFullPage(active.tabId, Number(args.maxFrames) || 12);
        if (result.error) return JSON.stringify({ error: result.error });
        if (result.frames.length === 0) return JSON.stringify({ error: 'No frames captured.' });
        this.pendingToolImages.push(...result.frames);
        return `Captured ${result.frames.length} page frame(s), top to bottom — they are attached as images below. Read them in order to understand the full page.`;
      }
      case 'click_element':
        return JSON.stringify(await browser.clickElement(tabId, String(args.selectorOrRef)));
      case 'fill_input':
        return JSON.stringify(
          await browser.fillInput(tabId, String(args.selectorOrRef), String(args.value)),
        );
      case 'submit_form':
        return JSON.stringify(await browser.submitForm(tabId, String(args.selectorOrRef)));
      case 'run_javascript':
        return browser.runJavascript(tabId, String(args.code));
      case 'press_keys':
        return JSON.stringify(
          await browser.pressKeys(tabId, String(args.combo), args.targetRef ? String(args.targetRef) : undefined),
        );
      case 'wait_for_element':
        return JSON.stringify(
          await browser.waitForElement(
            tabId,
            String(args.selector),
            (args.state as 'present' | 'visible' | 'enabled') ?? 'visible',
            typeof args.timeoutMs === 'number' ? args.timeoutMs : 8000,
          ),
        );
      case 'click_at':
        return JSON.stringify(await browser.clickAt(tabId, Number(args.x), Number(args.y)));
      case 'drag':
        return JSON.stringify(
          await browser.drag(tabId, Number(args.fromX), Number(args.fromY), Number(args.toX), Number(args.toY)),
        );
      case 'scroll_wheel':
        return JSON.stringify(await browser.scrollWheel(tabId, Number(args.x), Number(args.y), Number(args.deltaY)));
      case 'read_pdf':
        return browser.readPdf(
          args.tabId !== undefined ? Number(args.tabId) : undefined,
          args.url ? String(args.url) : undefined,
        );
      case 'read_office_document':
        return browser.readOfficeDocument(
          args.tabId !== undefined ? Number(args.tabId) : undefined,
          args.url ? String(args.url) : undefined,
        );
      case 'get_video_transcript': {
        const vidTab = args.tabId !== undefined ? Number(args.tabId) : (await browser.getActiveTab()).tabId;
        return browser.getVideoTranscript(vidTab, args.lang ? String(args.lang) : undefined);
      }
      case 'wait_for_page_state':
        return JSON.stringify(await browser.waitForPageState(tabId));
      case 'detect_auth_state': {
        const state = await browser.detectAuthState(tabId);
        await this.pauseForAuth(state, tabId);
        return JSON.stringify(state);
      }
      default:
        return `Error: unknown tool ${name}.`;
    }
  }

  // ----- auth pause/resume -----

  private async pauseIfAuthRequired(content: PageContent): Promise<void> {
    if (content.extractionStatus !== 'auth_required') return;
    await this.pauseForAuth(
      { status: 'auth_required', loginUrl: content.url },
      content.tabId,
    );
  }

  private async pauseForAuth(state: AuthState, tabId: number): Promise<void> {
    if (state.status !== 'auth_required' || this.stopRequested) return;
    let origin = '';
    try {
      origin = new URL(state.loginUrl ?? (await chrome.tabs.get(tabId)).url ?? '').hostname;
    } catch {
      origin = 'this site';
    }
    // If we already paused for this origin and the user resumed, yet it still looks
    // like a login wall, treat the signal as a false positive (e.g. a "Sign in" link
    // in the site chrome) and proceed — re-pausing would loop forever and exhaust the
    // step budget without making progress (the original pagination-stops-after-2-pages bug).
    if (this.authResumedOrigins.has(origin)) {
      this.notice(
        `Already signed in for ${origin} this session — treating the repeated login-wall signal as a false positive and continuing.`,
      );
      return;
    }
    const message = `Authentication required for ${origin}. Complete login in the browser, then click Resume.`;
    this.setStatus('auth_required', message);
    this.emit({ type: 'auth_required', origin, message });
    this.notice(message);
    await new Promise<void>((resolve) => {
      this.authWait = { origin, message, resolve };
    });
    if (!this.stopRequested) {
      this.authResumedOrigins.add(origin);
      this.notice('Resumed. Re-checking the page…');
      this.setStatus('acting');
    }
  }

  private async pauseForPermission(origin: string): Promise<void> {
    if (this.stopRequested) return;
    const message = `CANChat Agent needs access to ${origin.replace(/^https?:\/\//, '')} to read this page. Allow it to continue.`;
    this.setStatus('awaiting_approval', message);
    this.emit({ type: 'permission_required', origin, message });
    this.notice(message);
    await new Promise<void>((resolve) => {
      this.permissionWait = { origin, message, resolve };
    });
    if (!this.stopRequested) {
      this.notice('Access granted. Retrying…');
      this.setStatus('acting');
    }
  }

  // ----- approvals and pause -----

  /**
   * Pause the loop and ask the user to approve a state-changing action. Returns
   * a promise that stays pending until the panel sends an `approval_response`
   * (routed to `approvalResponse`, which resolves it). The `description` is the
   * model's plain-language `reason`; `detail` is the concrete action summary.
   */
  private requestApproval(description: string, detail: string, approvalContext?: ApprovalContext): Promise<boolean> {
    this.setStatus('awaiting_approval', description);
    const requestId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.emit({ type: 'approval_request', requestId, description, detail, approvalContext });
    return new Promise<boolean>((resolve) => {
      this.pendingApproval = { requestId, description, detail, approvalContext, resolve };
    });
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.pauseRequested) return;
    this.setStatus('paused');
    await new Promise<void>((resolve) => {
      this.pauseWaiter = resolve;
    });
  }

  // ----- working state (plan, findings, budget) -----

  // Build the outgoing message array for a model call: the persisted conversation
  // plus live working state folded into the initial system message. Built fresh
  // per call and never stored, so volatile state never lands in history,
  // compaction, or persistence. Folding avoids system/user/system role sequences
  // that stricter local chat templates reject.
  private withWorkingState(): LlmMessage[] {
    return withMergedSystemState(repairToolPairing(this.conversation), this.buildStateBlock());
  }

  private buildStateBlock(): string {
    const remaining = Math.max(0, this.stepBudget - this.stepsUsed);
    const lines: string[] = ['\n\n=== Working state (updated each step) ==='];
    if (this.activeTabLabel)
      lines.push(
        `Active tab (live URL): ${this.activeTabLabel} — page text fetched earlier in this conversation may be from a different URL; re-read with get_tab_content when answering about the current page.`,
      );
    lines.push(`Steps: ${this.stepsUsed}/${this.stepBudget} used (${remaining} left).`);
    if (this.knownSiteNames.length > 0) {
      lines.push(
        `Known sites available — prefer these over web search when the task's data could live on one (details in the Known sites directory above): ${this.knownSiteNames.slice(0, 25).join(', ')}.`,
      );
    }
    if (this.groupName) {
      lines.push(
        `Tab group for this conversation: "${this.groupName}" — tabs you open are collected here; the user may refer to it by name (e.g. "the ${this.groupName} group").`,
      );
    }
    if (this.plan) {
      const icon: Record<PlanStepStatus, string> = {
        pending: '[ ]',
        in_progress: '[»]',
        done: '[x]',
        skipped: '[-]',
      };
      lines.push('Plan:');
      this.plan.forEach((s, i) => lines.push(`  ${icon[s.status]} ${i + 1}. ${s.text}`));
    } else {
      lines.push('Plan: none yet. If this task needs more than a couple of steps, call set_plan first.');
    }
    if (this.findings.length > 0) {
      lines.push('Findings so far:');
      this.findings.slice(-FINDINGS_SHOWN).forEach((f) => lines.push(`  - ${f}`));
    }
    if (remaining <= 3) {
      lines.push(
        'You are low on steps. Record any remaining findings and prepare to give your best final answer soon.',
      );
    }
    if (this.relevantMemoryBlock) lines.push(this.relevantMemoryBlock);
    return lines.join('\n');
  }

  private setPlan(steps: string[]): string {
    this.plan = steps.filter((s) => s.trim()).map((text) => ({ text: text.trim(), status: 'pending' as PlanStepStatus }));
    this.emit({ type: 'plan_update', plan: this.planView() });
    return `Plan set with ${this.plan.length} steps.`;
  }

  private updatePlan(step: number, status: PlanStepStatus): string {
    if (!this.plan || step < 1 || step > this.plan.length) {
      return `Error: no plan step ${step}. Call set_plan first.`;
    }
    this.plan[step - 1].status = status;
    this.emit({ type: 'plan_update', plan: this.planView() });
    return `Step ${step} marked ${status}.`;
  }

  /**
   * If `url` points at an Office or PDF file, read it with the right reader and
   * return the extracted text — instead of letting open_url/navigate hand it to
   * the browser, which would download the file and leave nothing to process.
   * Returns null for ordinary pages so navigation proceeds normally.
   */
  private async maybeReadDocumentUrl(url: string): Promise<string | null> {
    const kind = documentKindForUrl(url);
    if (kind === 'office') return browser.readOfficeDocument(undefined, url);
    if (kind === 'pdf') return browser.readPdf(undefined, url);
    return null;
  }

  private async repoQueryVariants(settings: Settings, query: string): Promise<string[]> {
    try {
      const reply = await complete(
        resolveModelForRole(settings, 'utility'),
        [
          { role: 'system', content: 'Generate 2 concise retrieval query paraphrases for RAG search. Preserve names, dates, codes, and quoted terms. Return ONLY JSON: {"queries":["..."]}.' },
          { role: 'user', content: query },
        ],
        undefined,
        this.makeSignal(),
      );
      const obj = extractJsonObject(reply.content ?? '{}') as { queries?: unknown };
      return uniqueQueries(query, obj.queries);
    } catch {
      return [query];
    }
  }

  private async rerankRepoHits(settings: Settings, query: string, hits: SearchHit[], k: number): Promise<SearchHit[]> {
    if (hits.length <= k) return hits.slice(0, k);
    try {
      const candidates = hits.slice(0, 20).map((h, i) => ({ id: i + 1, name: h.name, url: h.url, text: h.text.slice(0, 1200) }));
      const reply = await complete(
        resolveModelForRole(settings, 'utility'),
        [
          { role: 'system', content: 'Rerank retrieval chunks for direct usefulness in answering the query. Prefer specific, answer-bearing chunks over generic or duplicate chunks. Return ONLY JSON: {"ids":[candidate ids in best order]}.' },
          { role: 'user', content: JSON.stringify({ query, candidates }) },
        ],
        undefined,
        this.makeSignal(),
      );
      const obj = extractJsonObject(reply.content ?? '{}') as { ids?: unknown };
      const ids = Array.isArray(obj.ids) ? obj.ids.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length) : [];
      const seen = new Set<number>();
      const reranked: SearchHit[] = [];
      for (const id of ids) {
        const idx = id - 1;
        if (!seen.has(idx) && hits[idx]) {
          seen.add(idx);
          reranked.push(hits[idx]);
        }
        if (reranked.length >= k) break;
      }
      for (let i = 0; reranked.length < k && i < hits.length; i++) if (!seen.has(i)) reranked.push(hits[i]);
      return reranked;
    } catch {
      return hits.slice(0, k);
    }
  }

  private exportData(args: Record<string, unknown>): string {
    const title = String(args.title ?? 'data').trim() || 'data';
    const columns = Array.isArray(args.columns) ? (args.columns as unknown[]).map(String) : [];
    let rows = Array.isArray(args.rows)
      ? (args.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map(String) : [String(r)]))
      : [];
    if (columns.length === 0 || rows.length === 0) {
      return 'Error: export_data needs at least one column and one row.';
    }
    let note = '';
    if (rows.length > 5000) {
      rows = rows.slice(0, 5000);
      note = ' (truncated to 5000 rows)';
    }
    const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'data'}.csv`;
    const dataExport: DataExport = { title, filename, columns, rows };
    this.pushChat({
      role: 'notice',
      text: `Prepared a table: "${title}" (${rows.length} rows × ${columns.length} columns)${note}. Download it from the card below.`,
      timestamp: new Date().toISOString(),
      dataExport,
    });
    return `Exported ${rows.length} rows${note}. The user can download it as CSV or JSON from the card.`;
  }

  private createFile(args: Record<string, unknown>): string {
    const filename = sanitizeTextFilename(String(args.filename ?? '').trim());
    const content = String(args.content ?? '');
    if (!filename) {
      return 'Error: create_file needs a filename.';
    }
    const fileArtifact: FileArtifact = {
      filename,
      mimeType: mimeTypeForTextFile(filename),
      dataBase64: encodeUtf8Base64(content),
    };
    this.pushChat({
      role: 'notice',
      text: `Prepared a file: "${filename}". Download it from the card below.`,
      timestamp: new Date().toISOString(),
      fileArtifact,
    });
    return `Created the file "${filename}" (${content.length} characters). The user can download it from the card.`;
  }

  private async createImage(args: Record<string, unknown>): Promise<string> {
    const settings = await getSettings();
    const apiKey = settings?.ideogramApiKey?.trim();
    if (!apiKey) {
      return 'Error: create_image needs an Ideogram API key. Add it in Settings.';
    }
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) {
      return 'Error: create_image needs a prompt.';
    }
    const aspectRatio = String(args.aspectRatio ?? 'ASPECT_1_1').trim() || 'ASPECT_1_1';
    const styleType = String(args.styleType ?? 'AUTO').trim() || 'AUTO';
    const model = String(args.model ?? 'V_2').trim() || 'V_2';
    const response = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
      },
      body: JSON.stringify({
        image_request: {
          prompt,
          aspect_ratio: aspectRatio,
          style_type: styleType,
          model,
          num_images: 1,
        },
      }),
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).trim();
      } catch {
        detail = '';
      }
      return `Error: Ideogram returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
    }
    let payload: any;
    try {
      payload = await response.json();
    } catch (e) {
      return `Error: could not parse Ideogram response: ${String(e)}`;
    }
    const first = Array.isArray(payload?.data) ? payload.data[0] : null;
    const imageUrl = String(first?.url ?? first?.image_url ?? first?.imageUrl ?? '').trim();
    const inlineBase64 = String(first?.b64_json ?? first?.image_base64 ?? first?.base64 ?? '').trim();
    let dataBase64 = '';
    let mimeType = String(first?.mime_type ?? first?.mimeType ?? '').trim().toLowerCase() || 'image/png';
    if (inlineBase64) {
      dataBase64 = inlineBase64;
    } else if (imageUrl) {
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        return `Error: downloading the generated image returned HTTP ${imageResponse.status}.`;
      }
      const bytes = new Uint8Array(await imageResponse.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return `Error: generated image is too large (> ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB).`;
      }
      dataBase64 = bytesToBase64(bytes);
      const contentType = imageResponse.headers.get('content-type');
      mimeType = contentType ? contentType.split(';')[0].trim().toLowerCase() : mimeType;
    } else {
      return 'Error: Ideogram response did not include an image URL.';
    }
    const slug = prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'ideogram-image';
    const fileArtifact: FileArtifact = {
      filename: `ideogram-${slug}.${imageExtensionForMimeType(mimeType)}`,
      mimeType,
      dataBase64,
    };
    this.pushChat({
      role: 'notice',
      text: `Prepared an image from the prompt. Download it from the card below.`,
      timestamp: new Date().toISOString(),
      fileArtifact,
    });
    return `Created the image "${fileArtifact.filename}". The user can download it from the card.`;
  }

  /**
   * Generate a downloadable .docx from markdown via the offscreen document, then
   * attach it to a notice message as a fileArtifact (mirrors exportData). The
   * generated bytes never touch the model — only a short confirmation is returned.
   */
  private async createWordDocument(args: Record<string, unknown>): Promise<string> {
    const title = String(args.title ?? '').trim();
    const markdown = String(args.markdown ?? '');
    if (!title && !markdown.trim()) {
      return 'Error: create_word_document needs a title or markdown content.';
    }
    const slug = (String(args.filename ?? '') || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
    const result = await generateDocument('docx', title, markdown);
    if (!result.ok || !result.dataBase64) {
      return `Error: could not generate the document. ${result.error ?? ''}`.trim();
    }
    const fileArtifact: FileArtifact = {
      filename: `${slug}.docx`,
      mimeType: result.mimeType ?? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      dataBase64: result.dataBase64,
    };
    this.pushChat({
      role: 'notice',
      text: `Prepared a Word document: "${title || fileArtifact.filename}". Download it from the card below.`,
      timestamp: new Date().toISOString(),
      fileArtifact,
    });
    return `Created the Word document "${fileArtifact.filename}". The user can download it from the card.`;
  }

  private async createPowerpoint(args: Record<string, unknown>): Promise<string> {
    const title = String(args.title ?? '').trim();
    const slides = normalizeSlides(args.slides);
    if (!title && slides.length === 0) {
      return 'Error: create_powerpoint needs a title and a slides array.';
    }
    const slug = (String(args.filename ?? '') || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'presentation';
    const result = await generatePresentation(title, slides);
    if (!result.ok || !result.dataBase64) {
      return `Error: could not generate the presentation. ${result.error ?? ''}`.trim();
    }
    const fileArtifact: FileArtifact = {
      filename: `${slug}.pptx`,
      mimeType: result.mimeType ?? 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      dataBase64: result.dataBase64,
    };
    this.pushChat({
      role: 'notice',
      text: `Prepared a PowerPoint deck: "${title || fileArtifact.filename}" (${slides.length} slide${slides.length === 1 ? '' : 's'}). Download it from the card below.`,
      timestamp: new Date().toISOString(),
      fileArtifact,
    });
    return `Created the PowerPoint "${fileArtifact.filename}" with ${slides.length} slide(s). The user can download it from the card.`;
  }

  /**
   * The working-state (relevant-subgraph) tier: nodes found relevant to this
   * user turn by embedding search, one hop of edges expanded, excluding
   * whatever is already in the core (systemBase) tier. Computed once per
   * turn (not per agent step within it) and cached on `relevantMemoryBlock`
   * for `buildStateBlock`. Degrades to '' (never throws) so an unavailable
   * index/embedder only loses the extra context, not the turn.
   */
  private async computeRelevantMemoryBlock(settings: Settings, userText: string): Promise<string> {
    if (this.memoryGraph.nodes.length === 0 || !userText.trim()) return '';
    const coreIds = new Set(rankCoreMemoryNodes(this.memoryGraph, this.activeProjectId).map((n) => n.id));
    const hits = await memoryIndexSearch(settings, userText, 5);
    if (!hits) return ''; // index unavailable — the core tier still answers what it can
    const byId = new Map(this.memoryGraph.nodes.map((n) => [n.id, n]));
    const found: MemoryNode[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const node = byId.get(hit.nodeId);
      if (!node || node.status === 'superseded' || coreIds.has(node.id) || seen.has(node.id)) continue;
      if (!visibleToProject(node.projectId, this.activeProjectId)) continue;
      found.push(node);
      seen.add(node.id);
    }
    // Expand one hop of edges from the found nodes, pulling in their active neighbors.
    const frontier = new Set(found.map((n) => n.id));
    for (const edge of this.memoryGraph.edges) {
      if (edge.status !== 'active') continue;
      const neighborId = frontier.has(edge.from) ? edge.to : frontier.has(edge.to) ? edge.from : null;
      if (!neighborId || coreIds.has(neighborId) || seen.has(neighborId)) continue;
      const neighbor = byId.get(neighborId);
      if (!neighbor || neighbor.status === 'superseded') continue;
      if (!visibleToProject(neighbor.projectId, this.activeProjectId)) continue;
      found.push(neighbor);
      seen.add(neighborId);
    }
    return renderRelevantMemoryBlock(found);
  }

  /**
   * Upsert nodes into the memory embedding index, transparently rebuilding
   * the whole index from `this.memoryGraph` if the repo's embed-model lock
   * has tripped (the user switched embedders since the index was built) and
   * retrying once. A failure here never blocks the tool call from succeeding
   * — the graph itself (already persisted) remains the source of truth even
   * if the index falls behind; a later rebuild will catch it up.
   */
  private async upsertMemoryIndex(settings: Settings, nodes: MemoryNode[]): Promise<void> {
    try {
      await memoryIndexUpsert(settings, nodes);
    } catch {
      try {
        await rebuildMemoryIndex(settings, this.memoryGraph.nodes);
      } catch {
        // Index unavailable (offscreen/embedder down) — the graph is still saved.
      }
    }
  }

  private recordFinding(text: string): string {
    const t = text.trim();
    if (!t) return 'Error: empty finding.';
    this.findings.push(t);
    return `Recorded. (${this.findings.length} findings so far.)`;
  }

  private planHasOpenSteps(): boolean {
    return this.plan?.some((s) => s.status === 'pending' || s.status === 'in_progress') ?? false;
  }

  /**
   * True when the model laid out a real plan (≥2 steps) but hasn't worked it at
   * all — open steps remain and none are marked done. This is the "set a plan,
   * then answer without executing it" signature; a partially-done plan is trusted
   * as a legitimate early finish.
   */
  private planUnstarted(): boolean {
    if (!this.plan || this.plan.length < 2) return false;
    if (!this.planHasOpenSteps()) return false;
    return !this.plan.some((s) => s.status === 'done');
  }

  // ----- helpers -----

  private buildContextBlock(): string {
    const snapshot = tabContext.getSnapshot();
    if (!snapshot) return '';
    const stale = tabContext.isStale(snapshot);
    const perTab = snapshot.tabs.length > 1 ? MULTI_TAB_CHARS : SINGLE_TAB_CHARS;
    const parts = snapshot.tabs.map((t, i) => {
      const body =
        t.extractionStatus === 'ok' || t.extractionStatus === 'partial'
          ? t.text.slice(0, perTab)
          : `(content unavailable: ${t.extractionStatus})`;
      return `[Tab ${i + 1}] tabId=${t.tabId} "${t.title}" ${t.url}\n${body}`;
    });
    return (
      `Context: the user has shared ${snapshot.tabs.length} tab(s) with you` +
      (stale ? ' (captured more than 5 minutes ago; may be stale — re-fetch if freshness matters)' : '') +
      `:\n\n${parts.join('\n\n---\n\n')}`
    );
  }

  private contentForModel(content: PageContent, maxChars: number): Record<string, unknown> {
    return {
      tabId: content.tabId,
      url: content.url,
      title: content.title,
      extractionStatus: content.extractionStatus,
      headings: content.headings.slice(0, 20),
      text: content.text.slice(0, maxChars),
      capturedAt: content.capturedAt,
    };
  }

  private serializeContent(content: PageContent, maxChars: number): string {
    return JSON.stringify({
      ...this.contentForModel(content, maxChars),
      links: content.links.slice(0, 40),
      metadata: content.metadata,
    });
  }

  private describeAction(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case 'get_all_tab_contents':
        return 'Read the contents of all open tabs';
      case 'click_element':
        return `Click element "${args.selectorOrRef}" on tab ${args.tabId}`;
      case 'fill_input':
        return `Type into element "${args.selectorOrRef}" on tab ${args.tabId}: "${String(args.value).slice(0, 80)}"`;
      case 'submit_form':
        return `Submit the form at "${args.selectorOrRef}" on tab ${args.tabId}`;
      case 'run_javascript':
        return `Run JavaScript on tab ${args.tabId}:\n${String(args.code).slice(0, 200)}`;
      case 'press_keys':
        return `Press "${args.combo}" on tab ${args.tabId}`;
      case 'click_at':
        return `Click at (${args.x}, ${args.y}) on tab ${args.tabId}`;
      case 'drag':
        return `Drag (${args.fromX}, ${args.fromY}) → (${args.toX}, ${args.toY}) on tab ${args.tabId}`;
      case 'save_app_playbook':
        return `Save app playbook "${args.name}" for ${normalizeHost(String(args.origin))}:\n${String(args.body).slice(0, 200)}`;
      case 'save_as_skill':
        return 'Save this task as a reusable skill (generalized instructions the agent can reuse for similar tasks).';
      case 'call_mcp_tool':
        return `Call MCP method "${args.name}" on server "${args.server}" with ${JSON.stringify(args.arguments ?? {}).slice(0, 200)}`;
      case 'call_webmcp_tool':
        return `Call the page's in-page tool "${args.name}" with ${JSON.stringify(args.arguments ?? {}).slice(0, 200)}`;
      case 'draft_email':
        return `Create an Outlook draft to ${stringArray(args.to).join(', ')} with subject "${String(args.subject ?? '').slice(0, 120)}". This will not send the email.`;
      case 'schedule_task':
        return `Schedule "${String(args.title ?? '').slice(0, 120)}" to run ${args.runAt ? `at ${args.runAt}` : `on ${JSON.stringify(args.recurrence ?? {})}`}.`;
      case 'cancel_scheduled_task':
        return `Cancel scheduled task ${String(args.id ?? '')}.`;
      default:
        return `${name} ${JSON.stringify(args).slice(0, 120)}`;
    }
  }

  private startActivity(tool: string, args: Record<string, unknown>): ToolActivity {
    const activity: ToolActivity = {
      id: `act-${++this.activityCounter}`,
      tool,
      argsSummary: JSON.stringify(args).slice(0, 200),
      status: 'running',
      timestamp: new Date().toISOString(),
    };
    this.activities.push(activity);
    this.emit({ type: 'tool_activity', activity });
    return activity;
  }

  private finishActivity(activity: ToolActivity, status: ToolActivity['status'], detail?: string): void {
    activity.status = status;
    activity.detail = detail;
    this.emit({ type: 'tool_activity', activity });
  }

  private pushChat(message: ChatMessageView): void {
    this.messages.push(message);
    // In an attended turn, a generated file waits as a card the user clicks to
    // download. In an unattended (scheduled/triggered) run there is no one to
    // click it and firing an OS download prompt for every run is its own kind
    // of annoying (especially with several jobs running), so save it to the
    // durable, browsable Products store instead.
    if (this.unattended && message.fileArtifact) void this.saveFileArtifactToProducts(message.fileArtifact);
    this.emit({ type: 'chat_message', message });
  }

  private async saveFileArtifactToProducts(artifact: FileArtifact): Promise<void> {
    try {
      await productSave(artifact.filename, artifact.mimeType, artifact.dataBase64, {
        sourceTitle: this.unattendedTaskTitle ?? undefined,
        conversationId: this.currentConversationId ?? undefined,
      });
    } catch {
      // Best-effort — the bytes are still retained in the conversation record either way.
    }
  }

  private notice(text: string): void {
    this.pushChat({ role: 'notice', text, timestamp: new Date().toISOString() });
  }

  private setStatus(status: AgentStatus, detail?: string): void {
    this.status = status;
    this.emit({ type: 'status', status, detail });
  }
}
