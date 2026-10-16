// Cards that physically move (Touch screen). When a card changes place between two board
// states (deck to hand, hand to a zone, a zone to the Graveyard, a hand card back to the
// deck...), a copy of it flies along an arc from where it was to where it is now, and the
// real card shows once it lands; a card landing on the field slams down with a ring.
//
// Kept cheap for phones: one fixed layer, a handful of small elements, Web Animations on
// transform and opacity only (composited), nothing per frame in JS. Rects are measured once
// per board change. Nothing flies while a 3D cinematic is on stage (it shows the move itself),
// while the tab is hidden, or when the phone asks for reduced motion.
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { DuelState, Pid } from '../eds/types';
import { holdFigure, hush } from '../art/hold';

/** Where a card is: a place name ("hand0", "mz1", "gy0", ...). */
type Where = string;
interface Snap {
  rect: DOMRect;
  /** the picture it showed: an image URL, or '' for a card back */
  face: string;
  def: boolean;
}

/** Every card's place in `s`. */
export function placesOf(s: DuelState): Map<number, Where> {
  const out = new Map<number, Where>();
  s.players.forEach((ps, p) => {
    ps.hand.forEach((c) => out.set(c.uid, `hand${p}`));
    ps.mz.forEach((c) => c && out.set(c.uid, `mz${p}`));
    ps.sz.forEach((c) => c && out.set(c.uid, `sz${p}`));
    if (ps.field) out.set(ps.field.uid, `fz${p}`);
    ps.gy.forEach((c) => out.set(c.uid, `gy${p}`));
    ps.deck.forEach((c) => out.set(c.uid, `deck${p}`));
    ps.removed.forEach((c) => out.set(c.uid, `rm${p}`));
    ps.fusion.forEach((c) => out.set(c.uid, `ex${p}`));
  });
  return out;
}

/** The pile a place shows up at when the card itself has no element there. */
const pileOf = (w: Where): string | null => {
  const p = w.slice(-1);
  if (w.startsWith('gy') || w.startsWith('rm')) return `gy${p}`;
  if (w.startsWith('deck') || w.startsWith('ex')) return `deck${p}`;
  return null;
};
const onField = (w: Where) => w.startsWith('mz') || w.startsWith('sz') || w.startsWith('fz');

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const busy = () => typeof document !== 'undefined' && (document.hidden || document.body.classList.contains('art-on'));

function snapOf(el: Element): Snap {
  const img = el.querySelector('img.cimg') as HTMLImageElement | null;
  return { rect: el.getBoundingClientRect(), face: img?.src ?? '', def: !!el.querySelector('.fcard.def') };
}

let layer: HTMLDivElement | null = null;
function flightLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'tflights';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  return layer;
}

export interface Flight {
  from: DOMRect;
  to: DOMRect;
  face: string;
  /** lands sideways (a Defense Position monster) */
  def: boolean;
  /** the card it becomes, hidden until the copy lands */
  target: HTMLElement | null;
  /** lands on the field: slam and ring */
  slam: boolean;
  /** flies into a pile: shrinks and fades as it goes in */
  intoPile: boolean;
  delay: number;
  /** opponent's side: a softer, shorter arc */
  fromOpp: boolean;
  /** a monster landing in a Monster Zone: its 3D figure waits for the landing */
  uid?: number;
}

/** Flies one card copy (see the file comment). */
export function fly(f: Flight): void {
  const host = flightLayer();
  const el = document.createElement('div');
  el.className = `tflight ${f.face ? '' : 'back'}`;
  if (f.face) {
    const img = document.createElement('img');
    img.src = f.face;
    img.draggable = false;
    el.appendChild(img);
  }
  // The copy is the size of where it lands; it starts scaled to where it took off.
  const w = f.to.width, h = f.to.height;
  const portraitW = f.def ? h : w, portraitH = f.def ? w : h;
  el.style.width = `${portraitW}px`;
  el.style.height = `${portraitH}px`;
  el.style.left = `${f.to.left + f.to.width / 2 - portraitW / 2}px`;
  el.style.top = `${f.to.top + f.to.height / 2 - portraitH / 2}px`;
  host.appendChild(el);
  const dx = f.from.left + f.from.width / 2 - (f.to.left + f.to.width / 2);
  const dy = f.from.top + f.from.height / 2 - (f.to.top + f.to.height / 2);
  const s0 = Math.max(0.25, Math.min(2.5, f.from.width / Math.max(1, f.def ? portraitH : portraitW)));
  const dist = Math.hypot(dx, dy);
  const lift = Math.min(70, dist * 0.22) * (f.fromOpp ? -0.6 : 1);
  const r1 = f.def ? 90 : 0;
  const r0 = (dx > 0 ? -1 : 1) * Math.min(14, dist / 25);
  const ms = Math.round(Math.min(520, 260 + dist * 0.45));
  const end = f.intoPile ? 0.55 : 1;
  const frames: Keyframe[] = [
    { transform: `translate(${dx}px, ${dy}px) rotate(${r0}deg) scale(${s0})`, opacity: f.intoPile ? 1 : 0.85, offset: 0 },
    { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - lift}px) rotate(${(r0 + r1) / 2}deg) scale(${f.slam ? 1.28 : (s0 + end) / 2 + 0.08})`, opacity: 1, offset: 0.55 },
    { transform: `translate(0, 0) rotate(${r1}deg) scale(${end})`, opacity: f.intoPile ? 0 : 1, offset: 1 },
  ];
  if (f.target) f.target.style.opacity = '0';
  if (f.uid !== undefined) holdFigure(f.uid, performance.now() + f.delay + ms);
  const anim = el.animate(frames, { duration: ms, delay: f.delay, easing: 'cubic-bezier(.3,.7,.25,1)', fill: 'both' });
  const done = () => {
    el.remove();
    if (f.target) {
      f.target.style.opacity = '';
      if (f.slam) {
        f.target.animate([{ transform: 'scale(1.16)', filter: 'brightness(1.8)' }, { transform: 'scale(1)', filter: 'brightness(1)' }], { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1.3)' });
        const ring = document.createElement('div');
        ring.className = 'tland';
        ring.style.left = `${f.to.left + f.to.width / 2}px`;
        ring.style.top = `${f.to.top + f.to.height / 2}px`;
        ring.style.width = ring.style.height = `${Math.max(w, h) * 1.1}px`;
        host.appendChild(ring);
        ring.addEventListener('animationend', () => ring.remove());
        setTimeout(() => ring.remove(), 900);
      }
    }
  };
  anim.onfinish = done;
  anim.oncancel = done;
}

/**
 * The Touch screen's moving cards: call with the root of the duel screen and the board
 * shown. `acting` is the seat at the bottom.
 */
export function useFlights(root: { current: HTMLElement | null }, state: DuelState, acting: Pid): void {
  const prev = useRef<{ places: Map<number, Where>; snaps: Map<string, Snap>; key: string } | null>(null);
  const seat = useRef(acting);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** The screen's layout changed (a resize): measure every card at the next move. */
  const stale = useRef(true);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => (stale.current = true));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The field swings into place as the duel opens (arena.css tmat-in): measure again once it has settled.
  useLayoutEffect(() => {
    const t = setTimeout(() => {
      const el = root.current;
      const cur = prev.current;
      if (!el || !cur) return;
      el.querySelectorAll('[data-uid]').forEach((n) => cur.snaps.set(`u${(n as HTMLElement).dataset.uid}`, snapOf(n)));
      el.querySelectorAll('[data-pile]').forEach((n) => cur.snaps.set((n as HTMLElement).dataset.pile!, snapOf(n)));
    }, 1100);
    return () => clearTimeout(t);
  }, []);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const places = placesOf(state);
    // The engine changes its state in place, so a move is spotted by where every card is.
    let key = '';
    places.forEach((w, uid) => (key += `${uid}${w}`));
    if (prev.current?.key === key && seat.current === acting) return;
    const before = prev.current;
    const snaps = new Map<string, Snap>();
    // Measured again: the hands (they shift with every card in or out), the cards that moved
    // and the piles; a card still in its field zone keeps its place from last time (the zones
    // are a fixed grid; on a resize, everything again).
    const all = !before || seat.current !== acting || stale.current;
    stale.current = false;
    el.querySelectorAll('[data-uid]').forEach((n) => {
      const uid = Number((n as HTMLElement).dataset.uid);
      const k = `u${uid}`;
      const w = places.get(uid);
      const kept = all || !w || !onField(w) || w !== before!.places.get(uid) ? null : before!.snaps.get(k);
      if (!kept) return void snaps.set(k, snapOf(n));
      // (a card can turn face-up where it stands: its picture is read again, its place is not)
      const img = n.querySelector('img.cimg') as HTMLImageElement | null;
      snaps.set(k, { rect: kept.rect, face: img?.src ?? '', def: !!n.querySelector('.fcard.def') });
    });
    el.querySelectorAll('[data-pile]').forEach((n) => snaps.set((n as HTMLElement).dataset.pile!, snapOf(n)));
    prev.current = { places, snaps, key };
    // A new duel (or a seat swap on one phone): start fresh, dealing the opening hands.
    const fresh = !before || seat.current !== acting;
    seat.current = acting;
    if (reduced() || busy()) return;
    const flights: Flight[] = [];
    const moved: [number, Where | undefined, Where][] = [];
    if (fresh) {
      if (state.turn > 1) return;
      places.forEach((w, uid) => w.startsWith('hand') && moved.push([uid, `deck${w.slice(-1)}`, w]));
    } else
      places.forEach((w, uid) => {
        const was = before!.places.get(uid);
        if (was !== undefined && was !== w) moved.push([uid, was, w]);
      });
    if (moved.length === 0 || moved.length > 12) return;
    let draws = 0;
    for (const [uid, was, w] of moved) {
      const fromSnap = (before?.snaps.get(`u${uid}`) && was && !pileOf(was) ? before.snaps.get(`u${uid}`) : null) ?? (was && pileOf(was) ? (before ?? prev.current).snaps.get(pileOf(was)!) : null);
      const targetEl = el.querySelector(`[data-uid="${uid}"]`) as HTMLElement | null;
      const toSnap = targetEl && !pileOf(w) ? snaps.get(`u${uid}`) : pileOf(w) ? snaps.get(pileOf(w)!) : null;
      if (!fromSnap || !toSnap) continue;
      const dist = Math.hypot(fromSnap.rect.left - toSnap.rect.left, fromSnap.rect.top - toSnap.rect.top);
      if (dist < 10 || toSnap.rect.width === 0) continue;
      const into = !!pileOf(w);
      // the picture: what it shows where it lands, or (into a pile, face down at the start) what it showed
      const face = into ? (w.startsWith('gy') ? (toSnap.face || fromSnap.face) : '') : toSnap.face;
      const isDraw = was?.startsWith('deck') && w.startsWith('hand');
      flights.push({
        from: fromSnap.rect,
        to: toSnap.rect,
        face,
        def: !into && toSnap.def,
        target: into ? null : targetEl,
        slam: onField(w) && !onField(was ?? ''),
        intoPile: into,
        delay: isDraw ? draws++ * (fresh ? 110 : 90) : 0,
        fromOpp: w.endsWith(String(1 - acting)),
        uid: w.startsWith('mz') ? uid : undefined,
      });
    }
    if (!fresh) return flights.forEach(fly);
    // The opening deal waits for the field to swing into place (arena.css tmat-in), the
    // hands hidden meanwhile; then every rect is measured again and the cards fly.
    flights.forEach((f) => f.target && (f.target.style.opacity = '0'));
    // the art loader stands back until the cards are in hand (its first pictures stalled the deal)
    hush(3500);
    const go = () => {
      const now = root.current;
      for (const f of flights) {
        const uid = f.target?.dataset.uid;
        const t = uid && now ? (now.querySelector(`[data-uid="${uid}"]`) as HTMLElement | null) : null;
        const pile = t && now ? now.querySelector(`[data-pile="deck${t.closest('.thand') ? acting : 1 - acting}"]`) : null;
        if (!t || !pile || busy()) {
          if (f.target) f.target.style.opacity = '';
          continue;
        }
        fly({ ...f, from: pile.getBoundingClientRect(), to: t.getBoundingClientRect(), target: t });
      }
    };
    // after the field's swing-in has ended (its animationend), or 1.5 s at the latest
    const mat = el.querySelector('.tmat');
    let done = false;
    const once = (ev?: Event) => {
      if (done || (ev && ev.target !== mat)) return;
      done = true;
      mat?.removeEventListener('animationend', once);
      go();
    };
    // (the swing starts once the screen is armed, a couple of frames after it opens)
    const armed = el.classList.contains('armed');
    if (mat && (!armed || mat.getAnimations?.().some((a) => a.playState === 'running'))) mat.addEventListener('animationend', once);
    else timers.current.push(setTimeout(once, 50));
    timers.current.push(setTimeout(once, armed ? 1500 : 2500));
  });
  useLayoutEffect(() => () => timers.current.forEach(clearTimeout), []);
}
