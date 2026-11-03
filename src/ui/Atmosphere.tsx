// The duel's atmosphere around the cards (Speed Duels and the classic game alike):
//   Living Field: a face-up Field Spell's landscape stays up as the arena behind the
//     board for as long as the card is on the field (src/art/livingField.ts).
//   Danger state: at low Life Points (a quarter of the starting LP, then an eighth)
//     your half of the field cracks, the screen's edges pulse red with a heartbeat
//     and you hear it (only with Sound on). The opponent's half cracks too when
//     they are the one in danger, so you can see the kill is close.
// Nothing here takes a tap: every layer is pointer-events: none.
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { DuelState, Pid } from '../eds/types';
import { dangerLevel, fieldTerrain } from './atmosphereRules';
import { LivingField } from '../art/livingField';
import { groundCrack, heartbeat } from './duelSfx';
import './atmosphere.css';

export { dangerLevel };

/** Heartbeat periods (ms) for danger levels 1 and 2. */
const BEAT_MS = [0, 1150, 800];

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
  const dMe = over ? 0 : dangerLevel(state.players[me].lp, speed);
  const dOpp = over ? 0 : dangerLevel(state.players[opp].lp, speed);
  const edge = useRef<HTMLDivElement>(null);
  const field = useRef<LivingField | null>(null);
  const lastDanger = useRef<[number, number]>([0, 0]);

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
    field.current?.setFields(oppT, mineT);
    document.body.dataset.lfMe = mineT ?? '';
    document.body.dataset.lfOpp = oppT ?? '';
  }, [mineT, oppT]);

  useEffect(() => {
    field.current?.setDanger(dMe, dOpp);
    const [pm, po] = lastDanger.current;
    // the ground gives way: a crack when a duelist first falls into (deeper) danger
    if ((dMe > pm || dOpp > po) && !document.body.classList.contains('art-on')) groundCrack();
    lastDanger.current = [dMe, dOpp];
    document.body.classList.toggle('danger-me', dMe > 0);
    document.body.classList.toggle('danger-me-2', dMe > 1);
    document.body.classList.toggle('danger-opp', dOpp > 0);
  }, [dMe, dOpp]);

  // the heartbeat: sound, edge pulse and the cracks' flare, all on one clock
  useEffect(() => {
    if (!dMe) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const beat = () => {
      if (document.hidden) return;
      field.current?.beat();
      const el = edge.current;
      if (el && !reduced)
        el.animate(
          [
            { opacity: 0.35 },
            { opacity: 1, offset: 0.12 },
            { opacity: 0.55, offset: 0.3 },
            { opacity: 0.85, offset: 0.42 },
            { opacity: 0.35 },
          ],
          { duration: Math.min(900, BEAT_MS[dMe] - 50), easing: 'ease-out' },
        );
      // (under a cinematic the heartbeat holds its breath: the cinematic has its own sound)
      if (!document.body.classList.contains('art-on')) heartbeat(dMe > 1);
    };
    beat();
    const id = setInterval(beat, BEAT_MS[dMe]);
    return () => clearInterval(id);
  }, [dMe]);

  useEffect(
    () => () => {
      for (const c of ['danger-me', 'danger-me-2', 'danger-opp']) document.body.classList.remove(c);
      delete document.body.dataset.lfMe;
      delete document.body.dataset.lfOpp;
    },
    [],
  );

  return <div ref={edge} class={`danger-edge${dMe ? ` on lv-${dMe}` : ''}`} aria-hidden="true" />;
}

// ---------------------------------------------------------------- cracks on the field

/** A small seeded random generator (the same cracks every render). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Jagged crack lines spreading from a few impact points along the duelist's edge of the mat. */
function crackPaths(seed: number, count: number): string[] {
  const r = rng(seed);
  const out: string[] = [];
  const grow = (x: number, y: number, ang: number, len: number, depth: number) => {
    let d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    const steps = 4 + Math.floor(r() * 4);
    for (let i = 0; i < steps; i++) {
      ang += (r() - 0.5) * 0.9;
      const l = (len / steps) * (0.6 + r() * 0.8);
      x += Math.cos(ang) * l;
      y += Math.sin(ang) * l;
      d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
      if (depth < 2 && r() < 0.35) grow(x, y, ang + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.6), len * 0.45, depth + 1);
    }
    out.push(d);
  };
  for (let i = 0; i < count; i++) {
    // impact points along the near edge (y = 100), cracks running up into the half
    const x = 8 + ((i + r() * 0.8) / count) * 84;
    grow(x, 100, -Math.PI / 2 + (r() - 0.5) * 1.3, 45 + r() * 35, 0);
  }
  return out;
}

/** Red cracks over one duelist's half of the mat (level 0 draws nothing). */
export function FieldCracks({ level, side }: { level: number; side: 'me' | 'opp' }) {
  const paths1 = useMemo(() => crackPaths(side === 'me' ? 7 : 19, 4), [side]);
  const paths2 = useMemo(() => crackPaths(side === 'me' ? 31 : 43, 4), [side]);
  if (!level) return null;
  const all = level > 1 ? [...paths1, ...paths2] : paths1;
  return (
    <svg class={`tcracks ${side} lv-${level}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <g class="tcracks-dark">
        {all.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      <g class="tcracks-glow">
        {all.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}
