// =============================================================================
// ChatPanel — the conversation surface: transcript, inline cards (data exports,
// snapshots), the approval/auth/permission prompts, and the composer. The
// composer is a contenteditable so inserted @bookmark / #repo mentions can
// render as styled chips; `text` mirrors its plain text for button state while
// the element itself stays uncontrolled (never re-rendered from state). Skills
// load from storage (live via onChanged) to power /command hints and the mic
// button. All user actions leave through the `send` prop — see Sidebar.
// =============================================================================

import { useEffect, useRef, useState } from 'preact/hooks';
import type { CapabilityRegistryEntry } from '../shared/capabilities';
import type { SidebarCommand } from '../shared/messages';
import type { AgentStatus, ChatMessageView, Citation, DataExport, FileArtifact, SiteEntry, Skill } from '../shared/types';
import { UPLOAD_ACCEPT } from '../shared/uploadFile';
import { captureDrop, clipboardIsEmail, itemsFromFiles, type DroppedItem } from './dropCapture';
import { capabilityBookmarkCandidates, dedupeBookmarkCandidates, filterBookmarkMentions, flattenBookmarkTree } from './bookmarkMentions';
import { DOCS_URL } from './links';
import { RepoUpload } from './RepoUpload';
import { UploadBanner } from './UploadBanner';
import { saveFile } from './download';
import { useT } from './i18n';
import { Markdown } from './Markdown';
import { CitationView } from './CitationView';

function toCsv(columns: string[], rows: string[][]): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns, ...rows].map((r) => r.map((c) => esc(c ?? '')).join(',')).join('\r\n');
}

function downloadBlob(content: string, type: string, filename: string): void {
  saveFile(new Blob([content], { type }), filename);
}

/** Decode a base64 string into bytes and offer it as a binary file download. */
function downloadBase64(dataBase64: string, type: string, filename: string): void {
  const bin = atob(dataBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  saveFile(new Blob([bytes], { type }), filename);
}

/** Download card for a generated binary document (e.g. a .docx). */
function FileArtifactCard({ file }: { file: FileArtifact }) {
  const t = useT();
  const isImage = file.mimeType.startsWith('image/');
  const download = () => downloadBase64(file.dataBase64, file.mimeType, file.filename);
  return (
    <div class="export-card">
      {isImage && (
        <img
          src={`data:${file.mimeType};base64,${file.dataBase64}`}
          class="export-image-preview"
          alt={file.filename}
          onClick={download}
        />
      )}
      <div class="export-head">
        <strong>{file.filename}</strong>
      </div>
      <div class="export-actions">
        <button class="btn btn-small btn-primary" onClick={download}>
          {t('export.download')}
        </button>
      </div>
    </div>
  );
}

function DataExportCard({ data }: { data: DataExport }) {
  const t = useT();
  const csv = () => toCsv(data.columns, data.rows);
  const json = () =>
    JSON.stringify(
      data.rows.map((r) => Object.fromEntries(data.columns.map((c, i) => [c, r[i] ?? '']))),
      null,
      2,
    );
  const preview = data.rows.slice(0, 8);
  return (
    <div class="export-card">
      <div class="export-head">
        <strong>{data.title}</strong>
        <span class="export-dims">
          {data.rows.length} × {data.columns.length}
        </span>
      </div>
      <div class="export-table-wrap">
        <table class="export-table">
          <thead>
            <tr>
              {data.columns.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.map((r, ri) => (
              <tr key={ri}>
                {data.columns.map((_, ci) => (
                  <td key={ci}>{r[ci] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {data.rows.length > preview.length && (
          <div class="export-more">+{data.rows.length - preview.length} more rows</div>
        )}
      </div>
      <div class="export-actions">
        <button class="btn btn-small btn-primary" onClick={() => downloadBlob(csv(), 'text/csv', data.filename)}>
          {t('export.csv')}
        </button>
        <button
          class="btn btn-small"
          onClick={() => downloadBlob(json(), 'application/json', data.filename.replace(/\.csv$/, '.json'))}
        >
          {t('export.json')}
        </button>
        <button class="btn btn-small" onClick={() => void navigator.clipboard.writeText(csv())}>
          {t('export.copyCsv')}
        </button>
      </div>
    </div>
  );
}

/** Split a trailing "Source tabs:" / "Sources:" block off the answer body. */
function splitSources(text: string): { body: string; sources: string | null } {
  const match = /(?:^|\n)(Source tabs?:|Sources:)\s*\n/i.exec(text);
  if (!match) return { body: text, sources: null };
  return {
    body: text.slice(0, match.index).trimEnd(),
    sources: text.slice(match.index).trim(),
  };
}

interface Props {
  messages: ChatMessageView[];
  status: AgentStatus;
  approval: { requestId: string; description: string; detail: string; approvalContext?: { toolName: string; capabilityKind?: string; capabilityName?: string; trustLevel?: string; authMethod?: string; authConfigured: boolean } } | null;
  authNotice: { origin: string; message: string } | null;
  permissionNotice: { origin: string; message: string } | null;
  pendingSnapshots: string[];
  canDistill: boolean;
  /** Prompt text to drop into the composer after an undo (null = nothing pending). */
  restoreDraft: string | null;
  onRestoreConsumed: () => void;
  /** Items captured by the panel-wide drop overlay → open the uploader with them. */
  droppedItems: DroppedItem[] | null;
  onDroppedItemsConsumed: () => void;
  send: (command: SidebarCommand) => void;
  disabled: boolean;
}

function MessageImages({ images }: { images: string[] }) {
  return (
    <div class="msg-images">
      {images.map((src, i) => (
        <img
          key={i}
          src={src}
          class="msg-image"
          alt={`Snapshot ${i + 1}`}
          onClick={() => void chrome.tabs.create({ url: src })}
        />
      ))}
    </div>
  );
}

export function ChatPanel({
  messages,
  status,
  approval,
  authNotice,
  permissionNotice,
  pendingSnapshots,
  canDistill,
  restoreDraft,
  onRestoreConsumed,
  droppedItems,
  onDroppedItemsConsumed,
  send,
  disabled,
}: Props) {
  const tr = useT();
  // The input is a contenteditable editor (so inserted bookmark URLs can render
  // bold). `text` mirrors its plain text for logic/button state; the element
  // itself is uncontrolled — never re-render its content from state.
  const [text, setText] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  // The sentence-level citation currently being inspected (chip click), or null.
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  // Voice prompts: available only when a transcription model is configured.
  const [hasTranscription, setHasTranscription] = useState(false);
  const [micState, setMicState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [micError, setMicError] = useState<string | null>(null);
  // Files/emails dropped on the panel or attached via 📎 → the shared uploader opens with them.
  const [dropItems, setDropItems] = useState<DroppedItem[] | null>(null);
  const [uploadBanner, setUploadBanner] = useState<string | null>(null);
  const [rememberSession, setRememberSession] = useState(false);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  // @-mention of browser bookmarks and #-mention of local repositories.
  const [mention, setMention] = useState<{ kind: 'bookmark' | 'repo'; query: string } | null>(null);
  const [mentionItems, setMentionItems] = useState<
    Array<{ primary: string; secondary: string; insert: string }>
  >([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  const getEditorText = () =>
    (editorRef.current?.innerText ?? '').replace(/\u00a0/g, ' ');
  const syncText = () => setText(getEditorText());
  const setEditorText = (value: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.textContent = value;
    setText(value);
    // caret to end
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    el.focus();
  };
  const clearEditor = () => {
    if (editorRef.current) editorRef.current.innerHTML = '';
    setText('');
    setMention(null);
    setMentionItems([]);
  };

  // After an undo, drop the removed prompt back into the composer for editing.
  useEffect(() => {
    if (restoreDraft != null) {
      setEditorText(restoreDraft);
      onRestoreConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreDraft]);

  useEffect(() => {
    const load = () =>
      chrome.storage.local.get(['ba_skills', 'ba_settings']).then((r) => {
        setSkills(Array.isArray(r.ba_skills) ? (r.ba_skills as Skill[]) : []);
        const s = r.ba_settings as { transcriptionModel?: string } | undefined;
        setHasTranscription(Boolean(s?.transcriptionModel?.trim()));
      });
    load();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('ba_skills' in changes || 'ba_settings' in changes) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Skill name hints while typing a /command. Includes the built-in /learn.
  const slashMatch = /^\/([a-z0-9-]*)$/i.exec(text.trim().split(/\s/)[0] ?? '');
  const hintItems: Array<{ id: string; name: string; description: string }> = [
    ...(skills.some((s) => s.name.toLowerCase() === 'learn')
      ? []
      : [{ id: 'builtin-learn', name: 'learn', description: 'Explore this site and save a reusable playbook' }]),
    ...skills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
  ];
  const matchingSkills =
    text.startsWith('/') && slashMatch
      ? hintItems.filter((s) => s.name.startsWith(slashMatch[1].toLowerCase()))
      : [];

  // Locate an active mention token at the caret: "@" for bookmarks, "#" for repos.
  const mentionRangeAtCaret = (): {
    node: Text;
    start: number;
    end: number;
    kind: 'bookmark' | 'repo';
    query: string;
  } | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !editorRef.current) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !editorRef.current.contains(node)) return null;
    const offset = range.startOffset;
    const before = (node.textContent ?? '').slice(0, offset);
    const m = /(?:^|\s)([@#])([^\s@#]*)$/.exec(before);
    if (!m) return null;
    return {
      node: node as Text,
      start: offset - m[2].length - 1,
      end: offset,
      kind: m[1] === '@' ? 'bookmark' : 'repo',
      query: m[2],
    };
  };

  const updateMention = () => {
    const found = mentionRangeAtCaret();
    setMention(found ? { kind: found.kind, query: found.query } : null);
  };

  // Fetch matching items (debounced) while a mention is being typed: bookmarks
  // for "@", local repositories for "#".
  useEffect(() => {
    if (!mention) {
      setMentionItems([]);
      return;
    }
    let cancelled = false;
    const q = mention.query.trim();
    const ql = q.toLowerCase();

    if (mention.kind === 'repo') {
      const timer = setTimeout(async () => {
        let repos: Array<{ name: string; docs: number; chunks: number }> = [];
        try {
          const list = await chrome.runtime.sendMessage({ type: 'repo_list' });
          if (Array.isArray(list)) repos = list;
        } catch {
          repos = [];
        }
        if (cancelled) return;
        const items = repos
          .filter((r) => !q || r.name.toLowerCase().includes(ql))
          .sort(
            (a, b) =>
              (a.name.toLowerCase().startsWith(ql) ? 0 : 1) -
              (b.name.toLowerCase().startsWith(ql) ? 0 : 1),
          )
          .slice(0, 8)
          .map((r) => ({
            primary: r.name,
            secondary: `${r.docs} doc${r.docs === 1 ? '' : 's'}, ${r.chunks} chunk${r.chunks === 1 ? '' : 's'}`,
            insert: r.name,
          }));
        setMentionItems(items);
        setMentionIndex(0);
      }, 80);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    // bookmark kind
    if (typeof chrome === 'undefined' || !chrome.bookmarks) {
      setMentionItems([]);
      return;
    }
    const timer = setTimeout(async () => {
      let tree: chrome.bookmarks.BookmarkTreeNode[] = [];
      let capabilities: CapabilityRegistryEntry[] = [];
      let sites: SiteEntry[] = [];
      try {
        const [bookmarkTree, stored] = await Promise.all([
          chrome.bookmarks.getTree(),
          chrome.storage.local.get(['ba_capabilities', 'ba_sites']),
        ]);
        tree = bookmarkTree;
        capabilities = Array.isArray(stored.ba_capabilities) ? (stored.ba_capabilities as CapabilityRegistryEntry[]) : [];
        sites = Array.isArray(stored.ba_sites) ? (stored.ba_sites as SiteEntry[]) : [];
      } catch {
        tree = [];
      }
      if (cancelled) return;
      const items = filterBookmarkMentions(
        dedupeBookmarkCandidates([
          ...flattenBookmarkTree(tree),
          ...capabilityBookmarkCandidates(capabilities, sites),
        ]),
        q,
        20,
      );
      setMentionItems(items);
      setMentionIndex(0);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention]);

  const mentionOpen = mention !== null && mentionItems.length > 0;

  const insertMention = (value: string) => {
    const found = mentionRangeAtCaret();
    const editor = editorRef.current;
    const sel = window.getSelection();
    if (!found || !editor || !sel) return;
    // Replace the "@query" span with a bold URL node + a trailing space.
    const del = document.createRange();
    del.setStart(found.node, found.start);
    del.setEnd(found.node, found.end);
    del.deleteContents();
    const space = document.createTextNode(' ');
    const bold = document.createElement('span');
    bold.className = 'mention-bold';
    bold.textContent = value;
    bold.dataset.kind = found.kind; // 'bookmark' | 'repo' — read back on submit
    bold.dataset.value = value;
    del.insertNode(space);
    del.insertNode(bold);
    // Caret into the (normal-weight) space node so typing continues unbolded.
    const after = document.createRange();
    after.setStart(space, space.length);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    editor.focus();
    setMention(null);
    setMentionItems([]);
    syncText();
  };

  const copyMessage = async (index: number, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex((c) => (c === index ? null : c)), 1500);
  };

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, approval, authNotice, permissionNotice]);

  // Permission requests must run in a user-gesture handler in an extension page.
  const grant = async (origins: string[]) => {
    const granted = await chrome.permissions.request({ origins });
    if (granted) send({ type: 'resume_agent' });
  };

  const busy = status === 'thinking' || status === 'acting' || status === 'awaiting_approval' || status === 'auth_required';

  // Collect tagged mentions (@bookmark / #repo) so the agent acts on them
  // explicitly, since the bold styling is lost when the text is flattened.
  const collectMentions = (): Array<{ kind: 'bookmark' | 'repo'; value: string }> => {
    const el = editorRef.current;
    if (!el) return [];
    const seen = new Set<string>();
    const out: Array<{ kind: 'bookmark' | 'repo'; value: string }> = [];
    el.querySelectorAll<HTMLElement>('.mention-bold[data-kind]').forEach((span) => {
      const kind = span.dataset.kind;
      const value = span.dataset.value ?? '';
      if ((kind !== 'bookmark' && kind !== 'repo') || !value) return;
      const key = `${kind}:${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind, value });
    });
    return out;
  };

  const submit = () => {
    const message = getEditorText().trim();
    if (!message || disabled || busy) return;
    const mentions = collectMentions();
    send({ type: 'user_message', text: message, mentions: mentions.length ? mentions : undefined });
    clearEditor();
  };

  const openMicPermission = () =>
    void chrome.tabs.create({ url: chrome.runtime.getURL('microphone.html') });

  // Push-to-talk: first click records, second click stops and transcribes via
  // the configured endpoint, appending the result to the composer.
  const stopRecording = () => recorderRef.current?.state === 'recording' && recorderRef.current.stop();

  const toggleMic = async () => {
    setMicError(null);
    if (micState === 'recording') {
      stopRecording();
      return;
    }
    if (micState === 'transcribing') return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Chrome won't show the mic prompt inside the side panel; grant it once
      // from a normal extension tab, then the side panel can record.
      setMicError(
        "The microphone can't be enabled from the side panel. I've opened a tab where you can allow it — then come back and tap the mic again.",
      );
      openMicPermission();
      return;
    }
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size === 0) {
        setMicState('idle');
        return;
      }
      setMicState('transcribing');
      try {
        const audioDataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        const res = (await chrome.runtime.sendMessage({ type: 'transcribe_audio', audioDataUrl })) as {
          ok: boolean;
          text?: string;
          error?: string;
        };
        if (res?.ok && res.text) {
          const existing = getEditorText().trim();
          setEditorText(existing ? `${existing} ${res.text}` : res.text);
        } else if (res?.ok) {
          setMicError('No speech detected.');
        } else {
          setMicError(res?.error ?? 'Transcription failed.');
        }
      } catch (err) {
        setMicError(String(err));
      } finally {
        setMicState('idle');
      }
    };
    recorder.start();
    setMicState('recording');
  };

  // Files picked via 📎 → open the knowledge-base uploader pre-loaded with them.
  // (Drag-and-drop is handled by the panel-wide overlay in Sidebar, which feeds
  //  `droppedItems`; the effect below consumes it.)
  const queueFiles = (files: File[]) => {
    void itemsFromFiles(files).then((items) => {
      if (items.length) setDropItems(items);
    });
  };

  // Overlay-captured drop (files or an email) → open the uploader with it.
  useEffect(() => {
    if (droppedItems && droppedItems.length) {
      setDropItems(droppedItems);
      onDroppedItemsConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedItems]);

  return (
    <div class="chat">
      {activeCitation && <CitationView citation={activeCitation} onClose={() => setActiveCitation(null)} />}
      <div class="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div class="chat-empty">
            <p>{tr('chat.empty')}</p>
            <a class="chat-empty-help" href={DOCS_URL} target="_blank" rel="noopener noreferrer">
              {tr('chat.help')}
            </a>
          </div>
        )}
        {messages.map((m, i) => {
          const { body, sources } = m.role === 'assistant' ? splitSources(m.text) : { body: m.text, sources: null };
          return (
          <div key={i} class={`msg msg-${m.role}`}>
            {m.images && m.images.length > 0 && <MessageImages images={m.images} />}
            {m.role === 'assistant' ? (
              <>
                <Markdown text={body} citations={m.citations} onCiteClick={setActiveCitation} />
                {sources && (
                  <div class="citations">
                    <Markdown text={sources} />
                  </div>
                )}
                <div class="msg-actions">
                  <button
                    class="copy-btn"
                    title="Copy to clipboard"
                    onClick={() => copyMessage(i, m.text)}
                  >
                    {copiedIndex === i ? tr('chat.copied') : tr('chat.copy')}
                  </button>
                </div>
              </>
            ) : (
              m.text
            )}
            {m.dataExport && <DataExportCard data={m.dataExport} />}
            {m.fileArtifact && <FileArtifactCard file={m.fileArtifact} />}
          </div>
          );
        })}

        {authNotice && (
          <div class="prompt-card">
            <div>{authNotice.message}</div>
            <div class="prompt-actions">
              <button class="btn btn-primary" onClick={() => send({ type: 'resume_agent' })}>
                Resume
              </button>
              <button class="btn" onClick={() => send({ type: 'stop_task' })}>
                Stop task
              </button>
            </div>
          </div>
        )}

        {permissionNotice && (
          <div class="prompt-card">
            <div>{permissionNotice.message}</div>
            <div class="prompt-actions">
              <button
                class="btn btn-primary"
                onClick={() => grant([permissionNotice.origin + '/*'])}
              >
                Allow this site
              </button>
              <button class="btn" onClick={() => grant(['<all_urls>'])}>
                Allow all sites
              </button>
              <button class="btn" onClick={() => send({ type: 'stop_task' })}>
                Stop task
              </button>
            </div>
          </div>
        )}

        {approval && (
          <div class="prompt-card" data-testid="approval">
            <div>
              <strong>{tr('approval.title')}</strong>
              {approval.approvalContext && (
                <div class="approval-context">
                  {approval.approvalContext.capabilityKind && <span class="approval-tag approval-cap">{approval.approvalContext.capabilityKind}</span>}
                  {approval.approvalContext.trustLevel && <span class={`approval-tag approval-trust approval-trust-${approval.approvalContext.trustLevel}`}>{approval.approvalContext.trustLevel}</span>}
                  {approval.approvalContext.authMethod && (
                    <span class={`approval-tag approval-auth ${approval.approvalContext.authConfigured ? 'approval-auth-ok' : 'approval-auth-missing'}`}>
                      {approval.approvalContext.authConfigured ? approval.approvalContext.authMethod : `${approval.approvalContext.authMethod} (not configured)`}
                    </span>
                  )}
                  {approval.approvalContext.capabilityName && <span class="approval-cap-name">{approval.approvalContext.capabilityName}</span>}
                </div>
              )}
              <div class="prompt-reason">{approval.description}</div>
              <details class="prompt-tech">
                <summary>{tr('approval.tech')}</summary>
                <div class="prompt-detail">{approval.detail}</div>
              </details>
            </div>
            <div class="prompt-actions-col">
              <label class="approval-remember">
                <input type="checkbox" checked={rememberSession} onChange={() => setRememberSession(!rememberSession)} />
                <span>{tr('approval.allow')}</span>
              </label>
              <div class="prompt-btn-row">
                <button
                  class="btn btn-primary"
                  onClick={() => send({ type: 'approval_response', requestId: approval.requestId, approved: true, rememberForSession: rememberSession })}
                >
                  {tr('approval.approve')}
                </button>
                <button
                  class="btn"
                  onClick={() => send({ type: 'approval_response', requestId: approval.requestId, approved: false })}
                >
                  {tr('approval.deny')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div class="chat-input-row">
        {uploadBanner && <UploadBanner text={uploadBanner} onDismiss={() => setUploadBanner(null)} />}
        {dropItems && (
          <div class="repo-upload-card">
            <RepoUpload
              initialItems={dropItems}
              onClose={() => setDropItems(null)}
              onDone={(s) => setUploadBanner(tr('repos.upload.done', { n: String(s.added), repo: s.repo }))}
            />
          </div>
        )}
        {canDistill && (
          <div class="distill-chip">
            <span>{tr('distill.offer')}</span>
            <button class="btn btn-small btn-primary" onClick={() => send({ type: 'distill_skill' })}>
              {tr('distill.save')}
            </button>
            <button class="icon-btn" title="Dismiss" onClick={() => send({ type: 'dismiss_distill' })}>
              ✕
            </button>
          </div>
        )}
        {pendingSnapshots.length > 0 && (
          <div class="snapshot-pending">
            {pendingSnapshots.map((src, i) => (
              <img key={i} src={src} class="snapshot-thumb" alt={`Pending snapshot ${i + 1}`} />
            ))}
            <span class="snapshot-label">
              {pendingSnapshots.length} snapshot{pendingSnapshots.length > 1 ? 's' : ''} attached
            </span>
            <button
              class="icon-btn"
              title="Discard snapshots"
              onClick={() => send({ type: 'discard_snapshots' })}
            >
              ✕
            </button>
          </div>
        )}
        {matchingSkills.length > 0 && (
          <div class="skill-hints">
            {matchingSkills.map((s) => (
              <button
                key={s.id}
                class="skill-hint"
                title={s.description}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setEditorText(`/${s.name} `);
                }}
              >
                /{s.name}
              </button>
            ))}
          </div>
        )}
        {mentionOpen && (
          <div class="mention-menu">
            {mentionItems.map((it, i) => (
              <button
                key={it.insert + i}
                class={`mention-item ${i === mentionIndex ? 'active' : ''}`}
                title={it.secondary}
                onMouseEnter={() => setMentionIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus in the editor
                  insertMention(it.insert);
                }}
              >
                <span class="mention-title">{it.primary}</span>
                <span class="mention-url">{it.secondary}</span>
              </button>
            ))}
          </div>
        )}
        <div
          ref={editorRef}
          class="chat-input"
          data-testid="chat-input"
          contentEditable={!disabled}
          role="textbox"
          aria-multiline="true"
          data-placeholder={disabled ? tr('chat.placeholderDisabled') : tr('chat.placeholder')}
          onInput={() => {
            // Keep :empty true when only a stray <br> remains, so the placeholder shows.
            if (editorRef.current && !getEditorText().trim()) editorRef.current.innerHTML = '';
            syncText();
            updateMention();
          }}
          onKeyUp={() => updateMention()}
          onMouseUp={() => updateMention()}
          onPaste={(e) => {
            // A pasted email (copied from Outlook — the reliable path on Mac,
            // where dragging into a side panel is blocked) opens the uploader
            // instead of dumping the message text into the composer.
            if (clipboardIsEmail(e.clipboardData)) {
              const items = captureDrop(e.clipboardData);
              if (items.length) {
                e.preventDefault();
                setDropItems(items);
                return;
              }
            }
            // Otherwise plain-text paste only — no foreign formatting in the editor.
            e.preventDefault();
            const pasted = e.clipboardData?.getData('text/plain') ?? '';
            document.execCommand('insertText', false, pasted);
          }}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % mentionItems.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertMention(mentionItems[mentionIndex].insert);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMention(null);
                setMentionItems([]);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {micError && (
          <div class="banner banner-error mic-error">
            <span>{micError}</span>
            <button class="btn btn-small" onClick={openMicPermission}>
              Enable microphone
            </button>
          </div>
        )}
        <div class="chat-buttons">
          <button class="btn btn-primary" data-testid="send" onClick={submit} disabled={disabled || busy || !text.trim()}>
            {tr('chat.send')}
          </button>
          <button
            class="btn attach-btn"
            data-testid="attach"
            title={tr('repos.upload.attach')}
            aria-label={tr('repos.upload.attach')}
            onClick={() => attachInputRef.current?.click()}
            disabled={disabled}
          >
            📎
          </button>
          <input
            ref={attachInputRef}
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            data-testid="attach-input"
            style="display:none"
            onChange={(e) => {
              const fl = (e.target as HTMLInputElement).files;
              queueFiles(Array.from(fl ?? []));
              (e.target as HTMLInputElement).value = '';
            }}
          />
          {hasTranscription && (
            <button
              class={`btn mic-btn${micState === 'recording' ? ' mic-recording' : ''}`}
              title={
                micState === 'recording'
                  ? 'Stop recording and transcribe'
                  : micState === 'transcribing'
                    ? 'Transcribing…'
                    : 'Record a voice prompt'
              }
              onClick={toggleMic}
              disabled={disabled || busy || micState === 'transcribing'}
            >
              {micState === 'recording' ? '● Stop' : micState === 'transcribing' ? '…' : '🎤'}
            </button>
          )}
          {status === 'paused' ? (
            <button class="btn" onClick={() => send({ type: 'resume_agent' })}>
              Resume
            </button>
          ) : (
            <button class="btn" onClick={() => send({ type: 'pause_agent' })} disabled={!busy}>
              {tr('chat.pause')}
            </button>
          )}
          <button class="btn" onClick={() => send({ type: 'stop_task' })} disabled={status === 'idle'}>
            {tr('chat.stop')}
          </button>
        </div>
      </div>
    </div>
  );
}
