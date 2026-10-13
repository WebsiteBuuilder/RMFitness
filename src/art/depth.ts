// Turns a card picture into what the 3D figure needs: the artwork cropped out of
// the card frame, a depth map guessed from the art (the subject stands forward,
// the background falls back) and the art's own main colors.
import { card, imageUrl } from '../eds/db';

/** The artwork box inside a full card picture, as fractions of its size. */
export const ART_BOX = { x: 0.12, y: 0.178, w: 0.76, h: 0.525 };
export const DEPTH_SIZE = 96;

export interface ArtData {
  /** the cropped artwork (square) */
  art: HTMLCanvasElement;
  /** the whole card, for card-shaped panels */
  full: HTMLCanvasElement;
  /** DEPTH_SIZE² depth values 0..255 (subject high, background low), guessed in the browser */
  depth: Uint8Array;
  /**
   * The prebuilt figure map when the card has one (public/cards/fig, made by
   * scripts/build-figures.py): RGB = relief, alpha = the subject cut out of its
   * background. Much cleaner than the guessed depth.
   */
  relief: HTMLImageElement | null;
  /** three main colors of the art, most striking first (0xRRGGBB) */
  palette: number[];
  /** the card's id when known (per-card figure tunes, src/art/overrides.ts) */
  id?: number;
}

const cache = new Map<string, Promise<ArtData>>();

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

/** A drawn stand-in card when the picture is missing. */
function drawnCard(name: string): HTMLCanvasElement {
  const info = card(name);
  const c = canvas(300, 437);
  const g = c.getContext('2d')!;
  const top = info?.kind === 'spell' ? '#1d8f6e' : info?.kind === 'trap' ? '#8f2a6e' : info?.sub === 'Fusion' ? '#6a3a9a' : info?.sub === 'Ritual' ? '#3a5aaa' : info?.sub === 'Normal' ? '#c9a24a' : '#c86a2a';
  g.fillStyle = top;
  g.fillRect(0, 0, 300, 437);
  const grd = g.createRadialGradient(150, 190, 10, 150, 190, 140);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(0.4, top);
  grd.addColorStop(1, '#101020');
  g.fillStyle = grd;
  g.fillRect(36, 78, 228, 229);
  g.fillStyle = '#fff';
  g.font = 'bold 22px sans-serif';
  g.textAlign = 'center';
  g.fillText(name.slice(0, 22), 150, 50, 270);
  return c;
}

function rgbToHsl(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 510;
  const d = (mx - mn) / 255;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

function blur(src: Float32Array, n: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0;
      let c = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= n) continue;
        s += src[y * n + xx];
        c++;
      }
      tmp[y * n + x] = s / c;
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0;
      let c = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= n) continue;
        s += tmp[yy * n + x];
        c++;
      }
      out[y * n + x] = s / c;
    }
  return out;
}

/** Depth and palette from the art pixels. Exported for tests. */
export function analyse(px: Uint8ClampedArray, n: number): { depth: Uint8Array; palette: number[] } {
  // 1. The border's average color is the background guess.
  let br = 0;
  let bg = 0;
  let bb = 0;
  let bc = 0;
  const ring = Math.max(2, Math.round(n * 0.06));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (x >= ring && y >= ring && x < n - ring && y < n - ring) continue;
      const i = (y * n + x) * 4;
      br += px[i];
      bg += px[i + 1];
      bb += px[i + 2];
      bc++;
    }
  br /= bc;
  bg /= bc;
  bb /= bc;
  // 2. Saliency: how different each pixel is from the background, plus a center pull
  //    and a little brightness and saturation (subjects tend to be lit and colorful).
  const raw = new Float32Array(n * n);
  const buckets = new Map<number, { n: number; r: number; g: number; b: number; s: number }>();
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const diff = Math.sqrt((r - br) ** 2 + (g - bg) ** 2 + (b - bb) ** 2) / 255;
      const { s, l } = rgbToHsl(r, g, b);
      const dx = x / n - 0.5;
      const dy = y / n - 0.55;
      const center = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.6);
      raw[y * n + x] = Math.min(1, diff * 1.4) * 0.55 + center * 0.3 + l * 0.08 + s * 0.07;
      // 3. Palette buckets (4 bits a channel), weighted toward saturated mid-tones.
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bkt = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0, s: 0 };
      bkt.n++;
      bkt.r += r;
      bkt.g += g;
      bkt.b += b;
      bkt.s += s * (1 - Math.abs(l - 0.55));
      buckets.set(key, bkt);
    }
  const soft = blur(blur(raw, n, 3), n, 2);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of soft) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const depth = new Uint8Array(n * n);
  const span = Math.max(1e-3, hi - lo);
  for (let i = 0; i < soft.length; i++) {
    const v = (soft[i] - lo) / span;
    depth[i] = Math.round(255 * v * v * (3 - 2 * v)); // smoothstep: crisper subject edge
  }
  const ranked = [...buckets.values()].map((b) => ({ c: ((b.r / b.n) << 16) | ((b.g / b.n) << 8) | (b.b / b.n), score: b.s + b.n * 0.02 })).sort((a, b) => b.score - a.score);
  const palette: number[] = [];
  const far = (a: number, b: number) => Math.abs((a >> 16) - (b >> 16)) + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) + Math.abs((a & 255) - (b & 255)) > 120;
  for (const { c } of ranked) {
    if (palette.every((p) => far(p, c))) palette.push(c);
    if (palette.length === 3) break;
  }
  while (palette.length < 3) palette.push(palette[0] ?? 0xffffff);
  return { depth, palette };
}

const BASE = import.meta.env?.BASE_URL ?? '/';
let figIndex: Promise<Record<string, number[]>> | null = null;
/** Which cards have a prebuilt figure map, with the subject's three main colors. */
function figures(): Promise<Record<string, number[]>> {
  figIndex ??= fetch(`${BASE}cards/fig/index.json`)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return figIndex;
}

async function relief(name: string): Promise<{ img: HTMLImageElement; palette: number[] } | null> {
  const id = card(name)?.id;
  if (!id) return null;
  const palette = (await figures())[id];
  if (!palette) return null;
  try {
    const img = await loadImage(`${BASE}cards/fig/${id}.webp`);
    await img.decode?.().catch(() => {});
    return { img, palette };
  } catch {
    return null;
  }
}

async function build(name: string): Promise<ArtData> {
  const url = imageUrl(name);
  const fig = relief(name);
  let full: HTMLCanvasElement;
  try {
    if (!url) throw new Error('no image');
    const img = await loadImage(url);
    await img.decode?.().catch(() => {});
    full = canvas(img.naturalWidth || 300, img.naturalHeight || 437);
    full.getContext('2d')!.drawImage(img, 0, 0, full.width, full.height);
  } catch {
    full = drawnCard(name);
  }
  const sx = full.width * ART_BOX.x;
  const sy = full.height * ART_BOX.y;
  const sw = full.width * ART_BOX.w;
  const sh = full.height * ART_BOX.h;
  const art = canvas(256, 256);
  art.getContext('2d')!.drawImage(full, sx, sy, sw, sh, 0, 0, 256, 256);
  const pre = await fig;
  const id = card(name)?.id;
  if (pre) return { art, full, depth: new Uint8Array(DEPTH_SIZE * DEPTH_SIZE), relief: pre.img, palette: pre.palette, id };
  const small = canvas(DEPTH_SIZE, DEPTH_SIZE);
  const sg = small.getContext('2d', { willReadFrequently: true })!;
  sg.drawImage(art, 0, 0, DEPTH_SIZE, DEPTH_SIZE);
  const { depth, palette } = analyse(sg.getImageData(0, 0, DEPTH_SIZE, DEPTH_SIZE).data, DEPTH_SIZE);
  return { art, full, depth, relief: null, palette, id };
}

/** Art data for a card, built once and cached (the last 40 cards). */
export function artFor(name: string): Promise<ArtData> {
  let p = cache.get(name);
  if (!p) {
    p = build(name);
    cache.set(name, p);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  } else {
    // most recently used last: what a duel keeps using stays cached
    cache.delete(name);
    cache.set(name, p);
  }
  return p;
}

const CACHE_MAX = 48;

/**
 * Gets the art of these cards ready ahead of time (both decks at the start of a
 * duel), two at a time, a short pause between each, so a cinematic never waits
 * for a picture. Stops when `stop()` turns true. At most CACHE_MAX - 8 names.
 */
export async function preloadArt(names: string[], stop: () => boolean = () => false): Promise<void> {
  const list = names.filter((n) => !!card(n)).slice(0, CACHE_MAX - 8);
  let i = 0;
  const pause = () => new Promise<void>((ok) => setTimeout(ok, 60));
  const worker = async () => {
    while (i < list.length && !stop()) {
      const n = list[i++];
      await artFor(n).catch(() => null);
      await pause();
    }
  };
  await Promise.all([worker(), worker()]);
}

/** A plain card back, drawn once. */
let back: HTMLCanvasElement | null = null;
export function cardBack(): HTMLCanvasElement {
  if (back) return back;
  back = canvas(300, 437);
  const g = back.getContext('2d')!;
  g.fillStyle = '#4a2a10';
  g.fillRect(0, 0, 300, 437);
  g.fillStyle = '#2a1408';
  g.fillRect(14, 14, 272, 409);
  const grd = g.createRadialGradient(150, 218, 10, 150, 218, 120);
  grd.addColorStop(0, '#ffcf6a');
  grd.addColorStop(0.35, '#d0621a');
  grd.addColorStop(1, '#2a1408');
  g.fillStyle = grd;
  g.beginPath();
  g.ellipse(150, 218, 95, 130, 0, 0, Math.PI * 2);
  g.fill();
  return back;
}
