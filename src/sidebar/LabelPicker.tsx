// =============================================================================
// Reusable label popover for the History overlay. One surface does double duty:
//   - toggling which labels are *checked* (the meaning — filter vs assignment —
//     is the caller's; we just report toggles), and
//   - managing the label *registry* (create / rename / recolour / delete).
// The caller mounts it inside a `position:relative` wrapper next to its trigger
// button and controls visibility; we handle outside-click / Esc dismissal.
// =============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_LABEL_COLOR, LABEL_COLORS, labelColorClass } from '../shared/labelColors';
import type { ConversationLabel } from '../shared/types';
import { useT } from './i18n';

interface Props {
  labels: ConversationLabel[];
  /** Ids currently checked (selected filters, or labels on the target conversation). */
  selected: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
  /** Registry mutations — shared across every place the picker appears. */
  onCreate: (name: string, color: string) => void;
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  onDelete: (label: ConversationLabel) => void;
  /** Optional extra action shown in the header (filter mode passes "Clear"). */
  clearLabel?: string;
  onClear?: () => void;
}

function Swatches({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div class="label-swatches">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          class={`label-swatch ${labelColorClass(c)} ${c === value ? 'is-picked' : ''}`}
          title={c}
          aria-label={c}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

export function LabelPicker({
  labels,
  selected,
  onToggle,
  onClose,
  onCreate,
  onRename,
  onRecolor,
  onDelete,
  clearLabel,
  onClear,
}: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(DEFAULT_LABEL_COLOR);

  // Position as a viewport-fixed popover anchored to the trigger (the wrapper
  // that holds it). This escapes the History card's `overflow:auto` clipping —
  // a plain absolutely-positioned panel gets cut off, especially on rows where
  // label chips push the tag button toward the edge (see clipping bug). We clamp
  // to the viewport on both axes and flip upward when there's no room below.
  useLayoutEffect(() => {
    const el = ref.current;
    const trigger = el?.parentElement;
    if (!el || !trigger) return;
    const place = () => {
      const r = trigger.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const m = 8; // viewport margin
      let left = Math.min(r.left, window.innerWidth - w - m);
      if (left < m) left = m;
      let top = r.bottom + 6;
      if (top + h > window.innerHeight - m) {
        const above = r.top - h - 6;
        top = above >= m ? above : Math.max(m, window.innerHeight - h - m);
      }
      el.style.position = 'fixed';
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.style.right = 'auto';
    };
    place();
    // Track the trigger if anything scrolls (capture catches the card's scroll).
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, []);

  // Dismiss on outside click or Esc. The boundary is the *wrapper* (which holds
  // both the trigger button and this panel), so clicking the trigger to close
  // doesn't first fire an outside-close that the trigger then re-opens.
  useEffect(() => {
    const trigger = ref.current?.parentElement?.querySelector<HTMLButtonElement>('button');
    ref.current?.querySelector<HTMLElement>('button, input')?.focus();
    const onDown = (e: MouseEvent) => {
      const boundary = ref.current?.parentElement ?? ref.current;
      if (boundary && !boundary.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  const startEdit = (l: ConversationLabel) => {
    setEditing(l.id);
    setDraftName(l.name);
  };
  const commitRename = (id: string) => {
    const name = draftName.trim();
    if (name) onRename(id, name);
    setEditing(null);
  };
  const create = () => {
    const name = newName.trim();
    if (!name) return;
    onCreate(name, newColor);
    setNewName('');
    setNewColor(DEFAULT_LABEL_COLOR);
  };

  return (
    <div class="label-picker" ref={ref} role="dialog" aria-label={t('conversations.labels')}>
      <div class="label-picker-head">
        <span class="label-picker-title">{t('conversations.labels')}</span>
        {clearLabel && onClear && (
          <button type="button" class="label-link" onClick={onClear}>
            {clearLabel}
          </button>
        )}
      </div>

      {labels.length === 0 ? (
        <p class="label-picker-empty">{t('conversations.noLabels')}</p>
      ) : (
        <ul class="label-picker-list">
          {labels.map((l) => (
            <li key={l.id} class="label-picker-row">
              {editing === l.id ? (
                <div class="label-editor">
                  <input
                    class="label-input"
                    value={draftName}
                    autoFocus
                    onInput={(e) => setDraftName((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(l.id);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                  <Swatches value={l.color} onPick={(c) => onRecolor(l.id, c)} />
                  <div class="label-editor-actions">
                    <button type="button" class="btn btn-small" onClick={() => commitRename(l.id)}>
                      {t('conversations.renameLabel')}
                    </button>
                    <button
                      type="button"
                      class="btn btn-small"
                      onClick={() => {
                        if (confirm(t('conversations.confirmDeleteLabel', { name: l.name }))) {
                          onDelete(l);
                          setEditing(null);
                        }
                      }}
                    >
                      {t('conversations.deleteLabel')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    class={`label-toggle ${selected.includes(l.id) ? 'is-on' : ''}`}
                    onClick={() => onToggle(l.id)}
                  >
                    <span class="label-check">{selected.includes(l.id) ? '✓' : ''}</span>
                    <span class={`conv-label-chip ${labelColorClass(l.color)}`}>{l.name}</span>
                  </button>
                  <button
                    type="button"
                    class="icon-btn label-edit"
                    title={t('conversations.renameLabel')}
                    aria-label={t('conversations.renameLabel')}
                    onClick={() => startEdit(l)}
                  >
                    ✎
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div class="label-create">
        <input
          class="label-input"
          placeholder={t('conversations.labelNamePlaceholder')}
          value={newName}
          onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
        />
        <Swatches value={newColor} onPick={setNewColor} />
        <button type="button" class="btn btn-small" disabled={!newName.trim()} onClick={create}>
          {t('conversations.addLabel')}
        </button>
      </div>
    </div>
  );
}
