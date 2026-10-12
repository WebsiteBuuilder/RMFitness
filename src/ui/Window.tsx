import type { ComponentChildren } from 'preact';

/** A GBA-style dialogue window. */
export function Win({ title, children, class: cls = '', onClose }: { title?: string; children: ComponentChildren; class?: string; onClose?: () => void }) {
  return (
    <div class={`win ${cls}`}>
      {title && (
        <div class="win-title">
          <span>{title}</span>
          {onClose && (
            <button class="win-x" onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </div>
      )}
      <div class="win-body">{children}</div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  onPick?: () => void;
  disabled?: boolean;
  note?: string;
  selected?: boolean;
}

/** Vertical command list with the blinking cursor arrow. */
export function Menu({ items, class: cls = '' }: { items: MenuItem[]; class?: string }) {
  return (
    <ul class={`menu ${cls}`}>
      {items.map((it) => (
        <li key={it.label}>
          <button class={`menu-item ${it.disabled ? 'off' : ''} ${it.selected ? 'sel' : ''}`} disabled={it.disabled} onClick={it.onPick}>
            <span class="cursor">▶</span>
            <span class="menu-label">{it.label}</span>
            {it.note && <span class="menu-note">{it.note}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Full-screen overlay holding a window. */
export function Overlay({ children, onClose }: { children: ComponentChildren; onClose?: () => void }) {
  return (
    <div class="overlay" onClick={onClose}>
      <div class="overlay-inner" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
