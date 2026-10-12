import type { ComponentChildren } from 'preact';

export interface Action {
  label: string;
  onPick: () => void;
  tone?: 'danger' | 'primary';
  disabled?: boolean;
}

/** Bottom action sheet: large buttons, one tap each. */
export function Sheet({
  title,
  subtitle,
  actions,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  actions: Action[];
  onClose: () => void;
  children?: ComponentChildren;
}) {
  return (
    <div class="overlay" onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <div class="sheet-title">{title}</div>
          {subtitle && <div class="sheet-sub">{subtitle}</div>}
        </div>
        {children}
        <div class="sheet-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              class={`sheet-btn ${a.tone ?? ''}`}
              disabled={a.disabled}
              onClick={() => {
                a.onPick();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
        <button class="sheet-btn cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Centered modal for lists and card reading. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  return (
    <div class="overlay" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <div class="sheet-title">{title}</div>
          <button class="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}
