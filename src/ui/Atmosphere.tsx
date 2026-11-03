// The duel's atmosphere around the cards (Speed Duels):
//   Living Field: a face-up Field Spell's landscape stays up as the arena behind the
//     board for as long as the card is on the field, sweeping out from its Field Zone
//     when it lands (src/art/livingField.ts).
//   Danger state: at low Life Points (a quarter of the starting LP, then an eighth)
//     your half of the field cracks and the screen's edges glow red. Your heart beats
//     in bursts of a few seconds (the edge, the cracks and, with Sound on, a heartbeat
//     you hear): when you fall into danger or deeper, when you take damage in it, and
//     at the start of your turn; a faint glow holds in between. The opponent's half
//     cracks (dimmer) when they are the one in danger, so you can see the kill is close.
// Nothing here takes a tap: every layer is pointer-events: none, and the red never
// lies over the cards in your hand.
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { DuelState, Pid } from '../eds/types';
import { dangerLevel, fieldTerrain } from './atmosphereRules';
import { LivingField } from '../art/livingField';
import { groundCrack, heartbeat } from './duelSfx';
import './atmosphere.css';

export { dangerLevel };

/** Heartbeat periods (ms) for danger levels 1 and 2. */
const BEAT_MS = [0, 1150, 800];
/** How long a burst of heartbeats lasts (ms). */
const BURST_MS = 6000;

let shared: LivingField | null = null;
let users = 0;

interface Props {
  state: DuelState;
  /** whose screen this is */
  me: Pid;
  speed: boolean;
}

export function DuelAtmosphere({ state, me, speed }: Props) {
  const opp = (1 - me) as Pid;
  const over = state.winner !== null && state.winner !== undefined;
  const mineT = fieldTerrain(state, me);
  const oppT = fieldTerrain(state, opp);
  const lv = [0, 1].map((p) => (over ? 0 : dangerLevel(state.players[p].lp, speed)));
  const dMe = lv[me];
  const dOpp = lv[opp];
  const myLp = state.players[me].lp;
  const edge = useRef<HTMLDivElement>(null);
  const field = useRef<LivingField | null>(null);
  /** each duelist's danger level last time (by seat, so a hotseat hand-over never replays the crack) */
  const lastLv = useRef<number[]>(lv); // (joining mid-duel, a rejoin or a replay seek is not news: no crack)
  const burstUntil = useRef(0);
  const lastLp = useRef(myLp);
  const lastTurn = useRef(state.turnPlayer);
  const lastMe = useRef(me);

  // one canvas for the whole app (a rematch or the next duel reuses it)
  useEffect(() => {
    users++;
    try {
      shared ??= new LivingField();
    } catch {
      shared = null;
    }
    field.current = shared;
    if (location.search.includes('debug')) (window as unknown as Record<string, unknown>).__lf = shared;
    return () => {
      users--;
      field.current = null;
      // (a tick later: the next duel screen may mount right after this one)
      setTimeout(() => {
        if (users === 0 && shared) (shared.dispose(), (shared = null));
      }, 0);
    };
  }, []);

  useEffect(() => {
    const f = field.current;
    if (!f) return;
    // a hotseat hand-over flips the board: the halves trade places at once (no new sweep)
    if (lastMe.current !== me) f.swapSides();
    lastMe.current = me;
    f.setFields(oppT, mineT);
  }, [mineT, oppT, me]);

  // danger: the ground cracks when a duelist first falls into (deeper) danger
  useEffect(() => {
    field.current?.setDanger(dMe, dOpp);
    const prev = lastLv.current;
    const deeper = lv.some((l, p) => l > prev[p]);
    if (deeper && !document.body.classList.contains('art-on')) groundCrack();
    if (lv[me] > prev[me]) burstUntil.current = performance.now() + BURST_MS;
    lastLv.current = lv;
    document.body.classList.toggle('danger-me', dMe > 0);
    document.body.classList.toggle('danger-me-2', dMe > 1);
    document.body.classList.toggle('danger-opp', dOpp > 0);
  }, [lv[0], lv[1]]);

  // ...and the heart races again when you take damage while in danger, and at the start of your turn
  useEffect(() => {
    if (dMe && myLp < lastLp.current) burstUntil.current = performance.now() + BURST_MS;
    lastLp.current = myLp;
  }, [myLp]);
  useEffect(() => {
    if (dMe && state.turnPlayer === me && lastTurn.current !== me) burstUntil.current = performance.now() + BURST_MS;
    lastTurn.current = state.turnPlayer;
  }, [state.turnPlayer]);
  // (a hotseat hand-over: the new duelist's own danger is not news, no burst)
  useEffect(() => {
    lastLp.current = myLp;
  }, [me]);

  // the heartbeat: sound, edge pulse and the cracks' flare, on one clock
  useEffect(() => {
    if (!dMe) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const beat = () => {
      if (document.hidden) return;
      const loud = performance.now() < burstUntil.current;
      if (loud) field.current?.beat();
      if (!reduced) {
        const k = loud ? 1 : 0.4;
        const keys = [{ opacity: 0.3 }, { opacity: 0.3 + 0.7 * k, offset: 0.12 }, { opacity: 0.3 + 0.3 * k, offset: 0.3 }, { opacity: 0.3 + 0.5 * k, offset: 0.42 }, { opacity: 0.3 }];
        const opts = { duration: Math.min(900, BEAT_MS[dMe] - 50), easing: 'ease-out' };
        edge.current?.animate(keys, opts);
        if (loud) document.querySelector('.tcracks.me .tcracks-glow')?.animate([{ opacity: 0.55 }, { opacity: 1, offset: 0.15 }, { opacity: 0.55 }], opts);
      }
      // (under a cinematic the heartbeat holds its breath: the cinematic has its own sound)
      if (loud && !document.body.classList.contains('art-on')) heartbeat(dMe > 1);
    };
    beat();
    const id = setInterval(beat, BEAT_MS[dMe]);
    return () => clearInterval(id);
  }, [dMe]);

  useEffect(
    () => () => {
      for (const c of ['danger-me', 'danger-me-2', 'danger-opp']) document.body.classList.remove(c);
    },
    [],
  );

  return <div ref={edge} class={`danger-edge${dMe ? ` on lv-${dMe}` : ''}`} aria-hidden="true" />;
}

// ---------------------------------------------------------------- cracks on the field

/** A small seeded random generator (the same cracks every render). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

interface Crack {
  d: string;
  /** stroke width scale: the trunk is thick, branches taper */
  w: number;
}

/**
 * Ground cracks: one or two impact points on the duelist's edge of the mat, a few
 * trunks splitting from each and tapering branches off them (100×100 box, y = 100 the
 * duelist's edge). Level 2 adds a second impact and longer reach.
 */
function crackPaths(seed: number, level: number): Crack[] {
  const r = rng(seed);
  const out: Crack[] = [];
  const grow = (x: number, y: number, ang: number, len: number, w: number, depth: number) => {
    let d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    const steps = 5 + Math.floor(r() * 3);
    for (let i = 0; i < steps; i++) {
      ang += (r() - 0.5) * 0.7;
      const l = (len / steps) * (0.7 + r() * 0.6);
      x += Math.cos(ang) * l;
      y += Math.sin(ang) * l;
      d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
      if (depth < 2 && i > 0 && r() < 0.32) grow(x, y, ang + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.5), len * 0.42, w * 0.55, depth + 1);
    }
    out.push({ d, w });
  };
  const impacts = level > 1 ? [28 + r() * 12, 64 + r() * 14] : [38 + r() * 24];
  for (const x of impacts) {
    const trunks = 3;
    for (let k = 0; k < trunks; k++) grow(x, 100, -Math.PI / 2 + (k - 1) * (0.55 + r() * 0.3), (level > 1 ? 70 : 52) + r() * 20, 1, 0);
  }
  return out;
}

/** The impact points (where trunks start on the duelist's edge). */
function impactsOf(paths: Crack[]): [number, number][] {
  const seen = new Map<string, [number, number]>();
  for (const c of paths) {
    const m = /^M([\d.]+) 100(\.0)?\b/.exec(c.d);
    if (m && c.w === 1) seen.set(m[1], [Number(m[1]), 100]);
  }
  return [...seen.values()];
}

/** Red cracks over one duelist's half of the mat (level 0 draws nothing). */
export function FieldCracks({ level, side }: { level: number; side: 'me' | 'opp' }) {
  const paths = useMemo(() => (level ? crackPaths(side === 'me' ? 7 : 19, level) : []), [side, level]);
  if (!level) return null;
  return (
    <svg class={`tcracks ${side} lv-${level}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <g class="tcracks-dark">
        {paths.map((c, i) => (
          <path key={i} d={c.d} style={{ strokeWidth: `${(4 * c.w).toFixed(2)}px` }} />
        ))}
      </g>
      <g class="tcracks-glow">
        {paths.map((c, i) => (
          <path key={i} d={c.d} style={{ strokeWidth: `${(8 * c.w).toFixed(2)}px` }} />
        ))}
      </g>
      <g class="tcracks-core">
        {paths.map((c, i) => (
          <path key={i} d={c.d} style={{ strokeWidth: `${(2.2 * c.w + 0.4).toFixed(2)}px` }} />
        ))}
      </g>
      <g class="tcracks-hot">
        {paths.map((c, i) => (
          <path key={i} d={c.d} style={{ strokeWidth: `${(0.9 * c.w).toFixed(2)}px` }} />
        ))}
      </g>
      {/* a starburst where the ground took the blow */}
      <defs>
        <radialGradient id={`tburst-${side}`}>
          <stop offset="0" stop-color="#fff2e0" stop-opacity="1" />
          <stop offset="0.35" stop-color="#ff5a2a" stop-opacity="0.75" />
          <stop offset="1" stop-color="#ff2a1a" stop-opacity="0" />
        </radialGradient>
      </defs>
      {impactsOf(paths).map(([x, y], i) => (
        <ellipse key={`b${i}`} class="tcracks-burst" cx={x} cy={y} rx={10} ry={8} fill={`url(#tburst-${side})`} />
      ))}
    </svg>
  );
}
