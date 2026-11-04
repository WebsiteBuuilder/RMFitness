// Battle scars on the mat (Speed Duel, Touch board): every landed attack leaves its Attribute's mark
// where it struck and a trail across the lane it crossed, for the rest of the duel. The marks are
// static SVG under the rows (one path per layer per scar, no per-frame work); the newest one lands
// with a short flare that waits out the cinematics (body.art-on) and is skipped with reduced motion.
// Positions come from the board itself (zone boxes measured on mount and on resize), so the marks
// follow every layout: phone, tablet, desktop, hotseat turning the board round.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DuelState, Pid } from '../eds/types';
import { scarsOf, type Scar } from '../eds/scars';
import { LAYERS, scarAge, scarMark, type Layer, type ScarGeo } from './matScarsRules';
import './matscars.css';

// ---------- the Menu switch ----------
const KEY = 'eds.scars';
export const SCARS_EVT = 'eds-scars';
export function scarsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}
export function setScarsOn(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SCARS_EVT));
}
export function useScarsOn(): boolean {
  const [on, setOn] = useState(scarsOn);
  useEffect(() => {
    const f = () => setOn(scarsOn());
    window.addEventListener(SCARS_EVT, f);
    return () => window.removeEventListener(SCARS_EVT, f);
  }, []);
  return on;
}

// ---------- measuring the board ----------
interface RowBox {
  top: number;
  bottom: number;
  /** a Monster Zone's centre x, by zone index */
  xs: number[];
}
interface Board {
  w: number;
  h: number;
  zw: number;
  top: RowBox;
  bottom: RowBox;
}

/** el's box in the mat's own (untransformed) coordinates: the offset chain up to the mat, or the
 *  screen rects (tilted, so a little off) if some ancestor in between is not on that chain */
function boxIn(el: HTMLElement, mat: HTMLElement) {
  let x = 0;
  let y = 0;
  let e: HTMLElement | null = el;
  while (e && e !== mat) {
    x += e.offsetLeft;
    y += e.offsetTop;
    const p = e.offsetParent as HTMLElement | null;
    if (p !== mat && (!p || !mat.contains(p))) {
      const a = el.getBoundingClientRect();
      const b = mat.getBoundingClientRect();
      return { x: a.left - b.left, y: a.top - b.top, w: el.offsetWidth, h: el.offsetHeight };
    }
    e = p;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

function measure(mat: HTMLElement, zones: number): Board | null {
  const rows = mat.querySelectorAll<HTMLElement>(':scope > .trow');
  if (rows.length < 4 || !mat.offsetWidth) return null;
  const row = (el: HTMLElement, top: boolean): RowBox | null => {
    const xs: number[] = [];
    let t = Infinity;
    let b = -Infinity;
    for (let i = 0; i < zones; i++) {
      // the top row lists the far player's zones right to left; the near row left to right (TouchDuel.tsx)
      const z = el.children[top ? 1 + (zones - 1 - i) : 1 + i] as HTMLElement | undefined;
      if (!z) return null;
      const bx = boxIn(z, mat);
      xs.push(bx.x + bx.w / 2);
      t = Math.min(t, bx.y);
      b = Math.max(b, bx.y + bx.h);
    }
    return { top: t, bottom: b, xs };
  };
  const top = row(rows[1], true);
  const bottom = row(rows[2], false);
  if (!top || !bottom) return null;
  const z0 = rows[2].children[1] as HTMLElement;
  return { w: mat.offsetWidth, h: mat.offsetHeight, zw: z0.offsetWidth, top, bottom };
}

/** Where a scar sits: from the attacker's front edge, across the lane, into the defender's zone
 *  (a little toward the lane, where the blow lands); a direct attack strikes the defender's line
 *  straight ahead. The zone's well is see-through, so the mark shows in an empty zone and round a card. */
function geoOf(s: Scar, b: Board, near: Pid): ScarGeo | null {
  const fromNear = s.by === near;
  const atk = fromNear ? b.bottom : b.top;
  const def = fromNear ? b.top : b.bottom;
  const ax = atk.xs[s.from];
  if (ax === undefined) return null;
  const direct = s.to < 0 || def.xs[s.to] === undefined;
  const zh = def.bottom - def.top;
  const mid = (def.top + def.bottom) / 2;
  return {
    a: { x: ax, y: fromNear ? atk.top : atk.bottom },
    i: { x: direct ? ax : def.xs[s.to], y: mid + (fromNear ? 1 : -1) * zh * 0.14 },
    zw: b.zw,
    direct,
  };
}

/** one path per class, in the layer order */
function merged(layers: Layer[]): Layer[] {
  const by = new Map<string, string>();
  for (const [c, d] of layers) by.set(c, (by.get(c) ?? '') + d);
  const out: Layer[] = [];
  for (const c of LAYERS) {
    const d = by.get(c);
    if (d) out.push([c, d]);
  }
  return out;
}

/** the soft stain round each blow, per Attribute: colour, strength at the centre */
const HALO: Record<string, [string, number]> = {
  FIRE: ['#ff4a10', 0.62],
  WATER: ['#aef0ff', 0.42],
  WIND: ['#8affc0', 0.3],
  EARTH: ['#a8804c', 0.4],
  NONE: ['#a8804c', 0.4],
  LIGHT: ['#fff0a8', 0.45],
  DIVINE: ['#ffd040', 0.55],
  DARK: ['#2a0440', 0.85],
};

interface Props {
  state: DuelState;
  /** the player at the bottom of the board */
  near: Pid;
}

export function MatScars({ state, near }: Props) {
  const on = useScarsOn();
  const ref = useRef<SVGSVGElement>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const zones = state.players[0].mz.length;
  const scars = scarsOf(state.fx as Record<string, unknown>);
  const count = scars.length;
  const lastN = count ? scars[count - 1].n : 0;
  // the mark that lands while we watch flares; ones already there when the board opens (a rejoin, a replay jump) do not
  const seenAtMount = useRef<number | null>(null);
  if (seenAtMount.current === null) seenAtMount.current = lastN;

  useLayoutEffect(() => {
    if (!on || !count) return;
    const svg = ref.current;
    const mat = svg?.parentElement;
    if (!mat) return;
    const re = () => {
      const m = measure(mat, zones);
      setBoard((old) => (m && old && m.w === old.w && m.h === old.h && m.zw === old.zw && m.top.bottom === old.top.bottom && m.bottom.top === old.bottom.top ? old : m));
    };
    re();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', re);
      return () => window.removeEventListener('resize', re);
    }
    const ro = new ResizeObserver(re);
    ro.observe(mat);
    return () => ro.disconnect();
  }, [on, count > 0, zones]);

  const seed = state.seed | 0;
  const marks = useMemo(() => {
    if (!board) return [];
    return scars.map((s, i) => {
      const g = geoOf(s, board, near);
      if (!g) return null;
      const m = scarMark(s, g, seed);
      return { s, g, op: scarAge(i, scars.length), halo: m.halo, trail: merged(m.trail), hit: merged(m.hit) };
    });
    // (scars only grow, and each keeps its running number: the last number and the count say it all)
  }, [board, near, seed, lastN, count]);

  const uid = useId().replace(/[^\w-]/g, '');
  if (!on || !count) return null;
  const used = new Set(marks.map((m) => m?.s.attr));
  const fresh = lastN > (seenAtMount.current ?? 0) ? lastN : 0;
  return (
    <svg ref={ref} class="tscars" viewBox={board ? `0 0 ${board.w} ${board.h}` : '0 0 1 1'} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        {[...used].map(
          (a) =>
            a && (
              <radialGradient key={a} id={`${uid}-${a}`}>
                <stop offset="0" stop-color={HALO[a][0]} stop-opacity={HALO[a][1]} />
                <stop offset="0.55" stop-color={HALO[a][0]} stop-opacity={HALO[a][1] * 0.5} />
                <stop offset="1" stop-color={HALO[a][0]} stop-opacity="0" />
              </radialGradient>
            ),
        )}
      </defs>
      {marks.map(
        (m) =>
          m && (
            <g
              key={m.s.n}
              class={`sc sc-${m.s.attr.toLowerCase()}${m.s.n === fresh ? ' fresh' : ''}${m.g.direct ? ' direct' : ''}`}
              style={{ opacity: m.op, '--ix': `${m.g.i.x.toFixed(1)}px`, '--iy': `${m.g.i.y.toFixed(1)}px`, '--ax': `${m.g.a.x.toFixed(1)}px`, '--ay': `${m.g.a.y.toFixed(1)}px` } as Record<string, string | number>}
            >
              <ellipse class="sc-halo" cx={m.halo.cx} cy={m.halo.cy} rx={m.halo.rx} ry={m.halo.ry} fill={`url(#${uid}-${m.s.attr})`} />
              <g class="sc-trail">
                {m.trail.map(([c, d]) => (
                  <path key={c} class={c} d={d} />
                ))}
              </g>
              <g class="sc-hit">
                {m.hit.map(([c, d]) => (
                  <path key={c} class={c} d={d} />
                ))}
              </g>
            </g>
          ),
      )}
    </svg>
  );
}
