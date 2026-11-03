// Damage counter pop: every Life Points change on the board lands with weight.
// - LpPops: the amount pops out of the LP plate (red, scaled to the hit; green for a heal)
//   and drifts off into the field, with a DANGER tag when the hit drops a duelist to
//   1000 LP or less.
// - LpCracks: the LP bar cracks from where the gauge lost its chunk, more cracks and longer
//   ones the harder the hit. The cracks flash, then stay on as faint scars (the last few
//   hits) until a heal mends them.
// - useLpShake: the board shakes, a twitch for a scratch, a jolt for a crushing blow, more
//   in danger; less for a blow you deal than one you take. None with reduced motion.
// The hits come from the on-screen counter (art/flow.tsx LpCount), so they land when the
// number actually changes: after the cinematic's own hit, in step with the count.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { Pid } from '../eds/types';
import { crackPaths, lpBarMemory, lpHit, lpListeners, sparkCount, seeded, MAX_SCARS, OPP_SHAKE, startLp, type Crack, type LpHit } from './lpHitRules';
import { lpCrack, lpSpark } from './duelSfx';
import './lphit.css';

type Listener = (who: Pid, from: number, to: number) => void;
const listeners = lpListeners;

function useLpHits(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l: Listener = (w, f, t) => ref.current(w, f, t);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}

/** setTimeout that is cleared when the component goes away. */
function useLater() {
  const ts = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => ts.current.forEach(clearTimeout), []);
  return (fn: () => void, ms: number) => {
    const t = setTimeout(() => (ts.current.delete(t), fn()), ms);
    ts.current.add(t);
    return t;
  };
}

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let seq = 0;

// ----------------------------------------------------------------- the floating number

interface Pop {
  id: number;
  hit: LpHit;
}

/** The numbers that pop out of `who`'s LP plate. `below`: the plate is at the top of the screen. */
export function LpPops({ who, speed, below }: { who: Pid; speed: boolean; below: boolean }) {
  const [pops, setPops] = useState<Pop[]>([]);
  const later = useLater();
  useLpHits((w, from, to) => {
    if (w !== who) return;
    const hit = lpHit(from, to, speed);
    if (!hit) return;
    const id = ++seq;
    setPops((p) => [...p.slice(-2), { id, hit }]);
    later(() => setPops((p) => p.filter((x) => x.id !== id)), hit.intoDanger ? 1700 : 1300);
  });
  if (!pops.length) return null;
  return (
    <>
      {pops.map(({ id, hit }) => (
        <span
          key={id}
          class={`lppop ${below ? 'below' : 'above'} ${hit.kind}${hit.danger || hit.ko ? ' crit' : ''} t${hit.tier}`}
          style={{ '--s': hit.scale.toFixed(2) } as Record<string, string>}
          aria-hidden="true"
        >
          <b>
            {hit.kind === 'heal' ? '+' : '−'}
            {hit.amount}
          </b>
          {hit.intoDanger && <em>DANGER</em>}
        </span>
      ))}
    </>
  );
}

// ----------------------------------------------------------------- the cracked bar

interface Scar {
  id: number;
  w: number;
  h: number;
  x: number;
  y: number;
  cracks: Crack[];
  hit: LpHit;
}

/**
 * The cracks over `who`'s LP bar (put it inside the bar, which must be positioned).
 * They burst from the chunk the gauge (`.tgauge`) lost, or from the LP plate (`.tlp`, `.lp`)
 * when the bar has no gauge.
 */
export function LpCracks({ who, speed }: { who: Pid; speed: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // (kept per duelist: a hotseat board swaps the bars, keyed by duelist, every turn)
  const [scars, setScars] = useState<Scar[]>(() => (lpBarMemory.get(who) as Scar[] | undefined) ?? []);
  useEffect(() => void lpBarMemory.set(who, scars), [scars]);
  const [fresh, setFresh] = useState(0);
  const [mending, setMending] = useState(false);
  const mend = useRef<ReturnType<typeof setTimeout> | null>(null);
  const later = useLater();
  const [sparks, setSparks] = useState<{ id: number; x: number; y: number; n: number } | null>(null);
  useLpHits((w, from, to) => {
    if (w !== who) return;
    const hit = lpHit(from, to, speed);
    const el = box.current;
    if (!hit || !el) return;
    if (hit.kind === 'heal') {
      // a heal mends the bar: the scars fade out
      if (scars.length && !mend.current) {
        setMending(true);
        const healed = new Set(scars.map((x) => x.id));
        mend.current = later(() => {
          mend.current = null;
          setScars((s) => s.filter((x) => !healed.has(x.id)));
          setMending(false);
        }, 520);
      }
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const bar = el.parentElement;
    const gauge = bar?.querySelector<HTMLElement>('.tgauge')?.getBoundingClientRect();
    let x: number;
    let y: number;
    if (gauge && gauge.width > 0) {
      // the middle of the chunk the gauge just lost
      const start = startLp(speed);
      const span = (Math.min(1, from / Math.max(start, from)) + Math.max(0, to) / Math.max(start, from)) / 2;
      x = gauge.left - r.left + gauge.width * span;
      y = gauge.top - r.top + gauge.height / 2;
    } else {
      const plate = bar?.querySelector<HTMLElement>('.tlp, .lp')?.getBoundingClientRect();
      x = plate ? plate.left - r.left + plate.width / 2 : r.width / 2;
      y = plate ? plate.top - r.top + plate.height / 2 : r.height / 2;
    }
    const id = ++seq;
    const cracks = crackPaths(hit, x, y, r.width, r.height, id * 7919 + to);
    // (a blow mid-mend: the old scars still go, the new one stays and shows)
    setMending(false);
    setFresh(id);
    setScars((s) => [...s.slice(-(MAX_SCARS - 1)), { id, w: r.width, h: r.height, x, y, cracks, hit }]);
    if (hit.tier > 0 || hit.danger) lpCrack(hit.sev, hit.danger || hit.ko);
    // breaking under 1000: the gauge throws sparks from where its fill now ends
    const n = sparkCount(hit);
    if (n) {
      const end = gauge && gauge.width > 0 ? gauge.left - r.left + gauge.width * Math.max(0, to) / Math.max(startLp(speed), from) : x;
      setSparks({ id, x: end, y, n });
      later(() => setSparks((sp) => (sp?.id === id ? null : sp)), 1200);
      if (hit.intoDanger) lpSpark();
    }
  });
  const last = fresh;
  let sparkEls: preact.JSX.Element[] = [];
  if (sparks) {
    const rnd = seeded(sparks.id);
    sparkEls = Array.from({ length: sparks.n }, (_, i) => {
      // a fan thrown up and out of the gauge, a few falling back down past it
      const a = -Math.PI / 2 + (rnd() - 0.5) * 2.6;
      const d = 18 + rnd() * 46;
      const dx = Math.cos(a) * d;
      const dy = Math.sin(a) * d * 0.8 + 10 + rnd() * 10;
      return (
        <i
          key={i}
          class={i % 3 === 0 ? 'long' : ''}
          style={{ left: `${sparks.x.toFixed(1)}px`, top: `${sparks.y.toFixed(1)}px`, '--dx': `${dx.toFixed(1)}px`, '--dy': `${dy.toFixed(1)}px`, '--a': `${((a * 180) / Math.PI).toFixed(0)}deg`, '--t': `${(rnd() * 0.12).toFixed(2)}s` } as Record<string, string>}
        />
      );
    });
  }
  return (
    <>
    {sparks && (
      <div key={sparks.id} class="lpsp" aria-hidden="true">
        {sparkEls}
      </div>
    )}
    <div ref={box} class={`lpcr${mending ? ' mend' : ''}`} aria-hidden="true">
      {scars.map((s) => (
        <div key={s.id} class={`lpcr-scar${s.id === last ? ' fresh' : ''}${s.hit.danger || s.hit.ko ? ' crit' : ''}`}>
          <svg viewBox={`0 0 ${s.w.toFixed(1)} ${s.h.toFixed(1)}`} preserveAspectRatio="none">
            {s.cracks.map((c, i) => (
              <g key={i} class={c.main ? 'm' : 'b'} style={{ '--i': String(i % 6) } as Record<string, string>}>
                <path class="sh" d={c.d} pathLength={1} />
                <path class="co" d={c.d} pathLength={1} />
              </g>
            ))}
          </svg>
          {s.id === last && (
            // the hot glow: its own layer, so fading it out is a composited opacity change
            <svg class="lpcr-hot" viewBox={`0 0 ${s.w.toFixed(1)} ${s.h.toFixed(1)}`} preserveAspectRatio="none">
              {s.cracks.map((c, i) => (
                <path key={i} class="gl" d={c.d} pathLength={1} style={{ '--i': String(i % 6) } as Record<string, string>} />
              ))}
            </svg>
          )}
          {s.id === last && (
            <i
              class="lpcr-flash"
              style={{ left: `${((s.x / s.w) * 100).toFixed(1)}%`, top: `${((s.y / s.h) * 100).toFixed(1)}%`, '--r': `${Math.round(30 + s.hit.reach * 0.6)}px` } as Record<string, string>}
            />
          )}
        </div>
      ))}
    </div>
    </>
  );
}

// ----------------------------------------------------------------- the shake

const shaking = new WeakMap<Element, Animation>();

/**
 * Shakes the parts of the board that `sel` picks inside `root` when Life Points drop:
 * scaled to the hit, more for `me`'s own (the player at this screen, null: both are).
 * `off`: a replay or a spectator's view (it shows the hits, not the jolts).
 * Moves them with `translate` alone, so it never fights a `transform` animation.
 */
export function useLpShake(root: RefObject<HTMLElement>, me: Pid | null, speed: boolean, sel: string, off = false) {
  useLpHits((who, from, to) => {
    const hit = lpHit(from, to, speed);
    if (off || !hit || hit.kind !== 'damage' || !root.current || reduced()) return;
    const amp = hit.shake * (me === null || who === me ? 1 : OPP_SHAKE);
    if (amp < 1) return;
    const els = root.current.querySelectorAll<HTMLElement>(sel);
    if (!els.length || typeof els[0].animate !== 'function') return;
    // a decaying rattle: big first jolt (down, toward the hit on your side), then smaller swings
    const n = 7;
    const frames: Keyframe[] = [{ translate: '0 0' }];
    for (let k = 1; k < n; k++) {
      const d = amp * (1 - k / n) ** 1.6;
      const sx = k % 2 ? 1 : -1;
      frames.push({ translate: `${(sx * d).toFixed(1)}px ${((k === 1 ? 0.8 : -0.4 * sx) * d * 0.6).toFixed(1)}px` });
    }
    frames.push({ translate: '0 0' });
    for (const el of els) {
      // the finishing blow: the field has its own KO shake (arena.css ko-shake), on the same property
      if (hit.ko && el.classList.contains('tmat')) continue;
      shaking.get(el)?.cancel();
      const a = el.animate(frames, { duration: hit.shakeMs, easing: 'linear' });
      shaking.set(el, a);
      a.onfinish = () => shaking.get(el) === a && shaking.delete(el);
    }
  });
}
