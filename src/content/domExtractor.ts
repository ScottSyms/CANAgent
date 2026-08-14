// =============================================================================
// DOM primitives — the actual page reading and acting, all executed inside the
// page by `contentScript`. Two families:
//   - Reading: `extractPage` (text/links/headings/metadata, with main-content
//     selection from `readabilityExtractor`), `buildElementMap` (interactive
//     elements with stable refIds + accessible names/roles for reliable
//     targeting), and `readAppContent` for canvas-rendered apps.
//   - Acting: click/fill/submit/press/scroll/drag, addressed by the refIds the
//     element map hands out.
// The limits below bound how much is shipped back to the model per call.
// =============================================================================

import type {
  ActionResult,
  ElementRef,
  HeadingSummary,
  LinkSummary,
  PageContent,
} from '../shared/types';
import { pickMainContent, readableText } from './readabilityExtractor';

const MAX_TEXT_CHARS = 20000;
const MAX_LINKS = 100;
const MAX_HEADINGS = 50;

function extractMetadata(): Record<string, string> {
  const metadata: Record<string, string> = {};
  document.querySelectorAll('meta[name], meta[property]').forEach((m) => {
    const key = m.getAttribute('name') ?? m.getAttribute('property') ?? '';
    const value = m.getAttribute('content') ?? '';
    if (key && value && !(key in metadata)) metadata[key] = value.slice(0, 500);
  });

  // Auth-detection hints consumed by the background authDetector.
  const passwordInputs = document.querySelectorAll('input[type="password"]');
  metadata['ba:hasPasswordInput'] = String(passwordInputs.length > 0);
  // A real login form has a password field. The old heuristic also matched any form
  // whose text said "sign in/log in" — which fires on the "Sign in" link or search
  // box in a logged-in site's header — so it is dropped to avoid false auth walls.
  const loginForm = Array.from(document.querySelectorAll('form')).some(
    (f) => f.querySelector('input[type="password"]') !== null,
  );
  metadata['ba:hasLoginForm'] = String(loginForm);
  return metadata;
}

function extractHeadings(): HeadingSummary[] {
  return Array.from(document.querySelectorAll('h1, h2, h3'))
    .slice(0, MAX_HEADINGS)
    .map((h) => ({
      level: Number(h.tagName.slice(1)),
      text: (h.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }))
    .filter((h) => h.text.length > 0);
}

function extractLinks(): LinkSummary[] {
  const seen = new Set<string>();
  const links: LinkSummary[] = [];
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = a.href;
    if (!href.startsWith('http') || seen.has(href)) continue;
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 150);
    if (!text) continue;
    seen.add(href);
    links.push({ text, href });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

export function extractPage(): Omit<PageContent, 'tabId'> {
  const main = pickMainContent(document);
  let text = readableText(main);
  let extractionStatus: PageContent['extractionStatus'] = 'ok';
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    extractionStatus = 'partial';
  }
  return {
    url: location.href,
    title: document.title,
    text,
    metadata: extractMetadata(),
    links: extractLinks(),
    headings: extractHeadings(),
    extractionStatus,
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Element map for controlled page interaction. refIds are stable for the
// lifetime of the injected script; the agent acts on refIds, not raw selectors.
// ---------------------------------------------------------------------------

const refMap = new Map<string, Element>();
let refCounter = 0;

function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && node !== document.body && depth < 5; depth++) {
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

const NATIVE_INTERACTIVE = 'a[href], button, input, select, textarea, summary, [onclick], [tabindex]';

// Elements with these ARIA roles are interactive controls worth mapping, even
// when they are plain <div>/<span> (common in Office 365 / Google apps).
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'textbox',
  'searchbox', 'slider', 'spinbutton', 'treeitem', 'gridcell', 'columnheader',
  'rowheader', 'listbox', 'menu', 'menubar', 'radiogroup', 'scrollbar',
]);

const GROUP_ROLES = new Set([
  'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar', 'tablist', 'listbox',
  'grid', 'table', 'group', 'region', 'navigation', 'form', 'tree',
]);

// Implicit ARIA role from tag/type — covers the common cases (not the full spec).
function implicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return (el as HTMLAnchorElement).href ? 'link' : undefined;
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'nav') return 'navigation';
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  return undefined;
}

function effectiveRole(el: Element): string | undefined {
  return el.getAttribute('role')?.trim().split(/\s+/)[0] || implicitRole(el);
}

function refText(el: string, root: Document | ShadowRoot): string {
  return el
    .split(/\s+/)
    .map((id) => root.getElementById?.(id)?.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Simplified accessible-name computation (accname order). A future upgrade is
// the dom-accessibility-api library; this stays dependency-free for the IIFE.
function computeName(el: Element): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const t = refText(labelledby, root);
    if (t) return t;
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();
  if (el.id && root.querySelector) {
    const label = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.textContent?.trim()) return label.textContent.replace(/\s+/g, ' ').trim();
  }
  const wrapLabel = el.closest('label');
  if (wrapLabel?.textContent?.trim()) return wrapLabel.textContent.replace(/\s+/g, ' ').trim();
  const placeholder = (el as HTMLInputElement).placeholder;
  if (placeholder) return placeholder;
  const title = el.getAttribute('title');
  if (title?.trim()) return title.trim();
  const alt = el.getAttribute('alt');
  if (alt?.trim()) return alt.trim();
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function computeStates(el: Element): string[] {
  const s: string[] = [];
  const exp = el.getAttribute('aria-expanded');
  if (exp === 'true') s.push('expanded');
  else if (exp === 'false') s.push('collapsed');
  if (el.getAttribute('aria-selected') === 'true') s.push('selected');
  const checked = el.getAttribute('aria-checked') ?? ((el as HTMLInputElement).checked ? 'true' : null);
  if (checked === 'true') s.push('checked');
  else if (checked === 'mixed') s.push('mixed');
  if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
  const cur = el.getAttribute('aria-current');
  if (cur && cur !== 'false') s.push('current');
  const pop = el.getAttribute('aria-haspopup');
  if (pop && pop !== 'false') s.push('haspopup');
  if (el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled) s.push('disabled');
  if (el.getAttribute('aria-readonly') === 'true') s.push('readonly');
  if (el.getAttribute('aria-required') === 'true') s.push('required');
  return s;
}

function closestGroup(el: Element): string | undefined {
  let node = el.parentElement;
  for (let depth = 0; node && depth < 12; depth++) {
    const role = node.getAttribute('role');
    if (role && GROUP_ROLES.has(role)) {
      const name = computeName(node).slice(0, 60);
      return name ? `${role} "${name}"` : role;
    }
    node = node.parentElement;
  }
  return undefined;
}

function isInteractive(el: Element): boolean {
  if (el.matches(NATIVE_INTERACTIVE)) return true;
  const role = el.getAttribute('role')?.trim().split(/\s+/)[0];
  return role ? INTERACTIVE_ROLES.has(role) : false;
}

interface InteractiveHit {
  el: Element;
  /** Computed once here (visibility check needs it anyway) and reused by
   * buildElementMap's mapping pass, instead of calling getBoundingClientRect
   * on the same element a second time. */
  rect: DOMRect;
}

// Collect interactive elements, descending into shadow roots and same-origin
// iframes so apps built on web components or framed editors (e.g. OWA) are
// reachable. Live elements are stored in refMap so refId resolution works
// across roots.
//
// Walks with a TreeWalker rather than `root.querySelectorAll('*')` so a huge/
// complex page doesn't pay for materializing an array of every element in the
// document just to find the first 200 interactive ones — the walk stops the
// instant the cap is hit.
function collectInteractive(root: Document | ShadowRoot, out: InteractiveHit[]): void {
  if (out.length >= 200) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;
  while (node) {
    if (out.length >= 200) break;
    const el = node;
    if (isInteractive(el)) {
      const rect = el.getBoundingClientRect();
      const style = rect.width > 0 && rect.height > 0 ? getComputedStyle(el) : null;
      if (style && style.visibility !== 'hidden' && style.display !== 'none') out.push({ el, rect });
    }
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) collectInteractive(shadow, out);
    if (el instanceof HTMLIFrameElement) {
      try {
        const doc = el.contentDocument;
        if (doc) collectInteractive(doc, out); // same-origin only; throws otherwise
      } catch {
        // Cross-origin iframe — not reachable without chrome.debugger.
      }
    }
    node = walker.nextNode() as Element | null;
  }
}

export function buildElementMap(): ElementRef[] {
  refMap.clear();
  refCounter = 0;
  const hits: InteractiveHit[] = [];
  collectInteractive(document, hits);
  return hits.map(({ el, rect: r }) => {
    const refId = `el-${refCounter++}`;
    refMap.set(refId, el);
    const name = computeName(el);
    const states = computeStates(el);
    const group = closestGroup(el);
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const ref: ElementRef = {
      refId,
      tagName: el.tagName.toLowerCase(),
      role: effectiveRole(el),
      ariaLabel: el.getAttribute('aria-label') ?? undefined,
      name: name || undefined,
      text: text && text !== name ? text : undefined,
      selector: cssPath(el),
      visible: true,
      enabled: !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true',
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    };
    if (states.length > 0) ref.states = states;
    if (group) ref.group = group;
    return ref;
  });
}

function resolveElement(refIdOrSelector: string): Element | null {
  const fromMap = refMap.get(refIdOrSelector);
  if (fromMap && fromMap.isConnected) return fromMap;
  try {
    return document.querySelector(refIdOrSelector);
  } catch {
    return null;
  }
}

// --- realistic synthetic interaction ----------------------------------------

function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function pointerOpts(x: number, y: number): PointerEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: 1,
  };
}

// Full pointer/mouse sequence at a coordinate, dispatched on the topmost
// element there. composed:true lets the events cross shadow boundaries.
function dispatchClickSequence(el: Element, x: number, y: number): void {
  const opts = pointerOpts(x, y);
  const up = { ...opts, buttons: 0 };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new PointerEvent('pointerenter', opts));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  if (el instanceof HTMLElement) el.focus();
  el.dispatchEvent(new PointerEvent('pointerup', up));
  el.dispatchEvent(new MouseEvent('mouseup', up));
  el.dispatchEvent(new MouseEvent('click', up));
}

export function clickElement(refIdOrSelector: string): ActionResult {
  const el = resolveElement(refIdOrSelector);
  if (!el) return { ok: false, detail: `Element not found: ${refIdOrSelector}` };
  const c = centerOf(el);
  dispatchClickSequence(el, c.x, c.y);
  return { ok: true, detail: `Clicked ${el.tagName.toLowerCase()}` };
}

// Set an input's value through the prototype's native setter so React/Vue
// value tracking registers the change (a plain `el.value =` does not).
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

export function fillInput(refIdOrSelector: string, value: string): ActionResult {
  const el = resolveElement(refIdOrSelector);
  if (!el) return { ok: false, detail: `Element not found: ${refIdOrSelector}` };
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    return { ok: false, detail: 'Element is not an input or textarea' };
  }
  el.focus();
  setNativeValue(el, value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  return { ok: true, detail: `Filled ${el.tagName.toLowerCase()}` };
}

export function submitForm(refIdOrSelector: string): ActionResult {
  const el = resolveElement(refIdOrSelector);
  if (!el) return { ok: false, detail: `Element not found: ${refIdOrSelector}` };
  const form = el instanceof HTMLFormElement ? el : el.closest('form');
  if (!form) return { ok: false, detail: 'No form found for element' };
  form.requestSubmit();
  return { ok: true, detail: 'Form submitted' };
}

// --- scroll step (for full-page capture) -------------------------------------

// Find the largest genuinely-scrollable element (for apps that scroll an inner
// container rather than the window — OWA reading pane, many SPAs).
function findScroller(): Element | null {
  let best: Element | null = null;
  let bestArea = 0;
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (el.scrollHeight - el.clientHeight <= 8 || el.clientHeight < 120) continue;
    const style = getComputedStyle(el);
    if (!/(auto|scroll)/.test(style.overflowY)) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

// Scroll down ~90% of a viewport, handling window and inner scrollers.
export function scrollStep(): { scrolled: boolean; atBottom: boolean } {
  const vh = window.innerHeight;
  const step = Math.floor(vh * 0.9);

  const docMax = document.documentElement.scrollHeight - vh;
  if (docMax > 8) {
    const before = window.scrollY;
    window.scrollBy(0, step);
    if (window.scrollY > before + 1) {
      return { scrolled: true, atBottom: window.scrollY >= docMax - 2 };
    }
  }

  const scroller = findScroller();
  if (scroller) {
    const before = scroller.scrollTop;
    scroller.scrollTop += step;
    const moved = scroller.scrollTop > before + 1;
    const atBottom = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2;
    return { scrolled: moved, atBottom: !moved || atBottom };
  }

  // Fallback for canvas apps: send PageDown to the focused element (best effort).
  const target = (document.activeElement as Element | null) ?? document.body;
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'PageDown', code: 'PageDown', bubbles: true, composed: true }),
  );
  return { scrolled: true, atBottom: false };
}

// --- canvas / app content reader ---------------------------------------------

function htmlToText(html: string): string {
  try {
    return (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return '';
  }
}

const APP_CONTENT_MAX = 20000;

// Best-effort extraction of content the DOM/ARIA can't see (e.g. canvas-rendered
// Google Docs/Sheets). No special permission: we read the selection model and
// intercept the app's own copy output (the in-flight dataTransfer, never the
// system clipboard).
export function readAppContent(): { method: string; text: string; truncated: boolean } {
  const sel = window.getSelection();
  const saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
  const restore = () => {
    if (!sel) return;
    sel.removeAllRanges();
    if (saved) sel.addRange(saved);
  };
  const cap = (text: string, method: string) => {
    const t = text.trim();
    return { method, text: t.slice(0, APP_CONTENT_MAX), truncated: t.length > APP_CONTENT_MAX };
  };

  // 1) Selection model: many apps reflect their content here on select-all.
  try {
    document.execCommand('selectAll');
    const selected = (window.getSelection()?.toString() ?? '').trim();
    if (selected.length > 50) {
      restore();
      return cap(selected, 'selection');
    }
  } catch {
    // fall through
  }

  // 2) Copy interception: capture what the app writes on copy, then discard it.
  try {
    let captured = '';
    const onCopy = (e: Event) => {
      const dt = (e as ClipboardEvent).clipboardData;
      if (dt) captured = dt.getData('text/plain') || htmlToText(dt.getData('text/html'));
    };
    window.addEventListener('copy', onCopy, true);
    document.execCommand('selectAll');
    document.execCommand('copy');
    window.removeEventListener('copy', onCopy, true);
    if (captured.trim().length > 50) {
      restore();
      return cap(captured, 'copy');
    }
  } catch {
    // fall through
  }
  restore();

  // 3) Plain visible text.
  const body = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
  if (body.length > 50) return cap(body, 'innerText');
  return { method: 'none', text: '', truncated: false };
}

// --- keyboard ----------------------------------------------------------------

const KEY_CODES: Record<string, string> = {
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ' ': 'Space',
};

function codeForKey(key: string): string {
  if (KEY_CODES[key]) return KEY_CODES[key];
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

// combo is "Enter", "Control+Enter", "Shift+Tab", "c", etc.
export function pressKeys(combo: string, targetRef?: string): ActionResult {
  const parts = combo.split('+').map((p) => p.trim());
  const key = parts.pop() ?? '';
  const mods = parts.map((p) => p.toLowerCase());
  const target =
    (targetRef ? resolveElement(targetRef) : null) ??
    (document.activeElement as Element | null) ??
    document.body;
  const init: KeyboardEventInit = {
    key,
    code: codeForKey(key),
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: mods.includes('control') || mods.includes('ctrl'),
    shiftKey: mods.includes('shift'),
    altKey: mods.includes('alt'),
    metaKey: mods.includes('meta') || mods.includes('cmd'),
  };
  if (target instanceof HTMLElement) target.focus();
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true, detail: `Pressed ${combo}` };
}

// --- coordinate gestures (canvas / maps) -------------------------------------

export function clickAt(x: number, y: number): ActionResult {
  const el = document.elementFromPoint(x, y);
  if (!el) return { ok: false, detail: `No element at (${x}, ${y})` };
  dispatchClickSequence(el, x, y);
  return { ok: true, detail: `Clicked at (${x}, ${y}) on ${el.tagName.toLowerCase()}` };
}

export function drag(fromX: number, fromY: number, toX: number, toY: number): ActionResult {
  const el = document.elementFromPoint(fromX, fromY);
  if (!el) return { ok: false, detail: `No element at (${fromX}, ${fromY})` };
  el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts(fromX, fromY)));
  el.dispatchEvent(new MouseEvent('mousedown', pointerOpts(fromX, fromY)));
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i) / steps;
    const y = fromY + ((toY - fromY) * i) / steps;
    el.dispatchEvent(new PointerEvent('pointermove', pointerOpts(x, y)));
    el.dispatchEvent(new MouseEvent('mousemove', pointerOpts(x, y)));
  }
  const up = { ...pointerOpts(toX, toY), buttons: 0 };
  el.dispatchEvent(new PointerEvent('pointerup', up));
  el.dispatchEvent(new MouseEvent('mouseup', up));
  return { ok: true, detail: `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})` };
}

export function scrollWheel(x: number, y: number, deltaY: number): ActionResult {
  const el = document.elementFromPoint(x, y) ?? document.body;
  el.dispatchEvent(
    new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaY }),
  );
  return { ok: true, detail: `Wheel deltaY=${deltaY} at (${x}, ${y})` };
}

// --- wait for element --------------------------------------------------------

export type WaitState = 'present' | 'visible' | 'enabled';

export function waitForElement(
  selector: string,
  state: WaitState,
  timeoutMs: number,
): Promise<ActionResult> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      let el: Element | null = null;
      try {
        el = document.querySelector(selector);
      } catch {
        resolve({ ok: false, detail: `Invalid selector: ${selector}` });
        return;
      }
      const ok =
        el !== null &&
        (state === 'present' ||
          (state === 'visible' && isVisible(el)) ||
          (state === 'enabled' && !(el as HTMLButtonElement).disabled));
      if (ok) {
        resolve({ ok: true, detail: `Element ${state}: ${selector}` });
      } else if (Date.now() >= deadline) {
        resolve({ ok: false, detail: `Timed out after ${timeoutMs}ms waiting for ${selector} to be ${state}` });
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}
