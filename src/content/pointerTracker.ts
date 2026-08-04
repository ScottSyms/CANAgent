import type { PointerTarget } from '../shared/types';

declare global {
  interface Window {
    __browserAgentInjectedPointerTracker?: boolean;
    __browserAgentPointerTarget?: PointerTarget | null;
    __browserAgentPointerAltDown?: boolean;
  }
}

type PointerState = {
  active: boolean;
  altDown: boolean;
  lastX: number;
  lastY: number;
  target: PointerTarget | null;
  overlay: HTMLDivElement | null;
  banner: HTMLDivElement | null;
};

function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && node !== document.body && depth < 5; depth++) {
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === node!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

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

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function elementInfo(el: Element): PointerTarget {
  const rect = el.getBoundingClientRect();
  const link = el instanceof HTMLAnchorElement ? el : el.closest('a[href]');
  return {
    tag: el.tagName.toLowerCase(),
    selector: cssPath(el),
    text: textOf(el) || undefined,
    role: el.getAttribute('role')?.trim().split(/\s+/)[0] || implicitRole(el),
    ariaLabel: el.getAttribute('aria-label')?.trim() || undefined,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    href: link instanceof HTMLAnchorElement ? link.href : undefined,
  };
}

function ensureOverlay(state: PointerState): HTMLDivElement {
  if (state.overlay) return state.overlay;
  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'pointer-events:none',
    'box-sizing:border-box',
    'border:2px solid rgba(59,130,246,0.95)',
    'border-radius:4px',
    'background:rgba(59,130,246,0.06)',
    'display:none',
  ].join(';');
  document.documentElement.appendChild(overlay);
  state.overlay = overlay;
  return overlay;
}

function ensureBanner(state: PointerState): HTMLDivElement {
  if (state.banner) return state.banner;
  const banner = document.createElement('div');
  banner.setAttribute('aria-hidden', 'true');
  banner.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'pointer-events:none',
    'box-sizing:border-box',
    'display:none',
    'max-width:320px',
    'padding:8px 10px',
    'border-radius:10px',
    'background:#0f172a',
    'color:#fff',
    'font:12px/1.3 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'box-shadow:0 10px 30px rgba(0,0,0,0.22)',
    'border:1px solid #64748b',
  ].join(';');
  document.documentElement.appendChild(banner);
  state.banner = banner;
  return banner;
}

function hideOverlay(state: PointerState): void {
  if (state.overlay) state.overlay.style.display = 'none';
}

function hideBanner(state: PointerState): void {
  if (state.banner) state.banner.style.display = 'none';
}

function intentLabel(target: PointerTarget): string {
  const label = target.ariaLabel || target.text || target.role || target.tag;
  if (target.href) return label ? `Open link: ${label}` : 'Open link';
  if (target.tag === 'button' || target.role === 'button' || target.role === 'menuitem') return label ? `Click: ${label}` : 'Click button';
  if (target.tag === 'input' || target.tag === 'textarea' || target.role === 'textbox' || target.role === 'searchbox') return label ? `Type into: ${label}` : 'Type into field';
  if (target.role === 'checkbox' || target.role === 'radio' || target.role === 'switch') return label ? `Toggle: ${label}` : 'Toggle control';
  if (target.tag === 'select' || target.role === 'combobox' || target.role === 'listbox') return label ? `Choose from: ${label}` : 'Choose option';
  return label ? `Inspect: ${label}` : 'Inspect element';
}

function positionBanner(state: PointerState, rect: DOMRect): void {
  const banner = ensureBanner(state);
  const pad = 10;
  const width = Math.min(320, Math.max(180, Math.round(rect.width || 220)));
  const x = Math.min(window.innerWidth - width - pad, Math.max(pad, rect.left));
  let y = rect.top - 12;
  const height = 44;
  if (y < pad) y = Math.min(window.innerHeight - height - pad, rect.bottom + 12);
  banner.style.width = `${width}px`;
  banner.style.left = `${x}px`;
  banner.style.top = `${Math.max(pad, y)}px`;
}

function updateOverlay(state: PointerState, el: Element | null): void {
  if (!state.active || !state.altDown || !el) {
    hideOverlay(state);
    hideBanner(state);
    state.target = null;
    window.__browserAgentPointerTarget = null;
    return;
  }

  const overlay = ensureOverlay(state);
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    hideOverlay(state);
    hideBanner(state);
    state.target = null;
    window.__browserAgentPointerTarget = null;
    return;
  }

  overlay.style.display = 'block';
  overlay.style.left = `${Math.max(0, rect.left)}px`;
  overlay.style.top = `${Math.max(0, rect.top)}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;

  const info = elementInfo(el);
  const banner = ensureBanner(state);
  banner.textContent = intentLabel(info);
  banner.style.display = 'block';
  positionBanner(state, rect);

  state.target = info;
  window.__browserAgentPointerTarget = state.target;
}

function currentElementFromPoint(state: PointerState): Element | null {
  if (state.lastX < 0 || state.lastY < 0) return null;
  return document.elementFromPoint(state.lastX, state.lastY);
}

function refresh(state: PointerState): void {
  updateOverlay(state, currentElementFromPoint(state));
}

function handleMouseMove(state: PointerState, event: MouseEvent): void {
  state.lastX = event.clientX;
  state.lastY = event.clientY;
  state.altDown = event.altKey;
  window.__browserAgentPointerAltDown = state.altDown;
  const fromPath = event.composedPath().find((n): n is Element => n instanceof Element) ?? null;
  updateOverlay(state, fromPath ?? (event.target instanceof Element ? event.target : currentElementFromPoint(state)));
}

function clearTarget(state: PointerState): void {
  hideOverlay(state);
  hideBanner(state);
  state.target = null;
  window.__browserAgentPointerTarget = null;
}

function handleKeyUp(state: PointerState): void {
  state.altDown = false;
  window.__browserAgentPointerAltDown = false;
  clearTarget(state);
}

function install(): void {
  if (window.__browserAgentInjectedPointerTracker) return;
  window.__browserAgentInjectedPointerTracker = true;

  const state: PointerState = {
    active: true,
    altDown: false,
    lastX: -1,
    lastY: -1,
    target: null,
    overlay: null,
    banner: null,
  };

  window.__browserAgentPointerTarget = null;
  window.__browserAgentPointerAltDown = false;

  document.addEventListener('mousemove', (event) => handleMouseMove(state, event), true);
  document.addEventListener('mouseleave', () => clearTarget(state), true);
  document.addEventListener('keydown', (event) => {
    if (event.altKey) {
      state.altDown = true;
      window.__browserAgentPointerAltDown = true;
      refresh(state);
    }
  }, true);
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Alt') handleKeyUp(state);
  }, true);
  window.addEventListener('blur', () => handleKeyUp(state));
  window.addEventListener('scroll', () => refresh(state), true);
  window.addEventListener('resize', () => refresh(state));

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.kind !== 'ba_get_pointer_target') return false;
    const target = window.__browserAgentPointerTarget;
    if (target) {
      sendResponse({ ok: true, target });
    } else {
      sendResponse({ ok: false, detail: 'Hold Alt and hover over an element.' });
    }
    return false;
  });
}

install();
