// =============================================================================
// Background service worker — the extension's central hub.
//
// Responsibilities:
//   1. Own the single AgentRuntime instance and broadcast its events to every
//      connected side panel.
//   2. Route long-lived `SidebarCommand`s (over a Port) to the runtime.
//   3. Answer one-shot request/response calls (settings "test connection",
//      transcription, repository management) that don't belong to a task.
//
// Collaborators: the side panel connects here over a Port and via
// `chrome.runtime.sendMessage`; this module delegates work to `AgentRuntime`
// (the agent loop), `llmProvider` (network calls), and `offscreenClient` (the
// OPFS repository store hosted in the offscreen document).
//
// Note on lifecycle: in MV3 this worker is ephemeral and may be evicted when
// idle. State lives in `AgentRuntime`/storage and is rebuildable; the panel
// sends periodic `ping`s to reset the idle timer during long tasks.
// =============================================================================

import type { BackgroundEvent, RepoInfo, RuntimeRequest, SidebarCommand, TestConnectionResponse } from '../shared/messages';
import { MAIL_REPO } from '../shared/graphMail';
import { AgentRuntime } from './agentRuntime';
import { recordLearnEvent, startLearnRecording, stopLearnRecording } from './learning';
import { LlmError, testConnection, transcribe } from './llmProvider';
import {
  graphGet,
  notebookGet,
  productDelete,
  productExport,
  productGet,
  productImport,
  productList,
  repoDelete,
  repoDeleteDoc,
  repoDocs,
  repoExport,
  repoExportOne,
  repoImport,
  repoImportOne,
  repoList,
} from './offscreenClient';
import { generateNotebookOverview, isOverviewStale } from './notebookOverview';
import { buildRepoGraph } from './graphExtract';
import { generateStudioOutput } from './studioOutputs';
import { studioGet } from './offscreenClient';
import { resolveSentenceCitations } from './sentenceResolve';
import type { NotebookOverview } from '../shared/types';
import type { DocGraph } from '../shared/docGraph';

// Repos with a graph build currently in flight (in-memory; lost on SW eviction,
// after which a build resumes from the checkpointed graph on the next request).
const graphBuilding = new Map<string, AbortController>();
import { ingestFile } from './repoIngest';
import { indexMailbox, type MailSyncProgress } from './mailIngest';
import {
  indexSharePointLibrary,
  probeSharePointSession,
  resolveSharePointBase,
  type SharePointSyncProgress,
} from './sharepointIngest';
import { connectMailbox, disconnectMailbox, isMailboxConnected } from './graphAuth';
import { cancelScheduledTask, getScheduledRuns, getScheduledTasks, reconcileScheduledAlarms, runScheduledTaskById, setScheduledTaskEnabled, taskIdFromAlarm, updateScheduledTask } from './scheduler';
import { cancelJob, jobIdFromAlarm, pauseJob, reconcileJobs, resumeJob, tick } from './jobEngine';
import { deleteJob } from './jobStore';
import './researchJob'; // side-effect: registers the 'research' job type with the engine
import {
  createEventTrigger,
  createWorkflow,
  deleteEventTrigger,
  deleteWorkflow,
  getEventTriggers,
  getTriggerRuns,
  getWorkflows,
  maybeFireEventTriggers,
  updateEventTrigger,
  updateWorkflow,
} from './automation';
import {
  getActiveProjectId,
  getMemoryEnabled,
  getMemoryGraph,
  getProjects,
  getSettings,
  migrateLegacySites,
  saveMemoryGraph,
  saveProjects,
  seedSkillsIfEmpty,
  setActiveProjectId,
} from './storage';
import { probeEnvironment } from './envProbe';
import { applyDecay, MEMORY_NODE_CAP, pruneGraph } from '../shared/memoryGraph';
import { memoryIndexRemove, memoryIndexUpsert } from './memoryIndex';
import { getVaultState, vaultDecrypt, vaultEncrypt } from './vault';

// ----- Mailbox auto-refresh (chrome.alarms, opt-in) -----
//
// Rides the same Graph connection as a manual "Index my Outlook mailbox"
// click. Only ever refreshes a mailbox already indexed at least once — never
// runs the (potentially large) initial full index silently in the
// background. A connection-expiry or network failure is recorded for the
// Mailbox card to display, not surfaced as an intrusive error (no user is
// present when the alarm fires).

const MAILBOX_ALARM = 'mailbox_auto_refresh';
const MAILBOX_STATUS_KEY = 'mailAutoRefreshStatus';

export interface MailAutoRefreshStatus {
  ts: number;
  ok: boolean;
  added?: number;
  failed?: number;
  error?: string;
}

// Guards manual and auto-triggered indexing from overlapping (both ride the
// same OWA session and would otherwise double up on requests/embeddings).
let mailIndexBusy = false;
let sharePointIndexBusy = false;

async function syncMailAlarm(): Promise<void> {
  const settings = await getSettings();
  if (settings?.mailAutoRefresh) {
    chrome.alarms.create(MAILBOX_ALARM, { periodInMinutes: 60 });
  } else {
    chrome.alarms.clear(MAILBOX_ALARM);
  }
}

// ----- Memory decay sweep (chrome.alarms, daily, opt-in via memory itself) -----
//
// Applies time-based staleness to graph memory (never deletes — see
// applyDecay's docstring) and prunes the graph back under its caps, then
// reconciles the embedding index for anything pruneGraph dropped. Runs once
// a day; cheap since the graph lives in chrome.storage.local, not OPFS.

const MEMORY_DECAY_ALARM = 'memory_decay_sweep';

async function syncMemoryDecayAlarm(): Promise<void> {
  if (await getMemoryEnabled()) {
    chrome.alarms.create(MEMORY_DECAY_ALARM, { periodInMinutes: 1440 });
  } else {
    chrome.alarms.clear(MEMORY_DECAY_ALARM);
  }
}

async function runMemoryDecaySweep(): Promise<void> {
  try {
    if (!(await getMemoryEnabled())) return;
    const graph = await getMemoryGraph();
    const swept = pruneGraph(applyDecay(graph));
    await saveMemoryGraph(swept);
    const keptIds = new Set(swept.nodes.map((n) => n.id));
    const droppedIds = graph.nodes.filter((n) => !keptIds.has(n.id)).map((n) => n.id);
    if (droppedIds.length > 0) await memoryIndexRemove(droppedIds);
  } catch {
    // Best-effort maintenance; a failed sweep just retries on the next alarm.
  }
}

void syncMailAlarm();
void syncMemoryDecayAlarm();
void reconcileScheduledAlarms();
void reconcileJobs(); // re-arm alarms for durable jobs interrupted by eviction

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ba_settings) void syncMailAlarm();
  if (changes.ba_memory_enabled) void syncMemoryDecayAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MAILBOX_ALARM) void runAutoMailboxRefresh();
  if (alarm.name === MEMORY_DECAY_ALARM) void runMemoryDecaySweep();
  const scheduledTaskId = taskIdFromAlarm(alarm.name);
  if (scheduledTaskId) void runScheduledTaskById(scheduledTaskId, runtime);
  const jobId = jobIdFromAlarm(alarm.name);
  if (jobId) void tick(jobId);
});

// Event triggers: a completed navigation is the only signal we watch for now
// (no WebMCP/DOM-event bridge yet). maybeFireEventTriggers no-ops fast when
// there are no triggers configured, so this costs nothing for the common
// (unused) case.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  void maybeFireEventTriggers(tab.url, runtime);
});

// A scheduled task/trigger completion notification is the only passive signal
// fired while no sidebar is open — clicking it opens the run history (and any
// auto-downloaded file names) on the Automations page.
if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html#automations') });
    chrome.notifications.clear(notificationId);
  });
}

function broadcastMailProgress(p: MailSyncProgress, last: { at: number }): void {
  const now = Date.now();
  if (p.phase === 'done' || now - last.at >= 250) {
    last.at = now;
    chrome.runtime.sendMessage({ type: 'mailbox_progress', progress: p }).catch(() => {});
  }
}

function broadcastSharePointProgress(p: SharePointSyncProgress, last: { at: number }): void {
  const now = Date.now();
  if (p.phase === 'done' || now - last.at >= 250) {
    last.at = now;
    chrome.runtime.sendMessage({ type: 'sharepoint_progress', progress: p }).catch(() => {});
  }
}

async function runAutoMailboxRefresh(): Promise<void> {
  if (mailIndexBusy) return; // a manual index is already in flight
  const settings = await getSettings();
  if (!settings?.mailAutoRefresh) return; // toggled off since the alarm fired

  const listRes = await repoList();
  const repos = listRes.ok && Array.isArray(listRes.result) ? (listRes.result as RepoInfo[]) : [];
  const alreadyIndexed = repos.some((r) => r.name === MAIL_REPO && r.kind === 'mail' && r.docs > 0);
  if (!alreadyIndexed) return;

  mailIndexBusy = true;
  const last = { at: 0 };
  try {
    const result = await indexMailbox(settings, MAIL_REPO, (p) => broadcastMailProgress(p, last));
    await chrome.storage.local.set({
      [MAILBOX_STATUS_KEY]: { ts: Date.now(), ok: true, added: result.added, failed: result.failed } satisfies MailAutoRefreshStatus,
    });
  } catch (e) {
    await chrome.storage.local.set({
      [MAILBOX_STATUS_KEY]: {
        ts: Date.now(),
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      } satisfies MailAutoRefreshStatus,
    });
  } finally {
    mailIndexBusy = false;
  }
}

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  void seedSkillsIfEmpty();
  void migrateLegacySites();
  void syncMailAlarm();
  void syncMemoryDecayAlarm();
  void reconcileScheduledAlarms();
});

// Every connected side panel holds a Port here. There is usually one, but the
// set tolerates several (e.g. panels in multiple windows) and self-heals when a
// post fails against a port that has gone away.
const ports = new Set<chrome.runtime.Port>();

// Fan an agent event out to all panels. Passed to AgentRuntime as its sole
// output channel, so the runtime never talks to chrome.* directly.
function broadcast(event: BackgroundEvent): void {
  for (const port of ports) {
    try {
      port.postMessage(event);
    } catch {
      ports.delete(port);
    }
  }
}

function broadcastNotice(text: string): void {
  broadcast({
    type: 'chat_message',
    message: { role: 'notice', text, timestamp: new Date().toISOString() },
  });
}

// One runtime for the whole extension — a single conversation/agent loop shared
// by whichever panel is open.
const runtime = new AgentRuntime(broadcast);

// The service worker may have just been revived after eviction. If a task was
// cut off mid-run, restore its thread and working state from the in-flight
// checkpoint so a reconnecting panel repaints it (see AgentRuntime.recoverInFlight).
void runtime.recoverInFlight();

// A panel connects: register its port, immediately replay the full current
// state (so a reconnecting panel re-paints), then translate each command into a
// runtime method call. This switch is the authoritative list of actions the UI
// can trigger.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidebar') return;
  ports.add(port);
  port.postMessage(runtime.fullState());

  port.onMessage.addListener((command: SidebarCommand) => {
    switch (command.type) {
      case 'user_message':
        void runtime.handleUserMessage(command.text, command.mentions);
        break;
      case 'stop_task':
        runtime.stop();
        break;
      case 'clear_conversation':
        runtime.clearConversation();
        break;
      case 'undo_exchange':
        runtime.undoLastExchange();
        break;
      case 'start_learn_mode':
        void (async () => {
          const result = await startLearnRecording();
          if (result.ok) broadcastNotice(`Learn mode started for ${result.recording?.targetHost ?? 'this site'}.`);
          else broadcastNotice(result.error ?? 'Could not start learn mode.');
        })();
        break;
      case 'stop_learn_mode':
        void (async () => {
          const result = await stopLearnRecording();
          if (result.ok) broadcastNotice(`Saved a learned playbook: /${result.skill?.name ?? 'learned-playbook'}.`);
          else broadcastNotice(result.error ?? 'Could not stop learn mode.');
        })();
        break;
      case 'load_conversation':
        void runtime.loadConversation(command.id);
        break;
      case 'delete_conversation':
        void runtime.deleteConversation(command.id);
        break;
      case 'import_conversation':
        void runtime.importConversation(command.record, command.labels);
        break;
      case 'clear_conversations':
        void runtime.clearConversations();
        break;
      case 'set_conversation_labels':
        void runtime.setConversationLabels(command.id, command.labels);
        break;
      case 'distill_skill':
        void runtime.distillSkill();
        break;
      case 'dismiss_distill':
        runtime.dismissDistill();
        break;
      case 'pause_agent':
        runtime.pause();
        break;
      case 'resume_agent':
        runtime.resume();
        break;
      case 'approval_response':
        runtime.approvalResponse(command.requestId, command.approved);
        break;
      case 'include_active_tab':
        void runtime.includeTabContext('active');
        break;
      case 'include_all_tabs':
        void runtime.includeTabContext('all');
        break;
      case 'refresh_context':
        void runtime.refreshContext();
        break;
      case 'attach_snapshot':
        runtime.attachSnapshot(command.dataUrl, command.title, command.url);
        break;
      case 'discard_snapshots':
        runtime.discardSnapshots();
        break;
      case 'capture_page':
        void runtime.capturePageToThread();
        break;
      case 'capture_to_repo':
        void runtime.captureToRepo(command.repo, command.scope);
        break;
      case 'get_state':
        port.postMessage(runtime.fullState());
        break;
      case 'ping':
        // Keepalive: each port message resets the service worker idle timer.
        break;
    }
  });

  port.onDisconnect.addListener(() => ports.delete(port));
});

// One-shot request/response calls that aren't part of a running task: the
// settings screen's "test connection", voice transcription, and repository
// management. Each handler returns `true` to keep the message channel open for
// the async `sendResponse` (a Chrome messaging requirement).
chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, sendResponse) => {
  if (request.type === 'stop_task') {
    runtime.stop();
    sendResponse({ ok: true });
    return false;
  }
  if (request.type === 'test_connection') {
    testConnection(request.settings).then((result: TestConnectionResponse) => sendResponse(result));
    return true; // async response
  }
  if (request.type === 'repo_list') {
    repoList().then((r) => sendResponse(r.ok ? r.result : []));
    return true;
  }
  if (request.type === 'vault_op') {
    // The offscreen repo store delegates vault crypto here (it may lack storage).
    (async () => {
      switch (request.op) {
        case 'state':
          return { state: await getVaultState() };
        case 'encrypt':
          return { value: await vaultEncrypt(request.value ?? '') };
        case 'decrypt':
          return { value: await vaultDecrypt(request.value ?? '') };
      }
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (request.type === 'job_control') {
    const { action, id } = request;
    const op =
      action === 'pause' ? pauseJob(id)
      : action === 'resume' ? resumeJob(id)
      : action === 'cancel' ? cancelJob(id)
      : /* delete */ cancelJob(id).then(() => deleteJob(id));
    op.then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (request.type === 'repo_delete') {
    repoDelete(request.repo).then((r) => sendResponse(r));
    return true;
  }
  if (request.type === 'repo_docs') {
    repoDocs(request.repo).then((r) => sendResponse(r.ok ? r.result : []));
    return true;
  }
  if (request.type === 'notebook_overview_get') {
    (async () => {
      const [nbRes, docsRes] = await Promise.all([notebookGet(request.repo), repoDocs(request.repo)]);
      const overview = (nbRes.ok ? nbRes.result : null) as NotebookOverview | null;
      const docs = (docsRes.ok ? docsRes.result : []) as Array<{ chunkCount: number }>;
      const docCount = docs.length;
      const chunkCount = docs.reduce((n, d) => n + (d.chunkCount ?? 0), 0);
      return { ok: true, overview, stale: isOverviewStale(overview, docCount, chunkCount), docCount, chunkCount };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (request.type === 'notebook_overview_generate') {
    (async () => {
      const settings = await getSettings();
      if (!settings) return { ok: false, error: 'No model configured. Open Settings first.' };
      return generateNotebookOverview(settings, request.repo);
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (request.type === 'notebook_graph_get') {
    (async () => {
      const [graphRes, docsRes] = await Promise.all([graphGet(request.repo), repoDocs(request.repo)]);
      const graph = (graphRes.ok ? graphRes.result : null) as DocGraph | null;
      const docs = (docsRes.ok ? docsRes.result : []) as unknown[];
      return { ok: true, graph, docCount: docs.length, building: graphBuilding.has(request.repo) };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (request.type === 'notebook_graph_build') {
    // Kept-open channel keeps the SW alive during the build; the UI polls
    // notebook_graph_get meanwhile for per-doc progress (checkpointed each doc).
    (async () => {
      const settings = await getSettings();
      if (!settings) return { ok: false, error: 'No model configured. Open Settings first.' };
      if (graphBuilding.has(request.repo)) return { ok: false, error: 'A graph build is already running for this notebook.' };
      const controller = new AbortController();
      graphBuilding.set(request.repo, controller);
      try {
        return await buildRepoGraph(settings, request.repo, {
          rebuild: request.rebuild,
          mode: request.mode ?? 'quick',
          signal: controller.signal,
        });
      } finally {
        graphBuilding.delete(request.repo);
      }
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (request.type === 'notebook_graph_cancel') {
    graphBuilding.get(request.repo)?.abort(new DOMException('Graph build stopped by user.', 'AbortError'));
    sendResponse({ ok: true });
    return false;
  }
  if (request.type === 'notebook_graph_evidence') {
    resolveSentenceCitations(request.repo, request.sentenceIds)
      .then((citations) => sendResponse({ ok: true, citations }))
      .catch((e) => sendResponse({ ok: false, error: String(e), citations: [] }));
    return true;
  }
  if (request.type === 'notebook_studio_get') {
    studioGet(request.repo)
      .then((r) => sendResponse({ ok: true, doc: r.ok ? r.result : { outputs: {} } }))
      .catch((e) => sendResponse({ ok: false, error: String(e), doc: { outputs: {} } }));
    return true;
  }
  if (request.type === 'notebook_studio_generate') {
    (async () => {
      const settings = await getSettings();
      if (!settings) return { ok: false, error: 'No model configured. Open Settings first.' };
      return generateStudioOutput(settings, request.repo, request.kind);
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (request.type === 'repo_doc_delete') {
    repoDeleteDoc(request.repo, request.docId).then((r) => sendResponse(r));
    return true;
  }
  if (request.type === 'repo_export') {
    repoExport().then((r) => sendResponse(r.ok ? r.result : []));
    return true;
  }
  if (request.type === 'repo_import') {
    repoImport(request.repos).then((r) => sendResponse(r));
    return true;
  }
  if (request.type === 'repo_export_one') {
    repoExportOne(request.repo)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (request.type === 'repo_import_one') {
    repoImportOne(request.repoData, request.targetName).then((r) => sendResponse(r));
    return true;
  }
  if (request.type === 'add_files_to_repo') {
    (async () => {
      const settings = await getSettings();
      if (!settings) {
        return { ok: false, results: [], error: 'No model configured. Open Settings first.' };
      }
      const results = [];
      for (const file of request.files) {
        const res = await ingestFile(settings, request.repo, file, request.kind ?? 'page');
        results.push({ name: file.name, ok: res.ok, chunks: res.chunks, error: res.error });
      }
      return { ok: results.some((r) => r.ok), results };
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'mailbox_connected') {
    isMailboxConnected().then((connected) => sendResponse({ connected }));
    return true;
  }
  if (request.type === 'mailbox_disconnect') {
    disconnectMailbox().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (request.type === 'sharepoint_session') {
    (async () => {
      const settings = await getSettings();
      const base = request.base?.trim().replace(/\/+$/, '') || (settings ? resolveSharePointBase(settings) : undefined);
      if (!base) return { connected: false, error: 'No SharePoint base URL configured.' };
      return probeSharePointSession(base);
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'index_sharepoint_library') {
    (async () => {
      if (sharePointIndexBusy) return { ok: false, error: 'A SharePoint refresh is already running — try again shortly.' };
      const settings = await getSettings();
      if (!settings) return { ok: false, error: 'No model configured. Open Settings first.' };
      sharePointIndexBusy = true;
      const last = { at: 0 };
      try {
        const result = await indexSharePointLibrary(settings, request.repo, request.libraryUrl, (p) =>
          broadcastSharePointProgress(p, last),
        );
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        sharePointIndexBusy = false;
      }
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'index_mailbox') {
    (async () => {
      if (mailIndexBusy) return { ok: false, error: 'A mailbox refresh is already running — try again shortly.' };
      const settings = await getSettings();
      if (!settings) return { ok: false, error: 'No model configured. Open Settings first.' };
      mailIndexBusy = true;
      const last = { at: 0 };
      try {
        // This handler only ever runs from a user click (the "Index"/"Connect &
        // index" button), so launching the interactive OAuth flow here satisfies
        // chrome.identity's user-gesture requirement.
        if (!(await isMailboxConnected())) {
          await connectMailbox(settings.graphClientId ?? '', settings.graphTenant || 'organizations');
        }
        const result = await indexMailbox(settings, request.repo, (p) => broadcastMailProgress(p, last));
        await chrome.storage.local.set({
          [MAILBOX_STATUS_KEY]: { ts: Date.now(), ok: true, added: result.added, failed: result.failed } satisfies MailAutoRefreshStatus,
        });
        return { ok: true, result };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await chrome.storage.local.set({
          [MAILBOX_STATUS_KEY]: { ts: Date.now(), ok: false, error } satisfies MailAutoRefreshStatus,
        });
        return { ok: false, error };
      } finally {
        mailIndexBusy = false;
      }
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'memory_graph_get') {
    getMemoryGraph().then(sendResponse);
    return true;
  }
  if (request.type === 'memory_graph_add') {
    (async () => {
      const text = request.text.trim();
      if (!text) return { ok: false, error: 'Empty memory text.' };
      const graph = await getMemoryGraph();
      if (graph.nodes.some((n) => n.status !== 'superseded' && n.summary === text)) {
        return { ok: true, added: false }; // already known — quietly skip rather than duplicate
      }
      if (graph.nodes.length >= MEMORY_NODE_CAP) {
        return { ok: false, error: `Memory is full (${MEMORY_NODE_CAP} entries). Delete entries before adding more.` };
      }
      const now = new Date().toISOString();
      const node = {
        id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'fact' as const,
        label: text.split(/\s+/).slice(0, 6).join(' '),
        summary: text,
        confidence: 1,
        durability: 0.7,
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
        lastConfirmedAt: now,
        provenance: request.source ? [{ conversationId: '', excerpt: request.source, at: now }] : [],
      };
      const next = { ...graph, nodes: [...graph.nodes, node] };
      await saveMemoryGraph(next);
      const settings = await getSettings();
      if (settings) {
        try {
          await memoryIndexUpsert(settings, [node]);
        } catch {
          // Graph write already succeeded; the index self-heals on the next decay sweep or reflection upsert.
        }
      }
      return { ok: true, added: true, id: node.id };
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'memory_graph_confirm') {
    (async () => {
      const graph = await getMemoryGraph();
      const now = new Date().toISOString();
      const next = {
        ...graph,
        nodes: graph.nodes.map((n) => (n.id === request.id ? { ...n, status: 'active' as const, lastConfirmedAt: now, updatedAt: now } : n)),
      };
      await saveMemoryGraph(next);
      return { ok: true };
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'memory_graph_update') {
    (async () => {
      const graph = await getMemoryGraph();
      const existing = graph.nodes.find((n) => n.id === request.id);
      if (!existing) return { ok: false, error: `No memory entry with id ${request.id}.` };
      const now = new Date().toISOString();
      const updated = { ...existing, summary: request.text.trim(), status: 'active' as const, updatedAt: now, lastConfirmedAt: now };
      const next = { ...graph, nodes: graph.nodes.map((n) => (n.id === request.id ? updated : n)) };
      await saveMemoryGraph(next);
      const settings = await getSettings();
      if (settings) {
        try {
          await memoryIndexUpsert(settings, [updated]);
        } catch {
          // The graph write already succeeded; a stale index entry self-heals on the next decay sweep or reflection upsert.
        }
      }
      return { ok: true };
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'memory_graph_delete') {
    (async () => {
      const graph = await getMemoryGraph();
      const next = {
        ...graph,
        nodes: graph.nodes.filter((n) => n.id !== request.id),
        edges: graph.edges.filter((e) => e.from !== request.id && e.to !== request.id),
      };
      await saveMemoryGraph(next);
      await memoryIndexRemove([request.id]);
      return { ok: true };
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'project_list') {
    getProjects().then(sendResponse);
    return true;
  }
  if (request.type === 'project_get_active') {
    getActiveProjectId().then(sendResponse);
    return true;
  }
  if (request.type === 'project_create') {
    (async () => {
      const name = request.name.trim();
      if (!name) return { ok: false, error: 'Project name is required.' };
      const projects = await getProjects();
      const project = {
        id: `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        color: request.color,
        createdAt: new Date().toISOString(),
      };
      await saveProjects([...projects, project]);
      return { ok: true, project };
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'project_update') {
    (async () => {
      const projects = await getProjects();
      if (!projects.some((p) => p.id === request.id)) return { ok: false, error: `No project with id ${request.id}.` };
      const next = projects.map((p) =>
        p.id === request.id
          ? { ...p, name: request.name?.trim() || p.name, color: request.color ?? p.color }
          : p,
      );
      await saveProjects(next);
      return { ok: true };
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'project_delete') {
    (async () => {
      const projects = await getProjects();
      await saveProjects(projects.filter((p) => p.id !== request.id));
      // Deleting the active project falls back to "no project" — scoped records
      // (conversations, memory, capabilities, skills) simply become invisible
      // under the new active scope rather than being deleted themselves.
      if ((await getActiveProjectId()) === request.id) await setActiveProjectId(null);
      return { ok: true };
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'project_set_active') {
    setActiveProjectId(request.id).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (request.type === 'learn_record_event') {
    recordLearnEvent(request.event).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (request.type === 'scheduled_tasks_get') {
    getScheduledTasks().then(sendResponse);
    return true;
  }
  if (request.type === 'scheduled_runs_get') {
    getScheduledRuns().then(sendResponse);
    return true;
  }
  if (request.type === 'scheduled_task_update') {
    updateScheduledTask(request.id, request.patch)
      .then((task) => sendResponse({ ok: Boolean(task), task }))
      .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }
  if (request.type === 'scheduled_task_set_enabled') {
    setScheduledTaskEnabled(request.id, request.enabled).then((task) => sendResponse({ ok: Boolean(task) }));
    return true;
  }
  if (request.type === 'scheduled_task_delete') {
    cancelScheduledTask(request.id).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (request.type === 'workflow_list') {
    getWorkflows().then(sendResponse);
    return true;
  }
  if (request.type === 'workflow_create') {
    (async () => {
      try {
        const workflow = await createWorkflow(request.name, request.skillNames, request.description);
        return { ok: true, workflow };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'workflow_update') {
    (async () => {
      try {
        const workflow = await updateWorkflow(request.id, request.patch);
        return { ok: Boolean(workflow), workflow };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'workflow_delete') {
    deleteWorkflow(request.id).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (request.type === 'event_trigger_list') {
    getEventTriggers().then(sendResponse);
    return true;
  }
  if (request.type === 'event_trigger_create') {
    (async () => {
      try {
        const trigger = await createEventTrigger({
          name: request.name,
          hostPattern: request.hostPattern,
          target: request.target,
          cooldownMinutes: request.cooldownMinutes,
          matchSubPages: request.matchSubPages,
          enabled: true,
        });
        return { ok: true, trigger };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'event_trigger_update') {
    updateEventTrigger(request.id, request.patch).then((trigger) => sendResponse({ ok: Boolean(trigger) }));
    return true;
  }
  if (request.type === 'event_trigger_delete') {
    deleteEventTrigger(request.id).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (request.type === 'trigger_runs_get') {
    getTriggerRuns().then(sendResponse);
    return true;
  }
  if (request.type === 'products_list') {
    productList().then(sendResponse);
    return true;
  }
  if (request.type === 'product_get') {
    productGet(request.id).then(sendResponse);
    return true;
  }
  if (request.type === 'product_delete') {
    productDelete(request.id).then((r) => sendResponse({ ok: r.ok }));
    return true;
  }
  if (request.type === 'products_export') {
    productExport().then((r) => sendResponse(r.ok ? r.result : []));
    return true;
  }
  if (request.type === 'products_import') {
    productImport(request.products).then((r) => sendResponse(r));
    return true;
  }
  if (request.type === 'probe_environment') {
    (async () => {
      // Only populate persistence when the memory feature is on.
      if (!(await getMemoryEnabled())) {
        return { ok: false, error: 'Memory is off. Enable "Remember things about me" first.' };
      }
      try {
        const { facts, notes } = await probeEnvironment();
        return { ok: true, facts, notes };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    })().then(sendResponse);
    return true;
  }
  if (request.type === 'transcribe_audio') {
    (async () => {
      const settings = await getSettings();
      if (!settings) return { ok: false, error: 'No endpoint configured. Open Settings first.' };
      if (!settings.transcriptionModel) {
        return { ok: false, error: 'No transcription model set. Add one in Settings to use voice prompts.' };
      }
      try {
        const text = await transcribe(settings, request.audioDataUrl);
        return { ok: true, text };
      } catch (err) {
        return { ok: false, error: err instanceof LlmError ? err.message : String(err) };
      }
    })().then(sendResponse);
    return true;
  }
  return false;
});
