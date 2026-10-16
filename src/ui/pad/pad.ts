// Controller support for every screen: any pad the browser sees (Xbox, PlayStation,
// Switch Pro and Joy-Con, Backbone/Kishi phone grips, plain Bluetooth pads) and a
// keyboard's arrow keys. The d-pad or left stick moves a gold focus ring between the
// things you could tap; A taps it, B goes back. Touch keeps working the whole time:
// a tap hides the ring, the next button press brings it back where you tapped.
//
// It works on the page itself, not inside each screen: whatever a finger can tap, the
// ring can reach (see ./registry for how tappable elements are found).
import { tappable } from './registry';
import { readPad, familyOf, glyph, familyName, type Btn, type Family, type PadLike } from './map';
import { pickNext, nearest, type Dir, type Box } from './nav';
import { pressBack } from '../backButton';
import { rumble } from './rumble';
import './pad.css';

const NATIVE = 'button:not([disabled]), a[href], input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role=button], [role=tab], [tabindex]:not([tabindex="-1"]), summary';
const TEXT = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea, select';
/** A sheet, menu or window that opens over the screen: focus jumps into it. */
const LAYER = '.overlay, [role=dialog], [role=alertdialog], .csheet-back, .tsheet, .tactions, .tphase-menu, .ttoast.aim, .tresult, .sheet, .so-sheet, .sr-sheet, .lv-sheet, .tb-sheet';
const PRIMARY = '[autofocus], .tbtn.main, .taction.main, .csheet-ok, .primary, .main, .ok';
const CLOSE = '.win-x, [aria-label="Close"], [aria-label="Back"], [data-pad-back]';
const EMPTY_ZONE = '.duel .tz.empty:not(.pick):not(.drop-ok), .duel .zone.empty:not(.pick)';
const HAND = '.thcard, .hand .card, .hand [data-uid]';
const TABS = '[role=tablist], .sdh-tabs, .tabs, .so-tabs, .rank-tabs, .fr-tabs';
const ON = /(^|\s)(on|active|sel|selected|cur|current)(\s|$)/;

const REPEAT_FIRST = 320;
const REPEAT_NEXT = 95;

let focused: Element | null = null;
let lastX = innerWidth / 2;
let lastY = innerHeight / 2;
/** the ring and hints show (a controller or arrow key was used since the last touch) */
let on = false;
let family: Family = 'generic';
let ring: HTMLDivElement;
let hints: HTMLDivElement;
let toast: HTMLDivElement;
let hintKey = '';
let guide = false;
const prev = new Map<number, Set<Btn>>();
const downAt = new Map<Btn, number>();
const repeatAt = new Map<Btn, number>();
let held = new Set<Btn>();
let padUsedAt = -1e9;
let loop = 0;
let lastScan = 0;
const layerTries = new WeakMap<Element, number>();
const layerSig = new WeakMap<Element, string>();
/** the ring has been on your hand since this duel began */
let handSeen = false;
let cameFrom: { el: Element; x: number; y: number } | null = null;
let artHeld = false;
let hintsAt = 0;
let hintsFrom = 0;

// ---------- what can be reached ----------

function rectOf(el: Element): Box & { width: number; height: number } {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

function scrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if ((/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 2) || (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 2)) return p;
  }
  const d = document.scrollingElement as HTMLElement | null;
  return d && d.scrollHeight > innerHeight + 2 ? d : null;
}

const PTS = [
  [0.5, 0.5],
  [0.2, 0.5],
  [0.8, 0.5],
  [0.5, 0.2],
  [0.5, 0.8],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.2, 0.8],
  [0.8, 0.8],
];

/** Some part of it can be seen and tapped (nothing covers it), or it is scrolled out of view in a list that can be. */
function reachable(el: Element, r: ReturnType<typeof rectOf>): boolean {
  if (r.width < 6 || r.height < 6) return false;
  let anyOn = false;
  for (const [px, py] of PTS) {
    const x = r.left + r.width * px;
    const y = r.top + r.height * py;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    anyOn = true;
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === el || el.contains(hit))) return true;
  }
  if (anyOn) return false;
  // scrolled out of view: fine if the list it is in can be seen
  const sc = scrollParent(el);
  if (!sc) return false;
  if (sc === document.scrollingElement) return getComputedStyle(el).visibility !== 'hidden';
  const s = rectOf(sc);
  const x = Math.min(Math.max(r.left + r.width / 2, s.left + 2, 1), Math.min(s.right, innerWidth) - 2);
  const y = Math.min(Math.max(r.top + r.height / 2, s.top + 2, 1), Math.min(s.bottom, innerHeight) - 2);
  const hit = document.elementFromPoint(x, y);
  return !!hit && sc.contains(hit);
}

interface Cand {
  el: Element;
  box: ReturnType<typeof rectOf>;
}

/** Everything the ring can land on right now. */
function candidates(): Cand[] {
  const all = new Set<Element>(document.querySelectorAll(NATIVE));
  for (const el of tappable()) all.add(el);
  all.delete(document.body);
  all.delete(document.documentElement);
  const area = innerWidth * innerHeight;
  const boxes = new Map<Element, ReturnType<typeof rectOf>>();
  const big: Cand[] = [];
  for (const el of all) {
    if ((el as HTMLElement).closest?.('[data-pad-skip], .pad-ui')) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    // an empty zone on the board is only a stop while it can be picked
    if (el.matches(EMPTY_ZONE)) continue;
    const box = rectOf(el);
    if (!reachable(el, box)) continue;
    // a whole board or backdrop that takes taps isn't a button (unless it's all there is: "tap to start")
    if (box.width * box.height > area * 0.55 && el.tagName !== 'BUTTON' && el.tagName !== 'A') big.push({ el, box });
    else boxes.set(el, box);
  }
  if (!boxes.size) return big.slice(-1);
  // A tappable panel with buttons inside: the buttons are the stops, not the panel.
  const outer = new Set<Element>();
  for (const el of boxes.keys()) for (let p = el.parentElement; p; p = p.parentElement) if (boxes.has(p)) outer.add(p);
  const out: Cand[] = [];
  for (const [el, box] of boxes) if (!outer.has(el) || el.tagName === 'BUTTON' || el.tagName === 'A') out.push({ el, box });
  return out;
}

// ---------- the ring ----------

function setFocus(el: Element | null, scroll = true) {
  if (focused && focused !== el) focused.classList.remove('pad-focus');
  focused = el;
  if (!el) return;
  el.classList.add('pad-focus');
  if (el.matches(HAND)) handSeen = true;
  if (scroll) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const r = el.getBoundingClientRect();
  lastX = r.left + r.width / 2;
  lastY = r.top + r.height / 2;
  // a text box keeps its keyboard closed until A
  const ae = document.activeElement as HTMLElement | null;
  if (ae && ae !== el && ae.matches?.(TEXT)) ae.blur();
  drawRing();
}

function drawRing() {
  if (!ring) return;
  if (!on || !focused || !focused.isConnected) {
    ring.style.opacity = '0';
    return;
  }
  // (a screen redraw may have rewritten its class list)
  if (!focused.classList.contains('pad-focus')) focused.classList.add('pad-focus');
  const r = focused.getBoundingClientRect();
  const br = parseFloat(getComputedStyle(focused).borderTopLeftRadius) || 6;
  ring.style.opacity = '1';
  ring.style.transform = `translate(${(r.left - 4).toFixed(1)}px, ${(r.top - 4).toFixed(1)}px)`;
  ring.style.width = `${(r.width + 8).toFixed(1)}px`;
  ring.style.height = `${(r.height + 8).toFixed(1)}px`;
  ring.style.borderRadius = `${Math.min(br + 4, 24)}px`;
}

/** Keep the ring on something real: after a screen change, or when a sheet opens over it. */
function validate(force = false) {
  const now = performance.now();
  if (!force && now - lastScan < 200) return;
  lastScan = now;
  // a sheet or menu that just opened takes the ring
  for (const layer of document.querySelectorAll(LAYER)) {
    // (the same sheet can come back with a new question: that counts as new)
    const sig = (layer.firstElementChild?.textContent ?? '').slice(0, 80);
    if (layerSig.get(layer) !== sig) {
      layerSig.set(layer, sig);
      layerTries.delete(layer);
    }
    const tries = layerTries.get(layer) ?? 0;
    // (one that is still sliding in gets a few more looks; then it is left alone)
    if (tries < 0 || tries > 15) continue;
    layerTries.set(layer, tries + 1);
    const c = candidates();
    const inside = c.filter((x) => layer.contains(x.el));
    const picks = c.filter((x) => x.el.matches('.pick'));
    if (!inside.length && !picks.length) continue;
    layerTries.set(layer, -1);
    const ae = document.activeElement;
    const pick =
      inside.find((x) => x.el === ae) ??
      // choosing an attack target: straight to the targets
      (picks.length && (layer.matches('.ttoast.aim') || !inside.length) ? picks[nearest(lastX, lastY, picks.map((x) => x.box))] : undefined) ??
      // a list of cards to choose from: the first card
      inside.find((x) => x.el.matches('.topt')) ??
      inside.find((x) => x.el.matches(PRIMARY)) ??
      inside.find((x) => x.el.matches('.sel, .on, [aria-selected=true], [aria-checked=true]')) ??
      // its first choice (a close × is never where you start)
      inside.sort((a, b) => Number(a.el.matches(CLOSE)) - Number(b.el.matches(CLOSE)) || a.box.top - b.box.top || a.box.left - b.box.left)[0];
    if (pick) {
      // when it closes, the ring goes back where it was
      if (focused && !layer.contains(focused)) cameFrom = { el: focused, x: lastX, y: lastY };
      return setFocus(pick.el);
    }
  }
  if (focused && focused.isConnected) {
    const box = rectOf(focused);
    if (reachable(focused, box)) return;
  }
  const c = candidates();
  if (!c.length) return setFocus(null);
  // back from a sheet or menu: to what was picked before it opened (or where it was)
  if (cameFrom) {
    const back = cameFrom;
    cameFrom = null;
    const same = c.find((x) => x.el === back.el);
    if (same) return setFocus(same.el);
    lastX = back.x;
    lastY = back.y;
  }
  // a duel just started: your hand
  if (!document.querySelector('.duel')) handSeen = false;
  else if (!handSeen) {
    const hand = c.filter((x) => x.el.matches(HAND));
    if (hand.length) return setFocus(hand[Math.floor((hand.length - 1) / 2)].el);
  }
  const n = c[nearest(lastX, lastY, c.map((x) => x.box))];
  const d = Math.hypot(Math.max(n.box.left - lastX, 0, lastX - n.box.right), Math.max(n.box.top - lastY, 0, lastY - n.box.bottom));
  // something where the ring was (a list that redrew): stay there
  if (d < 48 || (focused && focused.isConnected)) return setFocus(n.el);
  // a duel: your hand
  if (document.querySelector('.duel')) {
    const hand = c.filter((x) => x.el.matches(HAND));
    if (hand.length) return setFocus(hand[nearest(lastX, lastY, hand.map((x) => x.box))].el);
    return setFocus(n.el);
  }
  // a new screen: its main button, else the first thing under the top bar
  const order = c.slice().sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
  const pick = order.find((x) => x.el.matches(PRIMARY)) ?? order.find((x) => x.box.top >= innerHeight * 0.12) ?? order[0];
  setFocus(pick.el);
}

// ---------- moving ----------

function move(dir: Dir) {
  validate(true);
  if (!focused) return;
  const el = focused as HTMLInputElement;
  if (el.matches('input[type=range]') && (dir === 'left' || dir === 'right')) {
    if (dir === 'left') el.stepDown();
    else el.stepUp();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const c = candidates().filter((x) => x.el !== focused);
  const from = rectOf(focused);
  const i = pickNext(from, dir, c.map((x) => x.box));
  if (i >= 0) {
    setFocus(c[i].el);
    rumble(0, 0.12, 18);
    return;
  }
  // the end of what's on screen: scroll the list on
  const sc = scrollParent(focused);
  if (sc) {
    const dy = dir === 'down' ? 1 : dir === 'up' ? -1 : 0;
    const dx = dir === 'right' ? 1 : dir === 'left' ? -1 : 0;
    sc.scrollBy({ top: dy * sc.clientHeight * 0.5, left: dx * sc.clientWidth * 0.5, behavior: 'smooth' });
  }
}

function page(down: boolean) {
  const sc = (focused && scrollParent(focused)) || (document.scrollingElement as HTMLElement);
  if (!sc) return;
  sc.scrollBy({ top: (down ? 1 : -1) * sc.clientHeight * 0.8, behavior: 'smooth' });
  setTimeout(() => {
    const c = candidates();
    if (!c.length) return;
    const s = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : rectOf(sc);
    const inView = c.filter((x) => x.box.top >= s.top - 1 && x.box.bottom <= s.bottom + 1 && sc.contains(x.el));
    const list = inView.length ? inView : c;
    setFocus(list[nearest(lastX, down ? s.top : s.bottom, list.map((x) => x.box))].el, false);
  }, 380);
}

// ---------- pressing ----------

const visible = (sel: string): HTMLElement | null => {
  const all = [...document.querySelectorAll<HTMLElement>(sel)].reverse();
  return all.find((el) => reachable(el, rectOf(el))) ?? null;
};

function pointer(el: Element, type: string, x: number, y: number) {
  const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  el.dispatchEvent(new P(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 77, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 } as PointerEventInit));
}

/** What a finger tapping the middle of it would do. */
function tap(el: Element) {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  pointer(el, 'pointerdown', x, y);
  pointer(el, 'pointerup', x, y);
  if (typeof (el as HTMLElement).click === 'function') (el as HTMLElement).click();
  else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

function press() {
  // a 3D cinematic is playing: A skips it (hold A: skip them all), like tapping it
  const skip = document.querySelector<HTMLElement>('.art-skip.on');
  if (skip) {
    const r = skip.getBoundingClientRect();
    pointer(skip, 'pointerdown', r.left + r.width / 2, r.top + r.height / 2);
    artHeld = true;
    return;
  }
  validate(true);
  const el = focused as HTMLElement | null;
  if (!el) return;
  rumble(0.15, 0.3, 30);
  if (el.matches(TEXT)) {
    el.focus();
    (el as HTMLSelectElement).showPicker?.();
    return;
  }
  tap(el);
  // let the screen redraw, then put the ring somewhere real
  setTimeout(() => validate(true), 60);
}

function release() {
  if (!artHeld) return;
  artHeld = false;
  window.dispatchEvent(new (typeof PointerEvent === 'function' ? PointerEvent : MouseEvent)('pointerup', { pointerId: 77, bubbles: true } as PointerEventInit));
}

/** Back: close what is open, step back a screen; never leaves the game. */
export function back(viaEscape = true) {
  const ae = document.activeElement as HTMLElement | null;
  if (ae && ae.matches?.(TEXT)) return void ae.blur();
  if (viaEscape) {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    (ae && ae !== document.body ? ae : document.body).dispatchEvent(ev);
    if (ev.defaultPrevented) return void setTimeout(() => validate(true), 60);
  }
  const duel = document.querySelector<HTMLElement>('.duel.touch');
  if (duel) {
    const aim = duel.querySelector<HTMLElement>('.ttoast.aim button');
    if (aim) return void (tap(aim), setTimeout(() => validate(true), 60));
    if (duel.querySelector('.tactions, .tphase-menu, .tdetail') && !document.querySelector('.overlay, .csheet-back')) {
      duel.click();
      return void setTimeout(() => validate(true), 60);
    }
  }
  const close = visible(CLOSE);
  if (close) return void (tap(close), setTimeout(() => validate(true), 60));
  const ov = visible('.overlay');
  if (ov) return void (ov.click(), setTimeout(() => validate(true), 60));
  pressBack();
  setTimeout(() => validate(true), 60);
}

function inDuel() {
  return !!document.querySelector('.duel.touch, .duel');
}

function tabStep(d: 1 | -1) {
  const list = visibleTabs();
  if (!list) return;
  const tabs = [...list.querySelectorAll<HTMLElement>('button, [role=tab]')].filter((t) => !(t as HTMLButtonElement).disabled);
  if (tabs.length < 2) return;
  const i = Math.max(0, tabs.findIndex((t) => ON.test(t.className) || t.getAttribute('aria-selected') === 'true'));
  const next = tabs[(i + d + tabs.length) % tabs.length];
  tap(next);
  rumble(0, 0.2, 25);
  setTimeout(() => {
    if (focused && list.contains(focused)) setFocus(next, false);
    validate(true);
  }, 60);
}

function visibleTabs(): HTMLElement | null {
  return visible(TABS);
}

function cardInfo() {
  const detail = visible('.tdetail');
  if (detail) return tap(detail);
  // the classic board's card window, or select the card first and then open its text
  if (focused?.matches('[data-uid]')) {
    tap(focused);
    setTimeout(() => {
      const d = visible('.tdetail');
      if (d) tap(d);
    }, 90);
  }
}

function onButton(b: Btn) {
  switch (b) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return move(b);
    case 'a':
      return press();
    case 'b':
      return back();
    case 'x': {
      const ph = visible('.tphase-btn:not([disabled])');
      if (ph) return (tap(ph), setTimeout(() => validate(true), 60));
      return;
    }
    case 'y':
      return cardInfo();
    case 'start': {
      const m = visible('.tgear, [aria-label="Menu"], [aria-label="Settings"]');
      if (m) return (tap(m), setTimeout(() => validate(true), 60));
      return;
    }
    case 'select':
      guide = !guide;
      return renderHints(true);
    case 'lb':
    case 'rb':
      if (inDuel() && !visibleTabs()) return duelJump(b === 'lb');
      return tabStep(b === 'lb' ? -1 : 1);
    case 'lt':
    case 'rt':
      return page(b === 'rt');
  }
}

/** In a duel: LB to your hand, RB to the opponent's monsters. */
function duelJump(hand: boolean) {
  const c = candidates();
  const zone = hand ? c.filter((x) => x.el.matches(HAND)) : c.filter((x) => x.el.matches('.tz-m') && (x.el as HTMLElement).dataset.uid && x.box.top < innerHeight / 2);
  const list = zone.length ? zone : hand ? [] : c.filter((x) => x.el.matches('.tz-m') && x.box.top < innerHeight / 2);
  if (!list.length) return;
  const mid = list.sort((a, b) => a.box.left - b.box.left)[Math.floor((list.length - 1) / 2)];
  setFocus(mid.el);
}

// ---------- hints ----------

type Hint = [Btn[], string];
function hintList(): Hint[] {
  if (document.querySelector('.art-skip.on')) return [[['a'], 'Skip (hold: all)']];
  const out: Hint[] = [[['a'], 'Select'], [['b'], 'Back']];
  if (document.querySelector('.duel.touch')) {
    out.push([['x'], 'Phase'], [['y'], 'Text'], [['lb'], 'Hand'], [['rb'], 'Foes']);
    out.push(guide ? [['start'], 'Menu'] : [['select'], 'More']);
    if (guide) out.push([['select'], 'Hide']);
    return out;
  }
  if (visibleTabs()) out.push([['lb', 'rb'], 'Tabs']);
  if (guide) out.push([['lt', 'rt'], 'Page'], [['select'], 'Hide']);
  else out.push([['select'], 'Guide']);
  return out;
}

/** A bar fixed along the bottom of the screen (tabs, a hand): the hints sit just above it. */
function bottomBarTop(): number {
  for (const fx of [0.5, 0.2, 0.8]) {
    for (let el = document.elementFromPoint(innerWidth * fx, innerHeight - 8); el && el !== document.body; el = el.parentElement) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') {
        const r = el.getBoundingClientRect();
        if (r.bottom >= innerHeight - 4 && r.height < innerHeight * 0.3) return r.top;
        break;
      }
    }
  }
  return innerHeight;
}

function renderHints(force = false) {
  if (!hints) return;
  const duel = !!document.querySelector('.duel');
  document.documentElement.classList.toggle('pad-duel', duel);
  if (!on || connected() === 0) return void hints.classList.remove('show');
  const list = hintList();
  const key = family + JSON.stringify(list) + guide;
  if (force || key !== hintKey) hintsFrom = performance.now();
  // in a duel they show for a moment (and while the guide is open), then get out of the way
  hints.classList.toggle('show', !duel || guide || performance.now() - hintsFrom < 4000);
  const bt = document.querySelector('.duel') ? innerHeight : bottomBarTop();
  hints.style.bottom = bt < innerHeight ? `${Math.round(innerHeight - bt) + 6}px` : '';
  if (!force && key === hintKey) return;
  hintKey = key;
  hints.innerHTML = list
    .map(([bs, label]) => `<span class="pad-hint">${bs.map((b) => `<b class="pad-k pad-${family} pad-${b}">${glyph(family, b)}</b>`).join('')}${label}</span>`)
    .join('');
  hints.classList.toggle('guide', guide);
}

let toastT = 0;
function say(text: string) {
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastT);
  toastT = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

// ---------- the loop ----------

function pads(): PadLike[] {
  try {
    return ([...(navigator.getGamepads?.() ?? [])].filter((p) => p && p.connected) as unknown as PadLike[]);
  } catch {
    return [];
  }
}
function connected() {
  return pads().length;
}

function wake() {
  if (!on) {
    on = true;
    document.documentElement.classList.add('pad-on');
  }
}

function frame(now: number) {
  loop = 0;
  const list = pads();
  const next = new Set<Btn>();
  let sx = 0;
  let sy = 0;
  list.forEach((p, i) => {
    const idx = (p as unknown as Gamepad).index ?? i;
    const r = readPad(p, prev.get(idx));
    prev.set(idx, r.held);
    r.held.forEach((b) => next.add(b));
    if (Math.abs(r.sx) > Math.abs(sx)) sx = r.sx;
    if (Math.abs(r.sy) > Math.abs(sy)) sy = r.sy;
    if (r.held.size) family = familyOf(p.id);
  });
  for (const b of next) {
    if (!held.has(b)) {
      padUsedAt = now;
      const was = on;
      wake();
      downAt.set(b, now);
      repeatAt.set(b, now + REPEAT_FIRST);
      // the first press after a touch only brings the ring back (where the finger was)
      if (!was && b !== 'select') {
        validate(true);
        renderHints(true);
        continue;
      }
      onButton(b);
    } else if ((b === 'up' || b === 'down' || b === 'left' || b === 'right') && now >= (repeatAt.get(b) ?? Infinity)) {
      repeatAt.set(b, now + REPEAT_NEXT);
      onButton(b);
    }
  }
  if (held.has('a') && !next.has('a')) release();
  held = next;
  if (sx || sy) {
    wake();
    const sc = (focused && scrollParent(focused)) || (document.scrollingElement as HTMLElement);
    sc?.scrollBy(sx * 14, sy * 18);
  }
  if (on) {
    validate();
    drawRing();
    if (now - hintsAt > 250) {
      hintsAt = now;
      renderHints();
    }
  }
  if (list.length) loop = requestAnimationFrame(frame);
}

function start() {
  if (!loop) loop = requestAnimationFrame(frame);
}

let installed = false;
/** Turn controller support on (once, at startup). */
export function installPad() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  ring = document.createElement('div');
  ring.className = 'pad-ring pad-ui';
  hints = document.createElement('div');
  hints.className = 'pad-hints pad-ui';
  toast = document.createElement('div');
  toast.className = 'pad-toast pad-ui';
  document.body.append(ring, hints, toast);

  addEventListener('gamepadconnected', (e) => {
    const g = (e as GamepadEvent).gamepad;
    family = familyOf(g.id);
    say(`🎮 ${familyName(family)} connected · ${glyph(family, 'a')} select · ${glyph(family, 'b')} back`);
    // (the press that woke it only shows the ring: it never taps something you can't see yet)
    start();
  });
  addEventListener('gamepaddisconnected', (e) => {
    prev.delete((e as GamepadEvent).gamepad.index);
    if (artHeld) release();
    held = new Set();
    say(connected() ? 'A controller disconnected' : 'Controller disconnected · touch still works');
    renderHints(true);
    if (!connected()) drawRing();
  });
  // a controller that was already on before the page loaded (some browsers only list it after a press)
  if (connected()) start();

  // A finger takes over: hide the ring until the next button press (it starts from the tap).
  addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted || !on) return;
      on = false;
      lastX = e.clientX;
      lastY = e.clientY;
      document.documentElement.classList.remove('pad-on');
      focused?.classList.remove('pad-focus');
      focused = null;
      drawRing();
      renderHints(true);
    },
    true,
  );

  // Keyboards (and phone grips that type arrow keys) drive the same ring.
  addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t?.matches?.(TEXT);
      const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as Record<string, Dir>)[e.key];
      const padNow = connected() > 0;
      if (padNow && (dir || e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') && !typing) {
        // (Android also types these for a controller's d-pad and A/B: the controller already did it)
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (typing) {
        if (dir === 'up' || dir === 'down') (t as HTMLElement).blur();
        else return;
      }
      if (dir) {
        e.preventDefault();
        const was = on;
        wake();
        if (!was) validate(true);
        else move(dir);
        drawRing();
        return;
      }
      if (on && (e.key === 'Enter' || e.key === ' ') && focused && !(focused as HTMLElement).matches?.(TEXT)) {
        e.preventDefault();
        press();
      }
    },
    true,
  );
  // Escape the screens didn't use: step back like B
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Escape' || (e.target as HTMLElement)?.matches?.(TEXT)) return;
    // (after every screen had its turn at it)
    setTimeout(() => !e.defaultPrevented && back(false), 0);
  });
  addEventListener('resize', () => drawRing());
  addEventListener('scroll', () => drawRing(), true);
  // the ring follows things that slide (sheets, the hand fan) even without a controller loop
  setInterval(() => {
    if (!on || loop) return;
    validate();
    drawRing();
    renderHints();
  }, 120);
}

/** For tests in the browser: how long since a controller button was pressed. */
export const padIdleMs = () => performance.now() - padUsedAt;
