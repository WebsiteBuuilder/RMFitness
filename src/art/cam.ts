// The Duel Disk camera's shared pose: while the field is pushed in or tilted (src/ui/duelCam.ts),
// everything that places itself from the field cards' screen rectangles (the 3D figures, a
// cinematic's live card rectangles, the flat counter badges) reads them through unmapRect, so
// it gets the field's resting place and the camera then carries it along with the field.
//
// The pose is one plane-to-plane map in viewport CSS px (a homography: a push, a roll and a
// tilt seen in perspective): [X, Y, W] = H·[x, y, 1], p' = (X/W, Y/W), H row-major
// [h0 h1 h2; h3 h4 h5; h6 h7 h8]. No DOM work here unless a shot is live.

export type Mat = [number, number, number, number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** The element whose computed transform is the live pose (set by the camera while a shot plays; it pivots on the viewport's corner). */
let live: { el: HTMLElement } | null = null;
let cached: Mat = IDENTITY;
let cachedAt = -1;

/** A shot starts (el carries the pose) or ends (null). */
export function setCamLive(v: { el: HTMLElement } | null) {
  live = v;
  cachedAt = -1;
}

export const camLive = (): boolean => live !== null;

export function mul(a: Mat, b: Mat): Mat {
  const o = new Array(9) as Mat;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export function invert(m: Mat): Mat {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Parses a computed transform ("none", "matrix(...)", or a "matrix3d(...)" of a plane seen in perspective). */
export function parseMatrix(s: string): Mat {
  if (!s || s === 'none') return IDENTITY;
  const m = s.match(/matrix(3d)?\(([^)]+)\)/);
  if (!m) return IDENTITY;
  const v = m[2].split(',').map(Number);
  if (v.some((x) => !Number.isFinite(x))) return IDENTITY;
  // matrix3d is column-major: x' = m0 x + m4 y + m12, y' = m1 x + m5 y + m13, w = m3 x + m7 y + m15 (z = 0)
  return m[1] ? [v[0], v[4], v[12], v[1], v[5], v[13], v[3], v[7], v[15]] : [v[0], v[2], v[4], v[1], v[3], v[5], 0, 0, 1];
}

/** As CSS: matrix() when there is no perspective, else matrix3d() (z left untouched). */
export function cssOf(m: Mat): string {
  const n = (v: number) => +v.toFixed(7);
  const k = m[8] || 1;
  const h = m.map((v) => v / k) as Mat;
  if (Math.abs(h[6]) < 1e-9 && Math.abs(h[7]) < 1e-9) return `matrix(${[h[0], h[3], h[1], h[4], h[2], h[5]].map(n).join(',')})`;
  return `matrix3d(${[h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, h[8]].map(n).join(',')})`;
}


/** The live pose in viewport space (one style read a frame at most, none at rest). */
export function camNow(): Mat {
  if (!live) return IDENTITY;
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  if (now - cachedAt < 12 && cachedAt >= 0) return cached;
  cachedAt = now;
  if (!live.el.isConnected) return (cached = IDENTITY);
  cached = parseMatrix(getComputedStyle(live.el).transform);
  return cached;
}

export function isIdentity(m: Mat): boolean {
  const k = m[8] || 1;
  return (
    Math.abs(m[0] / k - 1) < 1e-4 && Math.abs(m[1] / k) < 1e-4 && Math.abs(m[3] / k) < 1e-4 && Math.abs(m[4] / k - 1) < 1e-4 &&
    Math.abs(m[2] / k) < 0.05 && Math.abs(m[5] / k) < 0.05 && Math.abs(m[6] / k) < 1e-7 && Math.abs(m[7] / k) < 1e-7
  );
}

/** Point (x, y) through pose m. */
export function apply(m: Mat, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8] || 1e-9;
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

/** A rectangle seen on screen under pose m → where it rests (its corners mapped back). */
export function unmapWith(r: RectLike, m: Mat): RectLike {
  if (isIdentity(m)) return r;
  const inv = invert(m);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]]) {
    const [u, v] = apply(inv, x, y);
    x0 = Math.min(x0, u);
    y0 = Math.min(y0, v);
    x1 = Math.max(x1, u);
    y1 = Math.max(y1, v);
  }
  // the centre maps back on its own (a box of the mapped-back corners is a little wider than the
  // card under a strong tilt, and lopsided); the size is that box's (a few percent large at the peak)
  const [cx, cy] = apply(inv, r.left + r.width / 2, r.top + r.height / 2);
  const w = x1 - x0;
  const h = y1 - y0;
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, right: cx + w / 2, bottom: cy + h / 2 };
}

/** A field card's rectangle as it rests (the same rectangle, and no style read, whenever no shot is live). */
export function unmapRect<T extends RectLike>(r: T): RectLike {
  return live ? unmapWith(r, camNow()) : r;
}
