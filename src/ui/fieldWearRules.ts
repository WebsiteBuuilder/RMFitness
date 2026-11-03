// The rules behind field wear (fieldWear.tsx): how worn each Monster Zone is and the shape of
// its scorch marks. The engine counts the monsters destroyed in each zone (state.fx.wear, see
// Engine.sendToGrave); the marks are drawn from that count with a seeded generator, so the same
// zone looks the same on every render, on both phones of an online duel, after a rejoin and in
// a replay. No DOM here (the tests run it in Node).
import type { DuelState, Pid } from '../eds/types';
import type { Terrain } from '../art/families';

/** The zone box the marks are drawn in (a card's shape, 59 × 86). */
export const W = 59;
export const H = 86;
/** Wear looks get worse up to this many destructions (more keep the worst look). */
export const MAX_LOOK = 3;

/** Monsters destroyed in a duelist's Monster Zone so far this duel (0: untouched). */
export function wearOf(state: DuelState, p: Pid, zone: number): number {
  const w = state.fx?.wear as (number | null)[][] | undefined;
  return Math.max(0, Number(w?.[p]?.[zone]) || 0);
}

/** How the marks are drawn on each landscape (the duelist's own Field Spell; null: the plain slab). */
export type WearStyle = Terrain | 'plain';
export const wearStyle = (t: Terrain | null): WearStyle => t ?? 'plain';

/** A small seeded random generator (the same marks every render). */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

export interface WearCrack {
  /** the crack's centre line */
  d: string;
  /** stroke width scale: trunks are thick, branches thinner */
  w: number;
  /** the crack as a filled sliver, wide where it starts and narrowing to a point (the dark gap) */
  gap: string;
  /** ...and its hot core, thinner */
  core: string;
}

/** A filled outline around a line of points, `half` wide at the start and tapering to nothing. */
export function taper(pts: [number, number][], half: number): string {
  const n = pts.length;
  if (n < 2) return '';
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[Math.max(0, i - 1)];
    const [bx, by] = pts[Math.min(n - 1, i + 1)];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const h = half * (1 - (0.92 * i) / (n - 1));
    const [x, y] = pts[i];
    left.push(`${f1(x + nx * h)} ${f1(y + ny * h)}`);
    right.push(`${f1(x - nx * h)} ${f1(y - ny * h)}`);
  }
  return `M${left.join(' L')} L${right.reverse().join(' L')} Z`;
}

export interface WearChip {
  /** the shard's top face */
  face: string;
  /** the dark gap it lifted out of (offset down-right: it sits raised) */
  shadow: string;
  /** its lit edges (up-left, toward the light) */
  lit: string;
}

export interface WearHit {
  /** where the monster fell */
  x: number;
  y: number;
  /** the scorched patch around it (a closed, rough outline) */
  blot: string;
  /** its size (the blot's mean radius) */
  r: number;
  cracks: WearCrack[];
  /** broken-out pieces of the slab along the cracks (the third hit shatters it) */
  chips: WearChip[];
  /** ash or embers lying in the scorch: [x, y, size] */
  specks: [number, number, number][];
}

const f1 = (n: number) => n.toFixed(1);
const clampX = (x: number) => Math.max(1, Math.min(W - 1, x));
const clampY = (y: number) => Math.max(1, Math.min(H - 1, y));

/**
 * The marks of one destruction: the k-th monster destroyed in this zone (k from 1). Each one
 * lands somewhere new and reaches further: the first leaves a scorch and hairline cracks, the
 * second a crater and cracks to the zone's edges, the third shatters the slab.
 * `grid`: the cracks run in straight lines and right angles (a machine floor, Tech landscapes).
 */
export function wearHit(seed: number, k: number, grid = false): WearHit {
  const r = rng(seed * 2654435761 + k * 40503);
  const lv = Math.min(k, MAX_LOOK);
  // the first lands near the middle; later ones off to a side
  const spread = k === 1 ? 0.18 : 0.42;
  const x = W / 2 + (r() - 0.5) * 2 * spread * W * 0.5;
  const y = H / 2 + (r() - 0.5) * 2 * spread * H * 0.45;
  const rad = [0, 17, 21, 24][lv] + r() * 4;
  // a rough outline: 16 points, the radius wandering
  let blot = '';
  const pts = 16;
  let wob = 1;
  for (let i = 0; i < pts; i++) {
    wob = Math.max(0.62, Math.min(1.3, wob + (r() - 0.5) * 0.45));
    const a = (i / pts) * Math.PI * 2;
    // (taller than wide: the zone is a card's shape)
    blot += `${i ? 'L' : 'M'}${f1(x + Math.cos(a) * rad * wob)} ${f1(y + Math.sin(a) * rad * wob * 1.25)} `;
  }
  blot += 'Z';
  const cracks: WearCrack[] = [];
  const reach = [0, 19, 32, 54][lv];
  /** where cracks bend (shards break out there) */
  const joints: [number, number, number][] = [];
  const grow = (cx: number, cy: number, ang: number, len: number, w: number, depth: number) => {
    const pts: [number, number][] = [[cx, cy]];
    const steps = grid ? 3 + Math.floor(r() * 2) : 6 + Math.floor(r() * 4);
    if (grid) ang = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    const heading = ang;
    for (let i = 0; i < steps; i++) {
      if (grid) {
        if (i && r() < 0.55) ang += (r() < 0.5 ? -1 : 1) * (Math.PI / 2);
      } else ang = heading + (r() - 0.5) * 1.3; // (jagged: each step zigs off the crack's heading)
      const l = (len / steps) * (0.6 + r() * 0.8);
      cx = clampX(cx + Math.cos(ang) * l);
      cy = clampY(cy + Math.sin(ang) * l);
      pts.push([cx, cy]);
      if (depth === 0 && i > 0) joints.push([cx, cy, ang]);
      if (depth < 1 + (lv > 1 ? 1 : 0) && i > 1 && r() < 0.3) grow(cx, cy, heading + (r() < 0.5 ? -1 : 1) * (grid ? Math.PI / 2 : 0.5 + r() * 0.6), len * 0.45, w * 0.6, depth + 1);
    }
    const d = 'M' + pts.map(([x, y]) => `${f1(x)} ${f1(y)}`).join(' L');
    cracks.push({ d, w, gap: taper(pts, 1.75 * w), core: taper(pts, 0.42 * w) });
  };
  const trunks = [0, 5, 6, 6][lv];
  const turn0 = r() * Math.PI * 2;
  // (the first two burst from where the monster fell; the third breaks the slab along a fault: its
  //  cracks start from points scattered round the blow, so it reads as broken stone, not a star in glass)
  for (let t = 0; t < trunks; t++) {
    const fa = r() * Math.PI * 2;
    const fd = lv >= 3 ? rad * (0.15 + r() * 0.55) : 0;
    grow(clampX(x + Math.cos(fa) * fd), clampY(y + Math.sin(fa) * fd * 1.25), turn0 + (t / trunks) * Math.PI * 2 + (r() - 0.5) * (lv >= 3 ? 1.4 : 0.5), reach * (0.7 + r() * 0.5), 1, 0);
  }
  // the third hit breaks pieces out of the slab
  const chips: WearChip[] = [];
  if (lv >= 3) {
    const n = Math.min(joints.length, 5 + Math.floor(r() * 2));
    const picks = joints.map((j) => [r(), j] as const).sort((a, b) => a[0] - b[0]).slice(0, n).map(([, j]) => j);
    for (const [jx, jy, ang] of picks) {
      // a sharp sliver lying along the crack: long axis on the crack, two or three cutting corners
      const len = 10 + r() * 6;
      const wid = 5.5 + r() * 3.5;
      const side = r() < 0.5 ? -1 : 1;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const at = (u: number, v: number): [number, number] => [clampX(jx + ca * u - sa * v * side), clampY(jy + sa * u + ca * v * side)];
      const pts = [at(-len * 0.5, 0.6), at(len * 0.5, 0.5), at(len * (0.15 + r() * 0.25), wid), at(-len * (0.15 + r() * 0.2), wid * (0.6 + r() * 0.3))];
      const path = (q: [number, number][], dx = 0, dy = 0) => 'M' + q.map(([a, b]) => `${f1(clampX(a + dx))} ${f1(clampY(b + dy))}`).join(' L') + ' Z';
      // the lit edges: the ones facing up-left
      let lit = '';
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const nx = by - ay;
        const ny = -(bx - ax); // (outward normal for a clockwise outline; either way, the up-left ones)
        if (nx + ny < 0) lit += `M${f1(ax)} ${f1(ay)} L${f1(bx)} ${f1(by)} `;
      }
      chips.push({ face: path(pts), shadow: path(pts, 1.3, 1.7), lit: lit.trim() || `M${f1(pts[0][0])} ${f1(pts[0][1])} L${f1(pts[1][0])} ${f1(pts[1][1])}` });
    }
  }
  const specks: [number, number, number][] = [];
  const ns = 3 + lv * 2;
  for (let i = 0; i < ns; i++) {
    const a = r() * Math.PI * 2;
    const dist = rad * Math.sqrt(r()) * 0.95;
    specks.push([+f1(clampX(x + Math.cos(a) * dist)), +f1(clampY(y + Math.sin(a) * dist * 1.25)), +(0.5 + r() * 0.9).toFixed(2)]);
  }
  return { x: +f1(x), y: +f1(y), blot, r: +f1(rad), cracks, chips, specks };
}

/** Every mark in a zone that has seen `count` monsters destroyed (the worst look from the third on). */
export function wearHits(p: Pid, zone: number, count: number, grid = false): WearHit[] {
  const out: WearHit[] = [];
  for (let k = 1; k <= Math.min(count, MAX_LOOK); k++) out.push(wearHit(1 + p * 977 + zone * 131, k, grid));
  return out;
}

/**
 * Which mark of a zone is landing right now (its flash and cooling play), from the zone's count
 * as it changes. A mark already there when the board appears (a rejoin, a hand-over, a replay
 * opened midway) is simply there; a replay stepping back clears it; reduced motion never lands.
 * Returns the count whose newest mark is landing (0: none).
 */
export interface Landing {
  /** the count last seen (null: not seen yet, the zone just appeared) */
  seen: number | null;
  /** the count whose newest mark started landing */
  fresh: number;
  /** ...and the one whose landing finished */
  cooled: number;
}
export const newLanding = (): Landing => ({ seen: null, fresh: 0, cooled: 0 });
export function landingAt(l: Landing, n: number, reduced: boolean): number {
  if (l.seen !== null && n > l.seen && !reduced) l.fresh = n;
  if (n < (l.seen ?? 0)) l.fresh = l.cooled = 0;
  l.seen = n;
  return l.fresh > l.cooled ? l.fresh : 0;
}
/** The landing finished (its animation ended, was cancelled, or its time ran out). */
export function landed(l: Landing, fresh: number) {
  if (fresh > l.cooled) l.cooled = fresh;
}
