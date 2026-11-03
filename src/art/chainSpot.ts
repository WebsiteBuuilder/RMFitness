// Chain spotlight: when cards chain, the chain lifts off the field in order, each card
// numbered, and then resolves link by link from the last one down. As each link resolves
// it comes forward, bigger, with its effect text and its own flash, and goes back to its
// place in the chain (dimmed, done). A tap on any card of the chain (or holding it) pauses
// everything and shows the card big with its whole text; a tap (or letting go) goes on.
//
// DOM only (no three.js), so the duel screen can load it with the art stage. The director
// (runtime.ts) drives it from its cinematics' timelines, so it pauses, skips and speeds up
// with them. Cheap by design: a handful of absolutely placed elements, moved with
// transform and opacity only; measured once per beat (the window's size), never per frame.
import { h, render } from 'preact';
import { card } from '../eds/db';
import { CardImg } from '../ui/CardImg';
import { spellWord } from '../ui/gameUi';
import type { ChainCard } from './cues';
import { END_DURATION, liftStep } from './chainRules';

export { END_DURATION, resolveDuration, stackDuration } from './chainRules';

/** A card read this long (a tap that was never closed) goes on by itself. */
export const INSPECT_MAX_MS = 25000;
/** The stage idle mid-chain: the chain stays up this long for what comes next. */
export const IDLE_GRACE_MS = 1600;
/** A press held this long is a hold: letting go closes the card. */
const HOLD_MS = 350;

const KIND_COLOR = { spell: '#1fd39a', trap: '#e2479c', monster: '#ff9a2e' } as const;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const easeOut = (k: number) => 1 - (1 - k) ** 3;
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const backOut = (k: number) => 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

interface Pose {
  x: number;
  y: number;
  w: number;
  rot: number;
  op: number;
}

interface Slot {
  link: ChainCard;
  el: HTMLElement;
  pic: HTMLElement;
  /** the card name its picture shows */
  shows: string;
  /** where it starts its lift (its zone on the field, when it is there) */
  from: Pose | null;
}

/** The card's kind line ("Counter Trap", "Quick-Play Spell", "Effect Monster"). */
export function kindLine(name: string): string {
  const info = card(name);
  if (!info) return '';
  if (info.kind === 'monster') return `${info.sub && info.sub !== 'Normal' ? info.sub : 'Effect'} Monster${info.level ? ` · Level ${info.level}` : ''}`;
  const sub = info.sub && info.sub !== 'Normal' ? `${info.sub} ` : '';
  return `${sub}${info.kind === 'spell' ? spellWord() : 'Trap'}`;
}

/** "Your Trap" / "Joey's Trap" / "Joey's monster effect". */
export function linkOwner(l: Pick<ChainCard, 'mine' | 'who' | 'what'>): string {
  const what = l.what === 'monster' ? 'monster effect' : l.what === 'spell' ? spellWord() : 'Trap';
  return l.mine ? `Your ${what}` : `${l.who || 'Their'}'s ${what}`;
}

export class ChainSpot {
  private root: HTMLElement;
  private slots = new Map<number, Slot>();
  private title: HTMLElement;
  private big: HTMLElement;
  private bigPic: HTMLElement;
  private bigShows = '';
  private text: HTMLElement;
  private tag: HTMLElement;
  private stamp: HTMLElement;
  private flashEl: HTMLElement;
  private inspectEl: HTMLElement | null = null;
  private inspectTimer = 0;
  private W = 360;
  private H = 640;
  private n = 0;
  /** the link in the spotlight (resolve beat), its pose there and its place in the chain */
  private live: { n: number; at: Pose; slot: Pose; negated: boolean; D: number; flashed: boolean } | null = null;
  private endTimer = 0;
  /** the stage went idle mid-chain (the grace runs, or waits for a card being read) */
  private idleArmed = false;
  /** how long a card may be read (shorter while a choice for the player waits behind it) */
  pauseLimit: () => number = () => INSPECT_MAX_MS;
  /** the stage pauses (true) and goes on (false) while a card is read */
  onPause: (on: boolean) => void = () => {};

  constructor(host: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'art-chain';
    root.innerHTML =
      '<b class="chs-title"></b>' +
      '<div class="chs-big"><i class="chs-pic"></i><b class="chs-badge"></b><i class="chs-stamp">NEGATED</i></div>' +
      '<i class="chs-flash"></i>' +
      '<div class="chs-text"><span class="chs-tag"></span><b class="chs-name"></b><i class="chs-kind"></i><p class="chs-desc"></p><em class="chs-more">Tap the card to read it all</em></div>';
    host.appendChild(root);
    this.root = root;
    this.title = root.querySelector('.chs-title')!;
    this.big = root.querySelector('.chs-big')!;
    this.bigPic = this.big.querySelector('.chs-pic')!;
    this.stamp = this.big.querySelector('.chs-stamp')!;
    this.flashEl = root.querySelector('.chs-flash')!;
    this.text = root.querySelector('.chs-text')!;
    this.tag = this.text.querySelector('.chs-tag')!;
    this.big.addEventListener('pointerdown', (ev) => this.press(ev, this.live?.n ?? 0));
  }

  get showing() {
    return this.root.classList.contains('on');
  }

  // ------------------------------------------------------------ layout
  private measure() {
    this.W = window.innerWidth || 360;
    this.H = window.innerHeight || 640;
  }

  /** The row the chain lifts into, across the middle of the screen. */
  private rowPose(i: number, n: number): Pose {
    const { W, H } = this;
    // a long chain shrinks so every card's name stays readable (each card covers only the next one's right edge)
    const w = Math.min(W * (n >= 4 ? 0.21 : 0.25), H * 0.15, 132);
    const step = n > 1 ? Math.min(w * 0.92, (W * 0.94 - w) / (n - 1)) : 0;
    this.root.style.setProperty('--step', `${step.toFixed(1)}px`);
    const c = i - (n - 1) / 2;
    return { x: W / 2 + c * step, y: H * 0.42 + Math.abs(c) * 4, w, rot: c * 3.5, op: 1 };
  }

  /** The chain docked down the left edge while it resolves: the last link on top. */
  colPose(nLink: number, n: number): Pose {
    const { W, H } = this;
    const w = Math.min(W * 0.15, H * 0.09, 68);
    const hh = w * 1.46;
    // one under the other with a gap when they fit, overlapping only on a long chain
    const step = n > 1 ? Math.min(hh + 10, (H * 0.5 - hh) / (n - 1)) : 0;
    return { x: 8 + w / 2, y: H * 0.24 + hh / 2 + (n - nLink) * step, w, rot: 0, op: 1 };
  }

  /** The spotlight's column: right of the docked chain (left, width) — its card and its text share it. */
  private lane(): { left: number; width: number } {
    const col = this.colPose(1, 1);
    const left = Math.round(col.x + col.w / 2 + 10);
    return { left, width: Math.min(this.W - left - 12, 420) };
  }

  /** The spotlight: the resolving card, big, above its text. */
  private bigPose(): Pose {
    const { H } = this;
    const lane = this.lane();
    const w = Math.min(lane.width * 0.6, (H * 0.34) / 1.46, 230);
    return { x: lane.left + lane.width / 2, y: H * 0.17 + (w * 1.46) / 2, w, rot: 0, op: 1 };
  }

  /** each element's box size as last set (a new size means a new layout; moves are transforms only) */
  private sized = new WeakMap<HTMLElement, number>();

  private place(el: HTMLElement, p: Pose, scale = 1) {
    const hh = p.w * 1.46;
    if (this.sized.get(el) !== p.w) {
      this.sized.set(el, p.w);
      el.style.width = `${p.w}px`;
      el.style.height = `${hh}px`;
    }
    el.style.transform = `translate3d(${(p.x - p.w / 2).toFixed(1)}px,${(p.y - hh / 2).toFixed(1)}px,0) rotate(${p.rot.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
    const op = p.op.toFixed(2);
    if (Number(el.style.opacity) !== Number(op) || el.style.opacity === '') el.style.opacity = op;
  }

  /** Between two poses (size included, by scale from the larger box so the picture stays sharp). */
  private between(el: HTMLElement, a: Pose, b: Pose, k: number) {
    const w = Math.max(a.w, b.w);
    const cur = lerp(a.w, b.w, k);
    this.place(el, { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w, rot: lerp(a.rot, b.rot, k), op: lerp(a.op, b.op, k) }, cur / w);
  }

  // ------------------------------------------------------------ cards
  private slotFor(l: ChainCard): Slot {
    let s = this.slots.get(l.n);
    if (s && s.link.card.uid !== l.card.uid) {
      this.dropSlot(s);
      s = undefined;
    }
    if (!s) {
      const el = document.createElement('div');
      el.className = `chs-card k-${l.what}`;
      // (link 2 and up: an arrow back to the link it answers, in the row)
      el.innerHTML = `<i class="chs-pic"></i><b class="chs-badge">${l.n}</b><i class="chs-done"></i>${l.n > 1 ? '<i class="chs-ans" aria-hidden="true"></i>' : ''}`;
      el.style.setProperty('--kc', KIND_COLOR[l.what]);
      const n = l.n;
      el.addEventListener('pointerdown', (ev) => this.press(ev, n));
      this.root.appendChild(el);
      s = { link: l, el, pic: el.querySelector('.chs-pic')!, shows: '', from: null };
      this.slots.set(l.n, s);
    }
    s.link = l;
    if (s.shows !== l.card.name) {
      s.shows = l.card.name;
      render(h(CardImg, { name: l.card.name, owner: l.card.owner ?? l.card.controller }), s.pic);
    }
    s.el.classList.toggle('done', l.done);
    s.el.classList.toggle('neg', l.negated);
    s.el.classList.toggle('mine', l.mine);
    return s;
  }

  private dropSlot(s: Slot) {
    render(null, s.pic);
    s.el.remove();
    this.slots.delete(s.link.n);
  }

  /** The chain as `stack` has it: new links get a card, links gone from it lose theirs. */
  private sync(stack: ChainCard[]) {
    const keep = new Set(stack.map((l) => l.n));
    for (const s of [...this.slots.values()]) if (!keep.has(s.link.n)) this.dropSlot(s);
    for (const l of stack) this.slotFor(l);
    this.n = Math.max(0, ...stack.map((l) => l.n));
  }

  private show() {
    clearTimeout(this.endTimer);
    this.idleArmed = false;
    this.root.classList.remove('out');
    this.root.classList.add('on');
    document.body.classList.add('chs-on');
  }

  // ------------------------------------------------------------ beats
  /** The chain lifts off the field, link by link, into a numbered row. `added`: the newest link. */
  stack(stack: ChainCard[], added: number) {
    this.measure();
    this.closeLive();
    this.sync(stack);
    this.show();
    this.root.classList.remove('docked');
    this.title.innerHTML = `CHAIN <b>${this.n}</b>`;
    this.title.style.setProperty('--kc', KIND_COLOR[stack.find((l) => l.n === added)?.what ?? 'trap']);
    this.title.classList.remove('pop');
    void this.title.offsetWidth;
    this.title.classList.add('pop');
    for (const s of this.slots.values()) {
      s.el.classList.remove('glide');
      s.el.classList.toggle('fresh', s.link.n === added);
      // it lifts from its zone on the field when it is there (rect: the art stage's coordinates)
      const r = s.link.card.rect;
      s.from = r && r.w > 4 && r.y > 0 && r.y < this.H ? { x: r.x, y: r.y, w: r.w, rot: 0, op: 1 } : null;
    }
    this.stackAt(0);
  }

  /** The lift at `t` cinematic seconds: link i rises from 0.25 i s, for 0.4 s, and its number pops. */
  stackAt(t: number) {
    const n = this.n;
    const step = liftStep(n);
    for (const s of this.slots.values()) {
      const i = s.link.n - 1;
      const to = this.rowPose(i, n);
      const k = clamp01((t - i * step) / 0.3);
      const from = s.from ?? { ...to, y: to.y + 50, w: to.w * 0.7, op: 0 };
      if (k <= 0) this.place(s.el, { ...from, op: s.from ? 0 : 0 });
      else this.between(s.el, { ...from, op: s.from ? 1 : 0 }, to, easeOut(k));
      // (it lifts off the card on the field: a lift, then a little settle)
      const b = backOut(clamp01((k - 0.7) / 0.3)).toFixed(2);
      if (s.el.style.getPropertyValue('--b') !== b) s.el.style.setProperty('--b', b);
      if (s.el.classList.contains('up') !== k > 0) s.el.classList.toggle('up', k > 0);
    }
  }

  /** Link `n` resolves: the chain docks at the edge, `n` comes forward into the spotlight. */
  resolve(stack: ChainCard[], n: number, negated: boolean, D: number) {
    this.measure();
    this.closeLive();
    this.sync(stack);
    this.show();
    this.root.classList.add('docked');
    this.title.innerHTML = '';
    const total = this.n;
    for (const s of this.slots.values()) {
      s.el.classList.add('glide');
      s.el.classList.remove('fresh');
      s.el.classList.add('up');
      s.el.style.setProperty('--b', '1');
      this.place(s.el, this.colPose(s.link.n, total));
      s.el.classList.toggle('ghost', s.link.n === n);
    }
    const l = stack.find((x) => x.n === n);
    if (!l) return;
    if (this.bigShows !== l.card.name) {
      this.bigShows = l.card.name;
      render(h(CardImg, { name: l.card.name, owner: l.card.owner ?? l.card.controller }), this.bigPic);
    }
    const color = KIND_COLOR[l.what];
    this.big.style.setProperty('--kc', color);
    this.text.style.setProperty('--kc', color);
    this.flashEl.style.setProperty('--kc', color);
    (this.big.querySelector('.chs-badge') as HTMLElement).textContent = String(n);
    this.big.classList.toggle('neg', negated);
    this.stamp.classList.remove('hit');
    const info = card(l.card.name);
    // (a link always answers the one below it: that is what a chain is)
    this.tag.textContent = `Chain Link ${n} · ${linkOwner(l)}${negated ? ' · Negated' : n > 1 ? ` · ↩ Link ${n - 1}` : ''}`;
    (this.text.querySelector('.chs-name') as HTMLElement).textContent = l.card.name;
    (this.text.querySelector('.chs-kind') as HTMLElement).textContent = kindLine(l.card.name);
    const desc = this.text.querySelector('.chs-desc') as HTMLElement;
    desc.textContent = info?.desc ?? '';
    this.text.classList.toggle('neg', negated);
    const at = this.bigPose();
    const lane = this.lane();
    this.text.style.width = `${lane.width}px`;
    this.text.style.transform = `translate3d(${lane.left}px,${(at.y + (at.w * 1.46) / 2 + 12).toFixed(1)}px,0)`;
    // a long text is cut short here; a tap on the card shows all of it
    this.text.classList.toggle('long', (info?.desc.length ?? 0) > 200);
    this.live = { n, at, slot: this.colPose(n, total), negated, D, flashed: false };
    this.big.classList.add('on');
    this.resolveAt(0);
  }

  /** The spotlight at `t` cinematic seconds of its `D`: out of the chain, held there to read, back into the chain. */
  resolveAt(t: number) {
    const lv = this.live;
    if (!lv) return;
    const OUT = 0.22;
    const BACK = 0.3;
    if (t < OUT) this.between(this.big, { ...lv.slot, op: 0.6 }, lv.at, easeOut(t / OUT));
    else if (t < lv.D - BACK) this.place(this.big, lv.at);
    else this.between(this.big, lv.at, { ...lv.slot, op: 0 }, easeInOut(clamp01((t - (lv.D - BACK)) / BACK)));
    // its own flash, as it arrives
    if (!lv.flashed && t >= OUT) {
      lv.flashed = true;
      if (t < OUT + 0.3) {
        const hh = lv.at.w * 1.46;
        this.flashEl.style.transform = `translate3d(${lv.at.x.toFixed(1)}px,${lv.at.y.toFixed(1)}px,0)`;
        this.flashEl.style.setProperty('--fw', `${Math.max(lv.at.w, hh) * 1.5}px`);
        this.flashEl.classList.remove('go');
        void this.flashEl.offsetWidth;
        this.flashEl.classList.add('go');
      }
    }
    const txt = clamp01((t - OUT * 0.4) / 0.15) * (1 - clamp01((t - (lv.D - BACK)) / (BACK * 0.6)));
    const op = txt.toFixed(2);
    if (Number(this.text.style.opacity) !== Number(op) || this.text.style.opacity === '') this.text.style.opacity = op;
    if (this.text.classList.contains('on') !== txt > 0.05) this.text.classList.toggle('on', txt > 0.05);
    if (lv.negated) this.stamp.classList.toggle('hit', t >= OUT + 0.12 && t < lv.D - BACK);
    if (t >= lv.D) {
      // back in its place, done
      const s = this.slots.get(lv.n);
      if (s) {
        s.el.classList.remove('ghost');
        s.el.classList.add('done');
        s.el.classList.toggle('neg', lv.negated);
      }
      this.big.classList.remove('on');
      this.text.classList.remove('on');
      this.live = null;
    }
  }

  private closeLive() {
    if (!this.live) return;
    this.resolveAt(this.live.D);
  }

  /** The chain has resolved: it folds away. */
  end() {
    this.closeLive();
    if (!this.showing) return this.hide();
    this.root.classList.add('out');
    clearTimeout(this.endTimer);
    this.endTimer = window.setTimeout(() => this.hide(), END_DURATION * 1000 + 40);
  }

  /**
   * The stage went quiet in the middle of a chain (the other duelist is deciding whether to
   * answer it): the chain stays up a moment for the next link or its resolution, so it does
   * not blink out and back; nothing comes, it goes.
   */
  idle(ms = IDLE_GRACE_MS) {
    if (!this.showing) return;
    this.idleArmed = true;
    // (a card being read stays up: the grace starts again once it is closed)
    if (this.inspectEl) return;
    clearTimeout(this.endTimer);
    this.endTimer = window.setTimeout(() => this.hide(), ms);
  }

  /** Gone at once (a skip, a choice for the player, leaving): what it holds is dropped. */
  hide() {
    clearTimeout(this.endTimer);
    this.idleArmed = false;
    this.closeInspect();
    this.live = null;
    this.root.classList.remove('on', 'out', 'docked');
    document.body.classList.remove('chs-on');
    this.big.classList.remove('on');
    this.text.classList.remove('on');
    for (const s of [...this.slots.values()]) this.dropSlot(s);
    this.n = 0;
  }

  dispose() {
    this.hide();
    render(null, this.bigPic);
    this.root.remove();
  }

  // ------------------------------------------------------------ tap to read
  /** A press on a chain card: everything holds still and the card shows big with all its text. */
  private press(ev: PointerEvent, n: number) {
    if (ev.button > 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const link = this.slots.get(n)?.link;
    if (!link) return;
    this.inspect(link);
    const down = performance.now();
    const up = (e: PointerEvent) => {
      if (e.pointerId !== ev.pointerId) return;
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      // a hold: letting go goes on; a tap: the card stays up until the next tap
      if (performance.now() - down >= HOLD_MS) this.closeInspect();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  inspect(l: ChainCard) {
    this.closeInspect(false);
    const info = card(l.card.name);
    const el = document.createElement('div');
    el.className = 'chs-inspect';
    el.style.setProperty('--kc', KIND_COLOR[l.what]);
    el.innerHTML =
      `<div class="chs-ibox"><div class="chs-ipic"><i class="chs-pic"></i><b class="chs-badge">${l.n}</b></div>` +
      `<div class="chs-itext"><span class="chs-tag">Chain Link ${l.n} · ${esc(linkOwner(l))}${l.done ? (l.negated ? ' · negated' : ' · resolved') : ''}</span>` +
      `<b class="chs-name">${esc(l.card.name)}</b><i class="chs-kind">${esc(kindLine(l.card.name))}</i>` +
      `${info?.kind === 'monster' && info.atk !== undefined ? `<i class="chs-stats">ATK ${info.atk} / DEF ${info.def ?? '?'}</i>` : ''}` +
      `<p class="chs-desc">${esc(info?.desc ?? '')}</p></div></div>` +
      '<em class="chs-ihint">Paused · tap anywhere to keep going</em>';
    render(h(CardImg, { name: l.card.name, owner: l.card.owner ?? l.card.controller }), el.querySelector('.chs-pic')!);
    // a tap on it (not a scroll of the text) goes on; the click that ends the very tap that
    // opened it lands here too on a phone, so only a press that started here counts
    let pressed = false;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      pressed = true;
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pressed) this.closeInspect();
    });
    this.root.appendChild(el);
    this.root.classList.add('reading');
    this.inspectEl = el;
    document.addEventListener('keydown', this.onKey, true);
    // reading pauses the hide that waits for an idle stage too
    clearTimeout(this.endTimer);
    // (checked each second: a choice for the player arriving meanwhile shortens it)
    const opened = performance.now();
    this.inspectTimer = window.setInterval(() => performance.now() - opened >= this.pauseLimit() && this.closeInspect(), 1000);
    this.onPause(true);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      this.closeInspect();
    }
  };

  get inspecting() {
    return this.inspectEl !== null;
  }

  closeInspect(resume = true) {
    clearInterval(this.inspectTimer);
    document.removeEventListener('keydown', this.onKey, true);
    const el = this.inspectEl;
    if (!el) return;
    this.inspectEl = null;
    this.root.classList.remove('reading');
    const pic = el.querySelector<HTMLElement>('.chs-pic');
    if (pic) render(null, pic);
    el.remove();
    if (resume) this.onPause(false);
    if (this.idleArmed && this.showing) this.idle();
  }
}
