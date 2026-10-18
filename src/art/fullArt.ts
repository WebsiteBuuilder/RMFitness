// The full-art face of an Overframe or Millennium card for the 3D scenes (the card that flies
// out of the hand and shatters in a summon), drawn on a canvas to match the card's CSS look in
// src/level/level.css: the art spread over the whole card behind a sharp window that melts into
// it, the name on the art, a dark glass text box, a rainbow (Overframe) or gold (Millennium) edge.
import { card } from '../eds/db';
import { ART_BOX } from './depth';
import { FIN } from './finish';

const cache = new Map<string, HTMLCanvasElement>();

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function round(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

/** The card's face at its finish (Overframe or better), from its picture `src`. */
export function fullArtCard(src: HTMLCanvasElement, name: string, fin: number): HTMLCanvasElement {
  const mi = fin >= FIN.MI;
  const key = `${name}|${mi ? 'MI' : 'OF'}|${src.width}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const W = src.width;
  const H = src.height;
  const out = canvas(W, H);
  const g = out.getContext('2d');
  if (!g) return src;
  const ax = ART_BOX.x * W;
  const ay = ART_BOX.y * H;
  const aw = ART_BOX.w * W;
  const ah = ART_BOX.h * H;
  // the spread: the art box scaled to the card's height, blurred (drawn tiny, then scaled up)
  const s = H / ah;
  const small = canvas(W / 14, H / 14);
  const sg = small.getContext('2d')!;
  sg.drawImage(src, ax, ay, aw, ah, (small.width - aw * s / 14) / 2, 0, (aw * s) / 14, small.height);
  g.imageSmoothingEnabled = true;
  g.drawImage(small, 0, 0, W, H);
  g.fillStyle = mi ? '#1a1000' : '#000';
  g.globalAlpha = mi ? 0.62 : 0.3;
  g.fillRect(0, 0, W, H);
  if (mi) {
    g.globalCompositeOperation = 'color';
    g.globalAlpha = 0.55;
    g.fillStyle = '#c8961e';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }
  g.globalAlpha = 1;
  // the sharp art, its edges melting into the spread
  const wx = 0.03 * W;
  const wy = 0.095 * H;
  const ww = 0.94 * W;
  const wh = 0.646 * H;
  const win = canvas(ww, wh);
  const wg = win.getContext('2d')!;
  wg.drawImage(src, ax, ay, aw, ah, 0, 0, win.width, win.height);
  wg.globalCompositeOperation = 'destination-in';
  const fx = wg.createLinearGradient(0, 0, win.width, 0);
  fx.addColorStop(0, 'rgba(0,0,0,0)');
  fx.addColorStop(0.09, '#000');
  fx.addColorStop(0.91, '#000');
  fx.addColorStop(1, 'rgba(0,0,0,0)');
  wg.fillStyle = fx;
  wg.fillRect(0, 0, win.width, win.height);
  const fy = wg.createLinearGradient(0, 0, 0, win.height);
  fy.addColorStop(0, 'rgba(0,0,0,0)');
  fy.addColorStop(0.07, '#000');
  fy.addColorStop(0.84, '#000');
  fy.addColorStop(1, 'rgba(0,0,0,0)');
  wg.fillStyle = fy;
  wg.fillRect(0, 0, win.width, win.height);
  g.drawImage(win, wx, wy);
  // a dark band under the name
  const top = g.createLinearGradient(0, 0, 0, H * 0.18);
  top.addColorStop(0, 'rgba(0,0,0,0.85)');
  top.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = top;
  g.fillRect(0, 0, W, H * 0.18);
  const gold = mi ? '#ffd56a' : '#ff5ad8';
  g.font = `800 ${Math.min(0.066, 0.92 / (name.length * 0.56)) * W}px system-ui, sans-serif`;
  g.textBaseline = 'top';
  g.fillStyle = mi ? '#fff3c8' : '#fff';
  g.shadowColor = '#000';
  g.shadowBlur = W * 0.01;
  g.fillText(name, W * 0.05, H * 0.025, W * 0.9);
  // the glass text box
  const info = card(name);
  const bx = W * 0.05;
  const by = H * 0.752;
  const bw = W * 0.9;
  const bh = H * 0.216;
  g.shadowBlur = W * 0.02;
  g.shadowColor = gold;
  g.fillStyle = mi ? 'rgba(10,6,0,0.9)' : 'rgba(8,10,24,0.88)';
  g.beginPath();
  round(g, bx, by, bw, bh, W * 0.03);
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = Math.max(1, W * 0.008);
  g.strokeStyle = gold;
  g.stroke();
  if (info?.kind === 'monster') {
    g.font = `900 ${W * 0.05}px system-ui, sans-serif`;
    g.fillStyle = '#fff';
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.fillText(`ATK/${info.atk ?? '?'} DEF/${info.def ?? '?'}`, bx + bw - W * 0.03, by + bh - H * 0.015);
    g.textAlign = 'left';
  }
  // the plate on the glass's top edge
  const label = mi ? 'MILLENNIUM' : 'OVERFRAME';
  const pw = W * (mi ? 0.62 : 0.56);
  const ph = W * 0.085;
  const px = (W - pw) / 2;
  const py = by - ph / 2;
  const pg = g.createLinearGradient(px, 0, px + pw, 0);
  if (mi) {
    pg.addColorStop(0, '#2a1a00');
    pg.addColorStop(0.5, '#000');
    pg.addColorStop(1, '#2a1a00');
  } else ['#ff4fd0', '#ffb84f', '#4fd8a0', '#4fe0ff', '#a24fff'].forEach((c, i) => pg.addColorStop(i / 4, c));
  g.fillStyle = pg;
  g.beginPath();
  round(g, px, py, pw, ph, ph / 2);
  g.fill();
  g.strokeStyle = mi ? '#ffd56a' : '#fff';
  g.stroke();
  g.font = `900 ${ph * 0.62}px system-ui, sans-serif`;
  g.fillStyle = mi ? '#ffe9a8' : '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, W / 2, py + ph / 2 + 1, pw * 0.9);
  // the edge: a rainbow (Overframe) or a gold line inside a dark one (Millennium)
  const e = g.createLinearGradient(0, 0, W, H);
  (mi ? ['#6a4800', '#ffd56a', '#fff6d8', '#ffd56a', '#6a4800'] : ['#ff4fd0', '#ffb84f', '#fff6c8', '#7cff9e', '#4fe0ff', '#a24fff']).forEach((c, i, a) => e.addColorStop(i / (a.length - 1), c));
  g.lineWidth = W * 0.035;
  g.strokeStyle = e;
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, W - g.lineWidth, H - g.lineWidth);
  cache.set(key, out);
  return out;
}

let eyeCanvas: HTMLCanvasElement | null = null;
/** The Millennium Eye (Wedjat) in gold on a clear canvas, for a card panel (only the strokes show).
 *  Drawn on a card-shaped canvas (CardPanel's 0.686 aspect), the eye across its middle. */
export function millenniumEyeCanvas(): HTMLCanvasElement {
  if (eyeCanvas) return eyeCanvas;
  const W = 343;
  const H = 500;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  if (!g) return c;
  g.translate(W / 2, H / 2);
  const k = W / 110;
  g.scale(k, k);
  g.translate(-50, -32);
  const gold = g.createLinearGradient(0, 0, 0, 64);
  gold.addColorStop(0, '#fff6d8');
  gold.addColorStop(0.5, '#ffd56a');
  gold.addColorStop(1, '#c8961e');
  g.shadowColor = '#ffc93a';
  g.shadowBlur = 6;
  g.strokeStyle = gold;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = 5;
  const path = (d: string) => g.stroke(new Path2D(d));
  path('M10 13 Q50 -4 92 10');
  path('M8 30 Q50 6 92 28 Q50 46 8 30 Z');
  path('M40 41 L34 60');
  path('M58 40 Q66 58 80 56 Q90 54 86 46');
  // the iris: a gold ring around a gold pupil
  g.lineWidth = 4;
  g.beginPath();
  g.arc(50, 27, 9, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#ffd56a';
  g.beginPath();
  g.arc(50, 27, 4.2, 0, Math.PI * 2);
  g.fill();
  eyeCanvas = c;
  return c;
}
