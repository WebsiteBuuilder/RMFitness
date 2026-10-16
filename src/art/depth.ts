// Turns a card picture into what the 3D figure needs: the artwork cropped out of
// the card frame, a depth map guessed from the art (the subject stands forward,
// the background falls back) and the art's own main colors.
import { card, imageUrl } from '../eds/db';
import { pressQuiet } from './hold';

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
  /**
   * Small pixel copies read once while the art loads (in the background), so measuring a
   * figure later never draws and reads an image mid-duel (that can stall a frame for seconds
   * while the GPU is busy): the relief at 64×64 and the art at 32×32, RGBA.
   */
  reliefPx?: Uint8ClampedArray;
  artPx?: Uint8ClampedArray;
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

async function relief(name: string): Promise<{ img: HTMLImageElement; palette: number[]; px?: Uint8ClampedArray } | null> {
  const id = card(name)?.id;
  if (!id) return null;
  const palette = (await figures())[id];
  if (!palette) return null;
  try {
    const src = `${BASE}cards/fig/${id}.webp`;
    const [img, px] = await Promise.all([loadImage(src), pxOff(src, 64)]);
    await img.decode?.().catch(() => {});
    return { img, palette, px };
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
    // CPU-backed (willReadFrequently): the reads of this art below and in artTame never stall on the GPU
    full.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0, full.width, full.height);
  } catch {
    full = drawnCard(name);
  }
  const sx = full.width * ART_BOX.x;
  const sy = full.height * ART_BOX.y;
  const sw = full.width * ART_BOX.w;
  const sh = full.height * ART_BOX.h;
  const art = canvas(256, 256);
  art.getContext('2d', { willReadFrequently: true })!.drawImage(full, sx, sy, sw, sh, 0, 0, 256, 256);
  const pre = await fig;
  const id = card(name)?.id;
  const artPx = readPx(art, 32);
  if (pre) return { art, full, depth: new Uint8Array(DEPTH_SIZE * DEPTH_SIZE), relief: pre.img, palette: pre.palette, id, reliefPx: pre.px ?? readPx(pre.img, 64), artPx };
  const small = canvas(DEPTH_SIZE, DEPTH_SIZE);
  const sg = small.getContext('2d', { willReadFrequently: true })!;
  sg.drawImage(art, 0, 0, DEPTH_SIZE, DEPTH_SIZE);
  const { depth, palette } = analyse(sg.getImageData(0, 0, DEPTH_SIZE, DEPTH_SIZE).data, DEPTH_SIZE);
  return { art, full, depth, relief: null, palette, id, artPx };
}

let pxWorker: Worker | null | undefined;
let pxSeq = 0;
const pxWaiting = new Map<number, (px: Uint8ClampedArray | undefined) => void>();
/** The picture at `url` read at n×n by a worker, off the page (undefined where workers can't). */
function pxOff(url: string, n: number): Promise<Uint8ClampedArray | undefined> {
  if (pxWorker === undefined) {
    try {
      pxWorker = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' ? new Worker(new URL('./px.worker.ts', import.meta.url), { type: 'module' }) : null;
      pxWorker?.addEventListener('message', (e: MessageEvent<{ id: number; px: Uint8ClampedArray | null }>) => {
        pxWaiting.get(e.data.id)?.(e.data.px ?? undefined);
        pxWaiting.delete(e.data.id);
      });
    } catch {
      pxWorker = null;
    }
  }
  if (!pxWorker) return Promise.resolve(undefined);
  const id = ++pxSeq;
  return new Promise((ok) => {
    pxWaiting.set(id, ok);
    pxWorker!.postMessage({ id, url: new URL(url, location.href).href, n });
  });
}

/** `src` drawn at n×n on a CPU-backed canvas and read back (undefined if that fails). */
function readPx(src: CanvasImageSource, n: number): Uint8ClampedArray | undefined {
  try {
    const g = canvas(n, n).getContext('2d', { willReadFrequently: true })!;
    g.drawImage(src, 0, 0, n, n);
    return g.getImageData(0, 0, n, n).data;
  } catch {
    return undefined;
  }
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
export async function preloadArt(names: string[], stop: () => boolean = () => false, each?: (art: ArtData) => void): Promise<void> {
  const list = names.filter((n) => !!card(n)).slice(0, CACHE_MAX - 8);
  let i = 0;
  // between cards, wait for an idle moment (never mid-animation when the phone is busy)
  const w = typeof window !== 'undefined' ? (window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }) : null;
  const idle = () => new Promise<void>((ok) => (w?.requestIdleCallback ? w.requestIdleCallback(() => ok(), { timeout: 1500 }) : setTimeout(ok, 60)));
  // and never while a cinematic plays or a finger is on the screen (up to 8 s of waiting, then on)
  const pause = async () => {
    await idle();
    for (let k = 0; k < 40 && typeof document !== 'undefined' && (document.body.classList.contains('art-on') || pressQuiet()); k++) await new Promise((ok) => setTimeout(ok, 200));
  };
  const worker = async () => {
    while (i < list.length && !stop()) {
      const n = list[i++];
      const art = await artFor(n).catch(() => null);
      if (art && each && !stop()) each(art);
      await pause();
    }
  };
  await Promise.all([worker(), worker()]);
}

/**
 * A card back, drawn once: a dark bronze border, a deep swirl of dark smoke and a
 * central oval with a thin gold rim. Matte (no glow of its own): a face-down card
 * reads as a card, not a lit panel.
 */
let back: HTMLCanvasElement | null = null;
export function cardBack(): HTMLCanvasElement {
  if (back) return back;
  const W = 300;
  const H = 437;
  back = canvas(W, H);
  const g = back.getContext('2d')!;
  // the border: dark bronze with a thin lighter bevel
  g.fillStyle = '#3a2614';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#7a5a34';
  g.lineWidth = 3;
  g.strokeRect(4, 4, W - 8, H - 8);
  // the field: near black-brown, darker toward the edges
  const fx = 16;
  const fy = 16;
  const fw = W - 32;
  const fh = H - 32;
  const bg = g.createRadialGradient(W / 2, H / 2, 20, W / 2, H / 2, 260);
  bg.addColorStop(0, '#3b2416');
  bg.addColorStop(1, '#0f0805');
  g.fillStyle = bg;
  g.fillRect(fx, fy, fw, fh);
  g.save();
  g.beginPath();
  g.rect(fx, fy, fw, fh);
  g.clip();
  // the swirl: spiral arms of dark smoke turning into the middle (deterministic)
  g.lineCap = 'round';
  for (let arm = 0; arm < 7; arm++) {
    const a0 = (arm / 7) * Math.PI * 2;
    for (let pass = 0; pass < 2; pass++) {
      g.beginPath();
      for (let i = 0; i <= 60; i++) {
        const k = i / 60;
        const r = 18 + k * 210;
        const a = a0 + k * 3.4 + pass * 0.12;
        const x = W / 2 + Math.cos(a) * r * 0.78;
        const y = H / 2 + Math.sin(a) * r;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.strokeStyle = pass ? 'rgba(20, 10, 6, 0.55)' : 'rgba(110, 62, 34, 0.35)';
      g.lineWidth = pass ? 10 : 16;
      g.stroke();
    }
  }
  g.restore();
  // the central oval: a dark core with a gold rim, a faint warm light inside (no glow)
  const ov = g.createRadialGradient(W / 2, H / 2, 6, W / 2, H / 2, 100);
  ov.addColorStop(0, '#5a3a20');
  ov.addColorStop(0.7, '#24140a');
  ov.addColorStop(1, '#140a05');
  g.fillStyle = ov;
  g.beginPath();
  g.ellipse(W / 2, H / 2, 74, 104, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#a8803e';
  g.lineWidth = 4;
  g.stroke();
  g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  g.lineWidth = 2;
  g.beginPath();
  g.ellipse(W / 2, H / 2, 66, 96, 0, 0, Math.PI * 2);
  g.stroke();
  // the inner frame line
  g.strokeStyle = 'rgba(168, 128, 62, 0.55)';
  g.lineWidth = 2;
  g.strokeRect(fx + 6, fy + 6, fw - 12, fh - 12);
  return back;
}
