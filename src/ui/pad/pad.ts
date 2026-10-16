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
import { closeKb, kbAction, kbOpen, openKb } from './kb';
import './pad.css';

const NATIVE = 'button:not([disabled]), a[href], input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role=button], [role=tab], [tabindex]:not([tabindex="-1"]), summary';
const TEXT = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea, select';
/** A sheet, menu or window that opens over the screen: focus jumps into it. */
const LAYER = '.overlay, .msgwin, [role=dialog], [role=alertdialog], .csheet-back, .tsheet, .tactions, .tphase-menu, .ttoast.aim, .tresult, .sheet, .so-sheet, .sr-sheet, .lv-sheet, .tb-sheet';
const PRIMARY = '[autofocus], .rematch-go, .so-btn.gold, .tbtn.main, .taction.main, .csheet-ok, .primary, .main, .ok';
const CLOSE = '.win-x, [aria-label="Close"], [aria-label="Back"], [data-pad-back]';
const EMPTY_ZONE = '.duel .tz.empty:not(.pick):not(.drop-ok), .duel .zone.empty:not(.pick), .topp-hand [data-uid]:not(.pick)';
const HAND = '.thcard, .hcard, .hand [data-uid]';
/** Choices one stray press shouldn't land on first (leaving, deleting, switching controls). */
const risky = (el: Element) => /controls|leave|surrender|give up|concede|delete|quit|switch profile|log out|open all|^\W*new deck/i.test(el.textContent ?? '');
/** The things a screen is about (tiles, list rows, cards), before its filters and chips. */
const CONTENT = '.sdh-tile, .crow, .menu-item, .ptile, .pack, .tile, [data-uid], .rd-raid, .so-card';
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
/** the menu the ring was in (its choices can change under it: Flip all → Open another) */
let inMenu: Element | null = null;
/** when Y last said a card's text is hidden (B right after only clears that note) */
let yToastAt = -1e9;
const rematchSeen = new WeakSet<Element>();
let artHeld = false;
let hintsAt = 0;

// ---------- what can be reached ----------

function rectOf(el: Element): Box & { width: number; height: number } {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

let spCache: Map<Element, HTMLElement | null> | null = null;
function scrollParent(el: Element): HTMLElement | null {
  const hit = spCache?.get(el.parentElement as Element);
  if (hit !== undefined) return hit;
  const found = findScrollParent(el);
  spCache?.set(el.parentElement as Element, found);
  return found;
}
function findScrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if ((/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 2) || (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 2)) return p;
  }
  const d = document.scrollingElement as HTMLElement | null;
  return d && d.scrollHeight > innerHeight + 2 ? d : null;
}

/** Bars and buttons pinned to the screen over a scrolling page. */
const FLOATING = '.sdh-tabs, .ol-pill, .tabs';
function underBar(hit: Element): boolean {
  for (let p: Element | null = hit; p && p !== document.body; p = p.parentElement) {
    const pos = getComputedStyle(p).position;
    if (pos === 'fixed' || pos === 'sticky') {
      const r = p.getBoundingClientRect();
      // (a bar, not a full-screen sheet)
      return r.height < innerHeight * 0.3;
    }
  }
  return false;
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
    // under a bar pinned to the screen (bottom tabs): the list can scroll it out
    if (hit && !el.closest(FLOATING) && underBar(hit) && scrollParent(el)) return true;
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
  spCache = new Map();
  try {
    return scan();
  } finally {
    spCache = null;
  }
}
function scan(): Cand[] {
  const all = scanAll();
  // a result screen, sheet or keyboard over everything: the ring stays on it
  const modal = [...document.querySelectorAll('.tresult, .csheet-back, .tsheet, .overlay, .pad-kb, .duel .tphase-menu')].pop();
  if (modal) {
    const inside = all.filter((x) => modal.contains(x.el));
    // (a sheet asking for a card on the field keeps those cards in reach)
    if (inside.length) return modal.matches('.tsheet, .csheet-back') ? [...inside, ...all.filter((x) => x.el.matches('.pick') && !modal.contains(x.el))] : inside;
  }
  // aiming an attack: only the targets (and the portrait for a direct attack, and Cancel)
  if (document.querySelector('.duel .ttoast.aim')) {
    const t = all.filter((x) => x.el.matches('.pick, .tbar.top, .ttoast.aim button'));
    if (t.length) return t;
  }
  return all;
}
function scanAll(): Cand[] {
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
    // (greyed-out choices are skipped, like Master Duel's menus)
    // (a locked chapter or legend is still a stop: you can look at it)
    if (((el as HTMLButtonElement).disabled && !el.matches('.locked')) || el.matches('.menu-item.off')) continue;
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

/** What the ring could reach at the last look (to tell a redrawn list from a new screen). */
let known = new WeakSet<Element>();
/** which screen this is (its first few stops), and where the ring last was on each screen */
let screenSig = '';
const placeOn = new Map<string, string>();
const labelOf = (el: Element) => ((el.getAttribute('aria-label') ?? '') + (el.textContent ?? '')).replace(/\s+/g, ' ').trim().slice(0, 40);
function remember(c: Cand[]) {
  known = new WeakSet(c.map((x) => x.el));
  screenSig = c
    .filter((x) => !x.el.closest(TABS))
    .slice(0, 6)
    .map((x) => labelOf(x.el).replace(/\d+/g, '#'))
    .join('|');
}

// ---------- the ring ----------

function setFocus(el: Element | null, scroll = true) {
  if (focused && focused !== el) focused.classList.remove('pad-focus');
  focused = el;
  if (!el) return;
  el.classList.add('pad-focus');
  inMenu = el.closest('.menu');
  if (el.matches(HAND)) handSeen = true;
  if (screenSig && !el.closest(TABS)) {
    placeOn.set(screenSig, labelOf(el));
    if (placeOn.size > 200) placeOn.delete(placeOn.keys().next().value as string);
  }
  if (scroll) {
    const r = el.getBoundingClientRect();
    if (r.top < 6 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // clear of a bar pinned along the bottom (tabs, the hint bar)
    if (!el.closest(FLOATING) && !el.closest('.duel')) {
      const bar = Math.min(bottomBarTop(), hints?.classList.contains('show') ? hints.getBoundingClientRect().top : innerHeight);
      const r2 = el.getBoundingClientRect();
      const sc = scrollParent(el);
      if (sc && r2.bottom > bar - 6) sc.scrollBy({ top: r2.bottom - bar + 14 });
    }
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
  // the hint bar steps aside when the ring is under it
  if (hints) {
    const h = hints.getBoundingClientRect();
    hints.classList.toggle('under', h.width > 0 && r.bottom > h.top && r.top < h.bottom && r.right > h.left && r.left < h.right);
  }
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
      // (a count in its title moved, 1/2 → 2/2, with the ring still in it: not a new question)
      if (!(focused?.isConnected && layer.contains(focused))) layerTries.delete(layer);
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
      inside.find((x) => x.el === ae && !x.el.matches(CLOSE)) ??
      // the choice the ring was on went away, its menu stayed (Flip all → Open another)
      (inMenu && layer.contains(inMenu) && !focused?.isConnected ? inside.find((x) => inMenu!.contains(x.el) && !risky(x.el)) : undefined) ??
      // choosing an attack target: straight to the targets
      (picks.length && (layer.matches('.ttoast.aim') || inside.every((x) => /^\W*(cancel|back)\s*$/i.test(x.el.textContent ?? ''))) ? picks[nearest(lastX, lastY, picks.map((x) => x.box))] : undefined) ??
      // a list of cards to choose from: the first card
      // (not a sheet that only shows cards: 0/0 to pick)
      (/(^|\D)0\s*\/\s*0\b/.test(layer.querySelector('.tsheet-count')?.textContent ?? '') ? undefined : inside.find((x) => x.el.matches('.topt'))) ??
      inside.find((x) => x.el.matches(PRIMARY)) ??
      inside.find((x) => x.el.matches('.sel, .on, [aria-selected=true], [aria-checked=true]')) ??
      // its first choice (a close × is never where you start)
      inside.sort((a, b) => Number(!!a.el.closest(FLOATING)) - Number(!!b.el.closest(FLOATING)) || Number(a.el.matches(CLOSE)) - Number(b.el.matches(CLOSE)) || Number(risky(a.el)) - Number(risky(b.el)) || a.box.top - b.box.top || a.box.left - b.box.left)[0];
    if (pick) {
      // when it closes, the ring goes back where it was
      if (focused && !layer.contains(focused)) cameFrom = { el: focused, x: lastX, y: lastY };
      return setFocus(pick.el);
    }
  }
  if (focused && focused.isConnected) {
    const box = rectOf(focused);
    const re = focused.matches('.mdres-go') ? document.querySelector('.rematch-go') : null;
    if (re && !rematchSeen.has(re) && reachable(re, rectOf(re))) {
      rematchSeen.add(re);
      return setFocus(re);
    }
    if (reachable(focused, box)) return;
  }
  const c = candidates();
  if (!c.length) return setFocus(null);
  // the choice went away but its menu is still there: its new first choice
  if (inMenu?.isConnected && !cameFrom?.el.isConnected && c.filter((x) => known.has(x.el)).length >= c.length * 0.4) {
    const menu = inMenu;
    const same = c.filter((x) => menu.contains(x.el));
    const pick = same.find((x) => !risky(x.el)) ?? same[0];
    if (pick) return setFocus(pick.el);
  }
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
  // a whole new screen (hardly anything from the last one is left)?
  const kept = c.filter((x) => known.has(x.el)).length;
  const newScreen = kept < c.length * 0.4;
  remember(c);
  // something where the ring was (a list that redrew): stay there
  if (!newScreen && (d < 48 || (focused && focused.isConnected))) return setFocus(n.el);
  // a duel: your hand
  if (document.querySelector('.duel')) {
    const hand = c.filter((x) => x.el.matches(HAND));
    if (hand.length) return setFocus(hand[nearest(lastX, lastY, hand.map((x) => x.box))].el);
    return setFocus(n.el);
  }
  // a new screen: its main button, else the first thing under the top bar
  // (back on a screen you were on before: where you were on it)
  const memo = placeOn.get(screenSig);
  const again = memo ? c.find((x) => labelOf(x.el) === memo) : undefined;
  if (again) return setFocus(again.el);
  setFocus(firstStop(c).el);
}

/** A new screen's first stop: its main button, else the first plain choice under the top bar (never a close ×, a tab or a bulk/destructive action). */
function firstStop(c: Cand[]): Cand {
  const order = c.slice().sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
  const plain = (x: Cand) => !x.el.matches(CLOSE) && !risky(x.el) && !x.el.closest(TABS) && !x.el.closest(FLOATING);
  // (below the top bar: it ends by ~100px)
  const below = (x: Cand) => x.box.bottom > Math.min(innerHeight * 0.12, 100);
  return (
    order.find((x) => x.el.matches('.rematch-go')) ??
    order.find((x) => x.el.matches(PRIMARY) && plain(x)) ??
    order.find((x) => x.el.matches(CONTENT) && below(x) && plain(x)) ??
    order.find((x) => below(x) && plain(x)) ??
    order.find(plain) ??
    order[0]
  );
}

// ---------- moving ----------

function move(dir: Dir) {
  validate(true);
  if (!focused) return;
  const el = focused as HTMLInputElement;
  if (el.matches('select') && (dir === 'left' || dir === 'right')) {
    const sel = el as unknown as HTMLSelectElement;
    const i = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + (dir === 'right' ? 1 : -1)));
    if (i !== sel.selectedIndex) {
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      say(sel.options[i].text);
    }
    return;
  }
  if (el.matches('input[type=range]') && (dir === 'left' || dir === 'right')) {
    if (dir === 'left') el.stepDown();
    else el.stepUp();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const all = candidates();
  remember(all);
  const from = rectOf(focused);
  const fromBar = !!focused.closest(FLOATING) || !!focused.closest(TABS);
  const c = all.filter(
    (x) =>
      x.el !== focused &&
      // left/right stays on its own row when the next thing over is a bar or a close ×
      !((dir === 'left' || dir === 'right') && !fromBar && (x.el.matches(CLOSE) || x.el.closest(FLOATING) || x.el.closest(TABS)) && (x.box.bottom <= from.top || x.box.top >= from.bottom)),
  );
  // a card's command bubble: its buttons first; out of it only onto another card
  const bubble = focused.closest('.duel .tactions');
  if (bubble) {
    const inB = c.filter((x) => bubble.contains(x.el));
    const k = pickNext(from, dir, inB.map((x) => x.box));
    if (k >= 0) return void setFocus(inB[k].el);
    const cards = c.filter((x) => x.el.matches('[data-uid]'));
    const k2 = pickNext(from, dir, cards.map((x) => x.box));
    if (k2 >= 0) {
      (document.querySelector('.duel.touch') as HTMLElement | null)?.click();
      return void setFocus(cards[k2].el);
    }
    return;
  }
  const small = (x: Cand) => x.el.matches('.tskill') || /^\s*Out \d+\s*$/.test(x.el.textContent ?? '');
  const field = focused.matches(HAND) && dir === 'up' ? c.filter((x) => !small(x) && !x.el.matches(HAND)) : null;
  const j = field ? pickNext(from, dir, field.map((x) => x.box)) : -1;
  const i = j >= 0 ? c.indexOf(field![j]) : pickNext(from, dir, c.map((x) => x.box));
  if (i >= 0) {
    let to = c[i].el;
    const row = to.parentElement;
    const cls = (x: Element) => x.getAttribute('class') ?? '';
    if (row && !inDuel() && !row.contains(focused) && !ON.test(cls(to))) {
      const picked = c.find((x) => x.el.parentElement === row && ON.test(cls(x.el)));
      if (picked) to = picked.el;
    }
    const duel = document.querySelector<HTMLElement>('.duel.touch');
    if (duel?.querySelector('.tactions') && !to.closest('.tactions') && to.matches('[data-uid]')) duel.click();
    setFocus(to);
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
  // once the list has stopped moving, the ring takes the first thing on the new page
  let last = NaN;
  let still = 0;
  const t0 = performance.now();
  const settle = () => {
    const y = sc.scrollTop;
    still = y === last ? still + 1 : 0;
    last = y;
    if (still < 2 && performance.now() - t0 < 1200) return void setTimeout(settle, 50);
    land();
  };
  setTimeout(settle, 120);
  const land = () => {
    const c = candidates();
    if (!c.length) return;
    const r = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : rectOf(sc);
    const s = { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, innerHeight, bottomBarTop()) };
    const inView = c.filter((x) => x.box.top >= s.top - 1 && x.box.bottom <= s.bottom + 1 && sc.contains(x.el) && !x.el.closest(FLOATING));
    const list = inView.length ? inView : c;
    // (already at the end: the last thing in the list, or the first at the top)
    const end = down ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 : sc.scrollTop <= 1;
    if (end && inView.length) {
      const ord = inView.slice().sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
      return void setFocus((down ? ord[ord.length - 1] : ord[0]).el);
    }
    setFocus(list[nearest(lastX, down ? s.top : s.bottom, list.map((x) => x.box))].el);
  };
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
  if (el.matches('select')) {
    el.focus();
    (el as HTMLSelectElement).showPicker?.();
    return;
  }
  if (el.matches(TEXT)) {
    const box = el as HTMLInputElement;
    openKb(box, () => {
      // back on the box; Done on a box with a button after it (Log in, Join) goes on to that button
      if (!box.isConnected) return void validate(true);
      setFocus(box);
      if (!box.value) return;
      // on to the box's own button (Log in, Join, Add), else the next thing down
      const c = candidates();
      const r = rectOf(box);
      const go = c.filter((x) => /^\W*(join|log ?in|go|ok|add|create|save|send|search|rename)\b/i.test(x.el.textContent ?? '') && Math.abs(center(x.box) - center(r)) < 140);
      if (go.length) setFocus(go[nearest(r.right, center(r), go.map((x) => x.box))].el);
      else move('down');
    });
    cameFrom = null;
    setTimeout(() => validate(true), 30);
    return;
  }
  if (el.matches('.tphase-item, .tphase-menu button') && /battle/i.test(el.textContent ?? '')) setTimeout(() => mine().length && duelJump(false, true), 350);
  if ((el as HTMLButtonElement).disabled) {
    say('Locked · clear the one before it first');
    rumble(0.25, 0, 70);
    return;
  }
  const before = new Set(candidates().map((x) => x.el));
  tap(el);
  if (el.matches('.topt')) {
    const sheet = el.closest('.tsheet, .csheet-back');
    return void setTimeout(() => {
      if (!sheet?.isConnected || !el.isConnected) return void validate(true);
      const ok = [...sheet.querySelectorAll<HTMLButtonElement>('.tbtn.main, .csheet-ok')].find((b) => !b.disabled);
      const [n, max] = (sheet.querySelector('.tsheet-count')?.textContent ?? '').split('/').map(Number);
      // all picked (2/2), or a one-pick sheet: on to OK
      if (ok && el.matches('.on') && (!max || n >= max)) return void setFocus(ok);
      if (!el.matches('.on')) return;
      const opts = [...sheet.querySelectorAll<HTMLElement>('.topt')];
      const next = opts.slice(opts.indexOf(el as HTMLElement) + 1).find((o) => !o.matches('.on')) ?? opts.find((o) => !o.matches('.on'));
      if (next) setFocus(next);
    }, 90);
  }
  if (el.matches('.rv:not(.up)')) {
    return void setTimeout(() => {
      const next = [...document.querySelectorAll<HTMLElement>('.rv:not(.up)')][0];
      if (next) setFocus(next);
      else validate(true);
    }, 80);
  }
  // let the screen redraw, then put the ring somewhere real
  setTimeout(() => validate(true), 60);
  setTimeout(() => {
    // picking one of a list can bring up its confirm ("Take Yami Yugi's deck"): go to it
    if (focused === el && !inDuel()) {
      const take = candidates().find((x) => !before.has(x.el) && /^\W*take\b/i.test(x.el.textContent ?? ''));
      if (take) setFocus(take.el);
    }
  }, 160);
  // a card in your hand with nothing to do right now: say so, instead of a silent press
  if (el.matches('.duel.touch .thcard')) {
    setTimeout(() => {
      if (!el.isConnected || document.querySelector('.tactions, .tsheet, .ttoast.aim, .overlay')) return;
      const mine = !!document.querySelector('.duel.turn-me .tphase-btn.live');
      say(mine ? 'No moves for this card right now · Y: card text' : "Wait for your turn · Y: card text");
      rumble(0.25, 0, 70);
    }, 160);
  }
}

function release() {
  if (!artHeld) return;
  artHeld = false;
  window.dispatchEvent(new (typeof PointerEvent === 'function' ? PointerEvent : MouseEvent)('pointerup', { pointerId: 77, bubbles: true } as PointerEventInit));
}

/** Back: close what is open, step back a screen; never leaves the game. */
export function back(viaEscape = true) {
  if (kbOpen()) return void closeKb();
  if (performance.now() - yToastAt < 2600) {
    yToastAt = -1e9;
    return void toast.classList.remove('show');
  }
  // the result screen: B never presses anything on it; the ring stays on its buttons
  if (document.querySelector('.duel .tresult')) return void validate(true);
  // a duel question with no Cancel (Yes/No): B goes to No, it never asks to leave the duel
  const ask = document.querySelector('.duel .tsheet, .duel .csheet-back');
  if (ask && ![...ask.querySelectorAll('button')].some((b) => /^\W*(cancel|back)\s*$/i.test(b.textContent ?? ''))) {
    const no = [...ask.querySelectorAll<HTMLElement>('button')].find((b) => /^\W*no\b/i.test(b.textContent ?? ''));
    if (no && focused !== no) setFocus(no);
    else say('Answer this one first');
    return;
  }
  const ae = document.activeElement as HTMLElement | null;
  if (ae && ae.matches?.(TEXT)) return void ae.blur();
  if (viaEscape) {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
    (ae && ae !== document.body ? ae : document.body).dispatchEvent(ev);
    if (ev.defaultPrevented) return void setTimeout(() => validate(true), 60);
  }
  const duel = document.querySelector<HTMLElement>('.duel.touch');
  if (duel) {
    const aim = visible('.overlay') ? null : duel.querySelector<HTMLElement>('.ttoast.aim button');
    if (aim) return void (tap(aim), setTimeout(() => validate(true), 60));
    if (duel.querySelector('.tactions, .tphase-menu, .tdetail') && !document.querySelector('.overlay, .csheet-back')) {
      // close it, and the ring goes back to the card it came from (else your hand)
      const from = cameFrom?.el;
      cameFrom = null;
      duel.click();
      return void setTimeout(() => {
        if (from?.isConnected && reachable(from, rectOf(from))) setFocus(from);
        else if (!focused?.isConnected || !focused.matches(HAND)) duelJump(true);
      }, 60);
    }
  }
  // the classic board: cancel the attack, or put the picked card down
  const classic = document.querySelector<HTMLElement>('.duel:not(.touch)');
  if (classic && !document.querySelector('.overlay')) {
    const cancel = [...classic.querySelectorAll<HTMLElement>('.msgwin .menu-item')].find((b) => /^\W*cancel\s*$/i.test(b.textContent ?? ''));
    if (cancel) return void (tap(cancel), setTimeout(() => validate(true), 60));
    const picked = classic.querySelector<HTMLElement>('[data-uid].sel');
    if (picked) return void (tap(picked), setTimeout(() => validate(true), 60));
  }
  // a card's command window (deck editor, trunk): back to the card list, the card put down
  if (focused?.closest('.msgwin') && !focused.closest('.overlay') && cameFrom?.el.isConnected) {
    const from = cameFrom.el;
    cameFrom = null;
    if (from.matches('.sel')) tap(from);
    setFocus(from);
    return void setTimeout(() => validate(true), 60);
  }
  const skip =
    [...document.querySelectorAll<HTMLElement>('.pack.tearable')].find((b) => reachable(b, rectOf(b))) ??
    [...document.querySelectorAll<HTMLElement>('.menu-item, button')].reverse().find((b) => /^\W*(flip all|skip|done|cancel|back)\s*$/i.test(b.textContent ?? '') && !b.closest('.tabs') && reachable(b, rectOf(b)));
  if (skip) {
    const menu = skip.closest('.menu');
    tap(skip);
    return void setTimeout(() => {
      // Flip all → its menu now says Open another / Done: the ring goes there
      const next = menu?.isConnected ? candidates().filter((x) => menu.contains(x.el)) : [];
      const pick = next.find((x) => !risky(x.el)) ?? next[0];
      if (pick) setFocus(pick.el);
      else validate(true);
    }, 90);
  }
  const close = visible(CLOSE);
  if (close) return void (tap(close), setTimeout(() => validate(true), 60));
  const ov = visible('.overlay');
  if (ov) return void (ov.click(), setTimeout(() => validate(true), 60));
  // a duel with nothing open: B never asks to leave (Start's menu does); it brings the ring home to your hand
  if (document.querySelector('.duel') && !document.querySelector('.csheet-back, .tresult, .tsheet, .duel .msgwin .menu-item')) {
    if (!focused?.matches(HAND)) duelJump(true);
    renderHints(true);
    return;
  }
  pressBack();
  setTimeout(() => validate(true), 60);
}

function inDuel() {
  return !!document.querySelector('.duel.touch, .duel');
}

function tabStep(d: 1 | -1) {
  const list = visibleTabs();
  if (!list) return;
  // (a Done or × at the end of the row is not a tab)
  const tabs = [...list.querySelectorAll<HTMLElement>('button, [role=tab]')].filter((t) => !(t as HTMLButtonElement).disabled && !t.matches('.x, .done, [data-pad-skip]') && !t.matches(CLOSE) && !/^\s*(done|close|back)\s*$/i.test(t.textContent ?? ''));
  if (tabs.length < 2) return;
  const i = Math.max(0, tabs.findIndex((t) => ON.test(t.className) || t.getAttribute('aria-selected') === 'true'));
  const next = tabs[(i + d + tabs.length) % tabs.length];
  tap(next);
  rumble(0, 0.2, 25);
  setTimeout(() => {
    if (focused && list.contains(focused)) return setFocus(next, false);
    const c = candidates();
    remember(c);
    const body = c.filter((x) => !x.el.closest(TABS));
    if (!body.length) return validate(true);
    const memo = placeOn.get(screenSig);
    setFocus(((memo && body.find((x) => labelOf(x.el) === memo)) || firstStop(body)).el);
  }, 80);
}

function visibleTabs(): HTMLElement | null {
  return visible(TABS);
}

function cardInfo() {
  if (focused?.matches('.duel.touch [data-uid]')) {
    if (!focused.dispatchEvent(new CustomEvent('pady', { bubbles: true, cancelable: true }))) return;
    yToastAt = performance.now();
    return void say('A face-down card: its text is hidden');
  }
  if (focused?.hasAttribute('data-pad-y')) return void focused.dispatchEvent(new CustomEvent('pady', { bubbles: true }));
  const detail = visible('.tdetail');
  if (detail) return tap(detail);
  const classicInfo = [...document.querySelectorAll<HTMLElement>('.msgwin .menu-item, .overlay .menu-item')].find((b) => /card info|skill text/i.test(b.textContent ?? ''));
  if (classicInfo) return tap(classicInfo);
  // the classic board's card window, or select the card first and then open its text
  if (focused?.matches('[data-uid]')) {
    tap(focused);
    setTimeout(() => {
      const d = visible('.tdetail') ?? [...document.querySelectorAll<HTMLElement>('.duel .msgwin .menu-item')].find((b) => /card info/i.test(b.textContent ?? ''));
      if (d) tap(d);
    }, 90);
  }
}

function onButton(b: Btn) {
  // the result screen: only its own buttons
  if (document.querySelector('.tresult') && (b === 'x' || b === 'y' || b === 'lb' || b === 'rb')) return;
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
      if (kbOpen()) return kbAction('del');
      // a screen's own X action on what the ring is on (deck editor: add or remove a copy)
      if (focused?.hasAttribute('data-pad-x') && !inDuel()) {
        if (!focused.getAttribute('data-pad-x')) return void (say("Can't add another copy of this card"), rumble(0.25, 0, 70));
        focused.dispatchEvent(new CustomEvent('padx', { bubbles: true }));
        rumble(0.1, 0.25, 25);
        return void setTimeout(() => renderHints(true), 60);
      }
      // (a card's command bubble closes first: one menu at a time)
      const duel = document.querySelector<HTMLElement>('.duel.touch');
      const delay = duel?.querySelector('.tactions') ? (duel.click(), 40) : 0;
      setTimeout(() => {
        if (document.querySelector('.duel .ttoast.aim')) return void say('Choose a target first · B cancels the attack');
        // (open already: X closes it)
        if (document.querySelector('.duel .tphase-menu')) return void (duel?.click(), setTimeout(() => validate(true), 60));
        const ph = visible('.tphase-btn:not([disabled]), .phasebtns .gbtn:not(.end)');
        if (ph) {
          tap(ph);
          // (it didn't open: once more)
          setTimeout(() => {
            if (ph.isConnected && ph.matches('.tphase-btn:not([disabled])') && !document.querySelector('.duel .tphase-menu')) ph.click();
            setTimeout(() => validate(true), 60);
          }, 140);
        } else say(!document.querySelector('.duel.turn-me') ? "It's the other duelist's turn" : document.querySelector('.duel .tsheet, .duel .csheet-back') ? 'Answer the question first' : 'One moment…');
        setTimeout(() => validate(true), 60);
      }, delay);
      return;
    }
    case 'y':
      if (kbOpen()) return kbAction('shift');
      return cardInfo();
    case 'start': {
      if (kbOpen()) return kbAction('done');
      const m = visible('.tgear, .duel .menu-btn, [aria-label="Menu"], [aria-label="Settings"]');
      if (m) return (tap(m), setTimeout(() => validate(true), 60));
      return;
    }
    case 'select':
      guide = !guide;
      return renderHints(true);
    case 'lb':
    case 'rb':
      if (inDuel() && !visibleTabs()) return b === 'lb' && focused?.matches(HAND) && mine().length ? duelJump(false, true) : duelJump(b === 'lb');
      return tabStep(b === 'lb' ? -1 : 1);
    case 'lt':
    case 'rt':
      return page(b === 'rt');
  }
}

/** In a duel: LB to your hand, RB to the opponent's monsters. */
/** where the two sides of the board meet (the turn row in the middle) */
function midY() {
  const m = document.querySelector('.duel .tmid:not(.tmid-float)')?.getBoundingClientRect();
  return m && m.height > 0 ? m.top + m.height / 2 : innerHeight / 2;
}
const center = (b: Box) => (b.top + b.bottom) / 2;
/** your monsters on the field */
function mine(c = candidates()) {
  const y = midY();
  return c.filter((x) => x.el.matches('.tz-m, .zone.z-m') && (x.el as HTMLElement).dataset.uid && center(x.box) > y);
}
function duelJump(hand: boolean, own = false) {
  // (a command bubble or the phase menu closes: the ring is going somewhere else)
  const duel = document.querySelector<HTMLElement>('.duel.touch');
  if (duel?.querySelector('.tactions, .tphase-menu')) duel.click();
  const c = candidates();
  if (own) {
    const m = mine(c).sort((a, b) => a.box.left - b.box.left);
    if (m.length) setFocus(m[Math.floor((m.length - 1) / 2)].el);
    return;
  }
  const zone = hand ? c.filter((x) => x.el.matches(HAND)) : c.filter((x) => x.el.matches('.tz-m, .zone.z-m') && (x.el as HTMLElement).dataset.uid && center(x.box) < midY());
  // (no monsters over there: their other cards, then their portrait)
  const list = zone.length ? zone : hand ? [] : c.filter((x) => x.el.matches('[data-uid], .tpile, .pile') && center(x.box) < midY());
  if (!list.length) {
    const top = c.find((x) => x.el.matches('.tbar.top'));
    if (top) setFocus(top.el);
    return;
  }
  const mid = list.sort((a, b) => a.box.left - b.box.left)[Math.floor((list.length - 1) / 2)];
  setFocus(mid.el);
}

// ---------- hints ----------

type Hint = [Btn[], string];
function hintList(): Hint[] {
  if (document.querySelector('.art-skip.on')) return [[['a'], 'Skip (hold: all)']];
  if (kbOpen()) return [[['a'], 'Type'], [['x'], 'Delete'], [['y'], 'Caps'], [['start'], 'Done'], [['b'], 'Close']];
  const out: Hint[] = [[['a'], 'Select'], [['b'], 'Back']];
  if (document.querySelector('.duel .tresult, .mdres-go')) return [[['a'], 'Select']];
  if (document.querySelector('.duel')) {
    out[0][1] = aLabel();
    if (document.querySelector('.duel .ttoast.aim')) return [out[0], [['b'], 'Cancel'], [['y'], 'Text']];
    if (!guide) return [...out, [['x'], 'Phase'], [['y'], 'Text'], [['select'], 'More']];
    out.push([['x'], 'Phase'], [['y'], 'Text'], [['lb'], 'Hand ⇄ Field'], [['rb'], 'Foes'], [['start'], 'Menu'], [['lt', 'rt'], 'Page'], [['select'], 'Hide']);
    return out;
  }
  const xl = focused?.getAttribute('data-pad-x');
  if (xl) out.push([['x'], xl]);
  if (focused?.hasAttribute('data-pad-y') || [...document.querySelectorAll('.msgwin .menu-item, .overlay .menu-item')].some((b) => /card info|skill text/i.test(b.textContent ?? ''))) out.push([['y'], 'Card info']);
  if (visibleTabs()) out.push([['lb', 'rb'], 'Tabs']);
  if (guide) out.push([['lt', 'rt'], 'Page'], [['select'], 'Hide']);
  else out.push([['select'], 'Guide']);
  return out;
}

/** What A does on the focused thing in a duel: its command's name, or picking the card. */
function aLabel(): string {
  const f = focused;
  if (!f || !f.isConnected) return 'Select';
  if (f.matches('.taction, .tphase-item, .tbtn, .menu-item, .tlink')) return (f.textContent ?? '').replace(/^\W+/, '').trim().slice(0, 16) || 'Select';
  if (f.matches('.pick')) return document.querySelector('.ttoast.aim') ? 'Attack this' : 'Choose';
  if (f.matches('.topt')) return 'Choose';
  if (f.matches('.tbar.top') && document.querySelector('.ttoast.aim')) return 'Direct attack';
  if (f.matches('.thcard')) return f.matches('.can') ? 'Play' : 'Card';
  if (f.matches(HAND)) return document.querySelector('.duel.turn-me .tphase-btn.live') ? 'Play' : 'Card';
  if (f.matches('[data-uid]')) return 'Card';
  if (f.matches('.tpile, .pile')) return 'Look';
  return 'Select';
}

/** A bar fixed along the bottom of the screen (tabs, a hand): the hints sit just above it. */
function bottomBarTop(): number {
  // (tab bars along the bottom, and the floating Friends button)
  let top = innerHeight;
  for (const fx of [0.5, 0.2, 0.8, 0.9]) {
    for (const dy of [8, 36, 64]) {
      for (let el = document.elementFromPoint(innerWidth * fx, innerHeight - dy); el && el !== document.body; el = el.parentElement) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          const r = el.getBoundingClientRect();
          if (r.bottom >= innerHeight - 100 && r.height < innerHeight * 0.3) top = Math.min(top, r.top);
          break;
        }
      }
    }
  }
  // (and anything pinned right on top of that: the Find a Match banner over the tabs)
  for (let n = 0; n < 3 && top < innerHeight; n++) {
    let up = top;
    for (const fx of [0.5, 0.2, 0.8]) {
      for (let el = document.elementFromPoint(innerWidth * fx, top - 8); el && el !== document.body; el = el.parentElement) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          const r = el.getBoundingClientRect();
          if (r.bottom >= top - 14 && r.height < innerHeight * 0.3 && r.top < up) up = r.top;
          break;
        }
      }
    }
    if (up === top) break;
    top = up;
  }
  return top;
}

let dimT = 0;
function renderHints(force = false) {
  if (!hints) return;
  const duel = !!document.querySelector('.duel');
  document.documentElement.classList.toggle('pad-duel', duel);
  if (!on || connected() === 0) return void hints.classList.remove('show');
  const list = hintList();
  const key = family + JSON.stringify(list) + guide;
  // in a duel they show for a moment (and while the guide is open), then get out of the way
  // (out of the way while a command bubble, the phase menu or a sheet is open)
  // (a question sheet hides them even with the guide open: they'd sit on its choices)
  hints.classList.toggle('show', !(duel && (document.querySelector('.overlay, .tsheet, .csheet-back, .tresult') || (!guide && document.querySelector('.duel .tactions, .duel .tphase-menu')))));
  // (in a duel: just over your Life Points, clear of the hand and the other player's side)
  const lp = document.querySelector('.duel.touch .tbar.bottom')?.getBoundingClientRect();
  const bt = lp ? lp.top : duel ? innerHeight : bottomBarTop();
  hints.style.bottom = bt < innerHeight ? `${Math.round(innerHeight - bt) + 4}px` : '';
  hints.style.top = lp ? 'auto' : '';
  // (the rewards screen keeps Continue along the bottom: the hints go up top)
  if (!lp && document.querySelector('.mdres-go')) (hints.style.top = 'calc(env(safe-area-inset-top, 0px) + 8px)'), (hints.style.bottom = 'auto');
  if (!force && key === hintKey) return;
  hintKey = key;
  // (in a duel the bar fades back after a few seconds, so the cards under it can be read)
  hints.classList.remove('dim');
  clearTimeout(dimT);
  if (duel) dimT = window.setTimeout(() => hints.classList.add('dim'), 3500);
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
    document.documentElement.classList.add('pad-here');
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
    if (!connected()) (drawRing(), document.documentElement.classList.remove('pad-here'));
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
