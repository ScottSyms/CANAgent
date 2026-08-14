// =============================================================================
// Browser tool adapter — the bridge between the agent's abstract tools and the
// real `chrome.*` APIs. Every entry here is the implementation of one tool that
// `agentRuntime`'s dispatch switch invokes (e.g. `get_tab_content`,
// `navigate`, `click_element`, `run_javascript`, `list_webmcp_tools`).
//
// Two execution styles appear throughout:
//   - Tab/navigation/group queries go straight through `chrome.tabs` etc.
//   - DOM reads and page actions are injected into the page with
//     `chrome.scripting.executeScript`. Plain inspection runs the bundled
//     `contentScript.js` (isolated world); anything that must see the page's
//     own JS (run_javascript, WebMCP) runs a `func` in `world: 'MAIN'` and can
//     only return JSON-serializable values across that boundary.
//
// Convention: functions return either typed results or, for the script-injected
// tools, a JSON string whose `{ __error }` shape signals failure without
// throwing — so the agent loop always gets a readable tool result.
// =============================================================================

import type { ContentRequest } from '../shared/messages';
import type {
  ActionResult,
  AuthState,
  ElementRef,
  NavigationResult,
  PageContent,
  PageStateResult,
  TabSummary,
} from '../shared/types';
import { resolveOfficeUrl, resolvePdfUrl } from '../shared/url';
import { normalizeUrl } from '../shared/repoChunk';
import { buildFileKql, clampTop, type M365SearchFilters } from '../shared/microsoftSearch';
import { buildGraphMailSearchUrl, parseGraphMailSearch } from '../shared/graphMail';
import { analyzeAuthState } from './authDetector';
import { getAccessToken } from './graphAuth';
import { graphGet } from './graphClient';
import { extractOffice, extractPdf } from './offscreenClient';
import { hasAllUrlsAccess } from './permissions';

const PAGE_LOAD_TIMEOUT_MS = 20000;
const READ_PDF_CONTEXT_CHARS = 60_000;
const READ_DOC_CONTEXT_CHARS = 60_000;
// Cap a video transcript put into the model's context (mirrors read_pdf).
const VIDEO_TRANSCRIPT_CONTEXT_CHARS = 60_000;
// Below this much extracted text, a readable page is treated as "sparse" and the
// readAppContent fallback is attempted (see getTabContent). Kept low so it only
// fires on genuinely empty extractions, not merely short pages.
const MIN_MEANINGFUL_TEXT_CHARS = 200;

function toTabSummary(tab: chrome.tabs.Tab, groupTitles?: Map<number, string>): TabSummary {
  const groupId = tab.groupId !== undefined && tab.groupId !== -1 ? tab.groupId : undefined;
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active,
    groupId,
    group: groupId !== undefined ? groupTitles?.get(groupId) : undefined,
  };
}

async function groupTitleMap(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    for (const g of await chrome.tabGroups.query({})) {
      if (g.title) map.set(g.id, g.title);
    }
  } catch {
    // tabGroups may be unavailable; ignore.
  }
  return map;
}

function emptyContent(
  tabId: number,
  url: string,
  title: string,
  status: PageContent['extractionStatus'],
  note: string,
): PageContent {
  return {
    tabId,
    url,
    title,
    text: '',
    metadata: { 'ba:note': note },
    links: [],
    headings: [],
    extractionStatus: status,
    capturedAt: new Date().toISOString(),
  };
}

function isRestrictedUrl(url: string): boolean {
  return /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-untrusted):/.test(url);
}

async function sendToTab<T>(tabId: number, request: ContentRequest): Promise<T> {
  return (await chrome.tabs.sendMessage(tabId, request)) as T;
}

/**
 * Inject the content script if it is not already present in the tab, then prove
 * a listener is actually live.
 *
 * The post-injection ping matters: `chrome.tabs.sendMessage` RESOLVES WITH
 * `undefined` when nothing answers (it only rejects when there is no receiver at
 * all), so without this check a tab whose listener is dead looks fine here and
 * then fails confusingly deeper in, with the real cause long gone.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  const ping = async (): Promise<boolean> => {
    try {
      const pong = await sendToTab<{ ok?: boolean } | undefined>(tabId, { kind: 'ba_ping' });
      return pong?.ok === true;
    } catch {
      return false; // No receiver in this tab yet.
    }
  };

  if (await ping()) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['contentScript.js'] });
  if (await ping()) return;
  throw new Error(
    'The content script could not be reached in this tab after injection. Reload the page ' +
      'and try again — a tab left open across an extension reload can be left without a live listener.',
  );
}

export async function listTabs(): Promise<TabSummary[]> {
  const [tabs, titles] = await Promise.all([chrome.tabs.query({}), groupTitleMap()]);
  return tabs.filter((t) => t.id !== undefined).map((t) => toTabSummary(t, titles));
}

/**
 * Resolve the user's active tab resiliently. `lastFocusedWindow` can briefly
 * return nothing when the side panel itself holds focus, so fall back to the
 * current window and finally to any active tab (preferring a real web page over
 * a chrome:// surface). Returns undefined only when there is genuinely no
 * active tab anywhere.
 */
async function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    const tabs = await chrome.tabs.query({ active: true });
    tab = tabs.find((t) => /^https?:/i.test(t.url ?? '')) ?? tabs[0];
  }
  return tab;
}

export async function getActiveTab(): Promise<TabSummary> {
  const tab = await queryActiveTab();
  if (!tab) throw new Error('No active tab found.');
  return toTabSummary(tab, await groupTitleMap());
}

export async function getTabContent(tabId: number): Promise<PageContent> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return emptyContent(tabId, '', '', 'unsupported', 'Tab no longer exists.');
  }
  const url = tab.url ?? '';
  const title = tab.title ?? '';
  const pdfUrl = resolvePdfUrl(url);
  if (pdfUrl) {
    const result = await extractPdf(pdfUrl, READ_PDF_CONTEXT_CHARS);
    if (!result.ok) {
      return emptyContent(tabId, url, title, 'unsupported', `PDF extraction failed: ${result.error ?? 'unknown error'}`);
    }
    const text = result.text ?? '';
    return {
      tabId,
      url,
      title,
      text,
      metadata: {
        'ba:sourceType': 'pdf',
        'ba:pdfUrl': pdfUrl,
        ...(result.truncated ? { 'ba:note': `PDF text truncated to ~${READ_PDF_CONTEXT_CHARS.toLocaleString()} characters.` } : {}),
        ...(!text.trim() ? { 'ba:note': 'PDF had no extractable selectable text; it may be scanned/image-only.' } : {}),
      },
      links: [],
      headings: [],
      extractionStatus: result.truncated || !text.trim() ? 'partial' : 'ok',
      capturedAt: new Date().toISOString(),
    };
  }
  const officeUrl = resolveOfficeUrl(url);
  if (officeUrl) {
    const result = await extractOffice(officeUrl, READ_DOC_CONTEXT_CHARS);
    if (!result.ok) {
      return emptyContent(tabId, url, title, 'unsupported', `Office document extraction failed: ${result.error ?? 'unknown error'}`);
    }
    const text = result.text ?? '';
    return {
      tabId,
      url,
      title,
      text,
      metadata: {
        'ba:sourceType': 'office',
        'ba:officeUrl': officeUrl,
        ...(result.truncated ? { 'ba:note': `Document text truncated to ~${READ_DOC_CONTEXT_CHARS.toLocaleString()} characters.` } : {}),
      },
      links: [],
      headings: [],
      extractionStatus: result.truncated ? 'partial' : 'ok',
      capturedAt: new Date().toISOString(),
    };
  }
  if (isRestrictedUrl(url)) {
    return emptyContent(tabId, url, title, 'unsupported', 'Browser-internal pages cannot be read.');
  }
  try {
    await ensureContentScript(tabId);
    const extracted = await sendToTab<Omit<PageContent, 'tabId'> | { ok: false; detail: string } | undefined>(
      tabId,
      { kind: 'ba_extract' },
    );
    // Validate before use. Two non-page-content replies are possible and both
    // used to blow up in analyzeAuthState (which dereferences .metadata/.text),
    // turning a precise cause into a generic "extraction failed":
    //   - `undefined`, when no listener answered (sendMessage resolves, not rejects);
    //   - `{ ok: false, detail }`, when extractPage threw inside the page.
    if (!extracted || typeof (extracted as PageContent).text !== 'string') {
      const detail =
        extracted && typeof (extracted as { detail?: unknown }).detail === 'string'
          ? (extracted as { detail: string }).detail
          : 'the content script returned no page content (no listener answered in this tab)';
      return emptyContent(tabId, url, title, 'unsupported', `Extraction failed: ${detail}`);
    }
    const content: PageContent = { tabId, ...(extracted as Omit<PageContent, 'tabId'>) };
    // Defensive defaults so a partial reply can't crash downstream consumers.
    content.metadata ??= {};
    content.links ??= [];
    content.headings ??= [];
    // Flag auth walls at extraction time so callers see it immediately.
    if (analyzeAuthState(content).status === 'auth_required') {
      content.extractionStatus = 'auth_required';
      return content;
    }
    // Sparse-text fallback: when the DOM/shadow extraction comes back nearly
    // empty on a page that isn't a login wall, try readAppContent (selection +
    // copy-interception + innerText). This rescues canvas-rendered apps (Google
    // Docs/Sheets) and stubborn SPAs where the accessible DOM carries little
    // text. It costs a select-all flash on the page, so it only runs when the
    // primary text is genuinely thin.
    if (
      (content.extractionStatus === 'ok' || content.extractionStatus === 'partial') &&
      content.text.trim().length < MIN_MEANINGFUL_TEXT_CHARS
    ) {
      try {
        const app = await sendToTab<{ method: string; text: string; truncated: boolean }>(tabId, {
          kind: 'ba_app_content',
        });
        if (app.method !== 'none' && app.text.trim().length > content.text.trim().length) {
          content.text = app.text;
          content.metadata['ba:extractMethod'] = app.method;
          content.metadata['ba:note'] =
            `Primary text extraction was sparse; recovered content via the "${app.method}" fallback.`;
          content.extractionStatus = app.truncated ? 'partial' : 'ok';
        }
      } catch {
        // Fallback unavailable — keep the sparse primary result.
      }
    }
    return content;
  } catch (err) {
    const message = String(err);
    const status = /Cannot access|cannot be scripted|permission/i.test(message)
      ? 'blocked'
      : 'unsupported';
    const content = emptyContent(
      tabId,
      url,
      title,
      status,
      status === 'blocked'
        ? 'No permission to read this tab. The user can grant access with "Use all tabs" or "Allow this site".'
        : `Extraction failed: ${message}`,
    );
    if (status === 'blocked') {
      // Lets the runtime pause and ask the user to grant this origin inline.
      try {
        content.metadata['ba:origin'] = new URL(url).origin;
      } catch {
        // No usable origin; the model gets the blocked note as-is.
      }
    }
    return content;
  }
}

export async function getAllTabContents(): Promise<PageContent[]> {
  if (!(await hasAllUrlsAccess())) {
    throw new Error(
      'Reading all tabs requires broader access. Ask the user to click "Use all tabs" in the sidebar to grant it.',
    );
  }
  const tabs = await listTabs();
  return Promise.all(tabs.map((t) => getTabContent(t.tabId)));
}

function waitForTabComplete(tabId: number, timeoutMs = PAGE_LOAD_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
    // The tab may already be loaded.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish(true);
      })
      .catch(() => finish(false));
  });
}

export async function navigate(tabId: number, url: string): Promise<NavigationResult> {
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (err) {
    return { tabId, url, title: '', status: 'error', error: String(err) };
  }
  // Wait for the navigation to start before watching for completion.
  await new Promise((r) => setTimeout(r, 300));
  const complete = await waitForTabComplete(tabId);
  const tab = await chrome.tabs.get(tabId);
  return {
    tabId,
    url: tab.url ?? url,
    title: tab.title ?? '',
    status: complete ? 'complete' : 'timeout',
  };
}

function buildSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/**
 * Search using the browser's default search engine, always in a BACKGROUND tab
 * so the agent never steals the user's focus. We create the tab inactive first,
 * then run chrome.search into it *by tabId* — which keeps the user's default
 * search engine (a plain tabs.create with a hardcoded URL would not). Results
 * are read back through getTabContent.
 */
export async function searchWeb(query: string): Promise<NavigationResult> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  } catch (err) {
    return { tabId: -1, url: '', title: '', status: 'error', error: String(err) };
  }
  if (!tab.id) return { tabId: -1, url: '', title: '', status: 'error', error: 'Tab not created.' };

  try {
    // Display results in our background tab (no disposition ⇒ uses tabId), so the
    // default engine is honored without activating the tab.
    await chrome.search.query({ text: query, tabId: tab.id });
  } catch {
    // Fallback if chrome.search is unavailable: navigate the tab to a search URL.
    await chrome.tabs.update(tab.id, { url: buildSearchUrl(query) });
  }

  const complete = await waitForTabComplete(tab.id);
  const loaded = await chrome.tabs.get(tab.id);
  return {
    tabId: tab.id,
    url: loaded.url ?? '',
    title: loaded.title ?? '',
    status: complete ? 'complete' : 'timeout',
  };
}

// Open a URL in a new background tab (caller adds it to the conversation group).
export async function openUrl(url: string): Promise<NavigationResult> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    return { tabId: -1, url, title: '', status: 'error', error: String(err) };
  }
  if (!tab.id) return { tabId: -1, url, title: '', status: 'error', error: 'Tab not created.' };
  const complete = await waitForTabComplete(tab.id);
  const loaded = await chrome.tabs.get(tab.id);
  return {
    tabId: tab.id,
    url: loaded.url ?? url,
    title: loaded.title ?? '',
    status: complete ? 'complete' : 'timeout',
  };
}

const GROUP_COLORS: chrome.tabGroups.ColorEnum[] = [
  'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'pink', 'purple',
];

function colorForName(name: string): chrome.tabGroups.ColorEnum {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

/**
 * Add a tab to the conversation's group, creating the group (with title+color)
 * if needed. Returns the live group id (may differ if a stale group was gone).
 */
export async function groupTab(
  tabId: number,
  name: string,
  existingGroupId: number | null,
): Promise<number | null> {
  if (existingGroupId !== null) {
    try {
      await chrome.tabs.group({ tabIds: [tabId], groupId: existingGroupId });
      return existingGroupId;
    } catch {
      // Group was closed — fall through and recreate.
    }
  }
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: name, color: colorForName(name) });
    return groupId;
  } catch {
    return null; // grouping unavailable; non-fatal
  }
}

/** Collapse or expand a tab group (best-effort; ignored if the group is gone). */
export async function setGroupCollapsed(groupId: number, collapsed: boolean): Promise<void> {
  try {
    await chrome.tabGroups.update(groupId, { collapsed });
  } catch {
    // group closed or grouping unavailable — non-fatal
  }
}

/** Normalized URLs of every currently open tab, for de-duping a restore reopen. */
export async function openTabUrls(): Promise<Set<string>> {
  try {
    const tabs = await chrome.tabs.query({});
    return new Set(tabs.map((t) => normalizeUrl(t.url ?? '')).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** True if a live tab group already uses this title (case-insensitive). */
export async function groupTitleTaken(name: string): Promise<boolean> {
  const lower = name.toLowerCase();
  try {
    return (await chrome.tabGroups.query({})).some((g) => (g.title ?? '').toLowerCase() === lower);
  } catch {
    return false;
  }
}

export interface TabGroupReadResult {
  error?: string;
  group?: string;
  count?: number;
  results?: PageContent[];
}

export async function readTabGroup(name: string | undefined, groupId: number | null): Promise<TabGroupReadResult> {
  let targetId = groupId ?? undefined;
  if (name) {
    const lower = name.toLowerCase();
    try {
      const match = (await chrome.tabGroups.query({})).find(
        (g) => (g.title ?? '').toLowerCase() === lower,
      );
      targetId = match?.id;
    } catch {
      targetId = undefined;
    }
  }
  if (targetId === undefined) {
    return { error: `No tab group${name ? ` named "${name}"` : ''} found.` };
  }
  const tabs = await chrome.tabs.query({ groupId: targetId });
  if (tabs.length === 0) return { error: 'That tab group has no tabs.' };
  const results = await Promise.all(
    tabs.filter((t) => t.id !== undefined).map((t) => getTabContent(t.id!)),
  );
  return {
    group: name,
    count: results.length,
    results,
  };
}

export async function getElementMap(tabId: number): Promise<ElementRef[]> {
  await ensureContentScript(tabId);
  return sendToTab<ElementRef[]>(tabId, { kind: 'ba_element_map' });
}

async function ensurePointerTracker(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['pointerTracker.js'] });
}

export async function queryPointerTarget(tabId: number): Promise<string> {
  await ensurePointerTracker(tabId);
  const result = await sendToTab<{ ok: boolean; target?: unknown; detail?: string }>(tabId, {
    kind: 'ba_get_pointer_target',
  });
  return JSON.stringify(result);
}

export async function readAppContent(tabId: number): Promise<string> {
  await ensureContentScript(tabId);
  const result = await sendToTab<{ method: string; text: string; truncated: boolean }>(tabId, {
    kind: 'ba_app_content',
  });
  if (result.method === 'none' || !result.text) {
    return JSON.stringify({
      method: 'none',
      note: 'No extractable text — the content is likely canvas-rendered. Use the snapshot tool and read it with vision.',
    });
  }
  return JSON.stringify(result);
}

export async function clickElement(tabId: number, selectorOrRef: string): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_click', refIdOrSelector: selectorOrRef });
}

export async function fillInput(
  tabId: number,
  selectorOrRef: string,
  value: string,
): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_fill', refIdOrSelector: selectorOrRef, value });
}

export async function submitForm(tabId: number, selectorOrRef: string): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_submit', refIdOrSelector: selectorOrRef });
}

export async function pressKeys(tabId: number, combo: string, targetRef?: string): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_press_keys', combo, targetRef });
}

export async function waitForElement(
  tabId: number,
  selector: string,
  state: 'present' | 'visible' | 'enabled',
  timeoutMs: number,
): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_wait', selector, state, timeoutMs });
}

export async function clickAt(tabId: number, x: number, y: number): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_click_at', x, y });
}

export async function drag(
  tabId: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_drag', fromX, fromY, toX, toY });
}

export async function scrollWheel(tabId: number, x: number, y: number, deltaY: number): Promise<ActionResult> {
  await ensureContentScript(tabId);
  return sendToTab<ActionResult>(tabId, { kind: 'ba_wheel', x, y, deltaY });
}

export async function scrollStep(tabId: number): Promise<{ scrolled: boolean; atBottom: boolean }> {
  await ensureContentScript(tabId);
  return sendToTab<{ scrolled: boolean; atBottom: boolean }>(tabId, { kind: 'ba_scroll_step' });
}

export async function waitForPageState(tabId: number): Promise<PageStateResult> {
  const complete = await waitForTabComplete(tabId);
  const tab = await chrome.tabs.get(tabId);
  return { tabId, state: complete ? 'complete' : 'timeout', url: tab.url ?? '' };
}

const MAX_JS_RESULT_CHARS = 10000;

// Runs in the page's MAIN world. Arbitrary code via eval, so the result of the
// last expression flows back. Wrapped in async so `await` works. Note: pages
// whose CSP forbids unsafe-eval will throw here — returned as __error, not a crash.
function jsRunner(src: string): Promise<string> {
  return (async () => {
    try {
      // eslint-disable-next-line no-eval
      const result = await (0, eval)(src);
      return JSON.stringify(result ?? null);
    } catch (e) {
      return JSON.stringify({ __error: String(e) });
    }
  })();
}

export async function runJavascript(tabId: number, code: string): Promise<string> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return JSON.stringify({ __error: 'Tab no longer exists.' });
  }
  if (isRestrictedUrl(tab.url ?? '')) {
    return JSON.stringify({ __error: 'Cannot run scripts on browser-internal pages.' });
  }
  let injection: chrome.scripting.InjectionResult<string>[];
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: jsRunner,
      args: [code],
    });
  } catch (err) {
    const message = String(err);
    const note = /Cannot access|cannot be scripted|permission/i.test(message)
      ? 'No permission to run scripts on this tab. The user can grant access with "Allow this site".'
      : message;
    return JSON.stringify({ __error: note });
  }
  let out = injection[0]?.result ?? 'null';
  if (out.length > MAX_JS_RESULT_CHARS) {
    out = out.slice(0, MAX_JS_RESULT_CHARS) + ' …[truncated]';
  }
  return out;
}

// Runs in the page's MAIN world: read the WebMCP registry the bridge populated.
function webmcpListRunner(): string {
  try {
    const reg = (window as unknown as { __CANAGENT_WEBMCP__?: { tools?: Map<string, unknown> } })
      .__CANAGENT_WEBMCP__;
    const tools = reg?.tools ? Array.from(reg.tools.values()) : [];
    return JSON.stringify(
      tools.map((t) => {
        const tool = t as { name?: string; description?: string; inputSchema?: unknown };
        return { name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? null };
      }),
    );
  } catch (e) {
    return JSON.stringify({ __error: String(e) });
  }
}

// Runs in the page's MAIN world: invoke a registered WebMCP tool's handler.
function webmcpCallRunner(name: string, args: unknown): Promise<string> {
  return (async () => {
    try {
      const reg = (window as unknown as { __CANAGENT_WEBMCP__?: { tools?: Map<string, unknown> } })
        .__CANAGENT_WEBMCP__;
      const tool = reg?.tools?.get(name) as { execute?: (a: unknown) => unknown } | undefined;
      if (!tool || typeof tool.execute !== 'function') {
        return JSON.stringify({ __error: `No WebMCP tool named "${name}" on this page.` });
      }
      const result = await tool.execute(args);
      return JSON.stringify(result ?? null);
    } catch (e) {
      return JSON.stringify({ __error: String(e) });
    }
  })();
}

export async function listWebmcpTools(tabId: number): Promise<string> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return JSON.stringify({ __error: 'Tab no longer exists.' });
  }
  if (isRestrictedUrl(tab.url ?? '')) {
    return JSON.stringify({ __error: 'Cannot inspect browser-internal pages.' });
  }
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: webmcpListRunner,
    });
    return injection[0]?.result ?? '[]';
  } catch (err) {
    return JSON.stringify({ __error: String(err) });
  }
}

export async function callWebmcpTool(
  tabId: number,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return JSON.stringify({ __error: 'Tab no longer exists.' });
  }
  if (isRestrictedUrl(tab.url ?? '')) {
    return JSON.stringify({ __error: 'Cannot run scripts on browser-internal pages.' });
  }
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: webmcpCallRunner,
      args: [name, args ?? {}],
    });
    let out = injection[0]?.result ?? 'null';
    if (out.length > MAX_JS_RESULT_CHARS) out = out.slice(0, MAX_JS_RESULT_CHARS) + ' …[truncated]';
    return out;
  } catch (err) {
    return JSON.stringify({ __error: String(err) });
  }
}

export async function readPdf(tabId: number | undefined, url: string | undefined): Promise<string> {
  let target = url;
  let visibleUrl = url;
  if (!target) {
    try {
      const tab = tabId ? await chrome.tabs.get(tabId) : await queryActiveTab();
      target = tab?.url;
      visibleUrl = tab?.url;
    } catch {
      // fall through
    }
  }
  if (!target) return JSON.stringify({ error: 'No URL or tab provided to read a PDF from.' });
  const resolved = resolvePdfUrl(target);
  if (!resolved) return JSON.stringify({ url: target, error: 'The target tab/URL is not a direct PDF or Chrome PDF viewer URL.' });
  // Cap what we put in the model's context; ingestion (add_to_repo) reads the
  // whole document instead.
  const result = await extractPdf(resolved, READ_PDF_CONTEXT_CHARS);
  if (!result.ok) return JSON.stringify({ url: visibleUrl ?? target, pdfUrl: resolved, error: result.error });
  return JSON.stringify({
    url: visibleUrl ?? target,
    pdfUrl: resolved,
    pageCount: result.pageCount,
    charCount: result.charCount,
    truncated: result.truncated,
    note: result.truncated
      ? `Only the first ~${READ_PDF_CONTEXT_CHARS.toLocaleString()} characters are shown (${
          result.charCountExact === false
            ? `the document has more than ${result.charCount?.toLocaleString()} chars`
            : `full document is ${result.charCount?.toLocaleString()} chars`
        }). To search the entire PDF, ingest it with add_to_repo and query it with search_repo.`
      : undefined,
    text: result.text,
  });
}

export async function readOfficeDocument(
  tabId: number | undefined,
  url: string | undefined,
): Promise<string> {
  let target = url;
  let visibleUrl = url;
  if (!target) {
    try {
      const tab = tabId ? await chrome.tabs.get(tabId) : await queryActiveTab();
      target = tab?.url;
      visibleUrl = tab?.url;
    } catch {
      // fall through
    }
  }
  if (!target) return JSON.stringify({ error: 'No URL or tab provided to read an Office file from.' });
  const resolved = resolveOfficeUrl(target);
  if (!resolved) {
    return JSON.stringify({
      url: target,
      error: 'The target tab/URL is not a direct Office file or a SharePoint/OneDrive Office-Online viewer URL.',
    });
  }
  // Cap context like read_pdf; ingestion (add_to_repo) reads the whole document.
  const result = await extractOffice(resolved, READ_DOC_CONTEXT_CHARS);
  if (!result.ok) return JSON.stringify({ url: visibleUrl ?? target, officeUrl: resolved, error: result.error });
  return JSON.stringify({
    url: visibleUrl ?? target,
    officeUrl: resolved,
    format: result.format,
    charCount: result.charCount,
    truncated: result.truncated,
    note: result.truncated
      ? `Only the first ~${READ_DOC_CONTEXT_CHARS.toLocaleString()} characters are shown (${
          result.charCountExact === false
            ? `the document has more than ${result.charCount?.toLocaleString()} chars`
            : `full document is ${result.charCount?.toLocaleString()} chars`
        }). To search the entire document, ingest it with add_to_repo and query it with search_repo.`
      : undefined,
    text: result.text,
  });
}

// Runs in the page's MAIN world: pull the video's existing caption/subtitle
// track (YouTube's timedtext, or a generic WebVTT <track>) and return it as
// plain text. Async so it can fetch the caption URL in the page's own (often
// same-origin) context. Returns a JSON string; `{ __error }` signals failure.
function videoTranscriptRunner(lang: string | undefined, maxChars: number): Promise<string> {
  return (async () => {
    const finish = (
      source: string,
      language: string,
      segments: Array<{ t: number; text: string }>,
    ): string => {
      const full = segments
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const truncated = full.length > maxChars;
      const lastT = segments.length ? segments[segments.length - 1].t : 0;
      return JSON.stringify({
        source,
        language,
        segmentCount: segments.length,
        durationSec: Math.round(lastT),
        charCount: full.length,
        truncated,
        text: truncated ? full.slice(0, maxChars) + ' …[truncated]' : full,
        note: truncated
          ? 'Transcript truncated to fit context. Ask about specific parts, or ingest the page for full retrieval.'
          : undefined,
      });
    };

    try {
      // --- YouTube: read the caption track list from the player response. ---
      const yt = (window as unknown as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
      const tracks =
        (yt as { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: unknown[] } } })
          ?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null;
      if (Array.isArray(tracks) && tracks.length) {
        const list = tracks as Array<{ baseUrl: string; languageCode?: string; kind?: string }>;
        const pick =
          (lang && list.find((t) => t.languageCode === lang)) ||
          list.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ||
          list.find((t) => t.languageCode === 'en') ||
          list[0];
        const res = await fetch(pick.baseUrl + '&fmt=json3');
        const data = (await res.json()) as {
          events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
        };
        const segments = (data.events ?? [])
          .filter((e) => e.segs)
          .map((e) => ({
            t: (e.tStartMs ?? 0) / 1000,
            text: (e.segs ?? []).map((s) => s.utf8 ?? '').join(''),
          }))
          .filter((s) => s.text.trim());
        if (segments.length) return finish('youtube', pick.languageCode ?? 'unknown', segments);
      }

      // --- Generic: a WebVTT <track> on a <video> element. ---
      const parseVtt = (vtt: string): Array<{ t: number; text: string }> => {
        const out: Array<{ t: number; text: string }> = [];
        for (const block of vtt.replace(/\r/g, '').split('\n\n')) {
          const m = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/.exec(block);
          if (!m) continue;
          const t = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
          const text = block
            .split('\n')
            .filter((l) => l && !l.includes('-->') && !/^\d+$/.test(l) && l !== 'WEBVTT')
            .join(' ')
            .replace(/<[^>]+>/g, '');
          if (text.trim()) out.push({ t, text });
        }
        return out;
      };
      for (const video of Array.from(document.querySelectorAll('video'))) {
        const track = Array.from(video.querySelectorAll('track')).find(
          (t) => /subtitles|captions/i.test(t.kind) && t.src && (!lang || t.srclang === lang),
        );
        if (track?.src) {
          const vtt = await (await fetch(track.src)).text();
          const segments = parseVtt(vtt);
          if (segments.length) return finish('webvtt', track.srclang || 'unknown', segments);
        }
      }

      return JSON.stringify({
        __error: 'No captions or transcript track found on this page. The video may have none, or they may be disabled.',
      });
    } catch (e) {
      return JSON.stringify({ __error: String(e) });
    }
  })();
}

export async function getVideoTranscript(tabId: number, lang?: string): Promise<string> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return JSON.stringify({ __error: 'Tab no longer exists.' });
  }
  if (isRestrictedUrl(tab.url ?? '')) {
    return JSON.stringify({ __error: 'Cannot read browser-internal pages.' });
  }
  try {
    const injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: videoTranscriptRunner,
      args: [lang ?? undefined, VIDEO_TRANSCRIPT_CONTEXT_CHARS],
    });
    return injection[0]?.result ?? JSON.stringify({ __error: 'No result from the page.' });
  } catch (err) {
    return JSON.stringify({ __error: String(err) });
  }
}

// Turn SharePoint's HitHighlightedSummary (with <c0>…</c0> highlights and
// <ddd/> ellipses) into plain text. No DOM in the service worker, so regex.
function cleanSummary(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<ddd\/>/g, '…')
    .replace(/<\/?c\d+>/g, '') // keep the highlighted term text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// SharePoint encodes people as claims tokens like
// "i:0#.f|membership|jane@contoso.com | Jane Smith". Pull a readable name/email.
function cleanUser(raw: string): string | undefined {
  if (!raw) return undefined;
  // Multi-valued props are ';'-separated; take the first principal.
  const first = raw.split(/;\s*/)[0].trim();
  const name = first.includes('|') ? first.split('|').pop()!.trim() : first;
  return name || undefined;
}

interface SharepointSearchOptions {
  query?: string;
  top?: number;
  sortBy?: 'relevance' | 'modified';
  editedByMe?: boolean;
}

export interface FileResult {
  source: 'file';
  title: string;
  url?: string;
  snippet: string;
  fileType?: string;
  createdBy?: string;
  modifiedBy?: string;
  modified?: string;
}

export interface MailResult {
  source: 'mail';
  subject: string;
  from?: string;
  received?: string;
  url?: string;
  preview?: string;
}

async function currentSharepointUser(
  base: string,
): Promise<{ title?: string; email?: string } | { error: string }> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/_api/web/currentuser`, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=nometadata' },
    });
    if (!res.ok) {
      return { error: `Could not determine the signed-in user (HTTP ${res.status}).` };
    }
    const u = (await res.json()) as { Title?: string; Email?: string };
    if (!u.Title && !u.Email) return { error: 'Signed-in user has no name/email.' };
    return { title: u.Title, email: u.Email };
  } catch (err) {
    return { error: `Could not determine the signed-in user: ${String(err)}` };
  }
}

/**
 * Core file search over SharePoint/Microsoft Search (cookie session). Indexes both
 * SharePoint sites and the user's OneDrive. Returns structured results so callers can
 * merge them with mail; the legacy `sharepoint_search` tool wraps this.
 */
export async function fileSearch(
  base: string,
  f: M365SearchFilters,
): Promise<{ results: FileResult[] } | { error: string }> {
  const rowlimit = clampTop(f.top);
  let editorName: string | undefined;
  if (f.editedByMe) {
    const me = await currentSharepointUser(base);
    if ('error' in me) {
      return { error: `${me.error} Open a tab on ${base} and make sure you are signed in, then retry.` };
    }
    editorName = me.title;
  }
  const queryText = buildFileKql(f, editorName);

  const props =
    'Title,Path,HitHighlightedSummary,FileType,FileExtension,LastModifiedTime,Author,Editor,EditorOWSUSER';
  let url =
    `${base.replace(/\/+$/, '')}/_api/search/query` +
    `?querytext='${encodeURIComponent(queryText)}'` +
    `&rowlimit=${rowlimit}` +
    `&selectproperties='${encodeURIComponent(props)}'` +
    `&clienttype='ContentSearchRegular'`;
  if (f.orderBy !== 'relevance') {
    url += `&sortlist='${encodeURIComponent('LastModifiedTime:descending')}'`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=nometadata' },
    });
  } catch (err) {
    return { error: `Could not reach SharePoint at ${base}: ${String(err)}` };
  }
  if (!res.ok) {
    return {
      error: `SharePoint search failed (HTTP ${res.status}). Make sure you are signed into ${base} in this browser, and that the base URL is correct.`,
    };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { error: 'SharePoint returned a non-JSON response (are you signed in?).' };
  }
  const rows =
    (data as { PrimaryQueryResult?: { RelevantResults?: { Table?: { Rows?: Array<{ Cells?: Array<{ Key: string; Value: string }> }> } } } })
      ?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ?? [];
  const results: FileResult[] = rows
    .map((row): FileResult => {
      const c: Record<string, string> = {};
      for (const cell of row.Cells ?? []) c[cell.Key] = cell.Value;
      return {
        source: 'file',
        title: c.Title || c.Path || '(untitled)',
        url: c.Path,
        snippet: cleanSummary(c.HitHighlightedSummary),
        fileType: c.FileType || c.FileExtension || undefined,
        createdBy: cleanUser(c.Author),
        modifiedBy: cleanUser(c.Editor) || cleanUser(c.EditorOWSUSER),
        modified: c.LastModifiedTime || undefined,
      };
    })
    .filter((r) => r.url);
  return { results };
}

/** Legacy `sharepoint_search` tool — thin wrapper over `fileSearch`. */
export async function sharepointSearch(base: string, opts: SharepointSearchOptions): Promise<string> {
  const out = await fileSearch(base, {
    query: opts.query,
    top: opts.top,
    editedByMe: opts.editedByMe,
    orderBy: opts.sortBy === 'relevance' ? 'relevance' : 'date',
  });
  if ('error' in out) return JSON.stringify({ error: out.error });
  return JSON.stringify({
    base,
    sortBy: opts.sortBy ?? 'modified',
    editedByMe: Boolean(opts.editedByMe),
    count: out.results.length,
    results: out.results,
  });
}

/**
 * Mail search over Microsoft Graph's `/me/messages`, authenticated by an
 * OAuth (PKCE) bearer token — no cookie session, works regardless of which web
 * frontend Microsoft serves the mailbox on. Structured `$filter` search
 * (subject/sender substring + date range), not OWA's old full-text-across-
 * message AQS search — a real (if minor) recall reduction, noted in the tool
 * description.
 */
export async function graphMailSearch(
  clientId: string,
  tenant: string,
  f: M365SearchFilters,
): Promise<{ results: MailResult[] } | { error: string }> {
  let token: string;
  try {
    token = await getAccessToken(clientId, tenant);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  let data: unknown;
  try {
    data = await graphGet(buildGraphMailSearchUrl(f), token);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const results: MailResult[] = parseGraphMailSearch(data).map((hit) => ({ source: 'mail', ...hit }));
  return { results };
}

export async function detectAuthState(tabId: number): Promise<AuthState> {
  const content = await getTabContent(tabId);
  if (content.extractionStatus === 'blocked') {
    return { status: 'blocked', reason: content.metadata['ba:note'] };
  }
  if (content.extractionStatus === 'unsupported') {
    return { status: 'unknown', reason: content.metadata['ba:note'] };
  }
  return analyzeAuthState(content);
}
