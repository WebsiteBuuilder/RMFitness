// Battle scars on the mat: the pure shapes (tested; matScars.tsx measures the board and draws them).
// Every landed attack leaves a mark where it struck (the front edge of the defender's Monster Zone,
// or straight ahead at the defender's line for a direct attack) and a trail across the lane the
// attack crossed, both in the attacker's Attribute: FIRE scorches, WATER frosts, WIND slashes,
// EARTH cracks, LIGHT burns in rays, DARK rots, DIVINE sears gold.
import type { Scar, ScarAttr } from '../eds/scars';
import { rng } from './fieldWearRules';

export interface Pt {
  x: number;
  y: number;
}
/** Where one scar sits on the measured mat (px in the mat's own box). */
export interface ScarGeo {
  /** the attacker's front edge (where the attack left from) */
  a: Pt;
  /** where it struck */
  i: Pt;
  /** a zone's width: marks scale with the board */
  zw: number;
  direct: boolean;
}
/** A mark is a few layers, one path each (classes styled per Attribute in matscars.css). */
export type Layer = [cls: string, d: string];
export interface ScarMark {
  attr: ScarAttr;
  /** a soft glow/stain round the blow (a radial gradient in the Attribute's colour) */
  halo: { cx: number; cy: number; rx: number; ry: number };
  trail: Layer[];
  hit: Layer[];
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();
type P = [number, number];

/** a filled stroke along pts, thick in the middle and pointed at both ends */
export function lens(pts: P[], half: number, ends = 0.08): string {
  const n = pts.length;
  if (n < 2) return '';
  const l: string[] = [];
  const r: string[] = [];
  for (let k = 0; k < n; k++) {
    const [ax, ay] = pts[Math.max(0, k - 1)];
    const [bx, by] = pts[Math.min(n - 1, k + 1)];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const h = half * (ends + (1 - ends) * Math.sin((Math.PI * k) / (n - 1)));
    const [x, y] = pts[k];
    l.push(`${f1(x + nx * h)} ${f1(y + ny * h)}`);
    r.push(`${f1(x - nx * h)} ${f1(y - ny * h)}`);
  }
  return `M${l.join(' L')} L${r.reverse().join(' L')} Z`;
}
/** a filled stroke from a fat root to a point (rays, spikes, fissures) */
export function spike(pts: P[], half: number): string {
  const n = pts.length;
  if (n < 2) return '';
  const l: string[] = [];
  const r: string[] = [];
  for (let k = 0; k < n; k++) {
    const [ax, ay] = pts[Math.max(0, k - 1)];
    const [bx, by] = pts[Math.min(n - 1, k + 1)];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const h = half * (1 - (0.94 * k) / (n - 1));
    const [x, y] = pts[k];
    l.push(`${f1(x + nx * h)} ${f1(y + ny * h)}`);
    r.push(`${f1(x - nx * h)} ${f1(y - ny * h)}`);
  }
  return `M${l.join(' L')} L${r.reverse().join(' L')} Z`;
}
/** a ragged blob: rx/ry radii, wobble 0..1 */
export function blot(r: () => number, cx: number, cy: number, rx: number, ry: number, wobble: number, n = 18): string {
  const pts: string[] = [];
  const lean = r() * Math.PI * 2;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const m = (1 - wobble / 2 + r() * wobble) * (1 + 0.22 * Math.cos(a - lean));
    pts.push(`${f1(cx + Math.cos(a) * rx * m)} ${f1(cy + Math.sin(a) * ry * m)}`);
  }
  return `M${pts.join(' L')} Z`;
}
const dot = (x: number, y: number, rr: number, sweep = 0) =>
  `M${f1(x - rr)} ${f1(y)}a${f1(rr)} ${f1(rr)} 0 1 ${sweep} ${f1(2 * rr)} 0a${f1(rr)} ${f1(rr)} 0 1 ${sweep} ${f1(-2 * rr)} 0`;

/** a wobbly line from a to b, n steps, sideways jitter j (px) */
function wobbleLine(r: () => number, a: P, b: P, n: number, j: number, wave = 0, phase = 0): P[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const out: P[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const off = (k === 0 || k === n ? 0 : (r() - 0.5) * 2 * j) + wave * Math.sin(t * Math.PI * 2 + phase) * Math.sin(t * Math.PI);
    out.push([a[0] + dx * t + nx * off, a[1] + dy * t + ny * off]);
  }
  return out;
}
/** a crack/ray from (cx,cy) at angle ang, length len, kinking as it goes */
function crack(r: () => number, cx: number, cy: number, ang: number, len: number, kink: number, steps = 4): P[] {
  const pts: P[] = [[cx, cy]];
  let x = cx;
  let y = cy;
  let a = ang;
  for (let k = 0; k < steps; k++) {
    a += (r() - 0.5) * kink;
    x += (Math.cos(a) * len) / steps;
    y += (Math.sin(a) * len) / steps;
    pts.push([x, y]);
  }
  return pts;
}

/** Layer classes, painted in this order inside a mark (matscars.css colours them per Attribute). */
export const LAYERS = ['sc-soot', 'sc-pit', 'sc-burn', 'sc-edge', 'sc-hot'] as const;

/** One scar's mark: deterministic from the duel's seed and the scar's running number. */
export function scarMark(s: Scar, g: ScarGeo, duelSeed = 0): ScarMark {
  const r = rng((s.n * 2654435761 + Math.imul(duelSeed | 0, 40503) + 17) >>> 0);
  const { a, i, zw } = g;
  const A: P = [a.x, a.y];
  const I: P = [i.x, i.y];
  const dx = I[0] - A[0];
  const dy = I[1] - A[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // the trail starts a little off the attacker's frame and runs into the blow
  const T0: P = [A[0] + ux * zw * 0.18, A[1] + uy * zw * 0.18];
  const big = g.direct ? 1.25 : 1;
  const R = zw * 0.4 * big * (0.9 + r() * 0.2);
  const fwd = Math.atan2(uy, ux);
  const trail: Layer[] = [];
  const hit: Layer[] = [];
  const steps = Math.max(6, Math.round(len / 9));

  switch (s.attr) {
    case 'FIRE': {
      const line = wobbleLine(r, T0, I, steps, 1.2);
      trail.push(['sc-soot', lens(line, zw * 0.085)], ['sc-hot', lens(line.slice(Math.floor(line.length * 0.35)), zw * 0.022)]);
      hit.push(['sc-soot', blot(r, I[0], I[1], R * 0.78, R * 0.6, 0.7, 22)]);
      hit.push(['sc-burn', blot(r, I[0], I[1], R * 0.42, R * 0.32, 0.6)]);
      let hot = '';
      const nc = 5 + Math.floor(r() * 3);
      for (let k = 0; k < nc; k++) hot += spike(crack(r, I[0], I[1], (k / nc) * Math.PI * 2 + r() * 0.6, R * (0.55 + r() * 0.5), 0.9), 1.3);
      for (let k = 0; k < 6; k++) {
        const an = r() * Math.PI * 2;
        const d = R * (0.7 + r() * 0.6);
        hot += dot(I[0] + Math.cos(an) * d, I[1] + Math.sin(an) * d * 0.8, 0.6 + r() * 0.7);
      }
      hit.push(['sc-hot', hot]);
      break;
    }
    case 'WATER': {
      const line = wobbleLine(r, T0, I, steps, 0.6);
      let ticks = '';
      for (let k = 2; k < line.length - 1; k += 2) {
        const [x, y] = line[k];
        const side = k % 4 === 0 ? 1 : -1;
        ticks += spike([[x, y], [x + (-uy * side + ux * 0.4) * zw * 0.09, y + (ux * side + uy * 0.4) * zw * 0.09]], 1.1);
      }
      trail.push(['sc-burn', lens(line, zw * 0.06)], ['sc-edge', lens(line, zw * 0.03) + ticks]);
      hit.push(['sc-pit', blot(r, I[0], I[1], R * 0.4, R * 0.3, 0.3, 6)]);
      let ice = '';
      let barbs = '';
      const ns = 8 + Math.floor(r() * 4);
      for (let k = 0; k < ns; k++) {
        const an = (k / ns) * Math.PI * 2 + r() * 0.3;
        const L = R * (0.55 + r() * 0.65);
        const tip: P = [I[0] + Math.cos(an) * L, I[1] + Math.sin(an) * L * 0.8];
        ice += spike([[I[0], I[1]], [(I[0] + tip[0]) / 2, (I[1] + tip[1]) / 2], tip], 2.1);
        // feathered barbs off each spike: frost, not a star
        for (const t of [0.45, 0.7]) {
          const bx = I[0] + (tip[0] - I[0]) * t;
          const by = I[1] + (tip[1] - I[1]) * t;
          for (const sd of [-1, 1]) {
            const ba = an + sd * 0.75;
            barbs += spike([[bx, by], [bx + Math.cos(ba) * L * 0.22, by + Math.sin(ba) * L * 0.18]], 0.8);
          }
        }
      }
      hit.push(['sc-edge', ice + barbs], ['sc-hot', dot(I[0], I[1], R * 0.12)]);
      break;
    }
    case 'WIND': {
      let gust = '';
      for (let k = -1; k <= 1; k++) {
        const off = k * zw * 0.07;
        const a2: P = [T0[0] - uy * off, T0[1] + ux * off];
        const b2: P = [I[0] - uy * off * 0.4, I[1] + ux * off * 0.4];
        gust += lens(wobbleLine(r, a2, b2, steps, 0.3, zw * 0.05 * (k === 0 ? 1 : -0.6), r() * 2), 0.9 + (k === 0 ? 0.4 : 0));
      }
      trail.push(['sc-edge', gust]);
      // three blade gouges across the blow
      const sa = fwd + Math.PI / 2 + (r() - 0.5) * 0.9;
      const cx = Math.cos(sa);
      const cy = Math.sin(sa);
      let gouge = '';
      let lip = '';
      for (let k = -1; k <= 1; k++) {
        const off = k * zw * 0.15;
        const L = R * (1.5 + r() * 0.4) * (k === 0 ? 1.1 : 0.9);
        const mx = I[0] + ux * off;
        const my = I[1] + uy * off;
        const p0: P = [mx - (cx * L) / 2, my - (cy * L) / 2];
        const p1: P = [mx + (cx * L) / 2, my + (cy * L) / 2];
        const line = wobbleLine(r, p0, p1, 8, 0.4);
        gouge += lens(line, 2.6 + r() * 0.8, 0.02);
        lip += lens(line.map(([x, y]) => [x - 0.9, y - 1.1] as P), 0.8, 0.02);
      }
      hit.push(['sc-soot', gouge], ['sc-edge', lip]);
      break;
    }
    case 'LIGHT':
    case 'DIVINE': {
      const div = s.attr === 'DIVINE' ? 1.25 : 1;
      const line: P[] = [T0, I];
      trail.push(['sc-burn', lens(wobbleLine(r, T0, I, steps, 0), 2.2 * div)], ['sc-hot', lens(line, 0.8 * div)]);
      let rays = '';
      const nr = 11 + Math.floor(r() * 6);
      for (let k = 0; k < nr; k++) {
        const an = (k / nr) * Math.PI * 2 + (r() - 0.5) * 0.45;
        const L = R * div * (0.45 + r() * r() * 1.1);
        const c0 = R * 0.18;
        // a ray burnt into the ground, broken once part-way
        const x0 = I[0] + Math.cos(an) * c0;
        const y0 = I[1] + Math.sin(an) * c0 * 0.8;
        const brk = 0.45 + r() * 0.25;
        const x1 = I[0] + Math.cos(an) * L * brk;
        const y1 = I[1] + Math.sin(an) * L * brk * 0.8;
        const x2 = I[0] + Math.cos(an) * (L * brk + 2.5);
        const y2 = I[1] + Math.sin(an) * (L * brk + 2.5) * 0.8;
        const half = (1.2 + r() * 1.3) * div;
        rays += lens([[x0, y0], [(x0 + x1) / 2, (y0 + y1) / 2], [x1, y1]], half, 0.35);
        if (r() < 0.7) rays += spike([[x2, y2], [I[0] + Math.cos(an) * L, I[1] + Math.sin(an) * L * 0.8]], half * 0.7);
      }
      if (s.attr === 'DIVINE') {
        // a god's blow splits the ground: gold-lit fissures under the rays and a ring of seared stone
        let fis = '';
        for (let k = 0; k < 6; k++) fis += spike(crack(r, I[0], I[1], (k / 6) * Math.PI * 2 + r() * 0.5, R * (1 + r() * 0.5), 1, 5), 2.2);
        hit.push(['sc-soot', fis], ['sc-edge', fis]);
      }
      hit.push(['sc-soot', blot(r, I[0], I[1], R * 0.36 * div, R * 0.28 * div, 0.7, 16)], ['sc-burn', rays], ['sc-hot', blot(r, I[0], I[1], R * 0.13 * div, R * 0.1 * div, 0.5, 8)]);
      break;
    }
    case 'DARK': {
      const line = wobbleLine(r, T0, I, steps, 0.8, zw * 0.06, r() * 6);
      trail.push(['sc-soot', lens(line, zw * 0.075)], ['sc-burn', lens(line, zw * 0.025)]);
      let rot = '';
      for (let k = 0; k < 3; k++) {
        const an = r() * Math.PI * 2;
        const d = R * 0.3 * r();
        rot += blot(r, I[0] + Math.cos(an) * d, I[1] + Math.sin(an) * d, R * (0.45 + r() * 0.25), R * (0.35 + r() * 0.2), 0.8, 14);
      }
      let tend = '';
      const nt = 6 + Math.floor(r() * 3);
      for (let k = 0; k < nt; k++) {
        // tendrils curl as they reach out
        const an0 = (k / nt) * Math.PI * 2 + r() * 0.5;
        const curl = (r() < 0.5 ? -1 : 1) * (0.35 + r() * 0.3);
        const L = R * (0.7 + r() * 0.6);
        const pts: P[] = [[I[0], I[1]]];
        let an = an0;
        for (let q = 1; q <= 6; q++) {
          an += curl;
          const [px, py] = pts[pts.length - 1];
          pts.push([px + (Math.cos(an) * L) / 6, py + (Math.sin(an) * L * 0.8) / 6]);
        }
        tend += spike(pts, 1.8);
      }
      hit.push(['sc-soot', rot], ['sc-burn', tend]);
      let motes = '';
      for (let k = 0; k < 5; k++) motes += dot(I[0] + (r() - 0.5) * R * 2, I[1] + (r() - 0.5) * R * 1.4, 0.5 + r() * 0.6);
      hit.push(['sc-hot', motes]);
      break;
    }
    default: {
      // EARTH (and anything without an Attribute): a gouged furrow into a cracked crater
      const line = wobbleLine(r, T0, I, steps, 0.9);
      trail.push(
        ['sc-soot', lens(line, zw * 0.07)],
        ['sc-edge', lens(line.map(([x, y]) => [x - uy * zw * 0.075, y + ux * zw * 0.075] as P), 0.7) + lens(line.map(([x, y]) => [x + uy * zw * 0.075, y - ux * zw * 0.075] as P), 0.5)],
      );
      let fis = '';
      const nf = 5 + Math.floor(r() * 3);
      for (let k = 0; k < nf; k++) {
        const an = (k / nf) * Math.PI * 2 + r() * 0.7;
        const c = crack(r, I[0], I[1], an, R * (0.8 + r() * 0.7), 1.2, 5);
        fis += spike(c, 2.4);
        if (r() < 0.6) {
          const m = c[2];
          fis += spike(crack(r, m[0], m[1], an + (r() < 0.5 ? -0.8 : 0.8), R * 0.4, 1, 3), 1.2);
        }
      }
      let rubble = '';
      for (let k = 0; k < 7; k++) {
        const an = r() * Math.PI * 2;
        const d = R * (0.45 + r() * 0.7);
        rubble += blot(r, I[0] + Math.cos(an) * d, I[1] + Math.sin(an) * d * 0.8, 1 + r() * 1.4, 0.8 + r(), 0.6, 5);
      }
      hit.push(['sc-soot', blot(r, I[0], I[1], R * 0.4, R * 0.3, 0.6) + fis], ['sc-pit', blot(r, I[0], I[1], R * 0.24, R * 0.18, 0.5)], ['sc-edge', rubble]);
    }
  }
  const hs = s.attr === 'DARK' || s.attr === 'FIRE' ? 1.35 : 1.2;
  return { attr: s.attr, halo: { cx: I[0], cy: I[1], rx: R * hs, ry: R * hs * 0.9 }, trail, hit };
}

/** Older scars weather: the newest two at full strength, then fading to 0.4 (never gone). */
export function scarAge(index: number, count: number): number {
  const age = count - 1 - index;
  return age < 2 ? 1 : Math.max(0.4, 0.85 - (age - 2) * 0.07);
}
