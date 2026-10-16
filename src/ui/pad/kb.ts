// An on-screen keyboard for controller players: a phone often won't raise its own keyboard
// for a controller press, and a pad-only player has no fingers on the glass anyway.
// pad.ts opens it on A over a text box; the keys are plain buttons, so the ring moves over them.

const ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl-', 'zxcvbnm_.@'];

let root: HTMLDivElement | null = null;
let target: HTMLInputElement | HTMLTextAreaElement | null = null;
let upper = false;
let done: (() => void) | null = null;

export const kbOpen = () => !!root?.isConnected;
export const kbTarget = () => target;

function setValue(v: string) {
  if (!target) return;
  const max = target.maxLength > 0 ? target.maxLength : Infinity;
  v = v.slice(0, max);
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, v);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  draw();
}

function draw() {
  if (!root || !target) return;
  const shown = root.querySelector<HTMLElement>('.pad-kb-val')!;
  const v = target.value;
  shown.textContent = v ? (target.type === 'password' ? '•'.repeat(v.length) : v) : target.placeholder || ' ';
  shown.classList.toggle('empty', !v);
  for (const k of root.querySelectorAll<HTMLButtonElement>('.pad-kb-key[data-k]')) {
    const c = k.dataset.k!;
    k.textContent = upper ? c.toUpperCase() : c;
  }
  root.querySelector('.pad-kb-shift')?.classList.toggle('on', upper);
}

/** what X, Y and Start do while it is open */
export function kbAction(a: 'del' | 'shift' | 'space' | 'done') {
  if (!target) return;
  if (a === 'del') setValue(target.value.slice(0, -1));
  else if (a === 'space') setValue(target.value + ' ');
  else if (a === 'shift') (upper = !upper), draw();
  else closeKb();
}

export function closeKb() {
  root?.remove();
  root = null;
  const d = done;
  done = null;
  d?.();
  target = null;
}

export function openKb(el: HTMLInputElement | HTMLTextAreaElement, onClose: () => void) {
  closeKb();
  target = el;
  done = onClose;
  // a code box (all capitals) starts in capitals
  upper = el.getAttribute('autocapitalize') === 'characters' || /code/i.test(el.placeholder);
  const numeric = el.type === 'number' || el.inputMode === 'numeric';
  root = document.createElement('div');
  root.className = 'pad-kb';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Keyboard');
  const rows = (numeric ? ['123', '456', '789', '0'] : ROWS)
    .map((r, i) => `<div class="pad-kb-row">${[...r].map((c, j) => `<button type="button" class="pad-kb-key" data-k="${c}"${i === (numeric ? 0 : 1) && j === 0 ? ' autofocus' : ''}>${c}</button>`).join('')}</div>`)
    .join('');
  root.innerHTML =
    // (a fixed first line: pad.ts tells a sheet's new question by its first line, and typing isn't one)
    `<div class="pad-kb-head">${el.type === 'password' ? 'Password' : el.placeholder || el.getAttribute('aria-label') || 'Type'}</div><div class="pad-kb-val"></div>${rows}` +
    `<div class="pad-kb-row">` +
    (numeric ? '' : `<button type="button" class="pad-kb-key pad-kb-shift wide" data-a="shift">⇧ Caps</button><button type="button" class="pad-kb-key wide2" data-a="space">Space</button>`) +
    `<button type="button" class="pad-kb-key wide" data-a="del">⌫</button><button type="button" class="pad-kb-key pad-kb-done wide" data-a="done">Done</button></div>`;
  root.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('.pad-kb-key');
    if (!b || !target) return;
    if (b.dataset.k) setValue(target.value + (upper ? b.dataset.k.toUpperCase() : b.dataset.k));
    else kbAction(b.dataset.a as 'del' | 'shift' | 'space' | 'done');
  });
  // (taps on it never fall through to the screen under it)
  root.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  document.body.appendChild(root);
  draw();
}
