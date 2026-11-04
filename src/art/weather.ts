// Weather over the duel field (Speed Duels, Touch board): rain, ash or blowing sand, the
// splashes it makes on the mat, and lightning bolts. One plain 2D canvas over the field
// (never the hand), drawn at up to 1.5x the CSS pixels, 30 frames a second (20 when the
// phone falls behind), and asleep when nothing falls and no bolt is lit. Every drop of a
// kind goes into one path and one stroke per frame; no blur filters, no shadows.
// The rules for what falls when live in src/ui/weatherRules.ts; Weather.tsx drives this.

export type FxPrecip = 'rain' | 'ash' | 'sand';

interface Bolt {
  pts: number[];
  branch: number[];
  born: number;
  life: number;
}

/** how many drops a full storm keeps on a phone-sized field (scaled by the field's area) */
const STORM_DROPS = 170;
const AREA_REF = 380 * 520;

export class WeatherFx {
  private ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private frameMs = 1000 / 30;
  private slow = 0;
  /** the drops: x, y, length, speed, layer (0 far, 1 near) */
  private drops = new Float32Array(0);
  private count = 0;
  /** how hard it falls, 0..1, and where it is heading (it rolls in and eases off) */
  private amount = 0;
  private target = 0;
  private wind = 0.18;
  private kind: FxPrecip = 'rain';
  private splashes: number[] = []; // x, y, age (s)
  private bolts: Bolt[] = [];
  private paused = false;
  private reduced = false;
  private ro: ResizeObserver | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d', { alpha: true });
    if (!c) throw new Error('no 2d canvas');
    this.ctx = c;
    this.reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    }
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.5);
    this.w = Math.max(1, Math.round(r.width * this.dpr));
    this.h = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    const n = Math.round(STORM_DROPS * Math.min(2.2, Math.max(0.6, (r.width * r.height) / AREA_REF)));
    if (n !== this.drops.length / 5) {
      this.drops = new Float32Array(n * 5);
      for (let i = 0; i < n; i++) this.seed(i, true);
    }
    this.wake();
  }

  /** a fresh drop at the top (or anywhere, at the start) */
  private seed(i: number, anywhere: boolean) {
    const d = this.drops;
    const o = i * 5;
    const near = Math.random() < 0.35 ? 1 : 0;
    d[o] = Math.random() * this.w * 1.2 - this.w * 0.1;
    d[o + 1] = anywhere ? Math.random() * this.h : -Math.random() * this.h * 0.2;
    d[o + 2] = (near ? 16 + Math.random() * 10 : 8 + Math.random() * 6) * this.dpr;
    d[o + 3] = (near ? 1.0 : 0.65) * (0.85 + Math.random() * 0.3);
    d[o + 4] = near;
  }

  /** What falls and how hard (0 none, 0.4 rain, 1 storm). It rolls in over a few seconds. */
  set(kind: FxPrecip, amount: number) {
    if (kind !== this.kind) {
      this.kind = kind;
      for (let i = 0; i < this.drops.length / 5; i++) this.seed(i, true);
    }
    this.target = Math.max(0, Math.min(1, amount));
    this.wind = kind === 'sand' ? 2.4 : 0.12 + this.target * 0.22;
    this.wake();
  }

  /** A lightning bolt from the sky over the opponent's side (the flash itself is a DOM layer). */
  bolt() {
    if (this.reduced) return;
    const x0 = this.w * (0.15 + Math.random() * 0.7);
    const y1 = this.h * (0.28 + Math.random() * 0.2);
    const pts = [x0, -4];
    let x = x0;
    const steps = 9;
    for (let i = 1; i <= steps; i++) {
      x += (Math.random() - 0.5) * this.w * 0.07;
      pts.push(x, (y1 * i) / steps);
    }
    const k = 2 * (3 + Math.floor(Math.random() * 3));
    const branch = [pts[k], pts[k + 1]];
    let bx = pts[k];
    const dir = Math.random() < 0.5 ? -1 : 1;
    for (let i = 1; i <= 4; i++) {
      bx += dir * this.w * (0.02 + Math.random() * 0.03);
      branch.push(bx, pts[k + 1] + (y1 * 0.12 * i) / 2);
    }
    this.bolts.push({ pts, branch, born: performance.now(), life: 420 });
    this.wake();
  }

  /** Hold still (a cinematic covers the screen, or the tab is hidden). */
  pause(on: boolean) {
    this.paused = on;
    if (!on) this.wake();
  }

  get busy() {
    return this.amount > 0.002 || this.target > 0 || this.bolts.length > 0 || this.splashes.length > 0;
  }

  private wake() {
    if (this.raf || this.paused || !this.busy) return;
    this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.paused) return;
    if (typeof document !== 'undefined' && document.hidden) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    const since = this.last ? now - this.last : this.frameMs;
    if (since < this.frameMs - 2) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    // a phone that keeps falling behind steps down to 20 frames a second
    if (this.last && since > 60) {
      if (++this.slow > 20) this.frameMs = 1000 / 20;
    } else this.slow = Math.max(0, this.slow - 1);
    this.last = now;
    this.draw(Math.min(0.1, since / 1000), now);
    if (this.busy) this.raf = requestAnimationFrame(this.frame);
    else this.ctx.clearRect(0, 0, this.w, this.h);
  };

  private draw(dt: number, now: number) {
    const c = this.ctx;
    const { w, h, dpr } = this;
    // roll in over ~4 s, ease off over ~3 s
    const rate = this.target > this.amount ? 0.25 : 0.35;
    this.amount += Math.sign(this.target - this.amount) * Math.min(Math.abs(this.target - this.amount), rate * dt);
    c.clearRect(0, 0, w, h);
    const total = this.drops.length / 5;
    this.count = Math.round(total * this.amount * (this.reduced ? 0.5 : 1));
    if (this.count > 0) {
      if (this.kind === 'rain') this.rain(dt);
      else if (this.kind === 'ash') this.ash(dt, now);
      else this.sand(dt);
    }
    // splashes on the mat (rain only): small rings that open and fade
    if (this.kind === 'rain' && this.count > 0 && !this.reduced) {
      const want = this.amount * 9 * dt * 30;
      for (let i = 0; i < want; i++) if (Math.random() < want - i) this.splashes.push(w * (0.08 + Math.random() * 0.84), h * (0.12 + Math.random() * 0.8), 0);
    }
    if (this.splashes.length) {
      c.beginPath();
      const s = this.splashes;
      let j = 0;
      for (let i = 0; i < s.length; i += 3) {
        const age = s[i + 2] + dt;
        if (age > 0.24) continue;
        s[j] = s[i];
        s[j + 1] = s[i + 1];
        s[j + 2] = age;
        j += 3;
        const r = (1 + age * 18) * dpr;
        c.moveTo(s[i] + r, s[i + 1]);
        c.ellipse(s[i], s[i + 1], r, r * 0.38, 0, 0, Math.PI * 2);
      }
      s.length = j;
      c.lineWidth = 0.8 * dpr;
      c.strokeStyle = 'rgba(205,225,255,0.24)';
      c.stroke();
    }
    if (this.bolts.length) this.drawBolts(now);
  }

  private rain(dt: number) {
    const c = this.ctx;
    const d = this.drops;
    const { w, h, dpr } = this;
    const fall = h * 1.6 * dt;
    const wind = this.wind;
    for (let layer = 0; layer < 2; layer++) {
      c.beginPath();
      for (let i = 0; i < this.count; i++) {
        const o = i * 5;
        if (d[o + 4] !== layer) continue;
        const sp = d[o + 3] * fall;
        d[o] += sp * wind;
        d[o + 1] += sp;
        if (d[o + 1] > h + 20 || d[o] > w + 40) this.seed(i, false);
        const len = d[o + 2];
        c.moveTo(d[o], d[o + 1]);
        c.lineTo(d[o] - len * wind, d[o + 1] - len);
      }
      c.lineWidth = (layer ? 1.25 : 0.8) * dpr;
      c.strokeStyle = layer ? 'rgba(215,230,255,0.42)' : 'rgba(180,200,240,0.26)';
      c.stroke();
    }
  }

  private ash(dt: number, now: number) {
    const c = this.ctx;
    const d = this.drops;
    const { w, h, dpr } = this;
    const fall = h * 0.12 * dt;
    c.fillStyle = 'rgba(190,180,175,0.5)';
    c.beginPath();
    for (let i = 0; i < this.count; i++) {
      const o = i * 5;
      const ember = i % 7 === 0;
      if (ember) continue;
      d[o] += Math.sin(now / 900 + i) * 0.4 * dpr + fall * 0.3;
      d[o + 1] += d[o + 3] * fall;
      if (d[o + 1] > h + 6 || d[o] > w + 10) this.seed(i, false);
      const s = (d[o + 4] ? 2.4 : 1.5) * dpr;
      c.rect(d[o], d[o + 1], s, s);
    }
    c.fill();
    // embers rise
    c.fillStyle = 'rgba(255,140,60,0.75)';
    c.beginPath();
    for (let i = 0; i < this.count; i += 7) {
      const o = i * 5;
      d[o] += Math.sin(now / 500 + i) * 0.6 * dpr;
      d[o + 1] -= d[o + 3] * fall * 2.2;
      if (d[o + 1] < -6) d[o + 1] = h + Math.random() * 20;
      const s = 1.8 * dpr;
      c.rect(d[o], d[o + 1], s, s);
    }
    c.fill();
  }

  private sand(dt: number) {
    const c = this.ctx;
    const d = this.drops;
    const { w, dpr } = this;
    const run = w * 1.1 * dt;
    c.beginPath();
    for (let i = 0; i < this.count; i++) {
      const o = i * 5;
      d[o] += d[o + 3] * run;
      d[o + 1] += d[o + 3] * run * 0.08;
      if (d[o] > w + 30) (this.seed(i, true), (this.drops[o] = -30));
      const len = d[o + 2] * 1.4;
      c.moveTo(d[o], d[o + 1]);
      c.lineTo(d[o] - len, d[o + 1] - len * 0.08);
    }
    c.lineWidth = 1.1 * dpr;
    c.strokeStyle = 'rgba(225,190,130,0.34)';
    c.stroke();
  }

  private drawBolts(now: number) {
    const c = this.ctx;
    const { dpr } = this;
    this.bolts = this.bolts.filter((b) => now - b.born < b.life);
    for (const b of this.bolts) {
      const t = (now - b.born) / b.life;
      // a flicker: on, dim, on again, gone
      const a = t < 0.15 ? 1 : t < 0.3 ? 0.35 : t < 0.5 ? 0.9 : 1 - (t - 0.5) / 0.5;
      const path = (p: number[]) => {
        c.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
      };
      c.lineCap = 'round';
      c.lineJoin = 'round';
      for (const [lw, col] of [
        [9, `rgba(140,160,255,${(0.18 * a).toFixed(3)})`],
        [4, `rgba(190,205,255,${(0.5 * a).toFixed(3)})`],
        [1.6, `rgba(255,255,255,${(0.95 * a).toFixed(3)})`],
      ] as [number, string][]) {
        c.beginPath();
        path(b.pts);
        c.lineWidth = lw * dpr;
        c.strokeStyle = col;
        c.stroke();
        c.beginPath();
        path(b.branch);
        c.lineWidth = lw * dpr * 0.6;
        c.stroke();
      }
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
  }
}
