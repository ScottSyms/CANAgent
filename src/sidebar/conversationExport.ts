import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ChatMessageView, Citation, DataExport, FileArtifact } from '../shared/types';
import { injectCitationChips } from '../shared/citations';
import { saveFile } from './download';

// marked's gfm/breaks options and DOMPurify's link hook are configured globally
// in Markdown.tsx (loaded with the sidebar); set the options here too so this
// module renders identically even if imported on its own.
marked.setOptions({ gfm: true, breaks: true });

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function downloadBlob(content: string, type: string, filename: string): void {
  saveFile(new Blob([content], { type }), filename);
}

/** Split a trailing "Source tabs:"/"Sources:" block off an assistant answer. */
function splitSources(text: string): { body: string; sources: string | null } {
  const match = /(?:^|\n)(Source tabs?:|Sources:)\s*\n/i.exec(text);
  if (!match) return { body: text, sources: null };
  return { body: text.slice(0, match.index).trimEnd(), sources: text.slice(match.index).trim() };
}

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

function renderImages(images: string[]): string {
  return (
    `<div class="msg-images">` +
    images.map((src) => `<img class="msg-image" src="${escapeHtml(src)}" alt="snapshot">`).join('') +
    `</div>`
  );
}

function renderTable(data: DataExport): string {
  const head = data.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const body = data.rows
    .map((r) => `<tr>${data.columns.map((_, ci) => `<td>${escapeHtml(r[ci] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return (
    `<table class="export-table"><caption>${escapeHtml(data.title)}</caption>` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  );
}

function renderFileArtifact(file: FileArtifact): string {
  if (file.mimeType.startsWith('image/')) {
    return (
      `<div class="msg-images">` +
      `<img class="msg-image" src="data:${escapeHtml(file.mimeType)};base64,${file.dataBase64}" alt="${escapeHtml(file.filename)}">` +
      `</div>`
    );
  }
  return `<div class="export-fileart">${escapeHtml(file.filename)}</div>`;
}

/** A numbered footnote list of the sentence-level citations for one answer. */
export function renderCitations(citations: Citation[]): string {
  const items = citations
    .map((c, i) => {
      const page = c.page ? ` (p.${c.page})` : '';
      const href = c.page && !c.url.includes('#') ? `${c.url}#page=${c.page}` : c.url;
      return (
        `<li><span class="cite-n">${i + 1}</span> ` +
        `“${escapeHtml(c.sentenceText)}” — ` +
        `<a href="${escapeHtml(href)}">${escapeHtml(c.docName)}${escapeHtml(page)}</a></li>`
      );
    })
    .join('');
  return `<ol class="export-citations">${items}</ol>`;
}

const ROLE_LABEL: Record<ChatMessageView['role'], string> = {
  user: 'You',
  assistant: 'Agent',
  notice: 'Notice',
};

function renderMessage(m: ChatMessageView): string {
  const parts: string[] = [];
  if (m.images && m.images.length > 0) parts.push(renderImages(m.images));

  if (m.role === 'assistant') {
    const { body, sources } = splitSources(m.text);
    let bodyHtml = renderMarkdown(body);
    if (m.citations && m.citations.length > 0) {
      const numberById = new Map(m.citations.map((c, i) => [c.sentenceId, i + 1] as const));
      bodyHtml = injectCitationChips(bodyHtml, numberById);
    }
    parts.push(`<div class="md">${bodyHtml}</div>`);
    if (sources) parts.push(`<div class="citations md">${renderMarkdown(sources)}</div>`);
    if (m.citations && m.citations.length > 0) parts.push(renderCitations(m.citations));
  } else {
    // user / notice: plain text, escaped, line breaks preserved.
    parts.push(`<div class="plain">${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>`);
  }

  if (m.dataExport) parts.push(renderTable(m.dataExport));
  if (m.fileArtifact) parts.push(renderFileArtifact(m.fileArtifact));

  const time = m.timestamp ? `<span class="msg-time">${escapeHtml(m.timestamp)}</span>` : '';
  return (
    `<div class="msg msg-${m.role}">` +
    `<div class="msg-head"><span class="msg-role">${ROLE_LABEL[m.role]}</span>${time}</div>` +
    parts.join('') +
    `</div>`
  );
}

export const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px; background: #f5f6f8; color: #1b1c1e;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 820px; margin: 0 auto; }
  .doc-head { margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid #d8dbe0; }
  .doc-head h1 { font-size: 18px; margin: 0 0 4px; }
  .doc-head .meta { color: #6b7280; font-size: 13px; }
  .msg { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
  .msg-user { background: #eef3ff; border-color: #d4e0fb; }
  .msg-notice { background: #fafafa; color: #555; font-size: 14px; }
  .msg-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .msg-role { font-weight: 600; font-size: 12px; letter-spacing: .03em; text-transform: uppercase; color: #6b7280; }
  .msg-time { color: #9aa1ab; font-size: 12px; }
  .plain { white-space: normal; }
  .md p { margin: 0 0 .6em; }
  .md p:last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3 { line-height: 1.25; margin: .8em 0 .4em; }
  .md pre { background: #1f2430; color: #e6e9ef; padding: 10px 12px; border-radius: 8px; overflow: auto; }
  .md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  .md :not(pre) > code { background: #eef0f3; padding: .1em .35em; border-radius: 4px; }
  .md a { color: #2563eb; }
  .md ul, .md ol { padding-left: 1.4em; margin: .4em 0; }
  .md table { border-collapse: collapse; margin: .5em 0; }
  .md th, .md td { border: 1px solid #d8dbe0; padding: 4px 8px; text-align: left; }
  .citations { margin-top: 8px; padding-top: 8px; border-top: 1px solid #eceef1; font-size: 13px; color: #555; }
  .citation-chip { display: inline-block; min-width: 14px; padding: 0 4px; margin: 0 1px; border-radius: 7px;
    background: #dbe4ff; color: #2563eb; font-size: 10px; font-weight: 700; vertical-align: super; }
  .export-citations { margin: 10px 0 0; padding-left: 0; list-style: none; font-size: 13px; color: #555;
    border-top: 1px solid #eceef1; padding-top: 8px; }
  .export-citations li { margin: 4px 0; }
  .export-citations .cite-n { display: inline-block; min-width: 16px; font-weight: 700; color: #2563eb; }
  .msg-images { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .msg-image { max-width: 100%; max-height: 360px; border: 1px solid #d8dbe0; border-radius: 8px; }
  .export-table { border-collapse: collapse; margin: 8px 0; width: 100%; }
  .export-table caption { text-align: left; font-weight: 600; margin-bottom: 6px; }
  .export-table th, .export-table td { border: 1px solid #d8dbe0; padding: 4px 8px; text-align: left; font-size: 13px; }
  .export-table thead th { background: #f1f3f6; }
  .export-fileart { margin-top: 8px; color: #555; font-size: 13px; }
`;

/** Build a standalone HTML document for the conversation and download it. */
export function exportConversationHtml(messages: ChatMessageView[]): void {
  const now = new Date();
  const exportedAt = now.toLocaleString();
  const body = messages.map(renderMessage).join('\n');
  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>CANChat Agent conversation — ${escapeHtml(now.toISOString().slice(0, 10))}</title>\n` +
    `<style>${STYLE}</style>\n</head>\n<body>\n<div class="wrap">\n` +
    `<div class="doc-head"><h1>CANChat Agent conversation</h1>` +
    `<div class="meta">Exported ${escapeHtml(exportedAt)} · ${messages.length} message${messages.length === 1 ? '' : 's'}</div></div>\n` +
    body +
    `\n</div>\n</body>\n</html>\n`;

  downloadBlob(html, 'text/html', `canchat-agent-conversation-${now.toISOString().slice(0, 10)}.html`);
}
