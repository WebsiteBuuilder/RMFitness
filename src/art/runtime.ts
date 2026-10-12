// The 3D art engine's director and cinematics (loaded on demand: three.js only
// downloads once the first animation is needed). The director plays cues one at
// a time; battle figures stay on stage between the attack, the hit and the
// destruction, then fade when nothing more is coming.
import { card } from '../eds/db';
import type { Pid } from '../eds/types';
import type { CardRef, Cue } from './cues';
import { artFor, cardBack, type ArtData } from './depth';
import { profileFor, rand, type ArtProfile, type AttackStyle } from './profile';
import { boom, chime, drone, swell, whoosh, zap } from './sfx';
import { backOut, CardPanel, clamp01, easeIn, easeInOut, easeOut, Figure, lerp, Ribbon, Ring, Stage, type Fx, type Quality } from './stage';

/** DOM text and flashes drawn over the canvas (crisper than text in WebGL). */
export interface Ui {
  banner(o: { title: string; sub?: string; color: number; big?: boolean; dur: number; pos?: 'top' | 'mid' | 'bottom' }): void;
  number(o: { text: string; color: number; side: 'top' | 'bottom'; size: number }): void;
  flash(color: number, strength: number): void;
  caption(text: string, dur: number, cls?: string): void;
}

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
const brighten = (hex: number, min = 170) => {
  let r = (hex >> 16) & 255;
  let g = (hex >> 8) & 255;
  let b = hex & 255;
  const m = Math.max(r, g, b, 1);
  if (m < min) {
    const k = min / m;
    r = Math.min(255, r * k);
    g = Math.min(255, g * k);
    b = Math.min(255, b * k);
  }
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
};
const mix = (a: number, b: number, k: number) => {
  const ch = (s: number) => Math.round(lerp((a >> s) & 255, (b >> s) & 255, k)) << s;
  return ch(16) | ch(8) | ch(0);
};

// ---------------------------------------------------------------- Timeline
type SpanFn = (k: number, dt: number) => void;

/** A scripted cinematic: callbacks at moments and over spans of time (seconds). */
export class Timeline implements Fx {
  t = 0;
  /** playback speed: the Animation speed setting times this cinematic's own scaling */
  rate = 1;
  /** called at the commit marker: the moment the board catches up with the cinematic */
  onCommit: (() => void) | null = null;
  private items: { t0: number; t1: number; fn: SpanFn; done: boolean; cosmetic: boolean }[] = [];
  owned: Fx[] = [];
  constructor(
    public duration: number,
    private stage: Stage,
  ) {}
  /**
   * A callback at one moment. Cosmetic ones (banners, flashes, sounds, shakes,
   * numbers, bursts) are dropped when the cinematic is skipped; pass
   * `cosmetic = false` for steps that change what stays on stage.
   */
  at(t: number, fn: () => void, cosmetic = true) {
    this.items.push({ t0: t, t1: t, fn: () => fn(), done: false, cosmetic });
    return this;
  }
  span(t0: number, t1: number, fn: SpanFn) {
    this.items.push({ t0, t1, fn, done: false, cosmetic: false });
    return this;
  }
  /** Marks the impact or landing: the duel board shows the new state from here on. */
  commit(t: number) {
    return this.at(t, () => this.onCommit?.(), false);
  }
  /** Adds an object that belongs to this cinematic (removed when it ends). */
  own<T extends Fx>(f: T): T {
    this.owned.push(f);
    return this.stage.add(f as T & { mesh?: never });
  }
  update(dt: number) {
    dt *= this.rate;
    this.t += dt;
    for (const it of this.items) {
      if (it.done || this.t < it.t0) continue;
      const k = it.t1 > it.t0 ? clamp01((this.t - it.t0) / (it.t1 - it.t0)) : 1;
      it.fn(k, dt);
      if (this.t >= it.t1) it.done = true;
    }
    return this.t < this.duration;
  }
  /** Jumps to the end (tap to skip): every pending step lands in its final state, without its banners, flashes, sounds or shakes. */
  finish() {
    for (const it of this.items) {
      if (it.done) continue;
      it.done = true;
      if (!it.cosmetic) it.fn(1, 0);
    }
    this.t = this.duration;
  }
  dispose() {
    for (const f of this.owned) this.stage.remove(f);
    this.owned = [];
  }
}

// ---------------------------------------------------------------- actors
interface Actor {
  uid: number;
  name: string;
  side: 'near' | 'far';
  prof: ArtProfile;
  art: ArtData | null;
  fig: Figure | null;
  back: CardPanel | null;
  x: number;
  y: number;
  z: number;
  size: number;
  /** offset from its spot (lunges, knockback) */
  ox: number;
  oy: number;
}

interface Colors {
  main: number;
  accent: number;
  light: number;
}

const SLOW_KINDS = new Set(['summon', 'attack', 'hit', 'win']);

/** A cue waiting to play: `batch` groups the cues of one engine update (one chain), `scale` speeds up a repeat. */
interface Queued {
  cue: Cue;
  batch: number;
  scale: number;
}

/** How much faster a cinematic plays when it flows straight into the next one of its chain. */
function flowRate(cue: Cue, next: Queued | undefined, batch: number): number {
  const same = next && next.batch === batch ? next.cue.kind : null;
  if (cue.kind === 'attack') return same === 'hit' ? 1.6 : 1.25;
  if (cue.kind === 'hit') return 1.25;
  if (cue.kind === 'destroy' || cue.kind === 'damage') return same ? 1.4 : 1.2;
  return 1;
}

export class Director {
  stage: Stage;
  private queue: Queued[] = [];
  private current: Timeline | null = null;
  /** the chain (event batch) the current cinematic belongs to; -1 when none */
  private curBatch = -1;
  /** after a skip, figures left on stage fade at once */
  private fastFade = false;
  /** Animation speed setting: 1, 1.5 or 2 */
  timeScale = 1;
  /** a chain reached its impact or landing */
  onCommit: ((batch: number) => void) | null = null;
  /** a chain is over (played, skipped, cleared or failed) */
  onBatchEnd: ((batch: number) => void) | null = null;
  private actors = new Map<number, Actor>();
  private idleFor = 0;
  private bgTarget = 0;
  private bg = 0;
  private skipAll = false;
  private watchdog = 0;
  onIdle: (() => void) | null = null;
  onBusy: (() => void) | null = null;
  viewer: Pid = 0;

  constructor(
    canvas: HTMLCanvasElement,
    quality: Quality,
    private ui: Ui,
  ) {
    this.stage = new Stage(canvas, quality);
    this.stage.speed = quality === 'fast' ? 1.8 : 1;
    this.stage.onFrame = (dt) => this.frame(dt);
    // WebGL context lost (backgrounded phone, GPU reset): drop everything and report
    // idle so the duel never waits on a cinematic that cannot draw; play again once restored.
    this.stage.onLost = () => this.clear();
  }

  /** Compiles every shader ahead of the first cinematic (call right after construction). */
  prewarm(): Promise<void> {
    return this.stage.prewarm();
  }

  /** The WebGL context is gone: cinematics are skipped until the browser restores it. */
  get broken() {
    return this.stage.lost;
  }

  setQuality(q: Quality) {
    this.stage.quality = q;
    this.stage.speed = q === 'fast' ? 1.8 : 1;
  }

  get busy() {
    return this.queue.length > 0 || this.current !== null || this.actors.size > 0;
  }

  /** Playback speed of what is on now (for the DOM banners' timing). */
  get rate() {
    return this.current?.rate ?? this.timeScale;
  }

  /** Plays one chain: the cues of one engine update. `scales` speeds single cinematics up (2 = half as long). */
  push(cues: Cue[], batch = 0, scales?: number[]) {
    if (!cues.length || this.skipAll || this.stage.lost) {
      // nothing to show (or no WebGL right now): the board catches up at once
      this.onBatchEnd?.(batch);
      if (this.stage.lost) this.onIdle?.();
      return;
    }
    // A long backlog (reconnect, a burst of moves): keep only what matters most.
    const before = new Set(this.queue.map((q) => q.batch));
    this.queue.push(...cues.map((cue, i) => ({ cue, batch, scale: scales?.[i] ?? 1 })));
    if (this.queue.length > 10) {
      this.queue = this.queue.filter((q) => SLOW_KINDS.has(q.cue.kind) || q.cue.kind === 'damage' || q.cue.kind === 'destroy').slice(-10);
      const left = new Set(this.queue.map((q) => q.batch));
      for (const b of [...before, batch]) if (!left.has(b) && b !== this.curBatch) this.onBatchEnd?.(b);
    }
    this.fastFade = false;
    this.onBusy?.();
    this.stage.start();
    if (!this.current) this.next();
  }

  /** Tap: skip the whole current chain (every cue of the same event batch). */
  skip() {
    this.fastFade = true;
    const b = this.curBatch;
    if (b >= 0) this.queue = this.queue.filter((q) => q.batch !== b);
    this.endCurrent(true);
    if (!this.current && !this.queue.length) this.stage.particles.clear();
  }

  /** Long press / double tap: skip everything queued, and whatever arrives until the queue has drained. */
  skipEverything() {
    this.skipAll = true;
    this.fastFade = true;
    const rest = [...new Set(this.queue.map((q) => q.batch))];
    this.queue = [];
    this.endCurrent(true);
    for (const b of rest) this.onBatchEnd?.(b);
    this.stage.particles.clear();
  }

  /** Ends the cinematic on stage (finishing it first when skipped), reports a finished chain, starts the next. */
  private endCurrent(skipped: boolean) {
    const tl = this.current;
    if (!tl) return;
    if (skipped) tl.finish();
    tl.dispose();
    this.current = null;
    const b = this.curBatch;
    if (b >= 0 && !this.queue.some((q) => q.batch === b)) {
      this.curBatch = -1;
      this.onBatchEnd?.(b);
    }
    this.next();
  }

  /** Leaving (or 3D turned off): drop everything. */
  clear() {
    const rest = [...new Set([this.curBatch, ...this.queue.map((q) => q.batch)])].filter((b) => b >= 0);
    this.queue = [];
    this.current?.finish();
    this.current?.dispose();
    this.current = null;
    this.curBatch = -1;
    this.skipAll = false;
    for (const b of rest) this.onBatchEnd?.(b);
    for (const a of this.actors.values()) this.dropActor(a);
    this.actors.clear();
    this.stage.clear();
    this.bg = this.bgTarget = 0;
    this.stage.backdrop.u.uOpacity.value = 0;
    this.stage.stop();
    this.onIdle?.();
  }

  dispose() {
    this.clear();
    this.stage.dispose();
  }

  resize() {
    this.stage.resize();
  }

  private frame(dt: number) {
    // Backdrop eases toward what the current cinematic wants.
    // (the battle figures' backdrop fades with them, not after them)
    const want = this.current ? this.bgTarget : this.actors.size && !this.fastFade && this.idleFor < 0.3 ? 0.6 : 0;
    this.bg = lerp(this.bg, want, 1 - Math.exp(-dt * (this.fastFade ? 20 : 7)));
    if (this.fastFade && !this.current && this.bg < 0.03) this.bg = 0;
    this.stage.backdrop.u.uOpacity.value = this.bg;
    if (this.current) {
      this.watchdog += dt;
      if (!this.current.update(dt) || this.watchdog > this.current.duration / this.current.rate + 3) this.endCurrent(false);
      return;
    }
    // Nothing playing: battle figures linger a moment, then fade away (at once after a skip).
    this.idleFor += dt;
    const linger = this.fastFade ? 0 : 0.3;
    if (this.actors.size && this.idleFor > linger) {
      const k = clamp01((this.idleFor - linger) / (this.fastFade ? 0.15 : 0.25));
      for (const a of this.actors.values()) {
        if (a.fig) a.fig.u.uOpacity.value = Math.min(a.fig.u.uOpacity.value, 1 - k);
        if (a.back) a.back.u.uOpacity.value = Math.min(a.back.u.uOpacity.value, 1 - k);
      }
      if (k >= 1) {
        for (const a of this.actors.values()) this.dropActor(a);
        this.actors.clear();
      }
    }
    if (!this.actors.size && this.bg < 0.03 && (!this.stage.particles.active || this.fastFade || this.idleFor > 0.7)) {
      this.stage.particles.clear();
      this.stage.backdrop.u.uOpacity.value = 0;
      this.stage.stop();
      this.skipAll = false;
      this.fastFade = false;
      this.onIdle?.();
    }
  }

  private next() {
    this.watchdog = 0;
    const item = this.queue.shift();
    if (!item) {
      this.idleFor = 0;
      return;
    }
    this.idleFor = 0;
    this.fastFade = false;
    this.curBatch = item.batch;
    const placeholder = new Timeline(99, this.stage);
    this.current = placeholder;
    const rate = this.timeScale * item.scale * flowRate(item.cue, this.queue[0], item.batch);
    this.build(item.cue)
      .then((tl) => {
        if (this.current !== placeholder) {
          tl?.dispose();
          return;
        }
        if (!tl) {
          this.endCurrent(false);
          return;
        }
        tl.rate = rate;
        tl.onCommit = () => this.onCommit?.(item.batch);
        this.current = tl;
        if (this.skipAll) this.endCurrent(true);
      })
      .catch((err) => {
        console.warn('art engine: cinematic failed', err);
        if (this.current === placeholder) this.endCurrent(false);
      });
  }

  // ------------------------------------------------------------ helpers
  private get U() {
    return this.stage.unit;
  }

  private side(p: Pid): 'near' | 'far' {
    return p === this.viewer ? 'near' : 'far';
  }

  private spot(side: 'near' | 'far') {
    const U = this.U;
    return side === 'near' ? { x: 0, y: -1.3 * U, z: 0.5 } : { x: 0, y: 1.3 * U, z: -0.5 };
  }

  private anchor(c: CardRef | null, fallbackSide: 'near' | 'far') {
    if (c?.rect) {
      const w = this.stage.toWorld(c.rect.x, c.rect.y);
      return { x: w.x, y: w.y };
    }
    const s = this.spot(fallbackSide);
    return { x: s.x, y: s.y * 1.6 };
  }

  private async art(name: string): Promise<ArtData | null> {
    if (!name) return null;
    // Never hold the duel up for a slow picture: give it 1.5 s, then go on without.
    return Promise.race([artFor(name), new Promise<null>((res) => setTimeout(() => res(null), 1500))]).catch(() => null);
  }

  private colors(prof: ArtProfile, art: ArtData | null): Colors {
    const [m, a, l] = prof.colors;
    const signature = prof.attackName && card(prof.name) && art === null;
    const p = art?.palette ?? [a, l, m];
    return signature ? { main: brighten(m), accent: brighten(a), light: brighten(l, 220) } : { main: brighten(mix(m, p[0], 0.25)), accent: brighten(mix(p[0], a, 0.35)), light: brighten(mix(p[1] ?? l, 0xffffff, 0.5), 220) };
  }

  private figure(art: ArtData, size: number, prof: ArtProfile, glow: number) {
    const segs = this.stage.quality === 'full' ? 56 : 32;
    return new Figure(art, size, segs, glow, size * (0.22 + prof.depth * 0.3));
  }

  private dropActor(a: Actor) {
    if (a.fig) this.stage.remove(a.fig);
    if (a.back) this.stage.remove(a.back);
  }

  private async actor(c: CardRef, side: 'near' | 'far'): Promise<Actor> {
    const have = this.actors.get(c.uid);
    if (have) return have;
    const prof = profileFor(card(c.name), c.name || 'face-down');
    const art = c.name && c.faceUp ? await this.art(c.name) : null;
    const s = this.spot(side);
    const size = 1.25 * this.U;
    const a: Actor = { uid: c.uid, name: c.name, side, prof, art, fig: null, back: null, x: s.x, y: s.y, z: s.z, size, ox: 0, oy: 0 };
    if (art) {
      const col = this.colors(prof, art);
      a.fig = this.stage.add(this.figure(art, size, prof, col.main));
      a.fig.u.uOpacity.value = 0;
    } else {
      a.back = this.stage.add(new CardPanel(cardBack(), size * 0.95, 0x8a5a2a));
      if (c.def) a.back.mesh.rotation.z = Math.PI / 2;
      a.back.u.uOpacity.value = 0;
    }
    this.actors.set(c.uid, a);
    this.place(a);
    return a;
  }

  private place(a: Actor) {
    const m = a.fig?.mesh ?? a.back?.mesh;
    if (!m) return;
    m.position.set(a.x + a.ox, a.y + a.oy, a.z);
    // Near monsters lean back a little and far ones lean forward, as if on a table.
    m.rotation.x = a.side === 'near' ? -0.18 : 0.12;
  }

  private setOpacity(a: Actor, o: number) {
    if (a.fig) a.fig.u.uOpacity.value = o;
    if (a.back) a.back.u.uOpacity.value = o;
  }

  private cam(yaw: number, pitch: number, push: number) {
    this.stage.camBase.set(yaw, pitch, 10 - push);
  }

  private resetCam() {
    this.stage.camBase.set(0, 0, 10);
  }

  // ------------------------------------------------------------ cinematics
  private async build(cue: Cue): Promise<Timeline | null> {
    switch (cue.kind) {
      case 'summon':
        return this.summon(cue.card);
      case 'set':
        return this.set(cue.card);
      case 'flip':
        return this.flip(cue.card);
      case 'activate':
        return cue.what === 'monster' ? this.monsterEffect(cue.card) : this.activate(cue.card, cue.what);
      case 'skill':
        return this.skill(cue.player, cue.name);
      case 'attack':
        return this.attack(cue.attacker, cue.target, cue.defender);
      case 'hit':
        return this.hit(cue.attacker, cue.target, cue.defender, cue.dmg);
      case 'damage':
        return this.damage(cue.player, cue.amount);
      case 'destroy':
        return this.destroy(cue.card);
      case 'win':
        return cue.shadow ? this.shadowRealm(cue.shadow) : this.victory(cue.winner);
    }
  }

  /** A monster arrives: its entrance, a summoning circle and its name. */
  private async summon(c: CardRef): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const info = card(c.name);
    const prof = profileFor(info, c.name);
    const art = await this.art(c.name);
    const col = this.colors(prof, art);
    const tier = prof.tier;
    const D = [1.5, 1.8, 2.3, 3.0][tier] + (prof.entrance === 'fusion' || prof.entrance === 'ritual' ? 0.4 : 0);
    const tl = new Timeline(D, st);
    this.bgTarget = 0.55 + tier * 0.12;
    this.stage.backdrop.u.uColor.value.set(((col.main >> 16) & 255) / 900, ((col.main >> 8) & 255) / 900, (col.main & 255) / 900);
    const r = rand(prof.seed);
    const from = this.anchor(c, this.side(c.controller));
    const size = (1.15 + tier * 0.12) * U;
    const ground = -0.95 * U;
    const restY = 0.15 * U;

    // the card flies up from its zone and flips
    const flyer = tl.own(new CardPanel(art?.full ?? null, 0.9 * U, col.main));
    tl.span(0, 0.32, (k) => {
      const e = easeOut(k);
      flyer.mesh.position.set(lerp(from.x, 0, e), lerp(from.y, ground + 0.4 * U, e), lerp(0, 1.2, e));
      flyer.mesh.rotation.set(-0.5 * e, Math.PI * 2 * e, 0);
      flyer.u.uOpacity.value = 1 - easeIn(k);
      flyer.u.uTint.value = k;
    });
    tl.at(0, () => (prof.tier >= 2 ? swell(0.6) : whoosh(0.3, 400, 2000, 0.15)));

    // the circle
    const star = prof.entrance === 'fusion' ? 6 : prof.entrance === 'ritual' ? 5 : 0;
    const ring = tl.own(new Ring(2.6 * U, col.main, prof.glyphs, { star }));
    ring.mesh.rotation.x = -1.15;
    ring.mesh.position.set(0, ground, 0);
    ring.spinSpeed = 0.6 + prof.spin;
    const ring2 = tl.own(new Ring(1.8 * U, col.accent, prof.glyphs + 7, { inner: 0.55, outer: 0.7 }));
    ring2.mesh.rotation.x = -1.15;
    ring2.mesh.position.set(0, ground, 0.01);
    ring2.spinSpeed = -(0.8 + prof.spin);
    tl.span(0.15, 0.55, (k) => {
      ring.mesh.scale.setScalar(easeOut(k));
      ring2.mesh.scale.setScalar(easeOut(k));
      ring.u.uOpacity.value = k;
      ring2.u.uOpacity.value = k;
    });
    tl.span(D - 0.5, D, (k) => {
      ring.u.uOpacity.value = 1 - k;
      ring2.u.uOpacity.value = 1 - k;
    });

    // the monster
    const fig = art ? tl.own(this.figure(art, size, prof, col.main)) : null;
    const showAt = 0.45;
    const entr = prof.entrance;
    if (fig) {
      fig.u.uReveal.value = 0;
      fig.u.uOpacity.value = 0;
      fig.mesh.position.set(0, restY, 0);
    }
    const emit = (rate: number, dt: number, f: () => void) => {
      const n = Math.floor(rate * dt + Math.random());
      for (let i = 0; i < n; i++) f();
    };
    const P = st.particles;
    const intensity = st.quality === 'full' ? 1 : 0.5;
    tl.span(0.2, D - 0.4, (k, dt) => {
      // a column of light rising from the circle
      emit(60 * intensity * (1 + tier), dt, () => {
        const a = Math.random() * Math.PI * 2;
        const rr = (0.4 + Math.random() * 0.8) * U;
        P.emit({ x: Math.cos(a) * rr, y: ground + Math.sin(a) * rr * 0.4, z: 0.2, vy: (1.2 + Math.random() * 1.5) * U, life: 0.9, size: 0.09 * U, color: Math.random() < 0.5 ? col.main : col.light, drag: 0.6 });
      });
      void k;
    });
    switch (entr) {
      case 'descend':
        tl.span(showAt, showAt + 0.6, (k) => {
          if (!fig) return;
          const e = backOut(k);
          fig.mesh.position.y = lerp(3.2 * U, restY, e);
          fig.u.uOpacity.value = clamp01(k * 3);
          fig.u.uReveal.value = 1;
          fig.u.uTint.value = 1 - k;
        });
        tl.span(showAt, showAt + 0.6, (_k, dt) =>
          emit(80 * intensity, dt, () => P.emit({ x: (Math.random() - 0.5) * 2.4 * U, y: 3 * U, vy: -6 * U, life: 0.5, size: 0.07 * U, color: col.light, drag: 0 })),
        );
        tl.at(showAt + 0.5, () => {
          st.shake(0.4 + prof.shake * 0.6);
          boom(0.4 + tier * 0.15);
          P.emit({ x: 0, y: ground, burst: 4 * U, life: 0.7, size: 0.12 * U, color: col.accent }, Math.round(70 * intensity));
        });
        break;
      case 'erupt':
        tl.at(showAt - 0.1, () => {
          st.shake(0.5 + prof.shake * 0.5);
          boom(0.5);
          P.emit({ x: 0, y: ground, r: 0.4 * U, vy: 4 * U, burst: 3 * U, gravity: 9 * U, life: 1.1, size: 0.14 * U, color: mix(col.main, 0x7a5a3a, 0.5), drag: 0.3 }, Math.round(90 * intensity));
        });
        tl.span(showAt, showAt + 0.45, (k) => {
          if (!fig) return;
          fig.mesh.position.y = lerp(ground - 1.2 * U, restY, backOut(k));
          fig.u.uOpacity.value = clamp01(k * 4);
          fig.u.uReveal.value = clamp01(k * 1.4);
        });
        break;
      case 'materialize':
        tl.span(0.15, showAt + 0.15, (_k, dt) =>
          emit(160 * intensity, dt, () => {
            const a = Math.random() * Math.PI * 2;
            const rr = (1.4 + Math.random()) * U;
            P.emit({ x: Math.cos(a) * rr, y: restY + Math.sin(a) * rr, life: 0.55, size: 0.08 * U, color: Math.random() < 0.5 ? col.accent : col.light, drag: 0, pull: { x: 0, y: restY, strength: 22 * U, swirl: 6 * U } });
          }),
        );
        tl.at(0.15, () => zap(0.5));
        tl.span(showAt + 0.1, showAt + 0.55, (k) => {
          if (!fig) return;
          fig.u.uOpacity.value = 1;
          fig.u.uReveal.value = 1;
          fig.u.uTint.value = 1 - k;
          fig.mesh.scale.setScalar(size * lerp(0.6, 1, backOut(k)));
        });
        break;
      case 'portal': {
        const portal = tl.own(new Ring(2.2 * U, mix(col.main, 0x6a2aff, 0.5), prof.glyphs + 3, { inner: 0.3, outer: 0.95 }));
        portal.mesh.position.set(0, restY, -0.3);
        portal.spinSpeed = 3;
        tl.span(0.2, showAt + 0.2, (k) => (portal.mesh.scale.setScalar(easeOut(k)), (portal.u.uOpacity.value = k)));
        tl.span(D - 0.6, D - 0.2, (k) => (portal.u.uOpacity.value = 1 - k));
        tl.span(showAt, showAt + 0.6, (k) => {
          if (!fig) return;
          fig.u.uOpacity.value = clamp01(k * 2);
          fig.u.uReveal.value = 1;
          fig.u.uDark.value = 1 - k;
          fig.mesh.scale.setScalar(size * lerp(0.2, 1, easeOut(k)));
          fig.mesh.position.z = lerp(-1, 0, k);
        });
        tl.span(0.2, showAt + 0.4, (_k, dt) =>
          emit(90 * intensity, dt, () => {
            const a = Math.random() * Math.PI * 2;
            P.emit({ x: Math.cos(a) * 1.2 * U, y: restY + Math.sin(a) * 1.2 * U, life: 0.6, size: 0.1 * U, color: mix(col.main, 0x9a3cff, 0.5), drag: 0, pull: { x: 0, y: restY, strength: 10 * U, swirl: 14 * U } });
          }),
        );
        break;
      }
      case 'splash':
        tl.span(showAt - 0.1, showAt + 0.5, (_k, dt) =>
          emit(200 * intensity, dt, () => P.emit({ x: (Math.random() - 0.5) * 0.9 * U, y: ground, vx: (Math.random() - 0.5) * 2 * U, vy: (4 + Math.random() * 3) * U, gravity: 10 * U, life: 1, size: 0.1 * U, color: Math.random() < 0.6 ? 0x7fd8ff : col.light, drag: 0.2 })),
        );
        tl.at(showAt, () => whoosh(0.7, 300, 1200, 0.25));
        tl.span(showAt, showAt + 0.5, (k) => {
          if (!fig) return;
          fig.mesh.position.y = lerp(ground, restY, easeOut(k));
          fig.u.uOpacity.value = clamp01(k * 3);
          fig.u.uReveal.value = clamp01(k * 1.3);
        });
        break;
      case 'fusion':
      case 'ritual': {
        const orbs = entr === 'fusion' ? [col.main, col.accent] : [col.main, col.accent, col.light];
        tl.span(0.1, showAt + 0.2, (k, dt) =>
          orbs.forEach((oc, i) => {
            const a = (i / orbs.length) * Math.PI * 2 + k * 9;
            const rr = (1 - easeIn(k)) * 1.3 * U;
            emit(70 * intensity, dt, () => P.emit({ x: Math.cos(a) * rr, y: restY + Math.sin(a) * rr * 0.6, burst: 0.3 * U, life: 0.4, size: 0.16 * U, color: oc, drag: 3 }));
          }),
        );
        tl.at(showAt + 0.2, () => {
          this.ui.flash(col.light, 0.8);
          boom(0.6);
          chime(r());
          P.emit({ x: 0, y: restY, burst: 5 * U, life: 0.8, size: 0.13 * U, color: col.light }, Math.round(120 * intensity));
        });
        tl.span(showAt + 0.2, showAt + 0.7, (k) => {
          if (!fig) return;
          fig.u.uOpacity.value = 1;
          fig.u.uReveal.value = 1;
          fig.u.uTint.value = 1 - k;
          fig.mesh.scale.setScalar(size * lerp(1.15, 1, easeOut(k)));
        });
        break;
      }
      default:
        // rise
        tl.span(showAt, showAt + 0.6, (k) => {
          if (!fig) return;
          fig.mesh.position.y = lerp(ground - 0.2 * U, restY, easeOut(k));
          fig.u.uOpacity.value = 1;
          fig.u.uReveal.value = easeOut(k);
        });
        tl.at(showAt, () => chime(r()));
    }
    if (tier >= 2) tl.at(showAt + 0.55, () => (st.shake(prof.shake), this.ui.flash(col.main, 0.25 + tier * 0.1)));
    // the camera swings round the figure, so its depth shows
    tl.span(0, D, (k) => this.cam(lerp(prof.camYaw * 1.4, -prof.camYaw * 0.6, easeInOut(k)), lerp(-0.6 - prof.camPitch * 0.6, 0.1, easeInOut(k)), lerp(-0.5, 0.5 + tier * 0.2, easeInOut(k))));
    // name card
    tl.at(showAt + 0.25, () => {
      const sub = !info ? '' : info.kind === 'monster' ? `${'★'.repeat(Math.min(12, info.level ?? 0))}  ATK ${info.atk ?? '?'} / DEF ${info.def ?? '?'}` : '';
      const how = prof.entrance === 'fusion' ? 'Fusion Summon' : prof.entrance === 'ritual' ? 'Ritual Summon' : (info?.level ?? 0) >= 5 ? 'Tribute Summon' : '';
      this.ui.banner({ title: c.name, sub: [how, sub].filter(Boolean).join(' · '), color: col.main, big: tier >= 2, dur: D - showAt - 0.2, pos: 'bottom' });
    });
    // ...then it settles back into its card
    tl.span(D - 0.35, D, (k) => {
      if (!fig) return;
      const to = this.anchor(c, this.side(c.controller));
      fig.mesh.position.set(lerp(0, to.x, easeIn(k)), lerp(restY, to.y, easeIn(k)), lerp(0, -0.5, k));
      fig.mesh.scale.setScalar(size * lerp(1, 0.3, easeIn(k)));
      fig.u.uOpacity.value = 1 - easeIn(k);
    });
    tl.at(D, () => this.resetCam(), false);
    // the monster has landed: its card appears in its zone
    tl.commit(Math.min(D - 0.4, showAt + 0.5));
    return tl;
  }

  /** A face-down card slams onto the field (never shows what it is). */
  private async set(c: CardRef): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const tl = new Timeline(0.6, st);
    this.bgTarget = 0.2;
    const at = this.anchor(c, this.side(c.controller));
    const panel = tl.own(new CardPanel(cardBack(), 0.8 * U, 0xd08a3a));
    if (c.def) panel.mesh.rotation.z = Math.PI / 2;
    tl.span(0, 0.3, (k) => {
      const e = easeIn(k);
      panel.mesh.position.set(at.x, at.y + (1 - e) * 0.4 * U, lerp(3, 0, e));
      panel.mesh.rotation.x = lerp(-0.9, 0, e);
      panel.u.uOpacity.value = clamp01(k * 3);
    });
    tl.at(0.3, () => {
      whoosh(0.2, 1500, 300, 0.2);
      st.shake(0.15);
      st.particles.emit({ x: at.x, y: at.y, burst: 1.6 * U, life: 0.4, size: 0.06 * U, color: 0xc8a070, drag: 4 }, 24);
    });
    const ring = tl.own(new Ring(1.4 * U, 0xffc070, 1, { inner: 0.85, outer: 0.9 }));
    ring.mesh.position.set(at.x, at.y, 0);
    tl.span(0.3, 0.6, (k) => (ring.mesh.scale.setScalar(lerp(0.3, 1.2, easeOut(k))), (ring.u.uOpacity.value = 1 - k)));
    tl.span(0.42, 0.6, (k) => (panel.u.uOpacity.value = 1 - k));
    return tl;
  }

  /** A face-down monster turns face-up. */
  private async flip(c: CardRef): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const prof = profileFor(card(c.name), c.name);
    const art = await this.art(c.name);
    const col = this.colors(prof, art);
    const have = this.actors.get(c.uid);
    const tl = new Timeline(have ? 0.7 : 1.1, st);
    this.bgTarget = 0.5;
    tl.at(0, () => (chime(0.3), whoosh(0.3, 600, 2400, 0.15)));
    if (have && art) {
      // in a battle: the card back turns into the monster where it stands
      const fig = this.stage.add(this.figure(art, have.size, prof, col.main));
      tl.span(0, 0.35, (k) => {
        if (have.back) {
          have.back.mesh.rotation.y = (Math.PI / 2) * k;
          have.back.u.uOpacity.value = 1 - k;
        }
      });
      tl.at(
        0.35,
        () => {
          if (have.back) this.stage.remove(have.back);
          have.back = null;
          have.fig = fig;
          have.name = c.name;
          have.prof = prof;
          have.art = art;
          this.place(have);
        },
        false,
      );
      fig.u.uOpacity.value = 0;
      this.place({ ...have, fig, back: null });
      tl.span(0.35, 0.7, (k) => {
        fig.u.uOpacity.value = 1;
        fig.u.uReveal.value = easeOut(k);
        fig.u.uTint.value = 1 - k;
      });
      tl.at(0.4, () => this.ui.banner({ title: c.name, sub: 'Flip!', color: col.main, dur: 0.6, pos: this.side(c.controller) === 'near' ? 'bottom' : 'top' }));
      return tl;
    }
    const at = this.anchor(c, this.side(c.controller));
    const panel = tl.own(new CardPanel(cardBack(), 1.1 * U, col.main));
    tl.span(0, 0.3, (k) => {
      panel.mesh.position.set(lerp(at.x, 0, easeOut(k)), lerp(at.y, 0.1 * U, easeOut(k)), 0.5);
      panel.mesh.rotation.y = (Math.PI / 2) * easeIn(k);
      panel.u.uOpacity.value = 1 - easeIn(k) * 0.5;
    });
    tl.at(0.3, () => (panel.u.uOpacity.value = 0));
    if (art) {
      const fig = tl.own(this.figure(art, 1.5 * U, prof, col.main));
      fig.mesh.position.set(0, 0.1 * U, 0);
      fig.u.uOpacity.value = 0;
      tl.span(0.3, 0.75, (k) => {
        fig.u.uOpacity.value = 1;
        fig.u.uReveal.value = easeOut(k);
        fig.u.uTint.value = 1 - k;
      });
      tl.span(0.85, 1.1, (k) => (fig.u.uOpacity.value = 1 - k));
    }
    tl.at(0.35, () => {
      st.particles.emit({ x: 0, y: 0.1 * U, burst: 3 * U, life: 0.6, size: 0.1 * U, color: col.accent }, 60);
      this.ui.banner({ title: c.name, sub: 'Flip Summon', color: col.main, dur: 0.7, pos: 'bottom' });
    });
    return tl;
  }

  /** A Spell or Trap: the card lifts off its zone, glyph circle behind it. */
  private async activate(c: CardRef, what: 'spell' | 'trap'): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const info = card(c.name);
    const prof = profileFor(info, c.name);
    const art = await this.art(c.name);
    const base = what === 'spell' ? 0x1fd39a : 0xe0379a;
    const accent = art ? brighten(art.palette[0]) : 0xffffff;
    const D = 1.35;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.55;
    this.stage.backdrop.u.uColor.value.set(what === 'spell' ? 0.02 : 0.08, what === 'spell' ? 0.08 : 0.02, what === 'spell' ? 0.06 : 0.07);
    const from = this.anchor(c, this.side(c.controller));
    const H = 2.3 * U;
    const panel = tl.own(new CardPanel(art?.full ?? null, H, base));
    const ring = tl.own(new Ring(2.9 * U, base, prof.glyphs, { inner: 0.62, outer: 0.95, star: what === 'trap' ? 3 : 4 }));
    ring.mesh.position.set(0, 0.2 * U, -0.6);
    ring.spinSpeed = what === 'spell' ? 0.8 : -1.2;
    tl.at(0, () => (what === 'spell' ? chime(0.7) : zap(0.45)));
    tl.span(0, 0.38, (k) => {
      const e = easeOut(k);
      panel.mesh.position.set(lerp(from.x, 0, e), lerp(from.y, 0.2 * U, e), lerp(0, 0.8, e));
      panel.mesh.scale.setScalar(lerp(0.3, 1, e));
      panel.mesh.rotation.y = lerp(Math.PI, 0, e);
      panel.mesh.rotation.x = lerp(-1, 0, e);
    });
    tl.span(0.2, 0.55, (k) => (ring.mesh.scale.setScalar(easeOut(k)), (ring.u.uOpacity.value = k)));
    tl.span(0.4, 0.9, (k) => (panel.u.uSheen.value = lerp(-0.4, 1.8, k)));
    tl.at(0.42, () => {
      st.particles.emit({ x: 0, y: 0.2 * U, burst: 4.5 * U, life: 0.8, size: 0.09 * U, color: base }, 70);
      st.particles.emit({ x: 0, y: 0.2 * U, burst: 3 * U, life: 0.9, size: 0.12 * U, color: accent }, 40);
      this.ui.banner({ title: c.name, sub: info ? `${info.sub} ${what === 'spell' ? 'Spell' : 'Trap'}` : '', color: base, dur: 0.8, pos: 'bottom' });
      if (what === 'trap') st.shake(0.3);
    });
    tl.span(D - 0.35, D, (k) => {
      panel.mesh.position.set(lerp(0, from.x, easeIn(k)), lerp(0.2 * U, from.y, easeIn(k)), 0.8 - k);
      panel.mesh.scale.setScalar(lerp(1, 0.3, easeIn(k)));
      panel.u.uOpacity.value = 1 - easeIn(k);
      ring.u.uOpacity.value = 1 - k;
    });
    tl.span(0, D, (k) => this.cam(lerp(prof.camYaw * 0.6, 0, k), -0.2, lerp(0, 0.6, easeOut(k))));
    tl.at(D, () => this.resetCam(), false);
    return tl;
  }

  /** A monster uses its effect: it rises glowing. */
  private async monsterEffect(c: CardRef): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const prof = profileFor(card(c.name), c.name);
    const art = await this.art(c.name);
    const col = this.colors(prof, art);
    const have = this.actors.get(c.uid);
    const D = 1.1;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.5;
    let fig = have?.fig ?? null;
    const at = have ? { x: have.x, y: have.y } : { x: 0, y: 0.1 * U };
    if (!fig && art) {
      fig = tl.own(this.figure(art, 1.5 * U, prof, col.main));
      fig.mesh.position.set(at.x, at.y, 0);
      tl.span(0, 0.25, (k) => (fig!.u.uOpacity.value = k));
      tl.span(D - 0.25, D, (k) => (fig!.u.uOpacity.value = 1 - k));
    }
    const ring = tl.own(new Ring(1.8 * U, col.main, prof.glyphs));
    ring.mesh.position.set(at.x, at.y - 0.7 * U, 0);
    ring.mesh.rotation.x = -1.1;
    ring.spinSpeed = 2;
    tl.span(0, 0.3, (k) => (ring.u.uOpacity.value = k));
    tl.span(D - 0.3, D, (k) => (ring.u.uOpacity.value = 1 - k));
    tl.at(0.05, () => chime(0.5));
    tl.span(0.05, D - 0.2, (k, dt) => {
      if (fig) fig.u.uTint.value = 0.35 * Math.sin(k * Math.PI);
      const n = Math.floor(90 * dt + Math.random());
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        st.particles.emit({ x: at.x + Math.cos(a) * 0.7 * U, y: at.y - 0.6 * U, vy: 2.2 * U, life: 0.7, size: 0.09 * U, color: Math.random() < 0.5 ? col.main : col.accent, drag: 0.5 });
      }
    });
    tl.at(0.2, () => this.ui.banner({ title: c.name, sub: 'Effect', color: col.main, dur: 0.7, pos: this.side(c.controller) === 'near' ? 'bottom' : 'top' }));
    return tl;
  }

  private async skill(p: Pid, name: string): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const tl = new Timeline(1.2, st);
    this.bgTarget = 0.6;
    const ring = tl.own(new Ring(3 * U, 0x4ad8ff, 77, { inner: 0.5, outer: 0.95, star: 7 }));
    ring.spinSpeed = 1.5;
    tl.span(0, 0.3, (k) => (ring.mesh.scale.setScalar(easeOut(k)), (ring.u.uOpacity.value = k)));
    tl.span(0.9, 1.2, (k) => (ring.u.uOpacity.value = 1 - k));
    tl.at(0.1, () => {
      chime(0.9);
      st.particles.emit({ x: 0, y: 0, burst: 4 * U, life: 0.8, size: 0.1 * U, color: 0x9affff }, 60);
      this.ui.banner({ title: name.replace(/ \(Skill Card\)$/, ''), sub: `Skill · ${this.side(p) === 'near' ? 'you' : 'opponent'}`, color: 0x4ad8ff, big: true, dur: 0.9, pos: 'mid' });
    });
    return tl;
  }

  /** The attack is declared: both monsters face off and the attacker charges. */
  private async attack(a: CardRef, t: CardRef | null, defender: Pid): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const aSide = this.side(a.controller);
    const att = await this.actor(a, aSide);
    const tgt = t ? await this.actor(t, this.side(defender)) : null;
    const col = this.colors(att.prof, att.art);
    const D = 1.15;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.7;
    this.stage.backdrop.u.uColor.value.set(0.05, 0.03, 0.09);
    const fromA = this.anchor(a, aSide);
    const fromT = t ? this.anchor(t, this.side(defender)) : null;
    tl.span(0, 0.4, (k) => {
      const e = easeOut(k);
      for (const [act, from] of [
        [att, fromA],
        [tgt, fromT],
      ] as const) {
        if (!act || !from) continue;
        const m = act.fig?.mesh ?? act.back?.mesh;
        if (!m) continue;
        if (this.actorsFresh(act)) {
          m.position.set(lerp(from.x, act.x, e), lerp(from.y, act.y, e), act.z);
          m.scale.setScalar(act.fig ? act.size * lerp(0.35, 1, e) : lerp(0.35, 1, e));
          this.setOpacity(act, Math.max(k * 2, 0));
        }
      }
    });
    tl.at(
      0.4,
      () => {
        for (const act of [att, tgt]) if (act) ((act as Actor & { fresh?: boolean }).fresh = false, this.place(act), this.setOpacity(act, 1));
      },
      false,
    );
    // direct attack: the opponent's side lights up as the target
    if (!tgt) {
      const s = this.spot(this.side(defender));
      const mark = tl.own(new Ring(2.4 * U, 0xff4a4a, 13, { inner: 0.8, outer: 0.92 }));
      mark.mesh.position.set(0, s.y * 1.25, -0.5);
      mark.spinSpeed = 1;
      tl.span(0.2, 0.6, (k) => (mark.mesh.scale.setScalar(easeOut(k)), (mark.u.uOpacity.value = k * 0.8)));
    }
    // charge: energy gathers on the attacker
    tl.at(0.35, () => (att.prof.tier >= 2 ? swell(0.7) : whoosh(0.5, 200, 1600, 0.15)));
    tl.span(0.35, D, (_k, dt) => {
      const n = Math.floor(120 * dt + Math.random());
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = (0.9 + Math.random() * 0.6) * U;
        st.particles.emit({ x: att.x + Math.cos(ang) * rr, y: att.y + Math.sin(ang) * rr, life: 0.45, size: 0.08 * U, color: Math.random() < 0.5 ? col.main : col.light, drag: 0, pull: { x: att.x, y: att.y + 0.2 * U, strength: 18 * U, swirl: 5 * U } });
      }
    });
    tl.at(0.45, () => this.ui.banner({ title: `${att.prof.attackName}!`, sub: a.name, color: col.main, big: true, dur: 1.0, pos: aSide === 'near' ? 'mid' : 'mid' }));
    tl.span(0, D, (k) => this.cam(lerp(0, att.prof.camYaw * 0.8, easeOut(k)), lerp(0, aSide === 'near' ? -0.8 : 0.8, easeOut(k)), lerp(0, 0.6, easeOut(k))));
    return tl;
  }

  private actorsFresh(a: Actor) {
    return (a as Actor & { fresh?: boolean }).fresh !== false;
  }

  /** The blow lands: the attacker's own attack style travels to its target. */
  private async hit(a: CardRef | null, t: CardRef | null, defender: Pid, dmg?: { player: Pid; amount: number }): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const att = a ? (this.actors.get(a.uid) ?? (await this.actor(a, this.side(a.controller)))) : null;
    const tgt = t ? (this.actors.get(t.uid) ?? (await this.actor(t, this.side(defender)))) : null;
    for (const act of [att, tgt]) if (act) ((act as Actor & { fresh?: boolean }).fresh = false, this.place(act), this.setOpacity(act, 1));
    const prof = att?.prof ?? profileFor(undefined, 'unknown');
    const col = this.colors(prof, att?.art ?? null);
    const A = att ? { x: att.x, y: att.y + 0.15 * U } : { x: 0, y: -this.spot(this.side(defender)).y };
    const dSpot = this.spot(this.side(defender));
    const T = tgt ? { x: tgt.x, y: tgt.y } : { x: 0, y: dSpot.y * 1.35 };
    const travel = 0.35 + (1 - prof.speed) * 0.3;
    const D = travel + 0.8;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.75;
    const ctx: HitCtx = { st, tl, U, A, T, col, prof, travel, att, quality: st.quality };
    STYLES[prof.style](ctx, 1);
    if (prof.style2) STYLES[prof.style2](ctx, 0.45);
    // impact
    tl.at(travel, () => {
      const big = tgt ? 0.55 : 1;
      st.shake(0.5 + prof.shake * big);
      boom(0.35 + prof.tier * 0.15 + (tgt ? 0 : 0.25));
      this.ui.flash(col.light, tgt ? 0.35 : 0.6);
      st.particles.emit({ x: T.x, y: T.y, burst: 5 * U, life: 0.6, size: 0.12 * U, color: col.light, drag: 3 }, Math.round(80 * (st.quality === 'full' ? 1 : 0.5)));
      st.particles.emit({ x: T.x, y: T.y, burst: 3 * U, life: 0.9, size: 0.18 * U, color: col.main, drag: 2 }, 40);
      // the battle damage lands with the blow
      if (dmg) this.ui.number({ text: `-${dmg.amount}`, color: 0xff4a4a, side: this.side(dmg.player) === 'near' ? 'bottom' : 'top', size: 1 + Math.min(1, dmg.amount / 3000) * 1.2 });
    });
    tl.commit(travel);
    const wave = tl.own(new Ring(2.4 * U, col.main, prof.glyphs, { inner: 0.86, outer: 0.92 }));
    wave.mesh.position.set(T.x, T.y, 0.1);
    wave.u.uOpacity.value = 0;
    tl.span(travel, travel + 0.45, (k) => (wave.mesh.scale.setScalar(lerp(0.2, 1.4, easeOut(k))), (wave.u.uOpacity.value = 1 - k)));
    if (tgt) {
      tl.span(travel, travel + 0.4, (k) => {
        const kick = Math.sin(k * Math.PI) * 0.25 * U;
        const dir = Math.sign(T.y - A.y) || 1;
        tgt.oy = kick * dir;
        if (tgt.fig) tgt.fig.u.uTint.value = 1 - k;
        if (tgt.back) tgt.back.u.uTint.value = 1 - k;
        this.place(tgt);
      });
    }
    tl.span(0, D, (k) => this.cam(lerp(prof.camYaw * 0.8, -prof.camYaw * 0.3, k), lerp(A.y > T.y ? 0.6 : -0.6, 0, k) * 0.6, lerp(0.6, 0.9, k)));
    tl.at(D, () => this.resetCam(), false);
    return tl;
  }

  private async damage(p: Pid, amount: number): Promise<Timeline> {
    const st = this.stage;
    const tl = new Timeline(0.75, st);
    this.bgTarget = this.actors.size ? 0.7 : 0.25;
    tl.at(0, () => {
      const k = Math.min(1, amount / 3000);
      this.ui.number({ text: `-${amount}`, color: 0xff4a4a, side: this.side(p) === 'near' ? 'bottom' : 'top', size: 1 + k * 1.2 });
      this.ui.flash(0xff2020, 0.15 + k * 0.35);
      st.shake(0.25 + k * 0.7);
    });
    tl.commit(0);
    return tl;
  }

  /** A monster is destroyed: it shatters into pieces of its own art. */
  private async destroy(c: CardRef): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const tl = new Timeline(0.95, st);
    this.bgTarget = this.actors.size ? 0.7 : 0.3;
    let act = this.actors.get(c.uid) ?? null;
    let own: Figure | null = null;
    if (!act) {
      const art = await this.art(c.name);
      if (!art) return tl;
      const prof = profileFor(card(c.name), c.name);
      own = tl.own(this.figure(art, 0.9 * U, prof, this.colors(prof, art).main));
      const at = this.anchor(c, this.side(c.controller));
      own.mesh.position.set(at.x, at.y, 0.3);
    }
    const prof = act?.prof ?? profileFor(card(c.name), c.name);
    const col = this.colors(prof, act?.art ?? null);
    // a face-down card destroyed in battle shows what it was as it breaks
    if (act && !act.fig && act.art === null && c.name) {
      const art = await this.art(c.name);
      if (art) {
        if (act.back) this.stage.remove(act.back);
        act.back = null;
        act.fig = this.stage.add(this.figure(art, act.size, prof, col.main));
        act.art = art;
        this.place(act);
      }
    }
    const fig = act?.fig ?? own;
    const pos = fig ? fig.mesh.position.clone() : { x: 0, y: 0 };
    tl.at(0, () => {
      boom(0.35);
      whoosh(0.5, 3000, 400, 0.18);
      st.particles.emit({ x: pos.x, y: pos.y, burst: 3.5 * U, life: 0.9, size: 0.1 * U, color: col.main, gravity: 3 * U, drag: 1.5 }, 60);
    });
    tl.span(0, 0.9, (k) => {
      if (fig) {
        fig.u.uShatter.value = easeOut(k);
        fig.u.uTint.value = Math.max(0, 0.8 - k * 2);
      }
      if (act?.back) act.back.u.uOpacity.value = 1 - k;
    });
    tl.at(
      0.9,
      () => {
        if (act) {
          this.dropActor(act);
          this.actors.delete(act.uid);
          act = null;
        }
      },
      false,
    );
    tl.commit(0.3);
    return tl;
  }

  private async victory(winner: Pid | 'draw'): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const tl = new Timeline(1.6, st);
    this.bgTarget = 0.6;
    const color = winner === 'draw' ? 0xc0c0ff : winner === this.viewer ? 0xffd75a : 0xff5a5a;
    const ring = tl.own(new Ring(3.2 * U, color, 99, { inner: 0.7, outer: 0.95, star: 8 }));
    ring.spinSpeed = 1.2;
    tl.span(0, 0.5, (k) => (ring.mesh.scale.setScalar(easeOut(k)), (ring.u.uOpacity.value = k)));
    tl.span(1.1, 1.6, (k) => (ring.u.uOpacity.value = 1 - k));
    tl.at(0.1, () => {
      boom(0.7);
      this.ui.flash(color, 0.5);
      st.particles.emit({ x: 0, y: 0, burst: 6 * U, life: 1.2, size: 0.12 * U, color, gravity: 2 * U }, 140);
    });
    return tl;
  }

  /** The overkill finish: the eye opens and drags the loser into the Shadow Realm. */
  private async shadowRealm(sr: import('./shadow').ShadowResult): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const D = 6.4;
    const tl = new Timeline(D, st);
    this.bgTarget = 1;
    st.backdrop.u.uColor.value.set(0.35, 0.08, 0.55);
    const purple = 0x9a3cff;
    const magenta = 0xff4fd8;
    const gold = 0xffc94a;
    tl.at(0, () => drone(D - 0.3));
    tl.span(0, 1.2, (k) => (st.backdrop.u.uVortex.value = easeInOut(k)));
    tl.span(D - 0.8, D, (k) => (st.backdrop.u.uVortex.value = 1 - k));
    // the eye
    const eye = tl.own(new Ring(Math.min(2.6 * U, this.stage.halfW * 1.9), gold, 4242, { inner: 0.9, outer: 0.97, eye: true }));
    eye.mesh.position.set(0, 1.05 * U, -1);
    eye.spinSpeed = 0.3;
    tl.span(0.4, 1.7, (k) => {
      eye.u.uEye.value = Math.max(0.001, easeOut(k));
      eye.u.uOpacity.value = clamp01(k * 2);
    });
    tl.at(1.0, () => (this.ui.flash(magenta, 0.5), st.shake(0.8), boom(0.9)));
    tl.span(D - 1.0, D - 0.2, (k) => (eye.u.uEye.value = Math.max(0.001, 1 - easeIn(k))));
    // the vortex
    const vortex = tl.own(new Ring(3.2 * U, purple, 666, { inner: 0.78, outer: 0.92, star: 7 }));
    vortex.mesh.position.set(0, -0.35 * U, -0.8);
    vortex.spinSpeed = -2.5;
    tl.span(0.8, 1.8, (k) => (vortex.u.uOpacity.value = k * 0.55));
    tl.span(D - 1.0, D - 0.2, (k) => (vortex.u.uOpacity.value = 0.55 * (1 - k)));
    const center = { x: 0, y: -0.35 * U };
    tl.span(0.8, D - 1.1, (_k, dt) => {
      const n = Math.floor((st.quality === 'full' ? 260 : 120) * dt + Math.random());
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = (1.8 + Math.random() * 1.2) * U;
        st.particles.emit({ x: center.x + Math.cos(a) * rr, y: center.y + Math.sin(a) * rr, life: 1.1, size: 0.12 * U, color: Math.random() < 0.6 ? purple : magenta, drag: 0.2, pull: { x: center.x, y: center.y, strength: 6 * U, swirl: 9 * U } });
      }
    });
    // the soul: the sealed card (or the loser's last monster) is dragged in
    const soulName = sr.sealed ?? [...this.actors.values()].find((x) => x.side === this.side(sr.loser) && x.name)?.name ?? '';
    for (const a of [...this.actors.values()]) if (a.side === this.side(sr.loser) && a.name !== soulName) ((a.fig ? (a.fig.u.uDark.value = 1) : 0), void 0);
    const art = soulName ? await this.art(soulName) : null;
    if (art) {
      const prof = profileFor(card(soulName), soulName);
      const fig = tl.own(this.figure(art, 1.5 * U, prof, magenta));
      const start = { x: 0, y: this.side(sr.loser) === 'near' ? -1.6 * U : 1.4 * U };
      fig.mesh.position.set(start.x, start.y, 0.5);
      fig.u.uOpacity.value = 0;
      tl.span(1.6, 2.2, (k) => {
        fig.u.uOpacity.value = k;
        fig.u.uTint.value = 0.5 * (1 - k);
      });
      tl.span(2.4, 4.9, (k, dt) => {
        const e = easeIn(k);
        const ang = e * 9;
        const rr = (1 - e) * Math.hypot(start.x - center.x, start.y - center.y);
        const base = Math.atan2(start.y - center.y, start.x - center.x);
        fig.mesh.position.set(center.x + Math.cos(base + ang) * rr, center.y + Math.sin(base + ang) * rr, lerp(0.5, -0.8, e));
        fig.mesh.rotation.z = ang * 0.6;
        fig.mesh.scale.setScalar(1.5 * U * (1 - e * 0.9));
        fig.u.uDark.value = clamp01(k * 2);
        fig.u.uShatter.value = clamp01((k - 0.55) * 2.2);
        const n = Math.floor(80 * dt + Math.random());
        for (let i = 0; i < n; i++) st.particles.emit({ x: fig.mesh.position.x, y: fig.mesh.position.y, burst: 0.6 * U, life: 0.6, size: 0.1 * U, color: magenta, pull: { x: center.x, y: center.y, strength: 8 * U, swirl: 10 * U } });
      });
    }
    // whatever was still on the loser's side goes dark and breaks
    tl.span(2.0, 3.4, (k) => {
      for (const a of this.actors.values()) {
        if (a.side !== this.side(sr.loser)) continue;
        if (a.fig) {
          a.fig.u.uDark.value = 1;
          a.fig.u.uShatter.value = easeOut(k);
        }
        if (a.back) a.back.u.uOpacity.value = 1 - k;
      }
    });
    tl.at(4.9, () => (this.ui.flash(0xffffff, 0.7), boom(1), st.shake(1)));
    tl.at(1.2, () => this.ui.caption(`OVERKILL  +${sr.excess.toLocaleString()}`, 1.4, 'overkill'));
    tl.at(2.3, () => this.ui.caption(`${sr.loserName} has been sent to the Shadow Realm!`, 3.2, 'shadow'));
    if (sr.sealed) tl.at(4.0, () => this.ui.caption(`${sr.sealed} is sealed away until ${sr.loserName} wins a duel.`, 2.2, 'sealed'));
    tl.span(0, D, (k) => this.cam(Math.sin(k * 3) * 0.6, lerp(-0.3, 0.2, k), lerp(0, 1.4, easeInOut(k))));
    tl.at(
      D,
      () => {
        this.resetCam();
        for (const a of this.actors.values()) this.dropActor(a);
        this.actors.clear();
      },
      false,
    );
    return tl;
  }
}

// ---------------------------------------------------------------- attack styles
interface HitCtx {
  st: Stage;
  tl: Timeline;
  U: number;
  A: { x: number; y: number };
  T: { x: number; y: number };
  col: Colors;
  prof: ArtProfile;
  travel: number;
  att: Actor | null;
  quality: Quality;
}

type StyleFn = (c: HitCtx, power: number) => void;

const rate = (r: number, dt: number) => Math.floor(r * dt + Math.random());

function bez(a: { x: number; y: number }, b: { x: number; y: number }, bend: number, k: number) {
  const mx = (a.x + b.x) / 2 + bend;
  const my = (a.y + b.y) / 2;
  const u = 1 - k;
  return { x: u * u * a.x + 2 * u * k * mx + k * k * b.x, y: u * u * a.y + 2 * u * k * my + k * k * b.y };
}

/** The attacker leaps at its target and back. */
function lunge(c: HitCtx, reach: number) {
  const { tl, att, A, T, travel } = c;
  if (!att) return;
  tl.span(0, travel, (k) => {
    const e = easeIn(k);
    att.ox = (T.x - A.x) * reach * e;
    att.oy = (T.y - A.y) * reach * e;
    const m = att.fig?.mesh;
    if (m) m.position.set(att.x + att.ox, att.y + att.oy, att.z + e * 0.6);
  });
  tl.span(travel + 0.1, travel + 0.5, (k) => {
    const e = 1 - easeOut(k);
    const m = att.fig?.mesh;
    if (m) m.position.set(att.x + (T.x - A.x) * reach * e, att.y + (T.y - A.y) * reach * e, att.z + e * 0.6);
    att.ox = 0;
    att.oy = 0;
  });
}

const STYLES: Record<AttackStyle, StyleFn> = {
  beam(c, power) {
    const { st, tl, U, A, T, col, prof, travel } = c;
    const w = (0.2 + prof.width * 0.32) * U * power;
    const beams = power === 1 ? Math.max(1, Math.min(3, Math.round(prof.count / 2.5))) : 1;
    for (let b = 0; b < beams; b++) {
      const outer = tl.own(new Ribbon(24, col.main, 1));
      const core = tl.own(new Ribbon(24, col.light, 1));
      const off = (b - (beams - 1) / 2) * 0.35 * U;
      const pts = [
        { x: A.x + off, y: A.y, z: 0.6 },
        { x: T.x + off * 0.3, y: T.y, z: 0.2 },
      ];
      outer.set(pts, (k) => w * (0.7 + 0.3 * Math.sin(k * 30)));
      core.set(pts, w * 0.35);
      for (const r of [outer, core]) r.u.uHead.value = 0;
      tl.span(0.05 + b * 0.05, travel, (k) => {
        outer.u.uHead.value = core.u.uHead.value = easeIn(k) * 1.05;
      });
      tl.span(travel + 0.3, travel + 0.6, (k) => {
        outer.u.uOpacity.value = core.u.uOpacity.value = 1 - k;
        outer.u.uTail.value = core.u.uTail.value = k;
      });
    }
    tl.at(0.05, () => zap(travel + 0.3));
    tl.span(0, travel + 0.3, (_k, dt) => {
      for (let i = 0; i < rate(70 * power, dt); i++) st.particles.emit({ x: A.x, y: A.y, burst: 1.5 * U, life: 0.3, size: 0.12 * U, color: col.light, drag: 4 });
    });
  },
  barrage(c, power) {
    const { st, tl, U, A, T, col, prof, travel } = c;
    const n = Math.max(1, Math.round(prof.count * power));
    const big = n === 1;
    for (let i = 0; i < n; i++) {
      const delay = (i / n) * travel * 0.5;
      const bend = (prof.spread - 0.5 + (i - (n - 1) / 2) * 0.6) * 2 * U * (0.5 + prof.arc);
      tl.span(delay, travel, (k, dt) => {
        const p = bez(A, T, bend, easeIn(k));
        for (let j = 0; j < rate(big ? 220 : 90, dt); j++) st.particles.emit({ x: p.x, y: p.y, r: big ? 0.1 * U : 0.04 * U, burst: 0.3 * U, life: 0.25, size: (big ? 0.3 : 0.15) * U, color: j % 2 ? col.main : col.light, drag: 5 });
      });
    }
    tl.at(0.02, () => chime(prof.hue * 0.5 + 0.5));
  },
  slash(c, power) {
    const { st, tl, U, T, col, prof, travel } = c;
    lunge(c, 0.75 * power);
    const n = Math.max(1, Math.min(4, Math.round(prof.count * 0.6 * power)));
    for (let i = 0; i < n; i++) {
      const rib = tl.own(new Ribbon(20, i % 2 ? col.light : col.main, 0));
      const ang = prof.spin * Math.PI + (i * Math.PI) / n;
      const R = 0.9 * U;
      const pts = Array.from({ length: 9 }, (_, j) => {
        const a = ang - 0.9 + (j / 8) * 1.8;
        return { x: T.x + Math.cos(a) * R - Math.cos(ang) * R * 0.6, y: T.y + Math.sin(a) * R - Math.sin(ang) * R * 0.6, z: 0.5 };
      });
      rib.set(pts, (k) => 0.18 * U * Math.sin(k * Math.PI));
      rib.u.uHead.value = 0;
      const t0 = travel - 0.05 + i * 0.08;
      tl.span(t0, t0 + 0.12, (k) => (rib.u.uHead.value = k * 1.1));
      tl.span(t0 + 0.12, t0 + 0.35, (k) => (rib.u.uTail.value = k));
      tl.at(t0, () => {
        whoosh(0.15, 3000, 800, 0.2);
        st.particles.emit({ x: T.x, y: T.y, burst: 2.5 * U, life: 0.3, size: 0.07 * U, color: col.light, drag: 3 }, 20);
      });
    }
  },
  claw(c, power) {
    const { st, tl, U, T, col, travel } = c;
    lunge(c, 0.65 * power);
    for (let i = 0; i < 3; i++) {
      const rib = tl.own(new Ribbon(12, i === 1 ? col.light : col.main, 0));
      const dx = (i - 1) * 0.28 * U;
      rib.set(
        [
          { x: T.x - 0.6 * U + dx, y: T.y + 0.7 * U, z: 0.5 },
          { x: T.x + 0.5 * U + dx, y: T.y - 0.6 * U, z: 0.5 },
        ],
        (k) => 0.13 * U * Math.sin(k * Math.PI),
      );
      rib.u.uHead.value = 0;
      const t0 = travel - 0.08 + i * 0.04;
      tl.span(t0, t0 + 0.1, (k) => (rib.u.uHead.value = k * 1.1));
      tl.span(t0 + 0.15, t0 + 0.45, (k) => (rib.u.uOpacity.value = 1 - k));
    }
    tl.at(travel - 0.05, () => (whoosh(0.2, 2500, 600, 0.25), st.particles.emit({ x: T.x, y: T.y, burst: 2 * U, life: 0.4, size: 0.08 * U, color: 0xff5050 }, 30)));
  },
  lightning(c, power) {
    const { st, tl, U, T, col, prof, travel } = c;
    const n = Math.max(1, Math.round((1 + prof.count * 0.6) * power));
    for (let i = 0; i < n; i++) {
      const rib = tl.own(new Ribbon(18, i % 2 ? col.light : col.main, 0));
      const top = { x: T.x + (Math.random() - 0.5) * 1.6 * U, y: T.y + 3.2 * U };
      const t0 = travel * 0.4 + (i / n) * travel * 0.7;
      const reroll = () =>
        rib.set(
          Array.from({ length: 10 }, (_, j) => {
            const k = j / 9;
            const jit = j === 0 || j === 9 ? 0 : (Math.random() - 0.5) * 0.45 * U;
            return { x: lerp(top.x, T.x, k) + jit, y: lerp(top.y, T.y, k), z: 0.4 };
          }),
          (k) => 0.09 * U * (1.4 - k * 0.6),
        );
      reroll();
      rib.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.32, (k) => {
        if (Math.random() < 0.5) reroll();
        rib.u.uOpacity.value = k < 0.85 ? (Math.random() < 0.8 ? 1 : 0.3) : 1 - (k - 0.85) / 0.15;
      });
      tl.at(t0, () => {
        zap(0.25);
        c.st.shake(0.2);
        st.particles.emit({ x: T.x, y: T.y, burst: 3 * U, life: 0.3, size: 0.08 * U, color: col.light }, 25);
      });
    }
  },
  flame(c, power) {
    const { st, tl, U, A, T, col, prof, travel } = c;
    const bend = (prof.arc - 0.5) * 2.5 * U;
    tl.at(0, () => whoosh(travel + 0.2, 200, 900, 0.3));
    tl.span(0, travel, (k, dt) => {
      const p = bez(A, T, bend, easeIn(k));
      for (let j = 0; j < rate(260 * power, dt); j++) st.particles.emit({ x: p.x, y: p.y, r: 0.15 * U * power, vy: 0.8 * U, burst: 0.4 * U, life: 0.45, size: 0.26 * U * power, size1: 0.05 * U, color: j % 3 === 0 ? 0xffe08a : j % 3 === 1 ? 0xff6a1a : col.main, drag: 2 });
    });
    tl.at(travel, () => st.particles.emit({ x: T.x, y: T.y, burst: 5 * U, vy: 1.5 * U, life: 1, size: 0.25 * U, size1: 0.02, color: 0xff7a2a, drag: 2.5 }, Math.round(110 * power)));
  },
  torrent(c, power) {
    const { st, tl, U, A, T, col, travel } = c;
    tl.at(0, () => whoosh(travel + 0.3, 300, 700, 0.3));
    tl.span(0, travel + 0.15, (_k, dt) => {
      const dx = T.x - A.x;
      const dy = T.y - A.y;
      const time = Math.max(0.2, travel * 0.8);
      for (let j = 0; j < rate(320 * power, dt); j++)
        st.particles.emit({ x: A.x, y: A.y, r: 0.08 * U, vx: dx / time, vy: dy / time + 1.2 * U, gravity: 2.4 * U / time, burst: 0.4 * U, life: time, size: 0.14 * U, color: j % 2 ? 0x8fe0ff : col.main, drag: 0 });
    });
    tl.at(travel, () => st.particles.emit({ x: T.x, y: T.y, vy: 3 * U, burst: 3 * U, gravity: 8 * U, life: 0.8, size: 0.12 * U, color: 0xbfefff, drag: 0.5 }, Math.round(90 * power)));
  },
  shadow(c, power) {
    const { tl, U, T, col, prof, travel, st } = c;
    const n = Math.max(2, Math.round((2 + prof.count) * power));
    for (let i = 0; i < n; i++) {
      const rib = tl.own(new Ribbon(22, i % 2 ? mix(col.main, 0x9a3cff, 0.5) : 0xff4fd8, 1));
      const x0 = T.x + (i - (n - 1) / 2) * 0.35 * U;
      const ph = Math.random() * 6;
      tl.span(0.05, travel + 0.5, (k) => {
        const reach = easeOut(clamp01(k * 1.6));
        rib.set(
          Array.from({ length: 10 }, (_, j) => {
            const s = j / 9;
            return { x: lerp(x0, T.x, s * reach) + Math.sin(s * 6 + ph + k * 10) * 0.2 * U * (1 - s), y: lerp(T.y - 1.8 * U, T.y, s * reach), z: 0.4 };
          }),
          (s) => 0.12 * U * (1 - s * 0.8),
        );
        rib.u.uOpacity.value = k > 0.8 ? (1 - k) * 5 : 1;
      });
    }
    tl.at(0.05, () => (whoosh(0.8, 120, 500, 0.3), drone(1.2)));
    tl.span(0, travel + 0.4, (_k, dt) => {
      for (let j = 0; j < rate(60 * power, dt); j++) st.particles.emit({ x: T.x + (Math.random() - 0.5) * 1.6 * U, y: T.y - 1 * U, vy: 1.5 * U, life: 0.8, size: 0.22 * U, color: 0x6a1aaa, drag: 1 });
    });
  },
  quake(c, power) {
    const { st, tl, U, A, T, col, travel } = c;
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const k0 = i / (steps - 1);
      const p = { x: lerp(A.x, T.x, k0), y: lerp(A.y, T.y, k0) - 0.5 * U };
      const ring = tl.own(new Ring(1.6 * U, mix(col.main, 0xc08a4a, 0.5), 3 + i, { inner: 0.82, outer: 0.92 }));
      ring.mesh.position.set(p.x, p.y, 0.1);
      ring.mesh.rotation.x = -1.1;
      ring.u.uOpacity.value = 0;
      const t0 = (i / steps) * travel;
      tl.span(t0, t0 + 0.4, (k) => (ring.mesh.scale.setScalar(lerp(0.3, 1.3, easeOut(k))), (ring.u.uOpacity.value = 1 - k)));
      tl.at(t0, () => (st.shake(0.25 * power), boom(0.25)));
    }
    tl.at(travel, () => st.particles.emit({ x: T.x, y: T.y - 0.6 * U, r: 0.5 * U, vy: 5 * U, burst: 2 * U, gravity: 12 * U, life: 1, size: 0.18 * U, color: 0x9a7a5a, drag: 0.3 }, Math.round(70 * power)));
  },
  swarm(c, power) {
    const { st, tl, U, A, T, col, travel } = c;
    tl.at(0, () => whoosh(travel + 0.3, 2000, 4000, 0.12));
    tl.span(0, travel * 0.7, (_k, dt) => {
      for (let j = 0; j < rate(200 * power, dt); j++) st.particles.emit({ x: A.x, y: A.y, r: 0.3 * U, burst: 1.5 * U, life: travel + 0.4, size: 0.07 * U, color: j % 2 ? col.main : col.accent, drag: 0.5, pull: { x: T.x, y: T.y, strength: 14 * U, swirl: (Math.random() - 0.5) * 18 * U } });
    });
  },
  gale(c, power) {
    const { st, tl, U, A, T, col, prof, travel } = c;
    for (let i = 0; i < 2; i++) {
      const rib = tl.own(new Ribbon(40, i ? col.light : col.main, 1));
      tl.span(0, travel + 0.3, (k) => {
        const head = clamp01(k * 1.4);
        rib.set(
          Array.from({ length: 24 }, (_, j) => {
            const s = (j / 23) * head;
            const ang = s * 14 + i * Math.PI + k * 8;
            const rr = 0.35 * U * (1 - s * 0.5) * power;
            return { x: lerp(A.x, T.x, s) + Math.cos(ang) * rr, y: lerp(A.y, T.y, s) + Math.sin(ang) * rr * 0.4, z: 0.4 };
          }),
          (s) => 0.08 * U * (0.4 + s),
        );
        rib.u.uOpacity.value = k > 0.8 ? (1 - k) * 5 : 1;
      });
    }
    tl.at(0, () => whoosh(travel + 0.4, 500, 3500, 0.3));
    tl.span(0, travel, (k, dt) => {
      const p = { x: lerp(A.x, T.x, k), y: lerp(A.y, T.y, k) };
      for (let j = 0; j < rate(60 * power, dt); j++) st.particles.emit({ x: p.x, y: p.y, burst: 1.2 * U, life: 0.7, size: 0.08 * U, color: 0xffffff, drag: 1, gravity: -0.5 * U });
    });
    void prof;
  },
  ram(c, power) {
    const { st, tl, U, A, T, col, travel } = c;
    lunge(c, 0.92 * power);
    tl.span(0, travel, (k, dt) => {
      const p = { x: lerp(A.x, T.x, easeIn(k) * 0.9), y: lerp(A.y, T.y, easeIn(k) * 0.9) };
      for (let j = 0; j < rate(140 * power, dt); j++) st.particles.emit({ x: p.x, y: p.y, r: 0.4 * U, life: 0.35, size: 0.12 * U, color: j % 2 ? col.main : col.light, drag: 3 });
    });
    tl.at(0, () => whoosh(travel, 300, 2500, 0.3));
  },
};

export type { Quality };
export const ATTACK_STYLES = Object.keys(STYLES) as AttackStyle[];
export { css };
