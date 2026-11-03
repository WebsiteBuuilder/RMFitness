// Field wear (Speed Duels): a Monster Zone scorches and cracks where a monster was destroyed,
// and the damage stays until the duel ends. A second destruction in the same zone leaves a
// crater and longer cracks; the third shatters the slab. The marks take the colours of the
// duelist's own Field Spell landscape (lava seeps on a volcano, wet cracks by the ocean,
// straight seams on a machine floor...) and re-tint when it changes.
// The count lives in the engine state (fx.wear), so it is the same on both phones online, after
// a rejoin and in a replay; a new duel starts clean. The marks sit under the card and under the
// zone's highlights, and never take a tap.
import { useId, useMemo, useRef, useState } from 'preact/hooks';
import type { DuelState, Pid } from '../eds/types';
import { fieldTerrain } from './atmosphereRules';
import { H, MAX_LOOK, W, wearHits, wearOf, wearStyle, type WearHit } from './fieldWearRules';
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
  gap: h.cracks.map((c) => c.gap).join(''),
  core: h.cracks.map((c) => c.core).join(''),
  chipSh: h.chips.map((c) => c.shadow).join(''),
  chipFace: h.chips.map((c) => c.face).join(''),
  chipLit: h.chips.map((c) => c.lit).join(' '),
});

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
  const seen = useRef<number | null>(null);
  const freshN = useRef(0);
  if (seen.current !== null && n > seen.current) freshN.current = n;
  const cooled = useRef(0);
  if (n < (seen.current ?? 0)) freshN.current = cooled.current = 0; // (a replay stepping back)
  seen.current = n;
  // (once the landing has played, the mark drops its animation classes: nothing left running or clipped)
  const [, setTick] = useState(0);
  const fresh = freshN.current > cooled.current ? freshN.current : 0;
  const uid = useId();
  const grid = style === 'tech';
  // (drawn once per new mark, not on every render of the board)
  const hits = useMemo(() => (n ? wearHits(p, zone, n, grid).map(merge) : []), [p, zone, Math.min(n, MAX_LOOK), grid]);
  if (!n) return null;
  const lv = Math.min(n, MAX_LOOK);
  const id = `fw${uid.replace(/[^\w-]/g, '')}`;
  return (
    <svg
      class={`fwear st-${style} lv-${lv}${n > MAX_LOOK ? ' more' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      onAnimationEnd={(ev) => {
        if ((ev as AnimationEvent).animationName === 'fw-cool' && fresh) {
          cooled.current = fresh;
          setTick((t) => t + 1);
        }
      }}
    >
      <defs>
        <radialGradient id={`${id}c`}>
          <stop offset="0" class="fw-s-core" />
          <stop offset="0.5" class="fw-s-mid" />
          <stop offset="0.84" class="fw-s-rim" />
          <stop offset="0.95" class="fw-s-out" />
        </radialGradient>
        <radialGradient id={`${id}f`}>
          <stop offset="0" class="fw-s-f0" />
          <stop offset="0.35" class="fw-s-f1" />
          <stop offset="1" class="fw-s-f2" />
        </radialGradient>
        <radialGradient id={`${id}p`}>
          <stop offset="0" class="fw-s-pit0" />
          <stop offset="1" class="fw-s-pit1" />
        </radialGradient>
      </defs>
      {/* the third hit darkens the whole slab */}
      {lv >= 3 && <rect class="fw-soot" x="0" y="0" width={W} height={H} />}
      {/* a monster standing on the damage: its scorched edge still shows round the card */}
      {held && <rect class="fw-held" x="1" y="1" width={W - 2} height={H - 2} rx="4" />}
      {hits.map(({ h, specks, gap, core, chipSh, chipFace, chipLit }, i) => {
        const k = i + 1;
        // the newest mark flares; a 4th+ destruction re-lights the worst one
        const isFresh = fresh && k === Math.min(fresh, MAX_LOOK);
        return (
          <g key={isFresh ? `${k}-${fresh}` : k} class={`fw-hit${isFresh ? ' fresh' : ''}`} style={{ '--hx': `${h.x}px`, '--hy': `${h.y}px` } as Record<string, string>}>
            <path class="fw-blot" d={h.blot} fill={`url(#${id}c)`} />
            {k >= 2 && <ellipse class="fw-pit" cx={h.x} cy={h.y} rx={h.r * 0.36} ry={h.r * 0.45} fill={`url(#${id}p)`} />}
            <path class="fw-speck" d={specks} />
            <g class="fw-dark">
              <path d={gap} />
            </g>
            <g class="fw-glow">
              <path d={core} />
            </g>
            {chipFace && (
              <g class="fw-chip">
                <path class="fw-chip-sh" d={chipSh} />
                <path class="fw-chip-face" d={chipFace} />
                <path class="fw-chip-lit" d={chipLit} />
              </g>
            )}
            {isFresh && <ellipse class="fw-flash" cx={h.x} cy={h.y} rx={h.r * 1.3} ry={h.r * 1.5} fill={`url(#${id}f)`} />}
            {isFresh && <ellipse class="fw-ring" cx={h.x} cy={h.y} rx={h.r * 0.8} ry={h.r} />}
          </g>
        );
      })}
    </svg>
  );
}
