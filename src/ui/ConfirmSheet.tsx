// In-game confirmation sheet, used in place of the browser's confirm()/alert()/prompt().
// Two looks: a GBA dialogue window for Eternal Duelist Soul screens and a Master
// Duel-style bottom sheet for Speed Duel screens.
import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import './sheets.css';

export type SheetLook = 'gba' | 'md';

/** How long Confirm stays locked after the sheet opens, so a double tap can't go straight through. */
const ARM_MS = 450;

let nextId = 0;

export function ConfirmSheet({
  look,
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: {
  look: SheetLook;
  title: string;
  children?: ComponentChildren;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Confirm gives something up (surrender, a loss): shown in red */
  danger?: boolean;
  /** leave out for a sheet with one button (Cancel becomes its only button) */
  onConfirm?: () => void;
  onCancel: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const [id] = useState(() => `csheet-${++nextId}`);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    cancelBtn.current?.focus({ preventScroll: true });
    const t = window.setTimeout(() => setArmed(true), ARM_MS);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      } else if (ev.key === 'Tab' && box.current) {
        // keep focus inside the sheet
        const items = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), input, [tabindex="0"]')];
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = ev.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
        ev.preventDefault();
        items[next].focus();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', key, true);
      before?.focus?.({ preventScroll: true });
    };
  }, []);

  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  const confirm = () => {
    if (!armed || done.current || !onConfirm) return;
    done.current = true;
    onConfirm();
  };

  const buttons = (
    <div class="csheet-btns">
      <button ref={cancelBtn} type="button" class={look === 'gba' ? 'gbtn csheet-cancel' : 'csheet-b cancel'} onClick={cancel}>
        {cancelLabel}
      </button>
      {onConfirm && (
        <button type="button" class={`${look === 'gba' ? 'gbtn csheet-ok' : 'csheet-b ok'} ${danger ? 'danger' : ''} ${armed ? '' : 'arming'}`} aria-disabled={!armed} onClick={confirm}>
          {confirmLabel}
        </button>
      )}
    </div>
  );

  const sheet = (
    <div class={`csheet-back ${look}`} onClick={cancel}>
      <div ref={box} class={look === 'gba' ? 'win csheet-win' : 'csheet-md'} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={children ? `${id}-d` : undefined} onClick={(ev) => ev.stopPropagation()}>
        {look === 'gba' ? (
          <>
            <div class="win-title">
              <span id={`${id}-t`}>{title}</span>
            </div>
            <div class="win-body">
              {children && (
                <div id={`${id}-d`} class="csheet-text">
                  {children}
                </div>
              )}
              {buttons}
            </div>
          </>
        ) : (
          <>
            <div id={`${id}-t`} class="csheet-title">
              {title}
            </div>
            {children && (
              <div id={`${id}-d`} class="csheet-text">
                {children}
              </div>
            )}
            {buttons}
          </>
        )}
      </div>
    </div>
  );
  return createPortal(sheet, document.body);
}
