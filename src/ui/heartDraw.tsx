// The Heart of the Cards draw (Speed Duel): your Draw Phase card waits on top of your deck
// until you swipe up (or tap the deck, or press A) to draw it yourself. When you're behind,
// it becomes a destiny draw: the room goes dark, the deck glows gold, and the card rises,
// turns over in a burst of light and shows its name before it flies into your hand.
//
// Only the picture waits: the duel itself has already drawn the card (nothing here touches
// the rules, the room's log or the other phone). The card is hidden in your hand until it
// arrives; a timer draws it for you if you don't, so a turn never stalls.
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'preact/hooks';
import type { DuelState, Pid } from '../eds/types';
import { CardImg } from './CardImg';
import { fly } from './flights';
import { artBusy, onArtChange } from '../art/cues';
import * as sfx from './duelSfx';
import { setDrawHeld } from './immersionState';
import './immersion.css';

// ----------------------------------------------------------------- setting

export type DrawStyle = 'swipe' | 'auto';
const KEY = 'eds.drawStyle';
const EVT = 'eds-drawstyle';
export const DRAW_STYLE_NAMES: Record<DrawStyle, string> = { swipe: 'Swipe up', auto: 'Automatic' };

export function getDrawStyle(): DrawStyle {
  try {
    return localStorage.getItem(KEY) === 'auto' ? 'auto' : 'swipe';
  } catch {
    return 'swipe';
  }
}
export function setDrawStyle(s: DrawStyle) {
  try {
    localStorage.setItem(KEY, s);
  } catch {
    /* storage blocked */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVT));
}
export function useDrawStyle(): DrawStyle {
  const [s, set] = useState(getDrawStyle);
  useEffect(() => {
    const f = () => set(getDrawStyle());
    window.addEventListener(EVT, f);
    return () => window.removeEventListener(EVT, f);
  }, []);
  return s;
}

// ----------------------------------------------------------------- rules of the moment (pure, tested)

export { DESTINY_GAP, DESTINY_LOW, isDestiny, topSeq, freshDraw } from './heartRules';
import { isDestiny, topSeq, freshDraw } from './heartRules';

/** How long the card waits for you before drawing itself (ms). */
export const AUTO_MS = { normal: 5000, destiny: 12000 };

// ----------------------------------------------------------------- the hook

export interface DrawGateInfo {
  uid: number;
  destiny: boolean;
  /** this duel's destiny draws before this one (a repeat plays shorter) */
  repeat: number;
  key: number;
}

/** The card waiting to be drawn (call while the duel screen renders, before its children). */
export function useHeartDraw(state: DuelState, acting: Pid, on: boolean): [DrawGateInfo | null, () => void] {
  const ref = useRef<{ last: number; gate: DrawGateInfo | null; destinies: number } | null>(null);
  if (!ref.current) ref.current = { last: topSeq(state), gate: null, destinies: 0 };
  const r = ref.current;
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => () => setDrawHeld(null), []);
  const d = freshDraw(state, acting, r.last);
  if (d) {
    r.last = d.seq;
    if (on) {
      const destiny = isDestiny(state, acting);
      r.gate = { uid: d.uid, destiny, repeat: destiny ? r.destinies++ : 0, key: d.seq };
    }
  } else r.last = Math.max(r.last, topSeq(state));
  // the card left your hand some other way, or the duel ended: nothing to wait for
  if (r.gate && (state.winner !== null || !state.players[acting].hand.some((c) => c.uid === r.gate!.uid))) r.gate = null;
  setDrawHeld(r.gate?.uid ?? null);
  const done = () => {
    r.gate = null;
    setDrawHeld(null);
    force(0);
  };
  return [r.gate, done];
}


// ----------------------------------------------------------------- the screen

/** The "Swipe up to draw" words show for your first few draws on this phone; the chevrons always do. */
const HINT_TIMES = 4;
const HINT_KEY = 'eds.drawHints';
const hintCount = () => {
  try {
    return Number(localStorage.getItem(HINT_KEY)) || 0;
  } catch {
    return 0;
  }
};
const bumpHint = () => {
  try {
    localStorage.setItem(HINT_KEY, String(hintCount() + 1));
  } catch {
    /* storage blocked */
  }
};

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const handEl = (uid: number) => document.querySelector(`.thand [data-uid="${uid}"], .hand [data-uid="${uid}"]`) as HTMLElement | null;
const deckEl = (p: Pid) => document.querySelector(`[data-pile="deck${p}"]`) as HTMLElement | null;
const faceOf = (el: HTMLElement | null) => (el?.querySelector('img.cimg') as HTMLImageElement | null)?.src ?? '';

export function DrawGate({ gate, state, acting, blocked, onDone }: { gate: DrawGateInfo; state: DuelState; acting: Pid; blocked: boolean; onDone: () => void }) {
  const card = state.players[acting].hand.find((c) => c.uid === gate.uid);
  // the gate opens once no cinematic is playing (and the phone has been handed over)
  const [idle, setIdle] = useState(!artBusy());
  useEffect(() => onArtChange(() => setIdle(!artBusy())), []);
  const up = idle && !blocked;
  const [phase, setPhase] = useState<'wait' | 'reveal'>('wait');
  const [deck, setDeck] = useState<DOMRect | null>(null);
  const [nudge, setNudge] = useState(0);
  const finished = useRef(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const k = gate.repeat > 0 ? 0.62 : 1;

  // where the deck is (it can move with a resize)
  useLayoutEffect(() => {
    const measure = () => setDeck(deckEl(acting)?.getBoundingClientRect() ?? null);
    measure();
    addEventListener('resize', measure);
    return () => removeEventListener('resize', measure);
  }, [acting]);

  // the card draws itself by this time (counted from when the gate first opened, not again after a cinematic)
  const deadline = useRef(0);
  useEffect(() => {
    if (!up || phase !== 'wait') return;
    if (!deadline.current) {
      deadline.current = Date.now() + (gate.destiny ? AUTO_MS.destiny : AUTO_MS.normal);
      sfx.deckReady(gate.destiny);
    }
    const t = setTimeout(() => release(), Math.max(1500, deadline.current - Date.now()));
    return () => clearTimeout(t);
  }, [up, phase]);

  /** The card flies from `from` into its place in your hand. */
  const land = (from: DOMRect) => {
    if (finished.current) return;
    finished.current = true;
    const to = handEl(gate.uid);
    if (to && !reduced()) {
      const r = to.getBoundingClientRect();
      if (r.width > 0) fly({ from, to: r, face: faceOf(to), def: false, target: to, slam: false, intoPile: false, delay: 0, fromOpp: false });
    }
    onDone();
  };

  const release = () => {
    if (phase !== 'wait' || finished.current) return;
    bumpHint();
    swallowClick();
    const from = deckEl(acting)?.getBoundingClientRect() ?? deck;
    if (!gate.destiny || reduced() || !from) {
      sfx.drawSwipe();
      return from ? land(from) : ((finished.current = true), onDone());
    }
    setPhase('reveal');
  };

  // ----- the destiny reveal -----
  const cardRef = useRef<HTMLDivElement>(null);
  const flipRef = useRef<HTMLDivElement>(null);
  const auraRef = useRef<HTMLDivElement>(null);
  const [named, setNamed] = useState(false);
  const skipTo = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    if (phase !== 'reveal') return;
    const el = cardRef.current, flip = flipRef.current, aura = auraRef.current;
    const from = deckEl(acting)?.getBoundingClientRect() ?? deck;
    if (!el || !flip || !from) return land(from ?? new DOMRect(innerWidth / 2, innerHeight, 1, 1));
    const box = el.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (box.left + box.width / 2);
    const dy = from.top + from.height / 2 - (box.top + box.height / 2);
    const s0 = from.width / box.width;
    const T = (ms: number) => Math.round(ms * k);
    const anims: Animation[] = [];
    const timers: number[] = [];
    sfx.destinyRise();
    anims.push(
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${s0}) rotateX(0deg)`, offset: 0 },
          { transform: `translate(${dx * 0.3}px, ${dy * 0.35}px) scale(${(s0 + 1) / 2}) rotateX(18deg)`, offset: 0.55 },
          { transform: 'translate(0, 0) scale(1) rotateX(0deg)', offset: 1 },
        ],
        { duration: T(760), easing: 'cubic-bezier(.25,.8,.3,1)', fill: 'both' },
      ),
    );
    // it trembles in the light...
    anims.push(
      el.animate(
        [{ translate: '0 0' }, { translate: '-2px 1px' }, { translate: '2px -1px' }, { translate: '-1px -2px' }, { translate: '1px 2px' }, { translate: '0 0' }],
        { duration: T(380), delay: T(760), iterations: 1, easing: 'linear' },
      ),
    );
    if (aura) anims.push(aura.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }, { opacity: 1, transform: 'scale(1.15)' }], { duration: T(1150), easing: 'ease-out', fill: 'both' }));
    // ...turns over...
    anims.push(flip.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }], { duration: T(620), delay: T(1140), easing: 'cubic-bezier(.5,0,.3,1)', fill: 'both' }));
    timers.push(
      window.setTimeout(() => {
        sfx.destinyReveal();
        setNamed(true);
        try {
          navigator.vibrate?.([30, 40, 70]);
        } catch {
          /* no vibration here */
        }
      }, T(1430)),
    );
    // ...and flies into your hand
    const go = () => {
      timers.forEach(clearTimeout);
      land(el.getBoundingClientRect());
    };
    skipTo.current = go;
    timers.push(window.setTimeout(go, T(2650)));
    return () => {
      timers.forEach(clearTimeout);
      anims.forEach((a) => a.cancel());
    };
  }, [phase]);

  // ----- input: swipe up anywhere, tap the deck, Enter / Space / Up -----
  useEffect(() => {
    if (!up) return;
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'ArrowUp' && ev.key !== 'Enter' && ev.key !== ' ') return;
      // (typing in the chat, or a key held down from before, is not a draw)
      const t = ev.target as HTMLElement | null;
      if (ev.repeat || t?.isContentEditable || t?.matches?.('input, textarea, select')) return;
      ev.preventDefault();
      if (phase === 'wait') release();
      else skipTo.current();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [up, phase]);
  const down = (ev: PointerEvent) => {
    if (phase !== 'wait') return skipTo.current();
    start.current = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
  };
  const move = (ev: PointerEvent) => {
    const s = start.current;
    if (!s || s.id !== ev.pointerId) return;
    if (s.y - ev.clientY > 28 && Math.abs(ev.clientX - s.x) < (s.y - ev.clientY) * 1.6) {
      // drawn the moment the swipe reads (the finger still down: the click that follows is swallowed)
      start.current = null;
      release();
    }
  };
  const lift = (ev: PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || phase !== 'wait') return;
    // a tap on (or near) the deck draws too; anywhere else, a nudge toward it
    const d = deckEl(acting)?.getBoundingClientRect();
    const near = d && ev.clientX > d.left - 24 && ev.clientX < d.right + 24 && ev.clientY > d.top - 40 && ev.clientY < d.bottom + 24;
    if (near) release();
    else setNudge((n) => n + 1);
  };

  if (!up || !card) return <style>{hideCss(gate.uid)}</style>;
  const cx = deck ? deck.left + deck.width / 2 : innerWidth - 40;
  const cy = deck ? deck.top + deck.height / 2 : innerHeight - 120;
  const vars = { '--hx': `${cx}px`, '--hy': `${cy}px`, '--hw': `${deck?.width ?? 50}px`, '--hh': `${deck?.height ?? 72}px` } as Record<string, string>;
  // the destiny card: big in the middle of the screen
  const w = Math.min(innerWidth * 0.62, innerHeight * 0.44 * 0.686, 300);
  return (
    <div
      class={`hd-gate ${gate.destiny ? 'destiny' : 'normal'} hd-${phase} ${named ? 'hd-hit' : ''}`}
      style={vars}
      role="dialog"
      aria-label={gate.destiny ? 'Destiny draw' : 'Draw'}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={lift}
      onPointerCancel={() => (start.current = null)}
    >
      <style>{hideCss(gate.uid)}</style>
      <div class="hd-shade" />
      {phase === 'wait' && (
        <>
          <div class="hd-glow" />
          {gate.destiny && <div class="hd-rays" />}
          <div key={nudge} class={`hd-hint ${nudge ? 'nudge' : ''}`}>
            <span class="hd-chev" />
            <span class="hd-chev" />
            <span class="hd-chev" />
          </div>
          <button class="hd-deck main" aria-label="Draw your card" onClick={(ev) => (ev.stopPropagation(), release())} />
          {gate.destiny ? (
            <div class={`hd-words ${cy < innerHeight * 0.45 ? 'hd-low' : ''}`}>
              <b>Believe in the heart of the cards</b>
              <em>
                {state.players[acting].lp} LP vs {state.players[acting === 0 ? 1 : 0].lp} LP
              </em>
              <span>Swipe up for your destiny draw</span>
            </div>
          ) : (
            hintCount() < HINT_TIMES && <div class="hd-chip">Swipe up to draw</div>
          )}
        </>
      )}
      {phase === 'reveal' && (
        <>
          <div class="hd-stage-rays" />
          <div ref={cardRef} class="hd-card" style={{ width: `${w}px`, height: `${w * 1.458}px`, left: `${innerWidth / 2 - w / 2}px`, top: `${innerHeight * 0.4 - w * 0.729}px` }}>
            <div ref={auraRef} class="hd-aura" />
            <div ref={flipRef} class="hd-flip">
              <div class="hd-face hd-back">
                <CardImg name="" back />
              </div>
              <div class="hd-face hd-front">
                <CardImg name={card.name} owner={card.owner} />
              </div>
            </div>
          </div>
          <button class="hd-skip main" aria-label="Skip" onClick={() => skipTo.current()} />
          {named && <div class="hd-burst" />}
          {named && (
            <div class="hd-name" style={{ top: `${innerHeight * 0.4 + w * 0.76}px` }}>
              <small>Destiny draw</small>
              <b>{card.name}</b>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The tap that ends a swipe or a tap on the deck lands on nothing underneath (the gate is gone by then). */
function swallowClick() {
  const eat = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  document.addEventListener('click', eat, true);
  setTimeout(() => document.removeEventListener('click', eat, true), 450);
}

const hideCss = (uid: number) => `.thand [data-uid="${uid}"], .hand [data-uid="${uid}"] { visibility: hidden !important; }`;
