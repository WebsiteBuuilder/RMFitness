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
  /** the turn pill in the lane: the trails keep clear of it */
  pill: { x: number; y: number; w: number; h: number } | null;
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
  const pe = mat.querySelector<HTMLElement>(':scope > .tmid .tturn');
  const pill = pe ? boxIn(pe, mat) : null;
  return { w: mat.offsetWidth, h: mat.offsetHeight, zw: z0.offsetWidth, top, bottom, pill };
}

const boardKey = (b: Board) => [b.w, b.h, b.zw, b.pill?.x ?? 0, b.pill?.w ?? 0, b.pill?.y ?? 0, b.top.top, b.top.bottom, b.bottom.top, b.bottom.bottom, ...b.top.xs, ...b.bottom.xs].map((v) => Math.round(v)).join(',');

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
    i: { x: direct ? ax : def.xs[s.to], y: mid + (fromNear ? 1 : -1) * zh * 0.3 },
    zw: b.zw,
    direct,
    avoid: b.pill && { x: b.pill.x - 7, y: b.pill.y - 7, w: b.pill.w + 14, h: b.pill.h + 14 },
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
  FIRE: ['#ff5a14', 0.5],
  WATER: ['#aef0ff', 0.42],
  WIND: ['#8affc0', 0.3],
  EARTH: ['#5a3a18', 0.55],
  NONE: ['#5a3a18', 0.55],
  LIGHT: ['#fff4dc', 0.4],
  DIVINE: ['#ffe2a0', 0.48],
  DARK: ['#3a0858', 0.75],
};

/** layers that are ground (multiplied into the mat) rather than light */
const BASE = new Set(['sc-soot', 'sc-pit']);
/** halos that are stains (multiplied) rather than glows */
const DARK_HALO = new Set(['EARTH', 'NONE', 'DARK']);
/** sparks flung from a fresh blow (unit directions, scaled by the mark's size) */
const SPARKS: [number, number][] = [[1.1, -0.5], [-1, -0.7], [0.3, -1.2], [-0.4, 1], [1.2, 0.6], [-1.2, 0.3]];

interface Drawn {
  s: Scar;
  g: ScarGeo;
  halo: { cx: number; cy: number; rx: number; ry: number };
  trail: Layer[];
  hit: Layer[];
}

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
  // the mark that lands while we watch flares; ones already there when the board opens (a rejoin, a replay
  // jump), when the switch is turned back on, or when a rematch starts on the same screen do not
  const seen = useRef<{ n: number; seed: number; on: boolean } | null>(null);
  const seedNow = state.seed | 0;
  if (!seen.current || seen.current.seed !== seedNow || (on && !seen.current.on)) seen.current = { n: lastN, seed: seedNow, on };
  seen.current.on = on;

  useLayoutEffect(() => {
    if (!on || !count) return;
    const svg = ref.current;
    const mat = svg?.parentElement;
    if (!mat) return;
    const re = () => {
      const m = measure(mat, zones);
      // (a new object only when something moved: the marks redraw only then)
      setBoard((old) => (m && old && boardKey(m) === boardKey(old) ? old : m));
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
  // each mark is drawn once and kept (a new blow draws only itself); a resize or the board turning round redraws all
  const cache = useRef<{ key: unknown; seed: number; map: Map<number, Drawn | null> }>({ key: null, seed: 0, map: new Map() });
  const marks = useMemo(() => {
    if (!board) return [];
    const c = cache.current;
    // (a new board size or a new duel, such as a rematch on the same screen: start over)
    if (c.key !== board || c.seed !== seed || c.map.size > 64) c.map = new Map();
    c.key = board;
    c.seed = seed;
    const nearKey = near * 100000;
    return scars.map((s, i) => {
      let d = c.map.get(nearKey + s.n);
      if (d === undefined) {
        const g = geoOf(s, board, near);
        if (g) {
          const m = scarMark(s, g, seed);
          d = { s, g, halo: m.halo, trail: merged(m.trail), hit: merged(m.hit) };
        } else d = null;
        c.map.set(nearKey + s.n, d);
      }
      return d && { ...d, op: scarAge(i, scars.length) };
    });
    // (scars only grow, and each keeps its running number: the last number and the count say it all)
  }, [board, near, seed, lastN, count]);

  const uid = useId().replace(/[^\w-]/g, '');
  if (!on || !count) return null;
  const used = new Set(marks.map((m) => m?.s.attr));
  const fresh = lastN > seen.current.n ? lastN : 0;
  const vb = board ? `0 0 ${board.w} ${board.h}` : '0 0 1 1';
  const groupOf = (m: NonNullable<(typeof marks)[number]>) => ({
    key: m.s.n,
    class: `sc sc-${m.s.attr.toLowerCase()}${m.s.n === fresh ? ' fresh' : ''}${m.g.direct ? ' direct' : ''}${m.op < 1 ? ' old' : ''}`,
    style: { '--age': m.op.toFixed(2), '--ix': `${m.g.i.x.toFixed(1)}px`, '--iy': `${m.g.i.y.toFixed(1)}px` } as Record<string, string>,
  });
  const paths = (layers: Layer[], keep: (c: string) => boolean) => layers.filter(([c]) => keep(c)).map(([c, d]) => <path key={c} class={c} d={d} />);
  const dark = (a: string) => DARK_HALO.has(a);
  return (
    <>
      {/* the burnt, broken ground: multiplied into the mat, so its own texture shows through the char */}
      <svg ref={ref} class="tscars base" viewBox={vb} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          {[...used].map((a) => a && dark(a) && <Halo key={a} id={`${uid}-${a}`} a={a} />)}
        </defs>
        {/* the trails first: under every blow */}
        <g>
          {marks.map((m) => {
            if (!m) return null;
            const g = groupOf(m);
            return (
              <g key={g.key} class={`${g.class} sc-trail`} style={g.style}>
                {paths(m.trail, (c) => BASE.has(c))}
              </g>
            );
          })}
        </g>
        {marks.map((m) => {
          if (!m) return null;
          const g = groupOf(m);
          return (
            <g key={g.key} class={g.class} style={g.style}>
              {dark(m.s.attr) && <ellipse class="sc-halo" cx={m.halo.cx} cy={m.halo.cy} rx={m.halo.rx} ry={m.halo.ry} fill={`url(#${uid}-${m.s.attr})`} />}
              <g class="sc-hit">{paths(m.hit, (c) => BASE.has(c))}</g>
            </g>
          );
        })}
      </svg>
      {/* what still glows: embers, frost, light burnt into the stone */}
      <svg class="tscars glow" viewBox={vb} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          {[...used].map((a) => a && !dark(a) && <Halo key={a} id={`${uid}-${a}`} a={a} />)}
          <radialGradient id={`${uid}-f`}>
            <stop offset="0" stop-color="#fff" stop-opacity="1" />
            <stop offset="0.35" stop-color="#fff6d8" stop-opacity="0.85" />
            <stop offset="1" stop-color="#ffd9a0" stop-opacity="0" />
          </radialGradient>
        </defs>
        <g>
          {marks.map((m) => {
            if (!m) return null;
            const g = groupOf(m);
            return (
              <g key={g.key} class={`${g.class} sc-trail`} style={g.style}>
                {paths(m.trail, (c) => !BASE.has(c))}
              </g>
            );
          })}
        </g>
        {marks.map((m) => {
          if (!m) return null;
          const g = groupOf(m);
          const isFresh = m.s.n === fresh;
          const hot = isFresh ? m.hit.filter(([c]) => c === 'sc-burn' || c === 'sc-hot' || c === 'sc-edge').map(([, d]) => d).join('') : '';
          return (
            <g key={g.key} class={g.class} style={g.style}>
              {!dark(m.s.attr) && <ellipse class="sc-halo" cx={m.halo.cx} cy={m.halo.cy} rx={m.halo.rx} ry={m.halo.ry} fill={`url(#${uid}-${m.s.attr})`} />}
              <g class="sc-hit">{paths(m.hit, (c) => !BASE.has(c))}</g>
              {isFresh && (
                <g class="sc-land">
                  {/* white-hot first, cooling to the Attribute's colour from the outside in */}
                  <path class="sc-whitehot" d={hot} />
                  <ellipse class="sc-flash" cx={m.halo.cx} cy={m.halo.cy} rx={m.halo.rx * 0.9} ry={m.halo.ry * 0.9} fill={`url(#${uid}-f)`} />
                  <ellipse class="sc-ring" cx={m.halo.cx} cy={m.halo.cy} rx={m.halo.rx * 0.6} ry={m.halo.ry * 0.6} />
                  {SPARKS.map(([dx, dy], k) => (
                    <circle key={k} class="sc-spark" cx={m.halo.cx} cy={m.halo.cy} r={1.1} style={{ '--sx': `${(dx * m.halo.rx).toFixed(1)}px`, '--sy': `${(dy * m.halo.ry).toFixed(1)}px`, animationDelay: `${(k % 3) * 40}ms` } as Record<string, string>} />
                  ))}
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </>
  );
}

function Halo({ id, a }: { id: string; a: string }) {
  const [c, o] = HALO[a] ?? HALO.NONE;
  return (
    <radialGradient id={id}>
      {/* (a quick falloff: a glow or a stain, never a disc) */}
      <stop offset="0" stop-color={c} stop-opacity={o} />
      <stop offset="0.3" stop-color={c} stop-opacity={o * 0.6} />
      <stop offset="0.65" stop-color={c} stop-opacity={o * 0.18} />
      <stop offset="1" stop-color={c} stop-opacity="0" />
    </radialGradient>
  );
}
