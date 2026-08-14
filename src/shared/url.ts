/** Normalize a hostname or URL to a bare lowercase host without a leading www. */
export function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase();
  // Strip scheme and path if a full URL (or partial) was given.
  host = host.replace(/^[a-z]+:\/\//, '');
  host = host.split('/')[0];
  host = host.split('?')[0];
  host = host.split('#')[0];
  host = host.replace(/^www\./, '');
  return host;
}

/**
 * Reduce a conversation's tab-group tabs to the persistable pages: keep only
 * real http(s) URLs (drop chrome://, about:blank, empty), dedupe by URL, and cap
 * the count so a big research session can't bloat a saved record. Pure — used at
 * save time to snapshot the group for later rehydration.
 */
export function collectGroupUrls(
  tabs: Array<{ url?: string; title?: string }>,
  cap = 16,
): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const t of tabs) {
    const url = t.url ?? '';
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: t.title ?? '' });
    if (out.length >= cap) break;
  }
  return out;
}

const CHROME_PDF_VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

function pathLooksLikePdf(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Return the real PDF URL for a direct PDF URL or Chrome's built-in PDF viewer
 * wrapper (`chrome-extension://mhj.../index.html?src=<pdf-url>`). The browser tab
 * often exposes the wrapper URL, but pdf.js needs the underlying document URL.
 */
export function resolvePdfUrl(url: string): string | null {
  if (pathLooksLikePdf(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'chrome-extension:' || parsed.hostname !== CHROME_PDF_VIEWER_EXTENSION_ID) return null;
  const src = parsed.searchParams.get('src');
  if (!src) return null;
  try {
    const srcUrl = new URL(src);
    if (srcUrl.protocol === 'chrome-extension:' || srcUrl.protocol === 'chrome:' || srcUrl.protocol === 'chrome-untrusted:') return null;
    return src;
  } catch {
    return null;
  }
}

const OFFICE_EXTENSION = /\.(docx?|docm|pptx?|pptm|ppsx|xlsx?|xlsm|odt|ods|odp|rtf|epub)$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// SharePoint sharing-link prefix: /:w:/r/<path>, /:x:/…, /:p:/… (Word/Excel/PowerPoint).
const SHARING_PREFIX = /^\/:[wxp]:\/[a-z]\//i;

function getFileByIdUrl(siteUrl: string, guid: string): string {
  return `${siteUrl}/_api/web/GetFileById('${guid}')/$value`;
}

/**
 * Return the real, directly-fetchable file URL for an Office document tab. The
 * open tab usually shows a viewer/editor wrapper, not the file — `extractOffice`
 * needs the underlying bytes. Handles, in order:
 *  - SharePoint sharing links (`/:w:/r/<path>.docx?web=1…`) — strip the prefix
 *    and query to recover the server-relative file path;
 *  - direct file URLs (path ends in an Office extension) — returned unchanged;
 *  - the classic viewer wrapper (`/_layouts/15/Doc.aspx?sourcedoc={guid}` or
 *    `WopiFrame.aspx`) — the GUID resolves via SharePoint REST `GetFileById`;
 *  - the new `word/excel/powerpoint.cloud.microsoft` editors, whose `wopisrc`
 *    param carries `…/_vti_bin/wopi.ashx/files/<guid>` — same `GetFileById`.
 * All resolved URLs are fetched with the browser's own signed-in SharePoint
 * session (same as `sharepoint_search`).
 */
export function resolveOfficeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Sharing-link wrapper: the remainder after /:w:/r/ is the real server-relative
  // path; the query (?d=…&csf=1&web=1) only drives the viewer and must be dropped.
  const sharing = parsed.pathname.match(SHARING_PREFIX);
  if (sharing) {
    const path = parsed.pathname.slice(sharing[0].length - 1); // keep leading '/'
    if (OFFICE_EXTENSION.test(path.toLowerCase())) return parsed.origin + path;
  }

  if (OFFICE_EXTENSION.test(parsed.pathname.toLowerCase())) return url;

  // New unified Office editors (word|excel|powerpoint.cloud.microsoft, *.officeapps.live.com):
  // the WOPI source URL identifies the file GUID within its SharePoint site.
  const wopiSrc = parsed.searchParams.get('wopisrc') ?? parsed.searchParams.get('WOPISrc') ?? parsed.searchParams.get('WopiSrc');
  if (wopiSrc) {
    try {
      const w = new URL(wopiSrc);
      const m = w.pathname.match(/^(.*)\/_vti_bin\/wopi\.ashx\/files\/([0-9a-f-]{36})$/i);
      if (m && GUID.test(m[2])) return getFileByIdUrl(w.origin + m[1], m[2]);
    } catch {
      // fall through to the Doc.aspx test
    }
  }

  if (!/\/_layouts\/15\/(doc|wopiframe)\.aspx$/i.test(parsed.pathname)) return null;
  const rawGuid = parsed.searchParams.get('sourcedoc');
  if (!rawGuid) return null;
  const guid = rawGuid.replace(/[{}]/g, '');
  if (!GUID.test(guid)) return null;
  const siteUrl = parsed.origin + parsed.pathname.replace(/\/_layouts\/15\/(doc|wopiframe)\.aspx$/i, '');
  return getFileByIdUrl(siteUrl, guid);
}

/**
 * Classify a URL by file type so the agent reads documents instead of navigating
 * to them (the browser downloads Office/PDF files rather than rendering, leaving
 * nothing to process). Tests the path extension (ignoring any query string, e.g.
 * SharePoint's `…/Report.pptx?web=1`) plus the SharePoint Office-Online viewer
 * pattern (`resolveOfficeUrl`). Returns null for normal web pages.
 */
export function documentKindForUrl(url: string): 'office' | 'pdf' | null {
  if (resolvePdfUrl(url)) return 'pdf';
  if (resolveOfficeUrl(url)) return 'office';
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\.pdf$/.test(pathname)) return 'pdf';
  return null;
}

/** True when an active tab's host belongs to a playbook's origin (incl. subdomains). */
export function hostMatches(tabHost: string, origin: string): boolean {
  const a = normalizeHost(tabHost);
  const b = normalizeHost(origin);
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b);
}
