// =============================================================================
// History overlay — lists conversations the runtime auto-saves to local storage
// and lets the user reopen ("Continue"), export, delete, and organize them with
// colored labels.
//
// The list is read straight from `ba_conv_index` (mirroring how SettingsScreen
// reads `ba_settings`), with a storage subscription so it refreshes live as the
// agent autosaves. The label *registry* (`ba_conv_labels`) is likewise read and
// edited directly — the agent loop never touches it, so there's no race. Per-
// conversation actions (Continue/Delete/label assignment) are runtime mutations,
// so they go through the Port via `send`; assignment in particular is routed
// there so it can't clobber the active conversation's autosave.
// =============================================================================

import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  CONVERSATION_FILE,
  parseConversationFile,
  parseConversationLabels,
  slugifyTitle,
} from '../shared/conversationMeta';
import { labelColorClass } from '../shared/labelColors';
import { visibleToProject } from '../shared/memoryGraph';
import type { SidebarCommand } from '../shared/messages';
import type { ConversationLabel, ConversationSummary } from '../shared/types';
import { getConversation, getConversationIndex } from '../background/storage';
import { downloadBlob, exportConversationHtml } from './conversationExport';
import { useT } from './i18n';
import { LabelPicker } from './LabelPicker';
import { useModalFocus } from './useModalFocus';

const INDEX_KEY = 'ba_conv_index';
const LABELS_KEY = 'ba_conv_labels';

const svgProps = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
};
const IconSave = () => (
  <svg {...svgProps}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);
const IconExport = () => (
  <svg {...svgProps}>
    <path d="M14 3h7v7" />
    <path d="M10 14 21 3" />
    <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
  </svg>
);
const IconTrash = () => (
  <svg {...svgProps}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="m6 7 1 13h10l1-13" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);
const IconTag = () => (
  <svg {...svgProps}>
    <path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h8z" />
    <circle cx="7.5" cy="7.5" r="1.3" />
  </svg>
);

interface Props {
  send: (command: SidebarCommand) => void;
  onClose: () => void;
}

export function ConversationsScreen({ send, onClose }: Props) {
  const t = useT();
  const dialogRef = useModalFocus<HTMLDivElement>(onClose);
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [labels, setLabels] = useState<ConversationLabel[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState<string[]>([]); // selected label ids (OR)
  const [filterOpen, setFilterOpen] = useState(false);
  const [assignFor, setAssignFor] = useState<string | null>(null); // conversation id
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'oldest'>('recent');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  // Read the index + label registry + active project now and re-read whenever the
  // runtime (or this screen, or the Workspace Projects page) rewrites any of them,
  // so the list and chips stay live.
  useEffect(() => {
    const load = () => {
      // Titles/previews are decrypted here via getConversationIndex (they are
      // stored encrypted when a vault is active; a locked vault yields "🔒 Locked"
      // placeholders). Labels and the active project are plaintext structural data.
      void getConversationIndex().then((index) =>
        setItems([...index].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
      );
      void chrome.storage.local.get([LABELS_KEY, 'ba_active_project']).then((r) => {
        setLabels(Array.isArray(r[LABELS_KEY]) ? (r[LABELS_KEY] as ConversationLabel[]) : []);
        const active = r.ba_active_project;
        setActiveProjectId(typeof active === 'string' && active ? active : null);
      });
    };
    void load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (changes[INDEX_KEY] || changes[LABELS_KEY] || changes.ba_active_project)) void load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const labelById = useMemo(() => {
    const m = new Map<string, ConversationLabel>();
    for (const l of labels) m.set(l.id, l);
    return m;
  }, [labels]);

  // Filter by label (OR semantics) and free-text query (title + preview), then
  // sort by recency. `items` already arrives newest-first.
  const visible = useMemo(() => {
    const want = new Set(filter);
    const q = query.trim().toLowerCase();
    const filtered = items.filter((c) => {
      if (!visibleToProject(c.projectId, activeProjectId)) return false;
      if (filter.length > 0 && !(c.labels ?? []).some((id) => want.has(id))) return false;
      if (q && !`${c.title} ${c.summary ?? ''} ${c.preview}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return sort === 'oldest' ? [...filtered].reverse() : filtered;
  }, [items, filter, query, sort, activeProjectId]);

  // --- label registry mutations (direct storage writes) ----------------------
  const persistLabels = (next: ConversationLabel[]) => {
    setLabels(next);
    void chrome.storage.local.set({ [LABELS_KEY]: next });
  };
  const createLabel = (name: string, color: string) =>
    persistLabels([...labels, { id: crypto.randomUUID(), name, color }]);
  const renameLabel = (id: string, name: string) =>
    persistLabels(labels.map((l) => (l.id === id ? { ...l, name } : l)));
  const recolorLabel = (id: string, color: string) =>
    persistLabels(labels.map((l) => (l.id === id ? { ...l, color } : l)));
  const deleteLabel = (label: ConversationLabel) => {
    persistLabels(labels.filter((l) => l.id !== label.id));
    setFilter((f) => f.filter((id) => id !== label.id));
    // Strip the deleted label from every conversation that carried it.
    for (const c of items) {
      if ((c.labels ?? []).includes(label.id)) {
        send({ type: 'set_conversation_labels', id: c.id, labels: (c.labels ?? []).filter((x) => x !== label.id) });
      }
    }
  };

  // --- per-conversation assignment (routed through the runtime) ---------------
  const toggleAssign = (conv: ConversationSummary, labelId: string) => {
    const current = conv.labels ?? [];
    const next = current.includes(labelId)
      ? current.filter((x) => x !== labelId)
      : [...current, labelId];
    send({ type: 'set_conversation_labels', id: conv.id, labels: next });
  };

  const toggleFilter = (id: string) =>
    setFilter((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));

  const continueConversation = (id: string) => {
    send({ type: 'load_conversation', id });
    onClose();
  };

  const remove = (item: ConversationSummary) => {
    const title = item.title || t('conversations.untitled');
    if (!confirm(t('conversations.confirmDelete', { title }))) return;
    send({ type: 'delete_conversation', id: item.id });
  };

  const exportOne = async (id: string) => {
    // getConversation decrypts vault-encrypted bodies (null if the vault is locked).
    const body = await getConversation(id);
    if (body?.messages?.length) exportConversationHtml(body.messages);
    else if (!body) setNotice({ ok: false, text: 'Unavailable — unlock the encryption vault to open this conversation.' });
  };

  // Save one conversation to a portable, re-importable JSON file. Bundle the
  // definitions of any labels it carries so they re-register on import elsewhere.
  const saveOne = async (item: ConversationSummary) => {
    const body = await getConversation(item.id);
    if (!body) {
      setNotice({ ok: false, text: 'Unavailable — unlock the encryption vault to open this conversation.' });
      return;
    }
    const defs = (item.labels ?? [])
      .map((id) => labelById.get(id))
      .filter((l): l is ConversationLabel => !!l);
    const file = JSON.stringify({ ...CONVERSATION_FILE, conversation: body, labels: defs });
    downloadBlob(file, 'application/json', `canchat-agent-conversation-${slugifyTitle(item.title)}.json`);
  };

  // Load a conversation file: validate, then hand the body (and any bundled label
  // definitions) to the runtime, which stores it and opens it on screen.
  const loadFromFile = async (file: File) => {
    setNotice(null);
    const text = await file.text();
    const body = parseConversationFile(text);
    if (!body) {
      setNotice({ ok: false, text: t('conversations.importError') });
      return;
    }
    send({ type: 'import_conversation', record: body, labels: parseConversationLabels(text) });
    onClose();
  };

  const clearAll = () => {
    if (items.length === 0) return;
    if (!confirm(t('conversations.confirmClearAll', { n: String(items.length) }))) return;
    send({ type: 'clear_conversations' });
  };

  const sharedPickerProps = {
    labels,
    onCreate: createLabel,
    onRename: renameLabel,
    onRecolor: recolorLabel,
    onDelete: deleteLabel,
  };

  return (
    <div class="settings-overlay">
      <div
        ref={dialogRef}
        class="settings-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversation-history-title"
        tabIndex={-1}
      >
        <div class="settings-header">
          <strong id="conversation-history-title">{t('conversations.title')}</strong>
          <button class="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>

        <div class="settings-actions">
          <div class="label-filter">
            <button
              class={`btn ${filter.length > 0 ? 'btn-primary' : ''}`}
              onClick={() => setFilterOpen((v) => !v)}
            >
              <IconTag /> {t('conversations.labels')}
              {filter.length > 0 ? ` (${filter.length})` : ''}
            </button>
            {filterOpen && (
              <LabelPicker
                {...sharedPickerProps}
                selected={filter}
                onToggle={toggleFilter}
                onClose={() => setFilterOpen(false)}
                clearLabel={filter.length > 0 ? t('conversations.clearFilter') : undefined}
                onClear={() => setFilter([])}
              />
            )}
          </div>
          <label class="btn">
            {t('conversations.load')}
            <input
              type="file"
              accept="application/json,.json"
              style="display:none"
              onChange={(e) => {
                const input = e.target as HTMLInputElement;
                const f = input.files?.[0];
                if (f) void loadFromFile(f);
                input.value = '';
              }}
            />
          </label>
          <button class="btn" disabled={items.length === 0} onClick={clearAll}>
            {t('conversations.clearAll')}
          </button>
        </div>

        {items.length > 0 && (
          <div class="conv-search-row">
            <input
              class="conv-search"
              type="search"
              placeholder={t('conversations.search')}
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
            <select
              class="conv-sort"
              value={sort}
              onChange={(e) => setSort((e.target as HTMLSelectElement).value as 'recent' | 'oldest')}
            >
              <option value="recent">{t('conversations.sortRecent')}</option>
              <option value="oldest">{t('conversations.sortOldest')}</option>
            </select>
          </div>
        )}

        {filter.length > 0 && (
          <div class="filter-chips">
            {filter.map((id) => {
              const l = labelById.get(id);
              if (!l) return null;
              return (
                <button
                  key={id}
                  class={`conv-label-chip is-removable ${labelColorClass(l.color)}`}
                  onClick={() => toggleFilter(id)}
                  title={t('conversations.clearFilter')}
                >
                  {l.name} ✕
                </button>
              );
            })}
          </div>
        )}

        {notice && <div class={`banner ${notice.ok ? 'banner-ok' : 'banner-error'}`}>{notice.text}</div>}

        {items.length === 0 ? (
          <p class="settings-note">{t('conversations.empty')}</p>
        ) : visible.length === 0 ? (
          <p class="settings-note">
            {query.trim() ? t('conversations.noSearchMatches') : t('conversations.noMatches')}
          </p>
        ) : (
          <ul class="conv-list">
            {visible.map((item) => (
              <li class="conv-item" key={item.id}>
                <button class="conv-body" onClick={() => continueConversation(item.id)}>
                  <span class="conv-title">{item.title || t('conversations.untitled')}</span>
                  <span class="conv-sub">
                    {new Date(item.updatedAt).toLocaleString()} ·{' '}
                    {t('conversations.messageCount', { n: String(item.messageCount) })}
                  </span>
                  {(item.summary || item.preview) && (
                    <span class="conv-preview">{item.summary || item.preview}</span>
                  )}
                </button>

                <div class="conv-labels-row">
                  {(item.labels ?? []).map((id) => {
                    const l = labelById.get(id);
                    if (!l) return null;
                    return (
                      <span key={id} class={`conv-label-chip ${labelColorClass(l.color)}`}>
                        {l.name}
                      </span>
                    );
                  })}
                  <div class="label-assign">
                    <button
                      class="icon-btn conv-tag-btn"
                      title={t('conversations.assignLabels')}
                      aria-label={t('conversations.assignLabels')}
                      onClick={() => setAssignFor((id) => (id === item.id ? null : item.id))}
                    >
                      <IconTag />
                    </button>
                    {assignFor === item.id && (
                      <LabelPicker
                        {...sharedPickerProps}
                        selected={item.labels ?? []}
                        onToggle={(labelId) => toggleAssign(item, labelId)}
                        onClose={() => setAssignFor(null)}
                      />
                    )}
                  </div>
                </div>

                <div class="conv-actions">
                  <button class="btn btn-primary btn-small" onClick={() => continueConversation(item.id)}>
                    {t('conversations.continue')}
                  </button>
                  <span class="conv-actions-spacer" />
                  <button
                    class="icon-btn"
                    title={t('conversations.save')}
                    aria-label={t('conversations.save')}
                    onClick={() => void saveOne(item)}
                  >
                    <IconSave />
                  </button>
                  <button
                    class="icon-btn"
                    title={t('conversations.export')}
                    aria-label={t('conversations.export')}
                    onClick={() => void exportOne(item.id)}
                  >
                    <IconExport />
                  </button>
                  <button
                    class="icon-btn"
                    title={t('conversations.delete')}
                    aria-label={t('conversations.delete')}
                    onClick={() => remove(item)}
                  >
                    <IconTrash />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
