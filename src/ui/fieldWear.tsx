// Field wear (Speed Duels): a Monster Zone scorches and cracks where a monster was destroyed,
// and the damage stays until the duel ends. A second destruction in the same zone leaves a
// crater and longer cracks; the third shatters the slab. The marks take the colours of the
// duelist's own Field Spell landscape (lava seeps on a volcano, wet cracks by the ocean,
// straight seams on a machine floor...) and re-tint when it changes.
// The count lives in the engine state (fx.wear), so it is the same on both phones online, after
// a rejoin and in a replay; a new duel starts clean. The marks sit under the card and under the
// zone's highlights, and never take a tap.
import { useMemo, useRef } from 'preact/hooks';
import type { DuelState, Pid } from '../eds/types';
import { fieldTerrain } from './atmosphereRules';
import { H, MAX_LOOK, W, wearHits, wearOf, wearStyle } from './fieldWearRules';
import './fieldwear.css';

export { wearOf };

/** What a zone's wear depends on (for a memoized zone's signature). */
export function wearKey(state: DuelState, p: Pid, zone: number): string {
  const n = wearOf(state, p, zone);
  return n ? `${n}:${wearStyle(fieldTerrain(state, p))}` : '';
}

interface Props {
  state: DuelState;
  p: Pid;
  zone: number;
}

export function ZoneWear({ state, p, zone }: Props) {
  const n = wearOf(state, p, zone);
  const style = wearStyle(fieldTerrain(state, p));
  // (a mark that appears while this zone is on screen is fresh: it lands with a flare and cools;
  //  one already there when the board mounts, after a rejoin or a hand-over, is simply there)
  //  (the flag stays on the newest mark, so a later re-render never cuts its animation short)
  const seen = useRef<number | null>(null);
  const freshN = useRef(0);
  if (seen.current !== null && n > seen.current) freshN.current = n;
  if (n < (seen.current ?? 0)) freshN.current = 0;
  seen.current = n;
  const fresh = freshN.current;
  const grid = style === 'tech';
  // (drawn once per new mark, not on every render of the board)
  const hits = useMemo(() => (n ? wearHits(p, zone, n, grid) : []), [p, zone, Math.min(n, MAX_LOOK), grid]);
  if (!n) return null;
  const lv = Math.min(n, MAX_LOOK);
  const id = `fw${p}${zone}`;
  return (
    <svg class={`fwear st-${style} lv-${lv}${n > MAX_LOOK ? ' more' : ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}c`}>
          <stop offset="0" class="fw-s-core" />
          <stop offset="0.5" class="fw-s-mid" />
          <stop offset="0.8" class="fw-s-rim" />
          <stop offset="1" class="fw-s-out" />
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
      {hits.map((h, i) => {
        const k = i + 1;
        // the newest mark flares; a 4th+ destruction re-lights the worst one
        const isFresh = fresh && (k === Math.min(fresh, MAX_LOOK));
        return (
          <g key={isFresh ? `${k}-${fresh}` : k} class={`fw-hit${isFresh ? ' fresh' : ''}`} style={{ '--hx': `${h.x}px`, '--hy': `${h.y}px` } as Record<string, string>}>
            <path class="fw-blot" d={h.blot} fill={`url(#${id}c)`} />
            {k >= 2 && <ellipse class="fw-pit" cx={h.x} cy={h.y} rx={h.r * 0.36} ry={h.r * 0.45} fill={`url(#${id}p)`} />}
            {h.specks.map(([x, y, s], j) => (
              <circle key={j} class="fw-speck" cx={x} cy={y} r={s} />
            ))}
            <g class="fw-dark">
              {h.cracks.map((c, j) => (
                <path key={j} d={c.gap} />
              ))}
            </g>
            <g class="fw-glow">
              {h.cracks.map((c, j) => (
                <path key={j} d={c.core} />
              ))}
            </g>
            {h.chips.map((d, j) => (
              <path key={`c${j}`} class="fw-chip" d={d} />
            ))}
            {isFresh && <ellipse class="fw-flash" cx={h.x} cy={h.y} rx={h.r * 1.3} ry={h.r * 1.5} fill={`url(#${id}f)`} />}
            {isFresh && <ellipse class="fw-ring" cx={h.x} cy={h.y} rx={h.r * 0.8} ry={h.r} />}
          </g>
        );
      })}
    </svg>
  );
}
