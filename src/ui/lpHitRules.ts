// How hard a Life Points change lands on screen (lpHits.tsx): the size of the floating
// number, how far the LP bar cracks, how much the board shakes. All of it scales with the
// share of the starting Life Points lost, and gets a kick when the hit drops a duelist
// into danger (1000 LP or less in a Speed Duel). No DOM here (the tests run it in Node).
import { dangerLevel } from './atmosphereRules';
import type { Pid } from '../eds/types';

type LpListener = (who: Pid, from: number, to: number) => void;
/** Who hears Life Points move on screen (lpHits.tsx: the pops, cracks and shake). */
export const lpListeners = new Set<LpListener>();
/** Who hears a duelist's bar start over (a rematch on the same screen). */
export const lpResetListeners = new Set<(who: Pid) => void>();

/** What a duelist's LP bar keeps between remounts (its scars), per duelist: a new duel screen clears it. */
export const lpBarMemory = new Map<Pid, unknown>();
export function resetLpHits() {
  lpBarMemory.clear();
}

/** The on-screen Life Points of `who` started moving from `from` to `to` (art/flow.tsx LpCount). */
export function emitLpHit(who: Pid, from: number, to: number) {
  // (a counter coming back from 0 is a new duel on the same screen, not a heal: the bar starts clean)
  if (from <= 0 && to > from) {
    lpBarMemory.delete(who);
    for (const l of lpResetListeners) l(who);
    return;
  }
  for (const l of lpListeners) l(who, from, to);
}

export interface LpHit {
  /** LP lost (damage) or gained (heal): always positive */
  amount: number;
  kind: 'damage' | 'heal';
  /** 0..1: how big the hit is next to the starting Life Points (half of them or more is 1) */
  sev: number;
  /** 0 a scratch, 1 a hit, 2 a heavy hit, 3 a crushing one */
  tier: 0 | 1 | 2 | 3;
  /** the hit leaves this duelist in danger (and they still stand) */
  danger: boolean;
  /** this hit is the one that took them into danger */
  intoDanger: boolean;
  /** the hit ends the duel (0 LP) */
  ko: boolean;
  /** scale of the floating number (1 normal) */
  scale: number;
  /** how far the board shakes, in px (before the side weight and reduced motion) */
  shake: number;
  /** how long the shake lasts, ms */
  shakeMs: number;
  /** crack lines that burst from the impact (0 for a heal) */
  rays: number;
  /** how far (px) the longest crack runs across the bar */
  reach: number;
}

/**
 * How long the Life Points counter takes to roll to its new value, like the counter on the
 * show: a small change rolls by in under half a second, a big one keeps ticking up to 1.5 s.
 */
export function lpCountMs(delta: number): number {
  return Math.round(Math.min(1500, 450 + Math.abs(delta) * 0.28));
}

/** The starting Life Points of the game. */
export const startLp = (speed: boolean) => (speed ? 4000 : 8000);

/** A hit to the opponent shakes the board this much of a hit to you (you feel your own blows more). */
export const OPP_SHAKE = 0.55;
/** Most scars an LP bar keeps (older ones fall away as new ones land). */
export const MAX_SCARS = 6;

export function lpHit(from: number, to: number, speed: boolean): LpHit | null {
  if (from === to) return null;
  const start = startLp(speed);
  const kind = to < from ? 'damage' : 'heal';
  const amount = Math.abs(to - from);
  // (the finishing blow always lands as the heaviest hit, whatever was left)
  const sev = to <= 0 && to < from ? 1 : Math.min(1, amount / (start / 2));
  const tier: LpHit['tier'] = sev >= 0.75 ? 3 : sev >= 0.4 ? 2 : sev >= 0.125 ? 1 : 0;
  const ko = kind === 'damage' && to <= 0;
  const danger = kind === 'damage' && !ko && dangerLevel(to, speed) > 0;
  const intoDanger = danger && dangerLevel(from, speed) === 0;
  if (kind === 'heal') {
    return { amount, kind, sev, tier, danger: false, intoDanger: false, ko: false, scale: 0.9 + sev * 0.3, shake: 0, shakeMs: 0, rays: 0, reach: 0 };
  }
  // the board: a scratch is a twitch (2 px), a crushing blow a jolt (12 px); danger adds a third
  const kick = danger ? 1.35 : ko ? 1.5 : 1;
  const shake = Math.round((2 + 10 * Math.sqrt(sev)) * kick * 10) / 10;
  const shakeMs = Math.round(240 + 300 * sev + (danger || ko ? 120 : 0));
  // the bar: 2 cracks for a scratch, up to 8 for a crushing blow (+2 in danger)
  const rays = Math.min(8, 2 + Math.round(sev * 4) + (danger || ko ? 2 : 0));
  const reach = Math.round(22 + 110 * Math.sqrt(sev) + (danger || ko ? 24 : 0));
  const scale = Math.round((1 + 0.7 * Math.sqrt(sev) + (danger || ko ? 0.15 : 0)) * 100) / 100;
  return { amount, kind, sev, tier, danger, intoDanger, ko, scale, shake, shakeMs, rays, reach };
}

/** A small seeded random (the same hit always cracks the same way, in tests and on screen). */
export function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sparks that fly off the gauge when Life Points break under 1000 (or hit 0): none otherwise. */
export function sparkCount(hit: LpHit): number {
  return hit.intoDanger || hit.ko ? 14 : hit.danger && hit.tier >= 1 ? 7 : 0;
}

export interface Crack {
  /** SVG path data (pixels in the bar's box) */
  d: string;
  /** a main line (thicker) or a branch */
  main: boolean;
}

/**
 * The cracks a hit leaves on a bar `w` x `h` px, bursting from (x0, y0): jagged lines
 * that fan out along the bar (it is wide and short, so they run sideways and up/down
 * the bar), with branches off the long ones.
 */
export function crackPaths(hit: LpHit, x0: number, y0: number, w: number, h: number, seed: number): Crack[] {
  const rnd = seeded(seed);
  const out: Crack[] = [];
  const clampX = (x: number) => Math.max(1, Math.min(w - 1, x));
  const clampY = (y: number) => Math.max(1, Math.min(h - 1, y));
  const f = (n: number) => n.toFixed(1);
  for (let i = 0; i < hit.rays; i++) {
    // alternate left and right, each a little above or below the bar's line
    const dir = i % 2 === 0 ? -1 : 1;
    // mostly along the bar, some climbing up it
    const up = rnd() * 0.8 * (i % 3 === 2 ? 1.7 : 1);
    const ang = dir < 0 ? Math.PI + up : -up;
    const len = hit.reach * (0.45 + rnd() * 0.55) * (i < 2 ? 1 : 0.8);
    const segs = 3 + Math.floor(rnd() * 3);
    let x = x0;
    let y = y0;
    let a = ang;
    let d = `M${f(x)} ${f(y)}`;
    const pts: [number, number][] = [];
    for (let k = 0; k < segs; k++) {
      a += (rnd() - 0.5) * 0.45;
      const step = len / segs;
      x = clampX(x + Math.cos(a) * step);
      // the bar is short: vertical travel is squeezed so the crack stays across it
      y = clampY(y + Math.sin(a) * step * 0.5);
      d += ` L${f(x)} ${f(y)}`;
      pts.push([x, y]);
    }
    out.push({ d, main: true });
    // branches off the longer cracks
    if (len > 50 && rnd() < 0.35 + hit.sev * 0.5) {
      const [bx, by] = pts[Math.min(pts.length - 1, 1 + Math.floor(rnd() * (pts.length - 1)))];
      let ba = a + (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.6);
      let cx = bx;
      let cy = by;
      let bd = `M${f(cx)} ${f(cy)}`;
      for (let k = 0; k < 2; k++) {
        ba += (rnd() - 0.5) * 0.6;
        cx = clampX(cx + Math.cos(ba) * len * 0.18);
        cy = clampY(cy + Math.sin(ba) * len * 0.12);
        bd += ` L${f(cx)} ${f(cy)}`;
      }
      out.push({ d: bd, main: false });
    }
  }
  // the impact star: short shards right where it landed
  const shards = 3 + Math.round(hit.sev * 3);
  for (let i = 0; i < shards; i++) {
    const a = (i / shards) * Math.PI * 2 + rnd() * 0.6;
    const r = 4 + rnd() * (6 + hit.sev * 8);
    out.push({ d: `M${f(x0)} ${f(y0)} L${f(clampX(x0 + Math.cos(a) * r))} ${f(clampY(y0 + Math.sin(a) * r * 0.6))}`, main: false });
  }
  return out;
}
