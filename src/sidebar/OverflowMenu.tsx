// Header overflow ("More") menu — collects the less-frequent header actions so
// the brand title survives the ~360–400px side-panel width instead of being
// crushed to "CAN…" by seven inline controls.
//
// Mac-toolbar-style popover with real menu semantics: the trigger is a
// aria-haspopup button; the popover is role="menu" with roving focus
// (Arrow/Home/End), Escape/Tab and click-outside dismiss, and focus returned to
// the trigger on close. An optional `embedded` slot renders non-menuitem
// controls (the text-scale segmented control) above the items; clicks there
// deliberately do NOT close the menu, so "A+ A+ A+" works in one visit.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export interface OverflowItem {
  id: string;
  label: string;
  icon?: ComponentChildren;
  disabled?: boolean;
  /** Render highlighted while active. */
  active?: boolean;
  onSelect: () => void;
}

export function OverflowMenu({
  label,
  items,
  embedded,
}: {
  label: string;
  items: OverflowItem[];
  embedded?: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  // Click-outside dismiss (mousedown so it wins over focus juggling).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Focus the first enabled item when the menu opens.
  useEffect(() => {
    if (open) enabledItems()[0]?.focus();
  }, [open]);

  const enabledItems = (): HTMLButtonElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  const onMenuKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      close(false);
      return;
    }
    const focusables = enabledItems();
    if (focusables.length === 0) return;
    const idx = focusables.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusables[(idx + 1) % focusables.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusables[(idx - 1 + focusables.length) % focusables.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusables[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      focusables[focusables.length - 1]?.focus();
    }
  };

  return (
    <div class="overflow-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        class={`icon-btn${open ? ' icon-btn-active' : ''}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>

      {open && (
        <div class="overflow-pop" role="menu" aria-label={label} ref={menuRef} onKeyDown={onMenuKeyDown}>
          {embedded && (
            <>
              <div class="overflow-embedded" role="none">
                {embedded}
              </div>
              <div class="overflow-sep" role="separator" />
            </>
          )}
          {items.map((item) => (
            <button
              key={item.id}
              role="menuitem"
              class={`overflow-item${item.active ? ' is-active' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                item.onSelect();
                close();
              }}
            >
              {item.icon && (
                <span class="overflow-item-icon" aria-hidden="true">
                  {item.icon}
                </span>
              )}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
