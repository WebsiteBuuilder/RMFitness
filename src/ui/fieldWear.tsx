// Field wear (Speed Duels): a Monster Zone scorches and cracks where a monster was destroyed,
// and the damage stays until the duel ends. A second destruction in the same zone leaves a
// crater and longer cracks; the third shatters the slab. The marks take the colours of the
// duelist's own Field Spell landscape (lava seeps on a volcano, wet cracks by the ocean,
// straight seams on a machine floor...) and re-tint when it changes.
// The count lives in the engine state (fx.wear), so it is the same on both phones online, after
// a rejoin and in a replay; a new duel starts clean. The marks sit under the card and under the
// zone's highlights, and never take a tap.
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import type { DuelState, Pid } from '../eds/types';
import { fieldTerrain } from './atmosphereRules';
import { H, landed, landingAt, MAX_LOOK, newLanding, W, wearHits, wearOf, wearStyle, type Landing, type WearHit } from './fieldWearRules';
import './fieldwear.css';

export { wearOf };

/** What a zone's wear depends on (for a memoized zone's signature). */
export function wearKey(state: DuelState, p: Pid, zone: number): string {
  const n = wearOf(state, p, zone);
  return n ? `${n}:${wearStyle(fieldTerrain(state, p))}` : '';
}

/** One hit's marks merged into one path per layer (a handful of nodes per zone, not hundreds). */
interface Drawn {
  h: WearHit;
  specks: string;
  embers: string;
  plSh: string;
  plFace: string;
  plLit: string;
  gap: string;
  core: string;
  chipSh: string;
  chipFace: string;
  chipLit: string;
}
const dot = ([x, y, r]: [number, number, number]) => `M${(x - r).toFixed(1)} ${y}a${r} ${r} 0 1 0 ${(2 * r).toFixed(2)} 0a${r} ${r} 0 1 0 ${(-2 * r).toFixed(2)} 0`;
const merge = (h: WearHit): Drawn => ({
  h,
  specks: h.specks.map(dot).join(''),
  embers: h.embers.map(dot).join(''),
  plSh: h.plates.map((c) => c.shadow).join(''),
  plFace: h.plates.map((c) => c.face).join(''),
  plLit: h.plates.map((c) => c.lit).join(' '),
  gap: h.cracks.map((c) => c.gap).join(''),
  core: h.cracks.map((c) => c.core).join(''),
  chipSh: h.chips.map((c) => c.shadow).join(''),
  chipFace: h.chips.map((c) => c.face).join(''),
  chipLit: h.chips.map((c) => c.lit).join(' '),
});

const rmq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const reduced = () => !!rmq?.matches;

/** Embers smouldering round a card that stands on a worn zone (seeded: the same every render). */
function embersOf(p: number, zone: number, lv: number, seed: number): string {
  let s = (p * 977 + zone * 131 + 7 + Math.imul(seed, 2246822519)) >>> 0;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  let d = '';
  for (let i = 0; i < 5 + lv * 3; i++) {
    // along the frame: pick an edge, a spot on it, just outside or on the line
    const e = Math.floor(r() * 4);
    const t = r();
    const o = 0.8 + r() * 1.6;
    const x = e === 0 ? t * W : e === 1 ? W - o : e === 2 ? t * W : o;
    const y = e === 0 ? o : e === 1 ? t * H : e === 2 ? H - o : t * H;
    const rr = 0.5 + r() * 0.8;
    d += dot([+x.toFixed(1), +y.toFixed(1), +rr.toFixed(2)]);
  }
  return d;
}

interface Props {
  state: DuelState;
  p: Pid;
  zone: number;
}

export function ZoneWear({ state, p, zone }: Props) {
  const held = !!state.players[p].mz[zone];
  const n = wearOf(state, p, zone);
  const style = wearStyle(fieldTerrain(state, p));
  // (a mark that appears while this zone is on screen is fresh: it lands with a flare and cools;
  //  one already there when the board mounts, after a rejoin or a hand-over, is simply there)
  //  (the flag stays on the newest mark, so a later re-render never cuts its animation short)
  const land = useRef<Landing>(newLanding());
  const [, setTick] = useState(0);
  const fresh = landingAt(land.current, n, reduced());
  const done = () => {
    if (!fresh || land.current.cooled >= fresh) return;
    landed(land.current, fresh);
    setTick((t) => t + 1);
  };
  // (a fallback: a landing paused under a long cinematic, or cancelled by a settings change, still ends)
  useEffect(() => {
    if (!fresh) return;
    const id = setTimeout(done, 15000);
    return () => clearTimeout(id);
  }, [fresh]);
  const uid = useId();
  const grid = style === 'tech';
  // (drawn once per new mark, not on every render of the board)
  const seed = state.seed | 0;
  const hits = useMemo(() => (n ? wearHits(p, zone, n, grid, seed).map(merge) : []), [p, zone, Math.min(n, MAX_LOOK), grid, seed]);
  if (!n) return null;
  const lv = Math.min(n, MAX_LOOK);
  const id = `fw${uid.replace(/[^\w-]/g, '')}`;
  return (
    <>
    {/* a monster standing on the damage: soot and embers bleed past the card and the zone's frame */}
    {held && (
      <svg class={`fwear-held st-${style} lv-${lv}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <rect class="fw-held-soot" x="1.5" y="1.5" width={W - 3} height={H - 3} rx="4" />
        <rect class="fw-held-heat" x="1" y="1" width={W - 2} height={H - 2} rx="4" />
        <path class="fw-held-embers" d={embersOf(p, zone, lv, seed)} />
      </svg>
    )}
    <svg
      class={`fwear st-${style} lv-${lv}${n > MAX_LOOK ? ' more' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      onAnimationEnd={(ev) => (ev as AnimationEvent).animationName === 'fw-cool' && done()}
    >
      <defs>
        <radialGradient id={`${id}c`}>
          <stop offset="0" class="fw-s-core" />
          <stop offset="0.42" class="fw-s-core" />
          <stop offset="0.66" class="fw-s-mid" />
          <stop offset="0.82" class="fw-s-rim" />
          <stop offset="0.9" class="fw-s-out" />
        </radialGradient>
        <radialGradient id={`${id}f`}>
          <stop offset="0" class="fw-s-f0" />
          <stop offset="0.22" class="fw-s-f0" />
          <stop offset="0.45" class="fw-s-f1" />
          <stop offset="1" class="fw-s-f2" />
        </radialGradient>
        <radialGradient id={`${id}p`}>
          <stop offset="0" class="fw-s-pit0" />
          <stop offset="1" class="fw-s-pit1" />
        </radialGradient>
      </defs>
      {/* the third hit darkens the whole slab */}
      {lv >= 3 && <ellipse class="fw-soot" cx={W / 2} cy={H / 2} rx={W * 0.48} ry={H * 0.44} fill={`url(#${id}c)`} />}
      {/* a monster standing on the damage: its scorched edge still shows round the card */}
      {hits.map(({ h, specks, embers, plSh, plFace, plLit, gap, core, chipSh, chipFace, chipLit }, i) => {
        const k = i + 1;
        // the newest mark flares; a 4th+ destruction re-lights the worst one
        const isFresh = fresh && k === Math.min(fresh, MAX_LOOK);
        return (
          <g key={k < MAX_LOOK ? k : `${k}-${n}`} class={`fw-hit${isFresh ? ' fresh' : ''}`} style={{ '--hx': `${h.x}px`, '--hy': `${h.y}px` } as Record<string, string>}>
            <path class="fw-blot" d={h.blot} fill={`url(#${id}c)`} />
            {k >= 2 && (
              // a crater: dark pit, a lit rim toward the light (up-left), a shadowed lip opposite
              <g class="fw-crater">
                <ellipse class="fw-lip-lit" cx={h.x - 0.7} cy={h.y - 0.8} rx={h.r * 0.42} ry={h.r * 0.52} pathLength={100} />
                <ellipse class="fw-pit" cx={h.x} cy={h.y} rx={h.r * 0.4} ry={h.r * 0.5} fill={`url(#${id}p)`} />
                <ellipse class="fw-lip-dark" cx={h.x + 0.5} cy={h.y + 0.7} rx={h.r * 0.33} ry={h.r * 0.42} pathLength={100} />
              </g>
            )}
            <path class="fw-speck" d={specks} />
            <path class="fw-ember" d={embers} />
            <g class="fw-dark">
              <path d={gap} />
            </g>
            <g class="fw-glow">
              <path d={core} />
            </g>
            {isFresh && <path class="fw-hot" d={core} />}
            {plFace && (
              // the slab breaks into plates; the fire shows in the gaps between them
              <g class="fw-plates">
                <ellipse class="fw-plate-fire" cx={h.x} cy={h.y} rx={W * 0.42} ry={H * 0.4} fill={`url(#${id}f)`} />
                <path class="fw-plate-sh" d={plSh} />
                <path class="fw-plate-face" d={plFace} />
                <path class="fw-plate-char" d={plFace} />
                <path class="fw-plate-lit" d={plLit} />
              </g>
            )}
            {chipFace && (
              <g class="fw-chip">
                <path class="fw-chip-sh" d={chipSh} />
                <path class="fw-chip-face" d={chipFace} />
                <path class="fw-chip-char" d={chipFace} />
                <path class="fw-chip-lit" d={chipLit} />
              </g>
            )}
            {isFresh && <ellipse class="fw-flash" cx={h.x} cy={h.y} rx={h.r * 1.3} ry={h.r * 1.5} fill={`url(#${id}f)`} />}
            {isFresh && <ellipse class="fw-ring" cx={h.x} cy={h.y} rx={h.r * 0.8} ry={h.r} />}
          </g>
        );
      })}
    </svg>
    </>
  );
}
