# CANChat Agent — Specification

A build-from-scratch specification for **CANChat Agent**: a Chromium Manifest V3 browser
extension that puts an AI agent in the browser **side panel** and uses the
**authenticated browser itself as the agent's tool environment**. The agent reads
pages and tabs, drives web apps, searches the open web and the user's own systems,
and runs fully on a user-supplied OpenAI-compatible endpoint. No data leaves the
device except calls the user explicitly configures.

This document is self-contained: it is intended to be handed to a code-generation
tool to regenerate the extension. Where a concrete value matters (a permission, a
tool name, a default), it is stated exactly.

---

## 1. Goals & principles

- **The browser is the toolset.** Prefer doing things through the real, signed-in
  browser (tabs, DOM, the user's cookies/sessions) over external APIs. This gives
  access to authenticated systems with zero integration work.
- **Bring-your-own model.** No bundled key or provider. The user configures any
  **OpenAI-compatible** endpoint (`/chat/completions`, optional `/embeddings`):
  a hosted API, a local server, or a corporate gateway. The key is stored only on
  the device and never synced.
- **Data sovereignty.** All persistence is local (`chrome.storage.local` + OPFS).
  Embeddings for local RAG go to the user's *own* endpoint, so an on-prem endpoint
  keeps everything in-boundary.
- **Safe by default.** Read-only actions run freely; anything that changes page or
  browser state, or runs arbitrary code, requires explicit per-action user
  approval with a plain-language reason.
- **Honest about limits.** Surface caveats (no embeddings route, scanned PDFs,
  canvas apps) instead of failing silently.

---

## 2. Tech stack & toolchain

- **Language:** TypeScript (strict).
- **UI:** Preact + `@preact/preset-vite` (the side panel is a small SPA).
- **Bundler:** Vite, **two builds**:
  - `vite.config.ts` — the app, as ES modules. `rollupOptions.input` has four HTML
    pages — side panel (`sidebar.html`), offscreen document (`offscreen.html`),
    microphone capture page (`microphone.html`), and the full-tab **workspace**
    (`workspace.html`) — plus the service worker (`serviceWorker.js`,
    `type: module`).
  - `vite.content.config.ts` — the **content script** built as a single **IIFE**
    (`contentScript.js`), because content scripts cannot be ES modules.
  - `package.json` build script: `vite build && vite build --config vite.content.config.ts`.
- **Markdown:** `marked` + `dompurify` (render assistant messages safely).
- **PDF:** `pdfjs-dist` v6 (runs in the offscreen document; worker emitted as an asset).
- **Office (OOXML):** `fflate` (~8KB, pure JS — unzip `.docx`/`.pptx`/`.xlsx`) + `DOMParser`, in the offscreen document.
- **Document generation:** `docx` (build `.docx` from Markdown) and `pptxgenjs`
  (build `.pptx` from a slide spec), both **lazy-imported in the offscreen document**.
- **Runtime/tasks:** **mise** pins Node 26 and exposes tasks:
  `mise run install` (npm install), `mise run build`, `mise run typecheck` (`tsc --noEmit`),
  `mise run test`.
- **Tests:** **Vitest** unit suite (pure helpers under `src/**/*.test.ts`) + **Playwright**
  end-to-end specs (`tests/e2e/*.spec.ts`) driven by an offline **mock LLM**
  (`tests/e2e/mockLlm.ts`) that serves `/chat/completions` + `/embeddings` deterministically.
  Scripts: `test` (unit), `test:e2e` (builds then runs Playwright), `test:coverage`.
- **Target:** Chromium ≥ 116 (side panel + offscreen APIs).

Dependencies: `preact`, `marked`, `dompurify`, `pdfjs-dist`, `fflate`, `docx`,
`pptxgenjs`. Dev: `vite`, `@preact/preset-vite`, `typescript`, `@types/chrome`,
`vitest`, `@vitest/coverage-v8`, `@playwright/test`, `jsdom`, `knip`.

---

## 3. Manifest (MV3)

```jsonc
{
  "manifest_version": 3,
  "name": "CANChat Agent",
  "version": "0.1.0",
  "minimum_chrome_version": "116",
  "permissions": [
    "sidePanel", "tabs", "activeTab", "scripting", "storage",
    "search", "bookmarks", "offscreen", "tabGroups", "unlimitedStorage", "downloads",
    "cookies", "alarms", "identity"
  ],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "serviceWorker.js", "type": "module" },
  "side_panel": { "default_path": "sidebar.html" },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "action": { "default_title": "Open CANChat Agent", "default_icon": { … } },
  "icons": { "16": …, "32": …, "48": …, "128": … }
}
```

- **Full permissions are granted at install** (not staged). Rationale: the agent
  needs broad host access to be useful, and staged prompts mid-task are jarring.
- Clicking the toolbar action opens the side panel
  (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`).
- Icon: a maple-leaf mark (the "CAN" in CANChat Agent), four sizes.
- **CSP:** `extension_pages` adds `'wasm-unsafe-eval'` so the offscreen document can
  compile the on-device embedder's ONNX wasm; the runtime's worker + wasm are bundled
  as same-origin assets (no CDN) to satisfy `script-src 'self'`.

Permission roles: `sidePanel` (UI surface) · `tabs`/`activeTab`/`scripting`
(read & drive pages) · `search` (default search engine) · `bookmarks` (@-mention
picker) · `storage` (settings/skills/memory) · `offscreen` (pdf.js + RAG engine) ·
`tabGroups` (per-conversation groups) · `unlimitedStorage` (OPFS vector store not
evicted) · `downloads` (deliver generated `.docx`/`.pptx`/CSV artifacts) ·
`<all_urls>` (read any page, credentialed fetch for PDFs/SharePoint) · `cookies`
(SharePoint/OneDrive file search over the signed-in session) · `identity`
(`chrome.identity.launchWebAuthFlow` for the Microsoft Graph OAuth/PKCE flow behind
mail, calendar, and draft creation) · `alarms` (hourly mailbox auto-refresh).

---

## 4. Architecture & contexts

MV3 splits execution across several contexts. The split is forced by platform limits
and is load-bearing. The four core contexts are below; two more **purpose pages** are
created on demand — a hidden **microphone page** (`microphone.html`, getUserMedia for
voice prompts) and the full-tab **workspace** (`workspace.html`, the expanded work
environment) — each talking to the worker over `chrome.runtime.sendMessage` with a
`target` discriminator, exactly like the offscreen document:

```
┌──────────────┐  long-lived Port   ┌────────────────────┐
│  Side panel  │◀──────────────────▶│  Service worker     │
│  (Preact UI) │  SidebarCommand /  │  (agent runtime)    │
└──────────────┘  BackgroundEvent   └─────────┬──────────┘
                                              │ chrome.scripting / sendMessage
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                      ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐
                      │ Content     │  │ chrome.tabs │  │ Offscreen document │
                      │ script(s)   │  │ /search/... │  │ pdf.js + OPFS RAG  │
                      │ DOM extract │  └─────────────┘  └──────────────────┘
                      │ + actions   │
                      └─────────────┘
```

- **Service worker** (`src/background/`): hosts the **agent loop**, owns all state,
  brokers every tool call. Talks to the side panel over a named `Port`
  (`name: 'sidebar'`) plus one-shot `chrome.runtime.onMessage` for settings/repo
  admin. Can be killed by Chrome at any time — keep state reconstructable; a
  periodic `ping` from the panel resets the idle timer during long tasks.
- **Side panel** (`src/sidebar/`): Preact SPA. Renders chat, plan, tool activity,
  tab-context, approvals; sends `SidebarCommand`s; reflects `BackgroundEvent`s. No
  business logic — a thin view over runtime state.
- **Content scripts** (`src/content/`): injected on demand
  (`chrome.scripting.executeScript`) to extract page content (Readability-style),
  build the ARIA element map, and perform in-page actions/gestures. Built as IIFE.
- **Offscreen document** (`src/offscreen/`): a hidden page (reason `WORKERS`)
  created on demand, because the service worker can't host pdf.js or the async OPFS
  API. Hosts **PDF text extraction**, **Office (OOXML) extraction** (`fflate`
  unzip + `DOMParser`), document/presentation generation, the **OPFS vector store**,
  and the on-device embedder. Two message channels distinguished by a `target`
  field: `'offscreen'` (PDF / Office / doc-gen, by `type`) and `'offscreen-repo'`
  (RAG).

### File responsibilities

**`src/shared/`** (imported by every context)
- `types.ts` — all data types: `Settings`, `TabSummary`, `PageContent`,
  `ElementRef`, `AuthState`, `NavigationResult`, `AgentStatus`, `ChatMessageView`,
  `ToolActivity`, `PlanView`/`PlanStepStatus`, `MemoryEntry` (legacy flat memory,
  migration source), `Skill`, `DataExport`, etc.
- `memoryGraph.ts` — durable graph memory: `MemoryNode`/`MemoryEdge` types and
  pure logic (reflection parsing, merge, decay, pruning, prompt rendering).
- `messages.ts` — the wire protocol: `SidebarCommand`, `BackgroundEvent`,
  `RuntimeRequest` (one-shot), the offscreen request/response unions
  (`ExtractPdfRequest/Response`, `ExtractOfficeRequest/Response`,
  `GenerateDocumentRequest/Response`, `GeneratePresentationRequest`,
  `RepoRequest/RepoResponse`), and the map channel (`MapCommandMessage`/`MapResponse`).
- `schemas.ts` — `TOOL_DEFINITIONS`: the JSON-schema tool catalog sent to the LLM.
- `repoChunk.ts` — `chunkText(text)` (~800 chars, ~120 overlap, sentence/para
  aware) and `normalizeUrl(url)` (strip `?query`/`#hash`, lowercase host, drop
  trailing slash) for duplicate detection.
- `vectorSearch.ts` — pure int8 quantize / dequant + top-k cosine helpers shared by
  the OPFS store and its unit tests.
- `conversationMeta.ts` — `parseConversationMeta` (title+summary JSON) + preview/summary
  clipping for the History list.
- `slides.ts` — `normalizeSlides(input)`: coerce the model's slide array into clean
  `SlideSpec[]` for `create_powerpoint`.
- `uploadFile.ts` — `classifyUpload(name, mime)`, `MAX_UPLOAD_BYTES`, `UPLOAD_ACCEPT`
  for the repo file-upload flow.
- `capabilities.ts` — the **Capability Registry** model: `CapabilityRegistryEntry`
  (kinds: bookmark/mcp/rest/webmcp/model/knowledge/skill), trust levels, auth methods,
  `migrateSitesToCapabilities` (legacy `ba_sites` → registry), and `resolveAuth` /
  `isTrustedForAutoApproval` helpers used by the approval gate.
- `labelColors.ts` — deterministic color assignment for conversation labels.
- `backupFormat.ts` — validate/shape the Backup & Restore JSON bundle.
- `skillImport.ts` — parse imported skill files. `curatedPlaybooks.ts` — seed app
  playbooks. `url.ts` — URL helpers (incl. `collectGroupUrls` for tab rehydration).

**`src/background/`**
- `serviceWorker.ts` — entry point. Wires the `Port`, routes `SidebarCommand`s to
  the `AgentRuntime`, and handles one-shot `RuntimeRequest`s
  (`test_connection`, `repo_list`, `repo_delete`, `repo_docs`, `repo_doc_delete`,
  `repo_export`, `repo_import`, `add_files_to_repo`, `transcribe_audio`).
- `agentRuntime.ts` — **the core**. The agent loop, system prompt, tool dispatch,
  approval/pause/resume, planning & findings, observation summarization + the
  answer-verification and plan-execution guards, context compaction, tab-group
  lifecycle + rehydration, conversation history (save/load/delete/import) and the
  undo checkpoint stack, RAG ingestion, document/presentation generation, and the
  LLM-written conversation title+summary. Holds the `READ_ONLY_TOOLS` and
  `APPROVAL_REQUIRED` sets, `systemBase`, and the conversation array.
- `loopHelpers.ts` — pure, unit-tested loop helpers: `parseSummaryArray` (eviction
  digest) and `parseReflectionVerdict` (self-check JSON), both fail-open, plus
  `repairToolPairing` (see below).
- `llmProvider.ts` — `complete(settings, messages, tools?, signal?, onRetry?)`,
  `embed(settings, texts)`, `transcribe(settings, audio)`, `testConnection(settings)`,
  `resolveModelForRole(settings, role)` (model orchestration — see §9 *Model
  orchestration*). OpenAI-compatible HTTP with an **Azure mode** keyed off
  `apiVersion`; multimodal `image_url` content parts; transient-failure
  auto-retry; throws a typed `LlmError`.
- `browserToolAdapter.ts` — thin wrappers over Chrome APIs and the content script:
  `listTabs`, `getActiveTab`, `getTabContent`, `getAllTabContents`, `navigate`,
  `openUrl`, `readTabGroup`, `searchWeb`, `getElementMap`, `click/fill/submit`,
  `pressKeys`, `clickAt`, `drag`, `scrollWheel`, `waitForElement`,
  `waitForPageState`, `readPdf`, `readAppContent`, `sharepointSearch`. Owns
  `ensureContentScript` + `sendToTab`.
- `tabContextManager.ts` — builds the "what tabs are in context" snapshot for the
  panel (active tab / all tabs), with staleness.
- `repoIngest.ts` — `storeText(settings, repo, name, url, text)` (the shared
  chunk→embed→`repoAdd` tail), `ingestTab(...)` (PDF → DOM → app content → OCR
  ladder), and `ingestFile(settings, repo, file)` (uploaded text / PDF / Office file).
- `fullPageCapture.ts` — `captureFullPage(tabId, maxFrames)`: scroll-and-snapshot
  loop producing downscaled JPEG frames for the vision model.
- `offscreenClient.ts` — `ensureOffscreen` + wrappers: `extractPdf(url, maxChars?)`,
  `extractOffice(url, maxChars?)`, `generateDocument(title, markdown)`,
  `generatePresentation(title, slides)`, and
  `repoAdd/repoSearch/repoList/repoDelete/repoDocs/repoDeleteDoc/repoExport/repoImport`.
- `storage.ts` — `chrome.storage.local` helpers; settings, skills (seeded once),
  the **Capability Registry** (`getCapabilities` reads `ba_capabilities`, lazily
  migrating legacy `ba_sites`), memory, and **conversation history** (`ba_conv_index`,
  `ba_conv_<id>` records, `ba_conv_labels`).
- `permissions.ts`, `authDetector.ts` — host-permission checks; login-wall
  detection for the auto-pause flow.

**`src/content/`**
- `contentScript.ts` — message router for content actions.
- `domExtractor.ts` — `buildElementMap` (ARIA-aware: effective role, accessible
  name, states, group, rect; descends shadow DOM + same-origin iframes; cap 200),
  `readAppContent` (selection → copy-intercept → innerText), `scrollStep`, and the
  action primitives (click/fill/submit/keys/coordinate gestures with realistic
  events and a React value-setter shim).
- `readabilityExtractor.ts` — main-content text extraction.

**`src/offscreen/`**
- `offscreen.ts` — pdf.js `extractPdf(url, maxChars?)`, OOXML `extractOffice(url,
  maxChars?)` (fflate unzip → per-format XML text, incl. PPTX speaker notes), the
  `generate_document`/`generate_presentation` handlers (lazy-import `docGen`/`pptGen`),
  and the `offscreen-repo` router into `repoStore`.
- `docGen.ts` — `markdownToDocxBase64(title, markdown)` (lazy `docx`).
- `pptGen.ts` — `slidesToPptxBase64(title, slides)` (lazy `pptxgenjs`).
- `repoStore.ts` — the OPFS vector store (below).

**`src/microphone/`** — `microphone.ts`: a hidden page that records a voice prompt
via `getUserMedia` and returns the audio for `/audio/transcriptions`.

**`src/workspace/`** — the full-tab management console (`workspace.html` → `main.tsx`,
which imports both `../sidebar/styles.css` and `workspace.css` so pages built from
reused sidebar sections render styled): `Workspace.tsx` (shell + nav, mirrors the
conversation state over the `Port`). Nav pages: **Chat** (composer, same as the side
panel), **Projects** (`ProjectsPage.tsx` — full CRUD + active-project switch;
see §9 *Projects*), **Knowledge** (`RepositoriesSection`, reused from the
sidebar), **Memory** (`MemoryPage.tsx` — see §9), **Skills** (`SkillsSection`, reused), **Tools**
(`CapabilitiesSection`, reused, opened with `defaultOpen` so the console isn't a
collapsed accordion on load), **Models** (`ModelSection.tsx` — the connection card
(endpoint/key/model/Azure version/image key), `AdvancedSettingsSection.tsx` — the
behaviour / generation / retrieval / connected-services groups, and
`ModelProfilesSection.tsx` below them for named alternate-endpoint profiles and
role routing; see §9 *Model orchestration*. Both settings sections share the
`SettingsControls.tsx` Group/Toggle card chrome and **patch-save** — each save
re-reads `ba_settings` and merges only its own fields, so one section's save
can't revert the other's),
**Automations** (`AutomationsPage.tsx` — scheduled tasks and
event triggers; see §9 *Agent platform*),
**Products** (`ProductsPage.tsx` — files those runs generate, OPFS-backed;
see §9 *Agent platform*), **Data**
(`DataViewer.tsx`, over `export_data` results), **Image** (`ImageViewer.tsx`, full-size
generated images), and **Settings** (`ConsoleSettingsPage.tsx` — language switcher,
the App playbook library index URL, + reused `BackupRestoreSection`, also opened
with `defaultOpen`). The reused sidebar sections (`CapabilitiesSection`,
`BackupRestoreSection`) take an optional `defaultOpen` prop so the same component
collapses in the sidebar's stacked accordion but starts expanded as a dedicated
console page. **The Workspace is the settings surface**: the sidebar's tabbed
`SettingsScreen` overlay was removed; the sidebar keeps only first-run onboarding,
and its gear opens `workspace.html#settings` (the no-model banner and onboarding's
"Advanced setup…" open `#models`). The sidebar tracks configuredness via
`chrome.storage.onChanged` since there is no overlay close event.

**`src/sidebar/`** — `main.tsx` (bootstrap + UI scale), `Sidebar.tsx` (shell,
header, text-size control, **Undo** + **History** controls), `ChatPanel.tsx` (composer,
drag-drop + 📎 attach, document download cards), `Markdown.tsx`, `PlanPanel.tsx`,
`ToolActivityPanel.tsx`, `TabContextPanel.tsx` (context + snapshot/OCR + repo
capture), `ConversationsScreen.tsx` (the **History** list with title+summary, labels,
load/delete/import/export), `OnboardingScreen.tsx` (first-run setup),
`OverflowMenu.tsx` (the header's accessible "More" menu),
the settings sub-sections (rendered by Workspace pages) `CapabilitiesSection.tsx`
(the Capability Registry editor; supersedes `KnownSitesSection.tsx`),
`SkillsSection.tsx`,
`MemorySection.tsx`, `RepositoriesSection.tsx`, `BackupRestoreSection.tsx`,
`ProjectSwitcher.tsx` (compact active-project dropdown in the header), the shared
`RepoUpload.tsx` + `UploadBanner.tsx` uploader and `LabelPicker.tsx`; helpers
`repoUploadClient.ts`, `conversationExport.ts`, `download.ts`, `links.ts`,
`i18n.tsx` (EN/FR); `styles.css`.

---

## 5. The agent loop (`agentRuntime.ts`)

A turn-based loop over the OpenAI chat API with tool calling.

1. **Stable system prefix (`conversation[0]`)** = a **byte-stable** `systemBase`: the
   fixed `SYSTEM_PROMPT` + the assembled-once blocks (known sites, available skills,
   memory entries, the active app playbook, the user's custom instructions) followed
   by `TOOL_DEFINITIONS`. It is **not** rewritten each step, so the longest cacheable
   prefix stays identical across a task and the provider's prompt cache hits from step
   two on. The **live working-state** (active tab, current plan with per-step status,
   recorded findings, remaining step budget) is instead appended as a **trailing
   `system` message** rebuilt every step by `withWorkingState()` — most-salient,
   last position — so it never invalidates the cached prefix. `withWorkingState()`
   also runs `repairToolPairing()` over the conversation before sending: if a turn
   was orphaned (Stop pressed mid-tool, a reloaded thread, an exception before the
   results were appended) an assistant `tool_calls` message can lack matching `tool`
   responses, which the chat-completions API rejects with a 400 ("tool_call_ids did
   not have response messages"). The repair inserts a synthetic placeholder result
   for any unanswered id so a resumed conversation always stays valid.
2. **Call the model** with `TOOL_DEFINITIONS`. If it returns tool calls:
   - **Parallelize reads:** all calls whose names are in `READ_ONLY_TOOLS` run
     concurrently (`Promise.all`); state-changing calls run sequentially after.
   - **Approval gate:** before any `APPROVAL_REQUIRED` tool, emit an
     `approval_request` (description + the tool's required `reason` arg) and await
     the user's Approve/Deny. Deny returns a "user denied" result; do not retry. The
     request also carries the sourcing **capability's trust context** (kind, trust
     level, auth method); a tool from an `enterprise`/`local`-trust capability may be
     auto-approved (`isTrustedForAutoApproval`), and capability auth is resolved via
     `resolveAuth` (used for MCP calls).
   - **Auto-pause on auth walls:** if reading a page detects a login wall, pause
     and ask the user to sign in; resume re-fetches.
   - Append each tool result as a `tool` message; loop.
3. **Dynamic step budget:** a soft cap scaled to task size; the working-state block
   shows remaining steps so the model paces itself and produces an answer before
   exhaustion. The soft cap defaults to 20 but is **user-configurable** via
   `settings.maxSteps` (Advanced settings); the plan extension and hard ceiling scale
   from it (`extension = round(maxSteps/2)`, `ceiling = maxSteps × 2`), so 20 reproduces
   the historical 20/10/40 behavior. Derived by the pure `deriveStepBudget` helper.
4. **Context compaction:** when the conversation grows past the char budget, the
   oldest bulky tool outputs are **summarized into a short digest** (one cheap model
   call, preserving URLs/names/numbers) when `summarizeObservations` is on, else
   blanked to a static placeholder. The **plan and findings persist** in the
   working-state block regardless (that's their purpose).
5. **Finish guards** (before a tool-free answer is accepted, each at most once per
   task while budget remains):
   - **Plan-execution guard** — if the plan has ≥2 steps and **none** are marked done,
     push the model back once to actually work the steps (or mark them done/skipped)
     rather than answering at 0/N.
   - **Answer verification** (`verifyAnswers`) — one critic pass over the draft; on a
     `revise` verdict it loops once with the issues, else finalizes.
6. **Final answer** rendered as Markdown with a `Source tabs:` list of numbered
   full-URL links when the answer draws on pages. Generated files (`.docx`/`.pptx`/CSV)
   are attached as **download cards** (`FileArtifact`).
7. **Automatic lessons** (`maybeLearnLesson`, fire-and-forget after every settled
   turn, gated on `getMemoryEnabled()`): only runs for tasks worth learning from —
   a plan of ≥3 steps, ≥4 tool calls, a reflection/plan-nudge correction, or a
   recorded tool failure. One cheap LLM call distills the task (request, plan,
   reflection issues, tool failures, findings, final answer) into **at most one**
   reusable lesson: `{lesson, triggers[], tools[], origin?, confidence}` — rejected
   below `confidence 0.7` or with no `triggers` (`loopHelpers.parseLesson`). A new
   lesson is merged into an existing similar one (`findSimilarLesson`: same
   origin + overlapping trigger, or ≥half its terms overlap an existing lesson's
   text/triggers) rather than duplicating — reinforcing `uses` and shortening the
   stored text if the new phrasing is tighter. Stored as `LessonEntry[]` under
   `chrome.storage.local['ba_lessons']` (`storage.ts`, cap 50, newest-updated
   first; included in backup/restore). At the **start** of a task, the top 3
   lessons relevant to the request (`relevantLessons`/`lessonScore`: same-host
   bonus + trigger/term overlap with the task text) are injected into the system
   prompt (`lessonsPromptBlock`, "apply these when relevant, but defer to current
   user instructions and fresh tool output"). Never stores user facts, secrets, or
   page content — only agent-behavior instructions.
8. **Scoped subtask delegation** (`run_subtasks` tool → `runScopedSubtasks`): for
   "read/compare/summarize N pages/sources" work, the model can spawn up to 12
   independent mini-loops (`runScopedSubtask`), each a **fresh, tightly-scoped**
   conversation (its own system prompt, `maxTokens` capped at 800, `temperature 0`)
   restricted to a small read-only tool allowlist (`SCOPED_SUBTASK_ALLOWED`: tab/
   content readers, `search_web`/`open_url`, `read_pdf`/`read_office_document`,
   `get_video_transcript`, repo search, `microsoft365_search`/`calendar_search` —
   no state-changing tools). Runs up to 3 subtasks concurrently
   (`mapWithConcurrency`), each capped at `min(8, maxSteps)` iterations; a subtask
   must reply with `{"conclusion":"...","sources":[...]}` (JSON-only, parsed
   defensively with a raw-text fallback). Only the compact `{id, conclusion,
   sources, stepsUsed, error?}` per subtask returns to the parent — the raw page
   text/tool output each subtask read never enters the parent's context. This is
   the extension's answer to "how do you keep long multi-source tasks from
   blowing the context budget": push the bulk reading into disposable child loops.

**Tool classification (exact):**

- `APPROVAL_REQUIRED` = `click_element`, `fill_input`, `submit_form`,
  `run_javascript`, `press_keys`, `click_at`, `drag`, `save_app_playbook`,
  `save_as_skill`, `get_all_tab_contents`, `call_mcp_tool`, `call_webmcp_tool`,
  `draft_email`, `schedule_task`, `cancel_scheduled_task`. Each takes a required
  `reason` string (plain language, user-facing).
- `READ_ONLY_TOOLS` (safe to run in parallel) = `list_tabs`, `get_active_tab`,
  `get_tab_content`, `get_element_map`, `detect_auth_state`, `wait_for_element`,
  `search_known_sites`, `list_mcp_tools`, `list_webmcp_tools`, `sharepoint_search`,
  `microsoft365_search`, `read_tab_group`, `search_repo`, `list_repos`, `use_skill`, `set_plan`,
  `update_plan`, `record_finding`, `export_data`, `create_word_document`, `read_pdf`,
  `read_office_document`, `get_video_transcript`, `read_app_content`, and
  `query_pointer_target`.
- Everything else (e.g. `navigate`, `open_url`, `search_web`, `capture_full_page`,
  `add_to_repo`, `create_powerpoint`, memory tools) is stateful-but-benign:
  sequential, no approval card. (The `create_*` tools act on the extension's own
  sandboxed surfaces — not the user's session — so they are non-gated.)
- `UNATTENDED_BLOCKED_TOOLS` — a narrower gate than `APPROVAL_REQUIRED`, checked
  separately in `executeToolCall` before the normal approval logic: tools listed
  here stay frictionless in attended chat but are refused outright
  (`this.unattendedApprovalBlocked = true`, same signal as a denied approval)
  when `this.unattended` is true. Currently **empty** — its former sole member,
  `query_data`, left with the DuckDB engine's removal — and kept as the gate for
  any future tool with the same "fine attended, not fine silent" shape.

---

## 6. Tool catalog (`TOOL_DEFINITIONS`)

Each is a JSON-schema function the model can call. Grouped by purpose.

**Tabs & content**
- `list_tabs` — all tabs (id, title, URL, group).
- `get_active_tab` — the focused tab.
- `get_tab_content {tabId?}` — main text + metadata/links/headings; returns an
  `extractionStatus` (`ok|partial|blocked|auth_required|unsupported`). A tab
  showing Chrome's built-in PDF viewer (`chrome-extension://<pdf-viewer-id>/
  index.html?src=<pdf-url>`) is detected via `shared/url.ts:resolvePdfUrl` and
  routed straight to `extractPdf` on the unwrapped `src` URL — pdf.js needs the
  real document URL, not the viewer wrapper — rather than falling through to DOM
  extraction on the viewer chrome, which found nothing. `resolvePdfUrl` refuses
  to unwrap a `src` that is itself `chrome:`/`chrome-extension:`/
  `chrome-untrusted:`, closing off using the viewer to reach internal pages. The same
  branch handles Office files (see below) via `shared/url.ts:resolveOfficeUrl` — a tab
  showing a SharePoint/OneDrive-for-Business Office-Online viewer or editor
  doesn't serve the file at that URL; `resolveOfficeUrl` unwraps three wrapper shapes:
  sharing links (`/:w:/r/<path>.docx?web=1…`, also `:x:`/`:p:` — prefix and query stripped
  to recover the server-relative file path), the classic viewer
  (`.../_layouts/15/Doc.aspx?sourcedoc={guid}&…` or the `WopiFrame.aspx` equivalent —
  derives the site's `_api/web/GetFileById('{guid}')/$value` REST URL from the `sourcedoc`
  GUID and the path preceding `/_layouts/15/`), and the new unified
  `word|excel|powerpoint.cloud.microsoft` editors (the `wopisrc`/`WOPISrc` query param
  carries `…/_vti_bin/wopi.ashx/files/<guid>`, resolved to the same `GetFileById` URL).
  All are fetched with the same signed-in session cookie as `sharepoint_search`. Both `get_tab_content` (an already-open tab) and
  `read_office_document`/`ingestTab` (an explicit URL, or `add_to_repo`) resolve through
  it, so an Office 365 document already open in the browser — whether a direct file link
  or the Office-Online viewer/editor — reads and indexes with no extra step and no
  approval (reading was already ungated; the gap was that the viewer URL didn't resolve
  to fetchable bytes at all, so it silently fell through to near-empty DOM extraction).
- `read_app_content {tabId?}` — best-effort text from canvas/app surfaces via the
  selection model and copy-event interception (no clipboard permission needed).
- `get_all_tab_contents` — read every tab (**approval-gated**).
- `read_office_document {url?, tabId?}` — extract text from a `.docx`/`.pptx`/`.xlsx`
  (or a SharePoint Office-Online viewer URL, unwrapped via `resolveOfficeUrl`) via the
  offscreen `extractOffice` (fflate unzip + DOMParser); 60k context cap like `read_pdf`.
  OOXML only (legacy `.doc`/`.ppt`/`.xls` aren't zips and fail with a clear message).
- `read_pdf {url?, tabId?}` — extract PDF text via pdf.js; returns up to ~60k chars
  to context with `pageCount`/`charCount`/`truncated` and a note pointing to
  `add_to_repo` for the full document.
- `capture_full_page {maxFrames?}` — scroll-and-snapshot the whole page into frames
  for the vision model (opaque/canvas pages; needs a vision model).
- `get_video_transcript {tabId?, lang?}` — read a video's existing captions: YouTube's
  `ytInitialPlayerResponse` timedtext track (`fmt=json3`) or a generic WebVTT `<track>`;
  60k context cap. Read-only; instead of audio STT.

**Navigation & web search**
- `navigate {url}` — reuse a tab, wait for load.
- `open_url {url}` — open a **new** tab joined to the conversation's tab group.
- `read_tab_group {name?}` — read every tab in a group (default the conversation's).
- `search_web {query}` — open the browser's default search engine. **Never** use
  `site:` or other operators (stated forcefully in the prompt).

**Page control**
- `get_element_map {tabId?}` — ARIA-aware interactive-element map; act on `refId`s.
- `click_element`/`fill_input`/`submit_form {selectorOrRef, …, reason}` — gated.
- `press_keys {combo, ref?, reason}` — gated.
- `wait_for_element {selector, condition?, timeoutMs?}` — read-only.
- `click_at {x,y,reason}`, `drag {…, reason}`, `scroll_wheel {x,y,deltaY}` —
  coordinate gestures for canvas/maps (clicks/drags gated).
- `run_javascript {code, reason}` — arbitrary JS in the page's MAIN world, returns
  JSON (**always gated**); for app/framework APIs the dedicated tools can't express.
- `wait_for_page_state {tabId?}`, `detect_auth_state {tabId?}`.

**Retrieval**
- `add_to_repo {repo, scope?: 'tab'|'group'}` — ingest into a named OPFS repo.
- `search_repo {repo, query, k?}` — retrieve passages; answer + cite name/URL.
  Hybrid (semantic + BM25) by default, with multi-query paraphrase retrieval and
  an LLM rerank pass over a wider candidate pool — see §8.4.
- `list_repos` — repos with doc/chunk counts.
- `run_subtasks {tasks[], maxSteps?}` — isolated, tight-budget mini-loops for
  page/source-specific work (comparing/summarizing several pages); returns only
  each subtask's compact conclusion, not its raw reading — see §5 step 8.
- `sharepoint_search {query?, top?, sortBy?, editedByMe?}` — SharePoint Search REST
  via the signed-in session cookie; returns ranked `{title, url, snippet, createdBy,
  modifiedBy, modified}`. Defaults to `sortBy:'modified'` (most-recent-first) and,
  without an explicit `fileType`, a curated user-content file type filter (§9's
  `microsoft365_search` entry) rather than every indexed file; pass
  `sortBy:'relevance'` when ranking matters more than recency. `editedByMe:true`
  resolves the current user (`/_api/web/currentuser`) and filters `Editor:"<name>"`
  — together they answer "the last N files I edited". `query` optional.
- `microsoft365_search {source?, query?, from?, fileType?, sitePath?, editedByMe?, since?,
  until?, orderBy?, top?}` — **unified Microsoft 365 mail + file search over the signed-in
  session** (cookie auth, no setup; *not* the Graph API, which needs OAuth). `source`:
  `mail | files | both` (default both). **Files** reuse the SharePoint/Microsoft Search REST
  path (`fileSearch`, covers SharePoint + OneDrive) with a KQL `querytext` built from
  `query`/`filetype:`/`path:`/`LastModifiedTime` range/`Editor:` (`editedByMe`). Without an
  explicit `fileType`, `buildFileKql` scopes to a curated **user-content file type** filter
  (Office docs, PDF/txt/md/csv/html, common image/audio/video formats) rather than
  `IsDocument:1`, so results don't surface executables/components. Both `orderBy` (mail) and
  `sortBy` (`sharepoint_search`'s equivalent) default to **most-recent-first** (`date` /
  `modified`); pass `relevance` explicitly when ranking, not recency, is what's wanted.
  **Mail** goes over **Microsoft Graph** (`GET /me/messages`, OAuth bearer token —
  `graphMailSearch` in `browserToolAdapter.ts`), not the SharePoint cookie session. Filters
  become an OData `$filter`: `contains(subject,'…')` for the free-text query, a
  name-or-address `contains()` pair for `from`, and a `receivedDateTime` range for
  `since`/`until` (`shared/graphMail.ts:buildGraphMailFilter`). This is **substring matching
  on subject and sender, not full-text-across-the-message search** — a real (if minor) recall
  reduction versus a mailbox-wide keyword search; the system prompt tells the model to narrow
  by sender/subject/date rather than expect body-text hits. Returns `{files:[…], mail:[…]}`
  (and `filesError`/`mailError` when a source fails). The KQL/OData builders are pure +
  unit-tested (`shared/microsoftSearch.ts`, `shared/graphMail.ts`); the fetches in
  `browserToolAdapter.ts`/`graphClient.ts`. On a `mailError` (mailbox not connected, or the
  Graph connection expired past silent refresh), the model asks the user to connect in
  Settings → Mailbox and retry, only then falling back to the `/search-mail` skill.
- `search_known_sites {query}` — match against the user's **Capability Registry**
  (bookmark/mcp entries; formerly "Known Sites/Hints"). An entry may carry an `mcpUrl`.

**Tool servers (MCP / WebMCP)**
- `list_mcp_tools {server, query?}` / `call_mcp_tool {server, name, arguments, reason}`
  — discover and invoke methods on an MCP-server Hint over Streamable-HTTP JSON-RPC
  (`background/mcpClient.ts`). `call` is gated. Static bearer-token auth; remote HTTP only.
- `list_webmcp_tools {tabId?}` / `call_webmcp_tool {tabId?, name, arguments, reason}` —
  discover and invoke a page's in-page WebMCP tools, captured by a MAIN-world
  document_start bridge (`content/webmcpBridge.ts`) that shims `navigator.modelContext`.
  `call` is gated.

**Document generation** (output a downloadable file as a `FileArtifact` card — the
sandbox can't write back in place, so creation is delivered as a download)
- `create_word_document {title, markdown, filename?}` — render Markdown to a `.docx`
  via the offscreen `docx` generator. (Read-only: builds a fresh artifact.)
- `create_powerpoint {title, slides:[{title,bullets[],notes}], filename?}` — build a
  `.pptx` from a structured slide spec via the offscreen `pptxgenjs` generator.

**Knowledge & output**
- `save_app_playbook {origin, name, description, content, reason}` — persist a
  per-site playbook (gated); upsert by origin.
- `save_as_skill {reason}` — package the current task into a reusable skill
  (gated); upsert by name, patch-bumping the version on re-save. See §9
  *Generate a skill from a prompt*.
- `use_skill {name}` — load a named skill's instructions.
- `export_data {title, columns, rows}` — produce a downloadable CSV/JSON table.
- `set_plan {steps}`, `update_plan {step, status, note?}`, `record_finding {text}`.
- `save_memory {text, kind?, subject?, sourceUrl?, sourceTitle?}`,
  `update_memory {id, text}`, `delete_memory {id}` — durable graph memory
  (only when the memory feature is enabled). See §16.6.

---

## 7. Multi-protocol LLM provider (`llmProvider.ts` & `./adapters/`)

Protocol-adapter pattern. `complete()` dispatches request-building and response-parsing
to the adapter selected by `settings.protocol` (defaulting to `'chat-completions'`).
Every adapter translates between the canonical `LlmMessage[]`/`ToolDefinition[]` shape
and the wire format expected by the provider, so the agent loop and tool execution
stay protocol-agnostic.

**Protocols supported:**
- **`chat-completions`** (`openaiChatAdapter.ts`): OpenAI, Azure OpenAI, DeepSeek, GLM,
  MiniMax, Kimi, Ollama, vLLM, LM Studio. POSTs `${baseUrl}/chat/completions`.
- **`responses`** (`openaiResponsesAdapter.ts`): OpenAI `/responses` API (GPT-5.x, Grok).
  POSTs `${baseUrl}/responses` with `input` array of typed Items (`message`, `function_call`,
  `function_call_output`).
- **`anthropic-messages`** (`anthropicMessagesAdapter.ts`): Claude, Qwen `/v1/messages` API.
  POSTs `${baseUrl}/v1/messages` with top-level `system` string, `x-api-key` + `anthropic-version`
  headers, and `tool_use`/`tool_result` content blocks (merging consecutive tool results into
  a single `user` turn).
- **`gemini-native`** (`geminiNativeAdapter.ts`): Google Gemini `generateContent` API.
  POSTs `${baseUrl}/v1beta/models/${model}:generateContent` with `contents`/`parts`,
  `systemInstruction`, and `x-goog-api-key` header.

**Tool schema translation (`adapters/toolSchema.ts`):** Converts canonical `ToolDefinition[]`
into provider-native tool declarations (`input_schema` for Anthropic, `functionDeclarations`
with stripped `additionalProperties` for Gemini, and flattened shapes for Responses).

`embed()` POSTs `${baseUrl}/embeddings` with `model: settings.embeddingModel || settings.model` and
parses `data[].embedding`. `testConnection()` validates connection credentials. Non-2xx → typed `LlmError`
surfaced to the user.

**Azure OpenAI mode** is keyed off `settings.apiVersion`: when set, standard OpenAI endpoints append
`?api-version=<v>` and authenticate with `api-key`. When `retryOnRateLimit` is on (default), transient
failures (HTTP 429 / 5xx) back off and retry with `Retry-After` hints. `transcribe()` POSTs
`${baseUrl}/audio/transcriptions` for voice prompts when configured.

---

## 8. Local RAG — OPFS vector store (`offscreen/repoStore.ts`)

On-device retrieval over pages the user captures. No external service; embeddings
come from the user's own endpoint.

**Layout:** `/repos/<repo>/` in OPFS, four files:
- `meta.json` — `{ name, dim, bits, perDimScale[], docs: DocMeta[], chunkCount }`
  where `DocMeta = { id, name, url, capturedAt, chunkStart, chunkCount }`.
- `chunks.json` — parallel array `{ docId, name, url, text }[]`.
- `vectors.bin` — contiguous **int8** quantized vectors, `dim` bytes per chunk,
  row `i` at byte `i*dim`.
- `keywordIndex.json` — a precomputed BM25 index (`KeywordIndex`: per-chunk term
  frequencies + document lengths + corpus document frequencies), so search-time
  BM25 (§8.4) is O(query terms) instead of re-tokenizing the whole repo per query.
  Maintained incrementally: `add` extends it (`extendKeywordIndex`), `deleteDoc`/
  `import` rebuild it from the surviving chunks (`rebuildKeywordIndex`). If the
  file is missing or its `docLen.length` doesn't match the chunk count (an older
  repo, or corruption), `search` transparently rebuilds it in memory.

**Quantization (turbovec-inspired scalar quantization):** unit-normalize each
embedding, calibrate a **per-dimension scale** from the first batch
(`scale[d] = max|v[d]|`, fixed thereafter), then map to signed int8
(`round(v[d]/scale[d] * 127)`, clamped). ~4× storage shrink, near-lossless cosine.

**Operations** (offscreen `offscreen-repo` channel):
- `add {repo, doc, chunks, vectors}` — calibrate dim/scale on first add; reject a
  dimension mismatch (switching embedding models breaks an existing repo — must
  delete & re-ingest). Normalize → quantize → append to `vectors.bin`, append
  chunks, update meta.
- `search {repo, queryVector, k, query?, queryVectors?, queries?, hybrid?}` —
  normalize+quantize the query, brute-force weighted dot over all vectors (dequant
  via per-dim scale²), top-k. The hot loop precomputes a single
  `Float32Array qw[d] = q[d]*scale[d]²` so it's one multiply-add per element. See
  §8.4 for hybrid (semantic + BM25) fusion and multi-query retrieval, which ride
  this same op via the optional fields.
- `list` — repos with doc/chunk counts.
- `delete {repo}` — remove the repo dir.
- `docs {repo}` — list documents (for dedup + the Settings UI).
- `deleteDoc {repo, docId}` — **rebuild**: drop the doc's contiguous vector rows and
  chunks, re-sequence remaining docs' `chunkStart`, overwrite `vectors.bin`
  (truncating write). If the repo empties, reset `dim`/`perDimScale` so a later add
  can recalibrate (allowing a new embedding model).

**Ingestion (`repoIngest.ts`)** — text-extraction ladder per tab:
1. **PDF** (URL matches `*.pdf`): pdf.js whole-document extraction (no char cap for
   ingestion — the entire PDF is chunked/embedded; reading order preserved via the
   per-item `hasEOL` flag).
1b. **Office** (URL matches `*.docx/.pptx/.xlsx`): `extractOffice` whole-document.
2. **DOM** (`getTabContent`).
3. **App content** (`readAppContent`).
4. **OCR** (only on the active-tab `+ Tab` path): `captureFullPage` → vision
   transcription.
Then `chunkText` → `embed` → `repoAdd`. Scanned/image-only PDFs have no text layer →
fall through to OCR (active-tab only).

**De-duplication & replace** (orchestrated in `agentRuntime.ingestIntoRepo`, the
single chokepoint for both the tool and the UI buttons): before ingesting, fetch
existing docs and match by `normalizeUrl`. If any target page already exists, raise
**one combined** approval prompt ("Replace N page(s) already in <repo>?"). Approve →
`repoDeleteDoc` the old copy then re-ingest (replace). Decline → keep the original,
add nothing. New pages always ingest.

### 8.1 Repo kinds, on-device embedder, and the model lock

A repo carries a `kind`: `'page'` (tab/upload captures, the default), `'folder'` (a
locally-indexed directory), or `'mail'` (an Office 365 mailbox). All three share the
same store, quantization, and `search_repo`/`list_repos` surface — they differ only in
their **source**. Folder/mail docs additionally record `{ path, mtime, size }` in
`DocMeta`, the keys for **incremental sync** (skip unchanged, re-ingest changed, drop
vanished).

**Embedder choice (`Settings.embedder`).** RAG vectors come from either:
- `'local'` (default) — a **transformers.js** feature-extraction model
  (`Xenova/all-MiniLM-L6-v2`, 384-d) run in the offscreen document (`offscreen/localEmbed.ts`),
  forced single-threaded CPU wasm with WebGPU off for stability; the ONNX wasm is bundled
  to `dist/ort/` (vite `copyOrtWasm` plugin) and served from an extension-local URL so the
  embed path never hits a CDN at runtime. Message text never leaves the device.
- `'external'` — the configured OpenAI-compatible `/embeddings` endpoint (the original path).

`llmProvider.embedChunks(settings, texts)` dispatches local vs external for **both** ingest
and query; `embedderId(settings)` returns a stable identity (`local:<model>` /
`external:<model>`). **Model lock:** `repoAdd` stamps the repo with its `embedModel` and
rejects a later add — and `repoSearch` rejects a query — from a different embedder (vectors
across models aren't comparable), prompting a re-index. Emptying a repo clears the lock.

### 8.2 Folder indexing (drag-and-drop)

`sidebar/folderIndex.ts` indexes a local directory **without the native folder picker**
(`showDirectoryPicker`/`<input webkitdirectory>` deterministically crash Chrome's browser
process on some macOS builds). The user **drags a folder** onto a drop zone; the dropped
`DataTransferItem`s are recursed via `webkitGetAsEntry()` (no OS dialog), classified by the
existing upload classifier, read, and sent through `add_files_to_repo` (`kind:'folder'`) →
`ingestFile` → `storeText`. Re-dropping the same folder is an idempotent incremental refresh
keyed by relative path + mtime + size.

### 8.3 Mailbox indexing (Microsoft Graph OAuth)

`background/mailIngest.ts` indexes the user's whole Office 365 mailbox via **Microsoft
Graph** — auth-code + PKCE OAuth through `chrome.identity.launchWebAuthFlow`
(`shared/graphAuth.ts` for the pure URL/PKCE/token-body construction,
`background/graphAuth.ts` for the interactive flow + token storage/refresh in
`chrome.storage.local['graphTokens']`; no client secret, a public PKCE client). Requires a
one-time **Azure AD app registration** the user supplies a client ID for (`Settings.
graphClientId`/`graphTenant`, default tenant `organizations`), with delegated scopes
`Mail.Read Mail.ReadWrite Calendars.Read offline_access openid` — `Mail.ReadWrite` is
needed even just to create a draft (§8.5), Graph has no narrower scope for that — so most
enterprise tenants require admin consent for this combined scope set.

The flow: `GET /me/messages` (`$select`, `$top` clamped to 100, `$orderby=receivedDateTime
desc`, an incremental `$filter=receivedDateTime gt <high-water-mark>`), paged via
`@odata.nextLink`, each message → `messageToDoc` → `storeText` (`kind:'mail'`, keyed by the
Graph message id). 429/5xx are retried with `Retry-After` (`background/graphClient.ts:
graphRequest`, mirroring the same backoff shape used elsewhere); a 401 throws
`GraphSessionError` (token rejected — reconnect needed) rather than retrying. The pure
request/response builders/parsers live in `shared/graphMail.ts` (unit-tested without
`chrome.*`/network). **Incremental** via a high-water-mark on `receivedDateTime` plus
skip-by-id, same shape as before.

**Why Graph over the earlier cookie-session approach:** an OWA `service.svc` cookie-session
mailbox indexer (avoiding app registration entirely) was tried first, but broke for tenants
migrated to Microsoft's newer unified Outlook web client (`outlook.cloud.microsoft`), which
doesn't expose the classic `X-OWA-CANARY` session cookie that approach depended on. Graph is
a stable, versioned, Microsoft-supported API independent of which web frontend a tenant is
on, at the cost of the app-registration/admin-consent setup the user originally wanted to
avoid. SharePoint/OneDrive file search (`sharepoint_search`, the files half of
`microsoft365_search`) is unaffected by any of this — it stays on the cookie session, needing
no Graph connection.

**Auto-refresh (`chrome.alarms`, opt-in, off by default).** `serviceWorker.ts` maintains an
hourly `chrome.alarms` job (`syncMailAlarm`, kept in sync with `Settings.mailAutoRefresh` via
a `chrome.storage.onChanged` listener on `ba_settings`) that re-runs `indexMailbox` in the
background over the same Graph connection — no re-authentication, no user interaction (the
access token refreshes silently via the stored refresh token). It only ever refreshes a
mailbox already indexed at least once (checked via `repoList` for a `kind:'mail'` repo with
`docs > 0`); it never triggers the initial full index (or the initial interactive OAuth
consent) silently. A `mailIndexBusy` flag guards manual and auto-triggered runs from
overlapping. Each run's outcome (added/failed counts, or a connection-expiry/network error)
is recorded in `chrome.storage.local['mailAutoRefreshStatus']` for the Mailbox card to
display — a failure never surfaces as an intrusive error, since no user is present when the
alarm fires.

### 8.5 Calendar and draft creation (also Microsoft Graph)

Two more tools ride the same Graph connection as mailbox indexing (§8.3), reusing
`graphAuth.getAccessToken` and `graphClient.graphRequest`/`graphPostJson`:

- **`calendar_search`** — `GET /me/calendarView` (`shared/graphCalendar.ts:
  buildCalendarViewUrl`; a single generously-sized page, no server-side `$top`, matching how
  a calendar window is small enough that pagination isn't needed) with
  `Prefer: outlook.timezone="UTC"` so `start`/`end` come back UTC-normalized (Graph's
  `dateTime` field carries no offset of its own). Client-side: `eventMatchesQuery` (subject/
  location/organizer/attendees/body substring match, all query terms required), sort by
  start time, slice to the requested count. Same output shape (`id, subject, start, end,
  location, organizer, requiredAttendees, optionalAttendees, bodyPreview, bodyText, teamsUrl,
  url`) regardless of backend — `teamsUrl` prefers Graph's `onlineMeeting.joinUrl`, falling
  back to scanning body text for a `teams.microsoft.com` link.
- **`draft_email`** — `POST /me/messages` (`shared/graphMail.ts:buildGraphDraftMessage`/
  `parseGraphDraftResponse`) creates — **never sends** — a draft; Graph's `importance` enum
  is lowercase (`low`/`normal`/`high`), mapped from the tool-facing `Low`/`Normal`/`High` kept
  for schema stability. Graph returns the created Message resource directly (`id`,
  `changeKey`, `webLink`) with no envelope.

Both throw a plain error (mailbox not connected, or `GraphSessionError` if the connection
expired) that the system prompt maps to "ask the user to connect in Settings → Mailbox, then
retry" before any page-automation fallback.

### 8.4 Retrieval quality: hybrid search, multi-query, and reranking

`search_repo` layers three independent improvements over a single query embedding,
each falling back cleanly to the layer below on failure:

**Hybrid search (semantic + BM25, RRF-fused; `shared/hybridSearch.ts`).** Default
**on** (`Settings.hybridSearch`, `!== false`). Dense cosine ranking
(`scoreVectors`) and a BM25 keyword ranking over the same chunk text
(`shared/keywordSearch.ts`, ID-preserving tokenizer so codes/identifiers like
`AB-1234` stay intact) are combined with **Reciprocal Rank Fusion**
(`fuseRRF`: `score = Σ 1/(rrfK + rank)` across whichever ranked lists a chunk
appears in, rank-based so it never has to reconcile cosine scores and BM25 scores
on incompatible scales). Recovers exact-token recall that pure dense retrieval can
miss. Falls back to pure semantic when the query has no lexical hits or hybrid is
off.

**Multi-query retrieval.** Before embedding, `AgentRuntime.repoQueryVariants`
makes one cheap LLM call asking for up to 2 paraphrases of the query (preserving
names/dates/codes/quoted terms), deduplicated against the original (max 3 total).
Each variant is embedded and searched; `multiHybridSearch` fuses all the resulting
semantic + BM25 rankings (one list per query, per side) with the same `fuseRRF`.
Recovers chunks phrased differently than the user's literal wording. On any LLM
failure, silently falls back to the single original query.

**LLM reranking.** `search_repo` retrieves a wider candidate pool
(`max(20, k*3)`) from the fused ranking, then `AgentRuntime.rerankRepoHits` makes
one more LLM call with the top 20 candidates (truncated to ~1200 chars each) asking
for the best order by direct usefulness for the query, preferring specific,
answer-bearing chunks over generic/duplicate ones. Falls back to the fused order
(first `k`) if the model returns unusable/malformed ids or the call fails. The
response also returns `queries` (the paraphrases used) and `candidateCount` for
observability.

Net effect: `search_repo(query, k)` costs up to two extra small LLM calls, in
exchange for retrieval that isn't limited to the user's exact wording or exact
cosine-similarity ranking.

---

## 9. Other subsystems

**Per-conversation tab groups.** Tabs the agent opens (`search_web`, `open_url`)
join a Chrome tab group with a single-word name (from a curated animal pool, e.g.
"Wolf"), one group per conversation, created lazily on first open and colored from a
hash of the name. `clearConversation` resets the group so the next conversation gets
a fresh one; old groups/tabs are left open. The group name is surfaced to the agent
(state block + `list_tabs`) so the user can say "summarize the Wolf group".

**Snapshots & full-page capture.** The tab-context bar has **Snapshot** (one
viewport JPEG) and **Snapshot Page** (scroll the whole page into frames). Both queue
images that ride the user's next message as `image_url` parts. The agent tool
`capture_full_page` injects frames into the current task's context.

**SharePoint poor-man's RAG.** `sharepoint_search` hits
`${base}/_api/search/query?...&selectproperties='Title,Path,HitHighlightedSummary,…'`
with `credentials:'include'` (the signed-in `FedAuth` cookie), cleans the
`HitHighlightedSummary` snippet (regex, no DOM in the worker), and returns ranked
`{title, url, snippet, createdBy, modifiedBy, modified}` (people parsed from the
`Author`/`Editor`/`EditorOWSUSER` claims tokens). `sortBy:'modified'` adds
`sortlist='LastModifiedTime:descending'`; `editedByMe:true` first resolves the
signed-in user via `/_api/web/currentuser` and ANDs `Editor:"<displayName>"` into the
query — so "the last N files I edited" works. `query` is optional (defaults to
`IsDocument:1` for a recent-files listing). Base URL from the optional Settings field
or auto-detected from an open `*.sharepoint.com` tab. No app registration/token.
Caveat: the `Editor` managed property must be query-mapped and matching is by display
name, so the "me" filter isn't a perfect identity match.

**Capability Registry, skills, app playbooks, memory** (all in `chrome.storage.local`):
- **Capability Registry** (key `ba_capabilities`; `capabilities.ts`) — the unified
  successor to "Known Sites". Each `CapabilityRegistryEntry` has a **kind**
  (bookmark / mcp / rest / webmcp / model / knowledge / skill), name, description,
  optional URL, **auth method** (none / browser-session / oauth / token) + config,
  **trust level** (public / verified / enterprise / local), tags, and a `source`. The
  registry is **prompt-injected** (the agent prefers a matching capability's own search
  over web search) and backs `search_known_sites` and MCP-server resolution. Legacy
  `ba_sites` (Hints) entries are **auto-migrated** to capabilities on first read
  (`migrateSitesToCapabilities`), and `toSiteEntry` keeps the old shape available for
  compatibility. Managed in **Settings → Capabilities** (`CapabilitiesSection.tsx`).
  *(Discovery sources `bookmark-discovery` / `webmcp-discovery` / `remote-registry` are
  defined but not yet populated automatically — see §15.)*
- **Skills** — Claude-Code-style named instruction blocks (seeded with examples on
  install). The agent loads one with `use_skill`. **App playbooks** are skills with
  an `origin`; the matching site's playbook auto-appears in the prompt. The user
  teaches one with `/learn` (the agent explores and calls `save_app_playbook`;
  re-running upserts by origin).
- **Memory** — see "Durable graph memory" below for the full design (graph
  model, reflection, retrieval tiers). Optional (off by default, toggled in
  Settings). A **Probe environment** button (Memory settings, shown only when
  memory is enabled) sends a `probe_environment` `RuntimeRequest`;
  `background/envProbe.ts` gathers on-device facts about the signed-in user —
  Microsoft 365 identity (name / work email / AD sign-in username via
  SharePoint `/_api/web/currentuser` over the session cookie), the enterprise
  systems currently open (an allowlist of work hosts), and locale/timezone —
  and the UI adds each as a graph memory node via `memory_graph_add`
  (exact-text dedup, capped at `MEMORY_NODE_CAP`). The service worker refuses
  the probe when memory is off. Nothing leaves the device.

**Durable graph memory** (`shared/memoryGraph.ts`, `background/memoryIndex.ts`,
`chrome.storage.local` key `ba_memory_graph`): entities/facts (`MemoryNode`) and
relationships (`MemoryEdge`), each with `kind` (entity/fact/preference/event),
`confidence`, `durability`, `status` (active/stale/superseded), `provenance`
(conversation id + verbatim excerpt), and timestamps. Replaces the earlier flat
`MemoryEntry[]` (`ba_memory`), which is lazily, non-destructively migrated into
graph nodes on first read (`storage.ts:getMemoryGraph`) and left in place as a
Backup/Restore fallback for one release.
- **Embedding index** — a reserved OPFS repo (`__memory__`, `RepoKind:'memory'`)
  holds one chunk per node (`label: summary` text), reusing the RAG store's
  hybrid BM25+vector search wholesale (`memoryIndex.ts`'s
  upsert/remove/search/rebuild wrap the existing `repoAdd`/`repoSearch`/
  `repoDeleteDoc` — no parallel search engine). `repoList` excludes this repo
  from every user-facing knowledge-base UI (it is retrieval plumbing, not a
  knowledge base the user created). Embeddings are an index only — the graph's
  `summary` text is the source of truth, so an embed-model switch just
  triggers a cheap full rebuild rather than data loss.
- **Reflection** — `AgentRuntime.reflectMemories` fires after every settled
  turn (alongside the existing `maybeLearnLesson`, same trigger conditions): one
  plain `complete()` call (no tools — unattended-safe) extracts durable
  knowledge from the turn as strict JSON (`parseReflection`); an empty result
  is the common case. Two kinds of memory count: facts about the user, and —
  when a page was read this turn via `get_tab_content`/`read_app_content` and
  the user asked to remember it or discussed it substantively — named
  entities, facts, events, and relationships extracted FROM that page (e.g. an
  article's people, organizations, and what happened), building a personal
  knowledge graph rather than only a preference list.
  `AgentRuntime.findRecentPageSource` cross-references the task's tool-call
  results (matched by `tool_call_id`) to find the most recent page read, and
  its `{url, title}` is attached to every candidate's provenance
  (`MemoryProvenance.sourceUrl`/`sourceTitle`) so extracted facts stay citable
  — shown as a link on the memory's detail view in the Workspace Memory page.
  `save_memory` accepts the same optional `sourceUrl`/`sourceTitle` for
  explicit, in-conversation saves. Candidates below the user-configured
  `ba_memory_min_confidence` (default 0, i.e. off) are dropped before merging
  (`filterByMinConfidence`) — a knob for users who want automatic saving to be
  more conservative; it never applies to explicit `save_memory` calls, which
  always save at confidence 1. Each surviving candidate is merged into an existing
  node (term-overlap or embedding-index match) or inserted fresh; a match
  whose text has drifted enough to look like a contradiction
  (`shouldAdjudicate`) gets one more cheap LLM call deciding supersede-vs-merge
  (`adjudicateSupersede`) — a superseded node is kept (`status:'superseded'`,
  `supersededBy`) rather than deleted. The graph is persisted before any
  embedding-index call, so an index/embedder failure never loses an extracted
  fact.
- **Retrieval — two tiers, prompt-cache safe.** *Core tier*: the top ~15 active
  nodes ranked by `durability × effectiveConfidence` (time-decayed — see
  below), rendered into the byte-stable `systemBase` once per conversation
  (`renderCoreMemoryBlock`) alongside the memory-first answering rule ("if the
  known facts already answer the question, answer directly — don't reach for
  tools"). *Relevant-subgraph tier*: computed once per user turn (not per
  agent step) — an embedding-index search over the message plus one hop of
  active edges, excluding whatever is already in the core tier — appended to
  the mutable trailing working-state message (`computeRelevantMemoryBlock`),
  so per-turn retrieval never invalidates the provider's prompt cache on the
  fixed prefix.
- **Decay** — `applyDecay` marks a node/edge `stale` (never deletes) once its
  time-decayed effective confidence drops below `MEMORY_STALE_THRESHOLD`; the
  decay half-life scales with `durability` (a preference decays far slower
  than a situational fact). Runs lazily on load and via a daily
  `chrome.alarms` sweep (`serviceWorker.ts`, `memory_decay_sweep`) that also
  prunes the graph back under its caps (`MEMORY_NODE_CAP`/`MEMORY_EDGE_CAP`,
  superseded records evicted first) and reconciles the embedding index for
  anything dropped.
- **Management UI** — `src/workspace/MemoryPage.tsx` (reachable from
  Workspace's nav or `workspace.html#memory`): filterable list (status/kind) +
  detail pane to edit a node's summary, confirm it (clears staleness, bumps
  `lastConfirmedAt`), or delete it, with evidence excerpts and relationships
  shown per node. The sidebar's `MemorySection.tsx` is a thin summary (count +
  enabled toggle + Probe environment + a link into the Workspace page) backed
  by new `RuntimeRequest`s (`memory_graph_get/add/confirm/update/delete`,
  `serviceWorker.ts`) that operate on the graph store directly — the same
  one-shot-message pattern already used for repo/mailbox/SharePoint
  management.

**Projects** (`shared/types.ts` `Project`, `chrome.storage.local` keys
`ba_projects` + `ba_active_project`): a named workspace that scopes
conversations, durable memory, skills, and capabilities. Scoping is a **filter,
not a partition** — a record's `projectId` is optional; unset means global and
stays visible under every project, so introducing Projects required no
migration anywhere. `AgentRuntime` reads the active project once per user turn
(`this.activeProjectId`, set at the top of `handleUserMessage`) and:
- filters what's *read* — `scopedCapabilities`/`scopedSkills` wrap every
  `getCapabilities()`/`getSkills()` call site (systemBase assembly,
  `search_known_sites`, `list_mcp_tools`/`call_mcp_tool`, `use_skill`,
  `/learn`), and `visibleToProject` (`shared/memoryGraph.ts`) gates both memory
  tiers (`rankCoreMemoryNodes`/`renderCoreMemoryBlock` and the relevant-subgraph
  tier's hits and one-hop edge expansion in `computeRelevantMemoryBlock`);
- stamps what's *written* — `save_memory`, reflection-created/merged memory
  nodes, `save_app_playbook`, `distillSkill`, and a newly-created conversation
  (stamped once at creation via `currentConversationProjectId`, preserved
  verbatim by `saveConversation` the same way labels are) all inherit the
  active project id. Same-origin/name "replace existing" lookups (app
  playbook re-learning, skill distillation) only ever match a record already
  visible under the active project, so project A can never silently overwrite
  project B's same-named skill or playbook.
Project CRUD and the active-project pointer go through dedicated
`RuntimeRequest`s (`project_list/create/update/delete/set_active/get_active`,
`serviceWorker.ts`) mirroring the memory-graph request pattern; deleting a
project just clears the active pointer if it was active — scoped records are
never deleted, only hidden from view until the project is switched back to.
UI: a compact `ProjectSwitcher` dropdown in the sidebar header, a full CRUD
`src/workspace/ProjectsPage.tsx`, and an optional project selector added to the
`CapabilitiesSection`/`SkillsSection` forms (shown only once at least one
project exists).

**Model orchestration** (`shared/types.ts` `ModelRole`/`ModelProfile`,
`background/llmProvider.ts` `resolveModelForRole`): routes background/utility
LLM calls to a different named endpoint than the main chat model, without
touching `complete()` itself or its ~11 existing call sites' positional
arguments. `ModelRole` is `'main' | 'utility' | 'knowledgeGraph' |
'reflection' | 'plan' | 'vision'`; `'main'` (the user-facing chat loop and its final answer,
`agentRuntime.ts` lines ~1766/1973) is never routed. `Settings.modelProfiles`
holds named alternate endpoints (baseUrl/apiKey/model/apiVersion/temperature/
maxTokens/`privacyTier`); `Settings.roleProfiles` maps a role to a profile id.
`resolveModelForRole(settings, role)` is pure and total — no chrome.* deps,
never throws, and returns `settings` unchanged whenever there's nothing to
route to (no mapping, no matching profile, or the profile is gated out), so a
deployment with zero profiles behaves exactly as before roles existed. Every
call site simply wraps its `settings` argument, e.g.
`complete(resolveModelForRole(settings, 'reflection'), ...)`; the tagging by
role:
- `'utility'` — conversation title/summary, self-check verify gate, skill
  distillation, old-tool-output compaction (`summarizeEvicted`), RAG query
  paraphrase and rerank.
- `'knowledgeGraph'` — entity/relationship extraction and graph community
  summaries. An unassigned role inherits `'utility'`, then the main model, so
  existing Utility-routed graph builds retain their behavior.
- `'reflection'` — lesson-learning (`maybeLearnLesson`), memory extraction
  (`reflectMemories`), the merge-vs-supersede adjudication call.
- `'plan'` — scoped multi-step research subtasks (`runScopedSubtask`).
- `'vision'` — OCR transcription of page screenshots (`repoIngest.ts`
  `ocrTabText`).

**Rule-based routing only** — no classifier LLM decides where a call goes;
the mapping is static settings config, so it's also naturally **stable across
a task's steps** for prompt-cache purposes (nothing here reads per-message
state). **Privacy gate**: `Settings.restrictBackgroundToLocal`, when on,
skips any profile not explicitly tagged `privacyTier: 'local'` (untagged
profiles are conservatively treated as needing the same protection) and
falls back to the main model instead — background work never leaves the
device to a hosted service even if a cloud profile is assigned to that role.
UI: `src/workspace/ModelProfilesSection.tsx`, rendered below the existing
`ModelSection` on the Workspace's Models page — profile CRUD, a role
assignment table, and the restrict-to-local toggle, all writing directly into
`ba_settings` (the main connection fields above are untouched by this UI).

**Skill manifest v2 & install (local-only, v1)** (`shared/types.ts` `Skill`
`version`/`declaredTools`/`source`, `shared/skillImport.ts`
`compareSkillVersions`/`shouldReplaceSkill`/`bumpSkillVersion`/`parseSkillZip`):
skills carry a dotted version (compared numerically, not strict semver — no
pre-release handling, since skill versions are free text a user or the model
writes, not npm packages), an optional `declaredTools` list parsed from a
SKILL.md `allowed-tools:` frontmatter field (informational only — shown in
the editor, not an enforced permission gate; the real gate is still the
per-call approval flow), and a `source` (`manual`/`url`/`zip`/`generated` +
`installedAt`, with `registryUrl` **reserved** for a future hosted registry —
no server exists yet, so every install path here is local: paste a SKILL.md
URL, upload a zip, or have the agent generate one). Every non-manual install
path (URL, zip, remote-playbook-library) goes through version-aware merge
(`shouldReplaceSkill`) instead of always overwriting by name: absent-version
skills keep the historical always-replace behavior, but once both sides carry
a version, an older incoming bundle is skipped rather than clobbering a newer
local edit, and re-installing the identical bundle twice is a no-op.
`parseSkillZip` (pure, `fflate.unzipSync` — no DOM/network) extracts every
SKILL.md-shaped `.md` member from an archive, so one zip can be a single
skill or a "pack" of several under subdirectories; `SkillsSection.tsx`'s
**Import zip** button wires it up, reporting an added/updated/skipped-older
count per zip.

**Generate a skill from a prompt.** Explicitly **not** a new
sandboxed-execution surface — skills stay LLM-interpreted markdown, never
executable code, and the task that produces one still runs through the
normal, already-approval-gated tool loop (a real sandboxed typed-API runtime
for skill-declared *executable* tools was scoped out of this phase pending a
dedicated security review; see the plan). `AgentRuntime.packageTaskAsSkill`
is the one packaging step shared by two entry points: the existing UI "Save
as skill" button (`distillSkill`, offered after a substantial task) and the
new agent-callable **`save_as_skill`** tool (approval-gated, like
`save_app_playbook`) — so a user can say "save this as a skill" mid-task
instead of waiting for the task to end and clicking a button. Re-packaging
an already-saved same-name skill patch-bumps its version
(`bumpSkillVersion`) rather than leaving it untracked or duplicating it.

**Agent platform: scheduled tasks, workflows, and event triggers**
(`background/scheduler.ts`, `background/automation.ts`,
`shared/scheduledTasks.ts`, `shared/workflows.ts`, `shared/eventTriggers.ts`).
Three ways to run a task without the user driving it turn by turn, all
funneling through the same unattended path — `AgentRuntime.runScheduledTask`
(`unattended = true`, so any state-changing tool call returns `needs_approval`
instead of running silently; the existing unattended-approval gate is
untouched by any of this):
- **Scheduled tasks** (pre-existing since an earlier phase, previously
  tool-only with **no management UI at all** — a real gap closed here). A
  `ScheduledTask {title, prompt, recurrence, nextRunAt}` created via the
  agent's own `schedule_task`/`cancel_scheduled_task` tools, driven by
  `chrome.alarms` (one alarm per task, named `scheduled_task:<id>`,
  reconciled on install/settings-change so MV3 eviction never loses a
  schedule), with a capped `ScheduledRun[]` history
  (`getScheduledRuns`/100-entry cap) per run.
  **Delivery, since no sidebar is typically open when an alarm fires**: a
  `chrome.notifications` completion notification (`notifyRunComplete`, message
  text pulled out as pure `buildRunNotificationMessage` for testability;
  degrades to a no-op if the `notifications` permission/API is unavailable)
  fires on every run, clicking it opens the Automations page; any
  `FileArtifact` produced (e.g. `create_powerpoint`) is saved into the durable
  **Products** store (`AgentRuntime.pushChat` → `productSave`, only when
  `this.unattended` — an attended turn still uses the click-to-download card,
  unchanged) rather than either only rendering as a card no one is present to
  click, or firing an OS download prompt per run (a real annoyance once
  several jobs are scheduled); `runScheduledTask`'s return value carries
  `conversationId` and `fileArtifactNames`, threaded into
  `ScheduledRun`/`TriggerRun` and shown in full (not truncated to a hover
  tooltip) on the Automations page.
- **Products** (`offscreen/productStore.ts`, `shared/messages.ts`
  `ProductRequest`/`ProductMeta`) — an OPFS-backed store for files unattended
  runs generate, mirroring `repoStore.ts`'s pattern (offscreen-document-only;
  the service worker reaches it via `offscreenClient.ts`'s
  `productSave`/`productList`/`productGet`/`productDelete` → `target:
  'offscreen-product'` messages) but laid out one self-contained item per
  directory (`products/<id>/{meta.json, blob}`) rather than
  `repoStore.ts`'s single shared corpus. Each
  `ProductMeta {id, filename, mimeType, createdAt, sizeBytes, sourceTitle?,
  conversationId?}` is retrievable by id (base64 round-trip through the same
  bridge) and listed newest-first. UI: `src/workspace/ProductsPage.tsx` — a
  flat list (filename, timestamp, size, source task/trigger name) with
  Download (via the existing `saveFile` Save-As flow) and Delete per row; no
  expiry, capacity, or auto-pruning — deletion is manual. Included in
  **Backup & Restore** (`sidebar/BackupRestoreSection.tsx`), mirroring repos:
  `productExportAll`/`productImportAll` (base64-encoded blobs) round-trip
  through `products_export`/`products_import` messages and an `ExportedProduct
  {meta, dataB64}` array in the backup JSON, overwriting any product with the
  same id on restore.
- **Workflows** (`shared/workflows.ts` `Workflow {name, skillNames[]}`) — a
  named, ordered chain of *existing* skills. Running one is not a new
  execution engine: `buildWorkflowPrompt` just writes an explicit
  numbered instruction ("call `use_skill` for X, finish it, then Y, then
  Z…") and hands that to the normal loop, so a workflow is a saved shortcut
  through tools the agent already has, not a new capability.
  *As-built: the Workflows management UI has been removed from the Automations
  tab (a saved skill-chain proved to overlap with just invoking skills in
  order). The engine, storage, and `workflow_*` messages remain for
  backward-compatibility with any workflow already stored, but there is no
  longer a UI to create or edit them, and event triggers are skill-only (below).*
- **Event triggers** (`shared/eventTriggers.ts` `EventTrigger {hostPattern,
  target: skill|workflow, cooldownMinutes}`) — "when I open a page on this
  site, run this unattended." Firing is driven by a single top-level
  `chrome.tabs.onUpdated` listener in `serviceWorker.ts` (registered
  synchronously so MV3 eviction can't lose it) that calls
  `automation.maybeFireEventTriggers(url, runtime)`: matches enabled
  triggers by hostname (`hostMatches` — subdomain-aware, the same rule an
  app playbook's origin uses) and cooldown (`isInCooldown`, default 60
  minutes), skips entirely when `runtime.isRunning()` (never interrupts or
  interleaves with the user's own task — retried on the next matching
  navigation), and fires strictly one at a time (each `fireTrigger` call is
  awaited to completion before considering the next candidate). A
  `TriggerRun[]` history mirrors `ScheduledRun` (own 100-entry cap). Costs
  nothing per navigation beyond one empty storage read when no triggers are
  configured.

UI: `src/workspace/AutomationsPage.tsx` — the first-ever view into scheduled
tasks (list, edit/reschedule, pause/resume, delete, recent runs) alongside
Event trigger CRUD (site, target skill, cooldown, recent runs). Scheduled tasks
also support inline edit + reschedule. RuntimeRequests (`scheduled_tasks_get`,
`scheduled_task_set_enabled`, `scheduled_task_update`, `event_trigger_create`,
etc., `serviceWorker.ts`) mirror
the established one-shot-message pattern used throughout (Projects, memory
graph, repos).

**Explainability, scoped down.** A dedicated "explainability page" surfacing
findings/approval-reasons/memory-provenance in one place was in the original
plan for this phase but folded into the Automations page's run history
(status/summary/error per run, and each run's originating task/trigger/
workflow) rather than built as a separate page — the existing
`ToolActivityPanel` (per-conversation) and Memory page (per-fact provenance)
already cover the rest without duplicating them here.

**Auth auto-pause.** When page extraction detects a login wall, the task pauses,
the panel shows a sign-in notice, and resuming re-fetches the page.

**Conversation history.** Every settled turn persists the thread to
`chrome.storage.local`: an index (`ba_conv_index`, `ConversationSummary[]`) plus one
record per conversation (`ba_conv_<id>`, the display + model arrays so it can be fully
restored). The **History** screen (`ConversationsScreen.tsx`) lists threads with an
LLM-written **title + 1–2 sentence summary** (generated together in one call after the
first exchange, refreshed as the thread grows; fail-soft to a clipped snippet), is
filterable, and supports **load**, **delete**, **clear-all**, **export/import** (a
portable JSON file), and user-defined **labels** (`ba_conv_labels`, colored via
`labelColors.ts`, edited with `LabelPicker.tsx`).

**Undo last exchange.** A header **Undo** control removes the last user turn and the
response it produced, backed by an in-memory checkpoint stack (array-length snapshots
captured at the top of each turn), and drops the removed prompt back into the composer
for editing/resend. Live-session only (empty after a worker reload → button disabled);
disabled while a task runs.

**Tab-group rehydration.** Alongside `lastTaskUrl`, a conversation persists its tab
group's name + URLs (`collectGroupUrls`); on restore the agent best-effort re-opens
the active tab and the group's pages into a collapsed, same-named group (deduped
against already-open tabs, capped), so a resumed thread can be queried again.

**File upload into repositories.** Besides ingesting tabs, the user can upload files
(`.pdf/.docx/.pptx/.xlsx/.txt/.md/.csv`, capped at `MAX_UPLOAD_BYTES`) straight into a
repo. The shared `RepoUpload.tsx` (a reveal-on-demand, vertically-stacked card with a
drop zone + repo picker) appears both in **Workspace → Knowledge** and in the
**composer** (drag-drop onto the panel or the 📎 attach button). Files cross to the
worker as a `add_files_to_repo` request; text files send their text, PDF/Office send a
base64 data URL the offscreen extractor parses; each runs through `ingestFile` →
`storeText`. Per-file results drive a success **UploadBanner** (auto-clears on full
success; stays open to show any skips).

**Document & presentation generation.** `create_word_document` and `create_powerpoint`
build a `.docx` / `.pptx` in the offscreen document (lazy `docx` / `pptxgenjs`) and
deliver it as a downloadable `FileArtifact` card in chat. Generation only — the browser
sandbox cannot edit a source file in place.

**Voice prompts.** A hidden microphone page records audio via `getUserMedia`; the
worker sends it as `transcribe_audio` → `transcribe()` (`/audio/transcriptions`) and
drops the text into the composer. Enabled only when a `transcriptionModel` is set.

**Onboarding.** On first run with no endpoint configured, `OnboardingScreen.tsx`
walks the user through setting a base URL / key / model before the chat is usable.

**Workspace (full tab) & Notebooks Workspace.** The sidebar's **Settings** gear opens `workspace.html`
(`chrome.tabs.create`) — a management console that mirrors conversation state
over the same `Port` **and** is interactive: a **composer** sends `user_message`s like
the side panel. Its nav gives management surfaces dedicated pages — Memory, Skills,
Tools, Models, Automations, Products, Settings (language, playbook library, Backup & Restore) —
and panels too cramped for the side panel: a data/table viewer (`DataViewer`, over `export_data`
results) and a full-size image viewer (`ImageViewer`).

Knowledge base management lives in its own dedicated **Notebooks Workspace** (`notebooks.html` / `NotebooksWorkspace.tsx`),
accessed via the header's Knowledge icon or `#` composer mentions. It features a **Master-Detail NotebookLM layout**
with two sub-tabs:
- **Notebooks Tab:** Left master list for filtering and selecting repositories; right detail pane featuring sub-tabs for **📄 Overview** (with AI-generated all-encompassing title, key topic chips, and suggested questions), **🕸️ Concept Graph** (GraphRAG entity map and communities), **🎓 Studio Artifacts** (Briefing, FAQ, Study Guide), and **📁 Documents**. Includes 1-click **Export Knowledge Base (HTML)** (`exportKnowledgeBaseHtml`), which produces a standalone HTML dump with a Table of Contents, AI-generated title, ordered sections (Overview &rarr; Studio &rarr; Graph), and hyperlinked inline reference jump-links (`#ref-...`).
- **Indexing Tab:** Integrated ingestion connectors for Local Files & Folders (`RepoUpload` + drag-and-drop), SharePoint / OneDrive libraries (`SharePointSection`), and Office 365 Mailboxes (`MailboxSection`).

**Trust & auth model.** Capabilities carry a **trust level** and **auth method**, which
flow into the approval gate: tools sourced from an `enterprise`/`local`-trust capability
can be auto-approved, while lower-trust ones still prompt; capability auth (token /
browser-session) is resolved at call time via `resolveAuth` (used for MCP). The browser
session remains the primary trust boundary (OAuth/OIDC flows are not yet implemented —
token and browser-session auth only).

**Composer mentions.** The composer is a `contenteditable` that rewrites a typed
token into a **bold** node carrying `data-kind`/`data-value`. Two triggers share one
menu/insert mechanism: `@` opens a **bookmark** picker and inserts the chosen URL;
`#` opens a **repository** picker (`repo_list`) and inserts the chosen repo name.
Because the bold styling is lost when the message is flattened to text, the
mentions are also collected as **structured data** (`user_message.mentions:
{kind,value}[]`) and the runtime appends an explicit directive to the model-facing text
— so the agent acts on them directly: `search_repo` that exact repository, or open and
read that exact bookmarked URL (not a web search).

The `@` picker (`sidebar/bookmarkMentions.ts`, pure + unit-tested) draws from **three**
sources merged into one ranked, deduplicated list, not just `chrome.bookmarks`:
`flattenBookmarkTree` walks the full `chrome.bookmarks.getTree()` (carrying each
bookmark's folder path); `capabilityBookmarkCandidates` adds `kind:'bookmark'` entries
from the Capability Registry and `SiteEntry`/"Known Sites" (`ba_capabilities`/`ba_sites`
in storage) — so a Known Site is `@`-mentionable even if it isn't also a browser
bookmark. `dedupeBookmarkCandidates` merges by normalized URL (keeping the richer
title/description/tags). `filterBookmarkMentions` then scores by substring match across
title/URL/description/folder/tags (title-prefix best, then title/URL/description/tags/
folder in that order) and returns the top 20.

---

## 10. Side-panel UI (`src/sidebar/`)

- **Header** (`Sidebar.tsx`): title + agent **status** (idle/thinking/acting/…),
  prominent; a **History** button (opens `ConversationsScreen`); a **New Chat**
  button that also aborts any running task; a **⋯ More** overflow menu
  (`OverflowMenu.tsx` — ARIA menu with roving focus, Escape/click-outside dismiss)
  holding the **text-size control** (A− / percentage-reset / A+, whole-panel CSS
  `zoom`, persisted in `localStorage`, applied before first paint to avoid flash;
  clicking it does not dismiss the menu), **Save conversation as HTML**, **Undo**
  (disabled when nothing to undo or while running), and **Learn mode**; and a
  **settings** (gear) button that opens the Workspace (`workspace.html#settings`).
  The overflow menu exists so the brand title renders untruncated at the
  narrowest (~360px) panel width — guarded by `tests/e2e/header.spec.ts`.
- **Chat** (`ChatPanel.tsx` + `Markdown.tsx`): Markdown via `marked` + `dompurify`;
  bold, small citations with full URLs; per-message **copy** button; image
  thumbnails for snapshots; CSV/JSON download chips for `export_data` and **download
  cards** for generated `.docx`/`.pptx` (`FileArtifact`); a 📎 attach button and
  panel-wide drag-drop that open the **`RepoUpload` card** (files go into a
  knowledge base); a voice (🎤) prompt control when transcription is configured.
- **History** (`ConversationsScreen.tsx`): titled+summarized thread list with search,
  labels, and load / delete / clear-all / export / import.
- **Plan panel** (`PlanPanel.tsx`): the live plan with per-step status.
- **Tool activity** (`ToolActivityPanel.tsx`): a running log of tool calls and
  outcomes, including approvals (Approve/Deny inline).
- **Tab-context bar** (`TabContextPanel.tsx`):
  Snapshot, Snapshot Page, Refresh; a **repo capture** row — a repo-name box that is a
  `<datalist>` dropdown of existing repos *and* accepts a new typed name, plus
  **+ Tab** / **+ Group** buttons.
- **Settings**: the sidebar has no settings overlay — the gear opens the
  **Workspace**, where configuration is split across pages: **Models**
  (connection + the Advanced groups: behaviour, generation, retrieval,
  connected services), **Skills** (`SkillsSection.tsx`, incl. the **App
  playbook library** polling a configurable hosted index — `playbookIndexUrl`,
  editable there and on the Workspace Settings page), **Knowledge**
  (`RepositoriesSection.tsx`), **Tools** (`CapabilitiesSection.tsx`),
  **Memory** (`MemorySection.tsx` + `MemoryPage.tsx`), and **Settings**
  (language, playbook URL, `BackupRestoreSection.tsx`).
- **Panel → worker** (`SidebarCommand`, over the `Port`): `user_message`
  (with optional `mentions: {kind,value}[]`),
  `stop_task`, `clear_conversation`, `undo_exchange`, `load_conversation`,
  `delete_conversation`, `import_conversation`, `clear_conversations`,
  `set_conversation_labels`, `distill_skill`, `dismiss_distill`,
  `pause_agent`, `resume_agent`, `approval_response`, `include_active_tab`,
  `include_all_tabs`, `refresh_context`, `attach_snapshot`, `discard_snapshots`,
  `capture_page`, `capture_to_repo`, `get_state`, `ping`.
- **Worker → panel** (`BackgroundEvent`): `chat_message`, `status`, `tool_activity`,
  `approval_request`, `auth_required`, `permission_required`, `context_update`,
  `pending_snapshots`, `plan_update`, `distill_offer`, `undo_available`, `undo_done`,
  `error`, and a `full_state` snapshot (incl. `canDistill`, `canUndo`) sent on connect.
- **One-shot** (`RuntimeRequest` via `chrome.runtime.onMessage`): `test_connection`,
  `repo_list`, `repo_delete`, `repo_docs`, `repo_doc_delete`, `repo_export`,
  `repo_import`, `add_files_to_repo`, `transcribe_audio`, and
  `probe_environment` (→ `{ok, facts?, notes?, error?}`; gathers signed-in M365
  identity + open work systems + locale for Memory, only when memory is enabled).
- **Offscreen:** `ExtractPdfRequest {target:'offscreen', type:'extract_pdf', url,
  maxChars?}` → `ExtractPdfResponse {ok, text?, pageCount?, charCount?, truncated?,
  error?}`; `ExtractOfficeRequest {…, type:'extract_office', url, maxChars?}` →
  `ExtractOfficeResponse {ok, text?, format?, charCount?, truncated?, error?}`;
  `GenerateDocumentRequest {…, type:'generate_document', format:'docx', title, markdown}`
  and `GeneratePresentationRequest {…, type:'generate_presentation', title, slides}` →
  `GenerateDocumentResponse {ok, dataBase64?, mimeType?, error?}`; the
  `RepoRequest` union on `target:'offscreen-repo'` → `RepoResponse {ok, result?, error?}`.

The `approval_request` event additionally carries the sourcing capability's context
(`capabilityKind`, `capabilityName`, `trustLevel`, `authMethod`, `authConfigured`) so
the panel can show trust/auth before the user approves.

---

## 12. Settings shape

```ts
interface Settings {
  baseUrl: string;       // OpenAI-compatible endpoint, e.g. https://api.example.com/v1
  apiKey: string;        // stored only on device, never synced
  model: string;         // chat/completions model id
  apiVersion?: string;   // set → Azure mode (?api-version=… + api-key header) for every service
  temperature?: number;
  maxTokens?: number;
  repoSearchK?: number;  // default passages per search_repo; absent = 6
  hybridSearch?: boolean;// fuse semantic + BM25 (RRF) in search_repo, §8.4; absent = on
  maxSteps?: number;     // soft step budget per task; absent = 20 (extension = round/2, ceiling = ×2)
  systemPrompt?: string; // custom instructions, appended to the built-in prompt
  sharepointBaseUrl?: string; // optional, for sharepoint_search / microsoft365_search files
  graphClientId?: string;     // Azure AD app client ID — mail/calendar/draft/mailbox indexing (Graph OAuth), §8.3/8.5
  graphTenant?: string;       // Graph OAuth tenant; absent = 'organizations'
  mailAutoRefresh?: boolean;  // hourly chrome.alarms mailbox re-index, §8.3; absent/off = manual only
  playbookIndexUrl?: string;  // optional, hosted playbook index polled by the App playbook library; absent = bundled default
  embedder?: 'local' | 'external'; // RAG embedder: on-device transformers.js vs the /embeddings endpoint; absent = local
  localEmbedModel?: string;   // optional, transformers.js model id for the on-device embedder; absent = bundled default
  embeddingModel?: string;    // optional, for /embeddings (local RAG); defaults to `model`
  embeddingBaseUrl?: string;  // optional, separate embeddings endpoint; blank = baseUrl
  embeddingApiKey?: string;   // optional, separate embeddings key; blank = apiKey
  transcriptionModel?: string;   // optional, enables voice prompts (/audio/transcriptions)
  transcriptionBaseUrl?: string; // optional, separate STT endpoint; blank = baseUrl
  transcriptionApiKey?: string;  // optional, separate STT key; blank = apiKey
  retryOnRateLimit?: boolean;     // auto-retry transient 429/5xx (Retry-After aware); absent = on
  summarizeObservations?: boolean;// digest evicted tool outputs instead of blanking; absent = on
  verifyAnswers?: boolean;        // one self-check pass before accepting an answer; absent = on
}
```

Persisted under `ba_settings` in `chrome.storage.local`. The Settings screen trims
fields and drops empties on save. Other `chrome.storage.local` keys: `ba_capabilities`
(Capability Registry; legacy `ba_sites` is migrated into it), skills, memory, `ba_lessons`
(automatic lessons, §5 step 7; cap 50), `mailAutoRefreshStatus` (last background mailbox
refresh outcome); `ba_conv_index` / `ba_conv_<id>` / `ba_conv_labels` (conversation
history). OPFS holds
the RAG repos (`/repos/`) and the Products store (`/products/`).
The UI **language** preference is a separate key
(`ba_language`: `'auto'|'en'|'fr'`); in-app EN/FR localization lives in
`src/sidebar/i18n.tsx` (catalogue + `LanguageProvider`/`useT`), with a partial-coverage
caveat in `technical-debt.md`.

---

## 13. Build, load, verify

1. `mise run install` (or `npm install`).
2. `mise run typecheck` — must pass clean (`tsc --noEmit`).
3. `mise run test` — Vitest unit suite green. `npm run test:e2e` builds then runs the
   Playwright suite against the offline mock LLM (no live keys, no spend).
4. `mise run build` — emits `dist/` with `serviceWorker.js`, `sidebar.html`,
   `offscreen.html`, `microphone.html`, `contentScript.js`, assets (incl.
   the pdf.js worker), icons, and `manifest.json`.
5. Load **dist/** as an unpacked extension (`chrome://extensions`, Developer mode);
   accept the install permissions.
6. Open the side panel from the toolbar; configure an endpoint (the welcome card,
   or Workspace → Models) and **Test connection**.

**End-to-end checks:**
- "What does this page say?" on any article → reads the active tab and answers with
  a source link.
- A multi-step research task → a plan appears, tabs open into a named group,
  `read_tab_group` synthesizes, findings persist across compaction.
- A state-changing action (e.g. `fill_input` + `submit_form`) → an approval card
  with a plain-language reason; Deny stops cleanly.
- `read_pdf` on a long PDF → far more than 20k chars, `truncated` flagged with the
  full `charCount`.
- `+ Tab` a long PDF into a repo, then `search_repo` → passages from late pages
  (whole document ingested); re-adding the same page prompts to replace.
- Workspace → Knowledge → expand a repo → delete one document → its chunks drop
  and it stops appearing in search.
- `sharepoint_search` while signed into SharePoint → ranked snippets with URLs.
- "Make a 3-slide deck on X" / "write that up as a Word doc" → a `.pptx` / `.docx`
  download card appears and opens correctly (titles, bullets, speaker notes).
- Drag a file onto the panel (or use 📎) → it ingests into the chosen repo with a
  success banner and becomes searchable via `#repo` / `search_repo`.
- Send a few messages, open **History** → a titled+summarized row; load it to restore
  the thread (and reopen its tab group); **Undo** removes the last exchange.
- **Settings gear** → the Workspace opens sharing the conversation; the data viewer
  shows the last `export_data` table and the image viewer shows a generated image
  full-size.

---

## 14. Design decisions worth preserving

- **Offscreen document** exists solely because the MV3 service worker can't run
  pdf.js or the async OPFS API — don't try to move RAG/PDF into the worker.
- **Two Vite builds** because content scripts must be IIFEs, not ES modules.
- **Per-consumer caps, not a baked-in cap:** PDF extraction is complete; the
  `read_pdf` tool slices to ~60k for context, ingestion takes the whole document.
- **Approval reasons are user-facing copy**, not debug strings — they're the only
  thing the user sees before authorizing an action.
- **Embeddings via the user's endpoint + OPFS storage** keep RAG sovereign; never
  add a bundled embedding model or a third-party vector service.
- **WASM/Rust is deferred:** at personal scale, local CPU isn't the bottleneck
  (network round-trips dominate); revisit only past tens of thousands of chunks, and
  prefer an ANN index over a SIMD port. MV3 would also need `'wasm-unsafe-eval'` in
  the CSP.
- **No `site:` operator, ever** — search within a site by visiting the site.
- **Stable cached prefix:** `conversation[0]` (`SYSTEM_PROMPT` + tools) is kept
  byte-stable so the provider's prompt cache hits each step; volatile working-state
  rides a trailing `system` message instead — don't move it back into the prologue.
- **Generate, don't edit:** the browser sandbox can't write a file back in place, so
  `create_word_document` / `create_powerpoint` produce a downloadable `FileArtifact`
  rather than editing a source document.
- **One Capability Registry, not parallel subsystems.** Bookmarks, MCP, WebMCP, REST,
  models, knowledge sources, and skills are all `CapabilityRegistryEntry` kinds. Legacy
  "Known Sites" are migrated, not maintained as a second store — don't reintroduce a
  separate sites concept.
- **Trust rides on the capability, not the tool.** A tool's gating can be relaxed
  (auto-approve) or kept strict based on the sourcing capability's trust level; the
  browser session stays the root trust boundary.

---

## 15. Enhancement roadmap — Tools, Skills, Data & Trust Architecture

> **Status: mixed — partially shipped.** This is the *Data, Tools, Skills, and Trust
> Architecture* design package. Several items have since landed and are now documented
> as shipped behavior in §§1–14; the rest remain planned. Each item below is tagged
> **✅ shipped**, **🟡 partial**, or **⬜ planned**. Only ⬜/🟡 items describe work not
> yet (fully) built.

**Guiding architectural principle.** CANAgent evolves toward a layered model:

```
Browser → Identity → Trust → Authentication → Capability Discovery
Capability Registry → Models · Tools · Skills · Knowledge Sources
Agent → uses the registry · uses browser trust · orchestrates workflows · executes locally when possible
```

The keystone change — **replacing "Known Sites" with a Capability Registry** — has
shipped: bookmarks, MCP, WebMCP, REST, models, knowledge sources, and skills are now
all `CapabilityRegistryEntry` *kinds* (see §9). What remains is mostly **automatic
discovery** to populate that registry, plus deeper data/output handling.

### Shipped (now in the body)
- **✅ 15.1 Expandable workspace** — the **Settings** gear opens `workspace.html`,
  a full management console (Chat/Projects/Knowledge/Memory/Automations/Products/
  Skills/Tools/Models/Data/Image/Settings pages, most built by reusing the sidebar's
  own section components) sharing conversation state. It is also the settings
  surface — the sidebar's tabbed overlay was removed. See §9 *Workspace* and §10.
- **✅ 15.2 Capability Registry** — replaces Known Sites; `ba_capabilities`,
  `CapabilitiesSection`, legacy-site migration. See §9 *Capability Registry*.
- **🗑 15.12 Built-in DuckDB data engine** — shipped, then **removed** (unused):
  the engine, its `*_data`/`*_dataset` tools, the Datasets browser, and the
  ~23 MB of bundled wasm were deleted; `export_data`/`DataViewer` (collect rows
  while browsing → CSV) remain. The **map workspace** (one Leaflet tab + `map_*`
  tools) was removed at the same time for the same reason.
- **🗑 15.14 Natural-language data queries** — removed with the data engine.
- **🟡 15.6 Unified tool architecture** — `UnifiedToolDefinition` (kinds
  builtin/rest/mcp/webmcp/browser) exists and powers the Workspace tool browser, but
  the runtime's tool **dispatch** is not yet routed through it (built-in/MCP/WebMCP
  still have distinct call paths). REST tools are not yet invocable.
- **🟡 15.9 / 15.10 Trust & auth model** — capabilities carry trust levels + auth
  methods that feed the approval gate (auto-approve at enterprise/local trust) and MCP
  auth resolution. See §9 *Trust & auth model*. **OAuth/OIDC flows are ⬜ not yet
  implemented** — only browser-session and static-token auth work today.
- **🟡 15.15 Rich browser output** — the Workspace provides a data-table viewer and a
  full-size image viewer; **charts and formatted reports are ⬜ not yet built**
  (the map workspace shipped here previously but has been removed).

### Still planned (not yet implemented)

**⬜ 15.3 Bookmark-based discovery.** A periodic background process that enumerates
browser bookmarks, visits the sites, generates summary descriptions, and registers
them as capabilities (the `bookmark-discovery` source is defined but unpopulated).
*Benefit:* searchable enterprise capability discovery.

**⬜ 15.4 WebMCP capability discovery.** On visiting a page, auto-detect WebMCP,
enumerate methods, and register them in the Capability Registry associated with the
page (the `webmcp-discovery` source is defined but unpopulated) — so *"How do I submit
a travel claim?"* resolves to a bookmark + its WebMCP methods with no manual config.
(Builds on today's per-tab WebMCP bridge, §6.)

**⬜ 15.5 Remote enterprise Capability Registry.** Centrally-managed registries of
skills, MCP/REST tools, prompt templates, and knowledge connectors; on a recognized
site, offer *"approved enterprise capabilities available"* with **Load once / Always
load / Ignore** (the `remote-registry` source is defined but not fetched). *Benefit:*
governance, centralized updates, less local config.

**🟡 15.7 / 15.8 Explicit skills + slash-command framework.** Skills exist today
(`use_skill`) **and** a user-facing slash dispatch is wired: typing `/<name> [args]`
forces the matching skill (built-in `/learn` plus any seeded/user skill), passing the
trailing text as the task (`agentRuntime` slash parser; composer autocomplete in
`ChatPanel`). Two search skills ship in the basic set: **`/search-sharepoint`** and
**`/search-mail`** lead with the **`microsoft365_search`** tool (REST over the signed-in
session — SharePoint/Microsoft Search for files incl. OneDrive, Outlook-on-the-web for
mail), mapping the request to its structured parameters (`source` / `query` / `from` /
`fileType` / `sitePath` / `editedByMe` / `since` / `until` / `orderBy` / `top`) rather
than hand-writing KQL; `/search-mail` falls back to driving the Outlook web UI only if the
mail endpoint returns a `mailError`. Cookie auth over the signed-in browser session (no
Graph bearer token). What's still ⬜ is a richer **command→tool-chain**
framework (a dedicated `command` + `arguments` parser expanding one slash command into a
fixed multi-tool workflow, e.g. `/travel-claim …`). Principle to preserve: **tools are
capabilities (agent-selected); skills are workflows (user-invoked).**

**⬜ 15.11 Models as registry resources.** The registry already defines a `model` kind,
but models are still configured via Settings rather than being selectable registry
entries with endpoint / auth / cost / capabilities / context-window metadata.

**⬜ 15.13 Structured data-handler framework.** A uniform open/preview/query/convert/
export interface across CSV, JSON, Parquet, XLSX, DOCX, PPTX, PDF. Today these are
handled piecemeal (offscreen extractors for PDF/Office; `export_data` for tables out);
a single handler registry is not yet built. (A DuckDB-based engine shipped and was
later removed as unused — a future framework should re-justify that weight first.)

---

## 16. Security model & boundaries

The extension's security posture is best stated as **what the browser boundary gives us,
what it deliberately does not, and what the app must therefore enforce itself.** Stating
it this way avoids the common over-claim that "the browser sandboxes the agent" — it does
not; the extension is a *privileged* party that operates above the per-site sandbox.

### 16.1 Boundaries inherited from the browser (used, not reimplemented)
- **Authentication & sessions.** Auth is delegated to the browser and the user's IdP. The
  agent reaches authenticated systems by *inheriting the signed-in session* (cookies),
  so the extension never stores or handles the target systems' credentials or tokens.
- **Transport.** TLS and certificate validation are the browser's; the extension makes no
  raw socket connections.
- **Site isolation (for web content).** Same-origin policy / CORS, cookie scoping, and
  process/site isolation protect *sites from each other* and *the user from arbitrary
  pages* — battle-tested mechanisms the extension relies on rather than rebuilds.
- **Web search** specifically rides the user's own **default search engine** in a real
  tab — no third-party search API or key; egress matches ordinary browsing.

This makes "we use the browser as a mature, well-understood trust-and-transport boundary"
a *fair and accurate* claim.

### 16.2 Where the browser boundary does NOT contain the agent
The extension is granted broad privileges precisely so the agent can be useful, and those
privileges sit **above** the protections in §16.1:
- **Elevated permissions.** `<all_urls>`, `scripting` (incl. MAIN-world injection),
  `cookies`, `tabs`, `search`, `bookmarks` — the agent can read any page, run page script,
  read cookies, and make **credentialed cross-origin** requests. The same-origin policy
  does **not** fence the agent the way it fences a website.
- **Ambient credentialed authority (confused-deputy surface).** Because the agent acts
  with the user's live sessions across *every* origin, a single task spans authorities
  that SOP would normally keep apart. Site isolation says nothing about this.
- **The model is the new untrusted element.** The security-relevant boundary is
  **model ↔ privileged action**, not site ↔ site. Page/email/document content can attempt
  **prompt injection** to steer a privileged agent; the browser sandbox provides no defense
  against an injected instruction to misuse a tool the extension is already allowed to use.
- **An egress hop the browser boundary doesn't cover.** Content read via the browser is
  sent to the user's **configured LLM endpoint** (and embeddings to the embeddings
  endpoint). That hop is in-scope for the threat model even though TLS protects it.

### 16.3 Boundaries the app enforces itself
Because §16.2 is real, the controls that actually bound the agent are implemented in the
app, not borrowed from the browser:
- **Instruction-source boundary.** Only the user (via chat) issues commands; everything
  observed through tools (page DOM, emails, documents, file contents, tool results) is
  **data, not instructions**. Content that tries to direct the agent is surfaced to the
  user, not acted on — the primary prompt-injection defense.
- **Approval gate + tool classification (§5).** `READ_ONLY_TOOLS` run freely and in
  parallel; every `APPROVAL_REQUIRED` tool (page mutation, `run_javascript`, MCP/WebMCP
  calls, bulk tab reads, …) emits a plain-language approval card and blocks on a user
  decision. State-changing/outward-facing actions are confirmed, not assumed.
- **Capability trust levels (§9).** A tool's gating can be relaxed (auto-approve) or kept
  strict based on the *sourcing capability's* trust level; the browser session remains the
  root trust boundary. OAuth/OIDC is **not** implemented — only browser-session and
  static-token auth.
- **Auth auto-pause (§5).** A detected login wall pauses the task for the user to sign in,
  rather than the agent attempting credentials.
- **Local-only persistence.** Settings, skills, memory, conversations, RAG vectors, and
  generated products live in `chrome.storage.local` / OPFS on-device; the only outbound
  traffic is to endpoints the user explicitly configures (model, embeddings, transcription)
  plus the tool actions the agent takes in the browser.

### 16.4 Data egress summary
Data leaves the device only via: (1) the **LLM endpoint** (prompts, including page/file
content the agent read); (2) the **embeddings endpoint** for RAG; (3) the **transcription
endpoint** for voice; and (4) **explicit agent actions** in the authenticated browser
(navigations, credentialed fetches such as `microsoft365_search` / `sharepoint_search`,
`open_data_url`). An on-prem/self-hosted model + embeddings endpoint keeps (1)–(3)
in-boundary; (4) is always the user's own sessions on the open web or their own systems.

Retrieval quality (§8.4) sends stored **chunk text** to (1), the LLM endpoint, even when
the on-device (`local`) embedder is used: the reranker sends up to 20 candidate chunks
(~1200 chars each) for reordering, and the query-paraphrase step sends the raw query.
Choosing the on-device embedder keeps *embedding* fully local, but does not keep RAG
chunk content off the LLM endpoint once a repo is searched — the same endpoint the rest
of the conversation already flows through. Automatic lessons (§5 step 7) send a summary
of a task (request, plan, tool failures, findings, final-answer excerpt) to the LLM
endpoint to distill; the stored `LessonEntry` text itself lives only in
`chrome.storage.local`.

### 16.5 Honest non-claims
- The browser does **not** sandbox or contain the agent — the extension's permissions are
  exactly the bypass of the per-site sandbox.
- **Mail, calendar, and draft creation use Microsoft Graph** (OAuth, auth-code + PKCE) — an
  Azure AD app registration and admin consent are required for most enterprise tenants; this
  is **not** the zero-setup cookie-session approach used elsewhere. `sharepoint_search` and
  the files half of `microsoft365_search` remain cookie-session REST, bounded by what the
  signed-in user can see, with no Graph/app-registration involvement at all.
- Prompt-injection defense is **mitigation, not a guarantee**: the instruction-source
  boundary plus the approval gate reduce but do not eliminate the risk inherent in giving a
  language model privileged tools.
