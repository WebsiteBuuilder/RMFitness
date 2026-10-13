// The 3D art engine's director and cinematics (loaded on demand: three.js only
// downloads once the first animation is needed). The director plays cues one at
// a time; battle figures stay on stage between the attack, the hit and the
// destruction, then fade when nothing more is coming.
import { PerspectiveCamera, Vector2, Vector3 } from 'three';
import { card } from '../eds/db';
import type { Pid } from '../eds/types';
import type { CardRef, Cue } from './cues';
import { artFor, cardBack, type ArtData } from './depth';
import { profileFor, rand, SIGNATURE_CARDS, type ArtProfile, type AttackStyle } from './profile';
import { boom, chime, drone, swell, whoosh, zap } from './sfx';
import { backOut, BASE_FOV, CardPanel, clamp01, Crack, CutIn, easeIn, easeInOut, easeOut, Figure, Glow, lerp, Ribbon, Ring, setRgb, Shards, Stage, Veil, type Fx, type Quality } from './stage';
import { SPELL_COLOR as SPELL, TRAP_COLOR as TRAP } from './profile';

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
  oz: number;
  /** extra lean back (wind-up) or forward (recoil), radians */
  lean: number;
  role: Role;
  /** has flown from its card to its battle spot */
  entered: boolean;
  /** its card on the field (where it flies in from) */
  from: { x: number; y: number };
}

type Role = 'att' | 'def';

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
  /** the full-screen dim behind every cinematic, and the layer over it (flashes, cracks, speed lines) */
  private veil = new Veil(false);
  private front = new Veil(true);
  private dim = 0;
  private dimTarget = 0;
  /** where the dim's pool of light sits (0..1 screen) */
  private focus = new Vector2(0.5, 0.5);
  private crackAt = new Vector2(0.5, 0.5);
  /** a scratch camera for framing */
  private probe = new PerspectiveCamera(BASE_FOV, 1, 0.1, 100);
  /** which side attacks in the battle on stage (mirrors the layout) */
  private battleSide: 'near' | 'far' = 'near';

  constructor(
    canvas: HTMLCanvasElement,
    quality: Quality,
    private ui: Ui,
  ) {
    this.stage = new Stage(canvas, quality);
    this.stage.speed = quality === 'fast' ? 1.8 : 1;
    this.stage.onFrame = (dt) => this.frame(dt);
    this.stage.scene.add(this.veil.mesh, this.front.mesh);
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
    this.veil.dispose();
    this.front.dispose();
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
    this.stage.backdrop.u.uOpacity.value = this.bg * 0.7;
    this.veils(dt);
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
    if (!this.actors.size && this.bg < 0.03 && this.dim < 0.03 && (!this.stage.particles.active || this.fastFade || this.idleFor > 0.7)) {
      this.stage.particles.clear();
      this.stage.backdrop.u.uOpacity.value = 0;
      this.stage.stop();
      this.skipAll = false;
      this.fastFade = false;
      this.onIdle?.();
    }
  }

  /** The dim eases toward what the cinematic wants; flashes and overlays decay; the camera drifts home when idle. */
  private veils(dt: number) {
    const want = this.current ? this.dimTarget : this.actors.size && !this.fastFade && this.idleFor < 0.3 ? 0.75 : 0;
    this.dim = lerp(this.dim, want, 1 - Math.exp(-dt * (this.fastFade ? 22 : 8)));
    if (want === 0 && this.dim < 0.01) this.dim = 0;
    const v = this.veil.u;
    v.uDim.value = this.dim;
    v.uAspect.value = this.stage.camera.aspect;
    v.uFocus.value.lerp(this.focus, 1 - Math.exp(-dt * 6));
    const f = this.front.u;
    f.uAspect.value = this.stage.camera.aspect;
    f.uFlash.value *= Math.exp(-dt * 9);
    // overlays fade unless a span keeps setting them (spans run after this, every frame)
    const fade = Math.exp(-dt * 12);
    f.uRed.value *= fade;
    f.uSpeed.value *= fade;
    f.uCrackOp.value *= fade;
    if (!this.current) {
      const c = 1 - Math.exp(-dt * (this.fastFade ? 20 : 6));
      this.stage.camBase.lerp(REST.pos, c);
      this.stage.camLook.lerp(REST.look, c);
    }
    this.veil.update(dt);
    this.front.update(dt);
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

  /** Where each fighter stands in a battle: the attacker in the foreground, the defender deep in the frame. */
  private spot(role: Role) {
    const U = this.U;
    const m = this.battleSide === 'near' ? 1 : -1;
    return role === 'att' ? { x: -0.4 * U * m, y: -0.78 * U, z: 0.8 } : { x: 0.34 * U * m, y: 0.78 * U, z: -2.2 };
  }

  /** Where a direct attack lands: the defending duelist, deep beyond the field. */
  private directPoint(): P3 {
    const U = this.U;
    const m = this.battleSide === 'near' ? 1 : -1;
    return { x: 0.25 * U * m, y: 0.75 * U, z: -3.4 };
  }

  private anchor(c: CardRef | null, fallbackSide: 'near' | 'far') {
    if (c?.rect) {
      const w = this.stage.toWorld(c.rect.x, c.rect.y);
      return { x: w.x, y: w.y };
    }
    return { x: 0, y: (fallbackSide === 'near' ? -1 : 1) * 2.1 * this.U };
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
    return new Figure(art, size, segs, glow, size * (0.22 + prof.depth * 0.3), { rim: art.palette[0], edge: prof.tier >= 2 ? 1 : 0 });
  }

  private dropActor(a: Actor) {
    if (a.fig) this.stage.remove(a.fig);
    if (a.back) this.stage.remove(a.back);
  }

  private async actor(c: CardRef, role: Role): Promise<Actor> {
    const have = this.actors.get(c.uid);
    if (have) return have;
    const prof = profileFor(card(c.name), c.name || 'face-down');
    const art = c.name && c.faceUp ? await this.art(c.name) : null;
    const s = this.spot(role);
    const size = (role === 'att' ? 1.2 : 1.35) * this.U;
    const a: Actor = { uid: c.uid, name: c.name, side: this.side(c.controller), role, prof, art, fig: null, back: null, x: s.x, y: s.y, z: s.z, size, ox: 0, oy: 0, oz: 0, lean: 0, entered: false, from: this.anchor(c, this.side(c.controller)) };
    if (art) {
      const col = this.colors(prof, art);
      a.fig = this.stage.add(this.figure(art, size, prof, col.main));
      a.fig.u.uOpacity.value = 0;
    } else {
      a.back = this.stage.add(new CardPanel(cardBack(), size * 0.8, 0x8a5a2a));
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
    m.position.set(a.x + a.ox, a.y + a.oy, a.z + a.oz);
    // the fighters turn a little toward each other; the lean is the wind-up and the recoil
    const t = this.battleSide === 'near' ? 1 : -1;
    m.rotation.x = (a.role === 'att' ? -0.06 : 0.04) + a.lean;
    m.rotation.y = (a.role === 'att' ? 0.22 : -0.18) * t;
  }

  private setOpacity(a: Actor, o: number) {
    if (a.fig) a.fig.u.uOpacity.value = o;
    if (a.back) a.back.u.uOpacity.value = o;
  }

  /** Moves a fighter from its card on the field to its battle spot (k 0..1). */
  private enter(a: Actor, k: number) {
    const m = a.fig?.mesh ?? a.back?.mesh;
    if (!m || a.entered) return;
    const e = easeOut(k);
    m.position.set(lerp(a.from.x, a.x, e), lerp(a.from.y, a.y, e), lerp(0, a.z, e));
    const s = (a.fig ? a.size : 1) * lerp(0.35, 1, e);
    m.scale.set(s, s, s);
    this.setOpacity(a, clamp01(k * 2.5));
    if (k >= 1) {
      a.entered = true;
      this.place(a);
      this.setOpacity(a, 1);
    }
  }

  private muzzle(a: Actor): P3 {
    return { x: a.x + a.ox, y: a.y + a.oy + a.size * 0.2, z: a.z + a.oz + 0.35 };
  }

  private center(a: Actor): P3 {
    return { x: a.x + a.ox, y: a.y + a.oy, z: a.z + a.oz + 0.2 };
  }

  private boxOf(a: Actor): Box {
    // the relief pops toward the camera: frame the front of it
    return { x: a.x, y: a.y, z: a.z + a.size * 0.25, w: a.size * 0.52, h: a.size * 0.52 };
  }

  // ------------------------------------------------------------ shared beats
  // (the board syncs its Life Points and zones to each cinematic's tl.commit(t):
  // summon landing, attack impact, damage, the shatter)

  /** A colored flash over everything (WebGL, every tier). */
  private flash(color: number, s: number) {
    const u = this.front.u;
    setRgb(u.uFlashColor.value, color);
    u.uFlash.value = Math.max(u.uFlash.value, s);
  }

  private get q() {
    return this.stage.quality === 'full' ? 1 : 0.55;
  }

  /** Light shafts in the attribute color rising behind a subject (feet at `foot`). */
  private shafts(tl: Timeline, foot: P3, h: number, color: number, t0: number, t1: number, n = 3, peak = 0.85) {
    const U = this.U;
    for (let i = 0; i < n; i++) {
      const g = tl.own(new Glow((0.7 + (i % 2) * 0.35) * U, h, 'shaft', color, color));
      const o = i - (n - 1) / 2;
      g.mesh.position.set(foot.x + o * 0.42 * U, foot.y + h * 0.42, foot.z - 0.9 - Math.abs(o) * 0.2);
      g.mesh.rotation.z = -o * 0.2;
      tl.span(t0 + i * 0.05, t0 + 0.3 + i * 0.05, (k) => (g.u.uOpacity.value = peak * easeOut(k)));
      tl.span(t1 - 0.3, t1, (k) => (g.u.uOpacity.value = peak * (1 - k)));
    }
  }

  /**
   * The impact beat: hit-stop, flash + chroma pulse, punch-in, noise shake, a flare,
   * a shockwave on the ground plane and one facing the camera, sparks, and debris in
   * the defender's colors.
   */
  private impact(tl: Timeline, at: number, p: P3, o: { color: number; light: number; debris: number[]; power: number; ground?: number; quiet?: boolean }) {
    const st = this.stage;
    const U = this.U;
    const pw = clamp01(o.power);
    const flare = tl.own(new Glow((1.6 + pw * 1.1) * U, (1.6 + pw * 1.1) * U, 'flare', o.color, o.light));
    flare.mesh.position.set(p.x, p.y, p.z + 0.5);
    flare.u.uK.value = 1;
    tl.span(at, at + 0.4, (k) => {
      flare.u.uOpacity.value = 0.85 * (k < 0.15 ? 1 : 1 - easeOut((k - 0.15) / 0.85));
      flare.mesh.scale.setScalar(lerp(0.6, 1.15, easeOut(k)));
    });
    const ring = tl.own(new Glow(3.6 * U, 3.6 * U, 'shock', o.color, o.light));
    ring.mesh.position.set(p.x, p.y, p.z + 0.3);
    tl.span(at, at + 0.45, (k) => {
      ring.u.uK.value = easeOut(k);
      ring.u.uOpacity.value = 1 - k * 0.4;
    });
    const gy = o.ground ?? p.y - 0.7 * U;
    const floor = tl.own(new Glow((4 + pw * 2) * U, (4 + pw * 2) * U, 'shock', o.color, o.light));
    floor.mesh.position.set(p.x, gy, p.z);
    floor.mesh.rotation.x = -1.2;
    tl.span(at, at + 0.6, (k) => {
      floor.u.uK.value = easeOut(k);
      floor.u.uOpacity.value = 1 - k * 0.3;
    });
    tl.at(at, () => {
      if (!o.quiet) {
        st.hitStop(0.06 + 0.03 * pw);
        st.punch(3 + 4 * pw);
      }
      st.pulse('chroma', 0.35 + 0.6 * pw);
      st.pulse('flash', 0.08 + 0.16 * pw);
      this.flash(o.light, 0.12 + 0.16 * pw);
      st.shake(0.45 + 0.6 * pw);
      const P = st.particles;
      const q = this.q;
      P.emit({ x: p.x, y: p.y, z: p.z + 0.3, burst: 7 * U, life: 0.4, size: 0.08 * U, color: 0xffffff, drag: 5 }, Math.round(50 * q));
      P.emit({ x: p.x, y: p.y, z: p.z + 0.3, burst: 5 * U, life: 0.6, size: 0.13 * U, color: o.light, drag: 3 }, Math.round(50 * q));
      for (const c of o.debris) P.emit({ x: p.x, y: p.y, z: p.z + 0.2, r: 0.2 * U, burst: 4.5 * U, vy: 2.2 * U, gravity: 10 * U, life: 0.95, size: 0.1 * U, size1: 0.03 * U, color: c, drag: 1 }, Math.round(24 * q));
    });
  }

  // ------------------------------------------------------------ camera
  private shot(): Shot {
    return { pos: this.stage.camBase.clone(), look: this.stage.camLook.clone() };
  }

  private setShot(a: Shot, b: Shot, k: number) {
    this.stage.camBase.lerpVectors(a.pos, b.pos, k);
    this.stage.camLook.lerpVectors(a.look, b.look, k);
  }

  private resetCam() {
    this.stage.camBase.copy(REST.pos);
    this.stage.camLook.copy(REST.look);
  }

  /**
   * The safe area as fractions of the canvas height: room for the duel's HUD (Life
   * Points, hand) and, in the 3D Card Viewer, for its control panel over the canvas.
   */
  private safe(): { top: number; bottom: number } {
    let top = SAFE_TOP;
    let bottom = SAFE_BOTTOM;
    const cv = this.stage.canvas;
    const r = cv.getBoundingClientRect();
    if (r.height > 0) {
      const css = getComputedStyle(cv);
      const t = parseFloat(css.getPropertyValue('--art-safe-top'));
      const b = parseFloat(css.getPropertyValue('--art-safe-bottom'));
      if (t >= 0) top = t / r.height;
      if (b >= 0) bottom = b / r.height;
      // anything laid over the canvas's lower part (the viewer's panel)
      const panel = document.querySelector('.artlab-panel');
      if (panel) {
        const pr = panel.getBoundingClientRect();
        const cover = (r.bottom - pr.top) / r.height;
        top = Math.min(top, 0.07);
        bottom = Math.max(0.05, cover > 0 ? cover + 0.03 : 0.05);
      }
    }
    return { top: clamp01(top), bottom: Math.min(0.6, clamp01(bottom)) };
  }

  /**
   * A camera that fits every box inside the safe area: from direction (yaw, pitch),
   * as close as it can get with the boxes filling `fill` of the safe area, centered in it.
   */
  private fit(boxes: Box[], yaw: number, pitch: number, o: { fill?: number; minD?: number } = {}): Shot {
    const cam = this.probe;
    cam.aspect = this.stage.camera.aspect;
    cam.fov = BASE_FOV;
    cam.updateProjectionMatrix();
    const safe = this.safe();
    const fill = o.fill ?? 1;
    const maxW = 2 * 0.9 * fill;
    const maxH = 2 * (1 - safe.top - safe.bottom) * fill;
    const targetY = safe.bottom - safe.top;
    const pts: Vector3[] = [];
    const look = new Vector3();
    for (const b of boxes) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) pts.push(new Vector3(b.x + sx * b.w, b.y + sy * b.h, b.z));
      look.x += b.x / boxes.length;
      look.y += b.y / boxes.length;
      look.z += b.z / boxes.length;
    }
    const dir = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const v = new Vector3();
    const span = (d: number) => {
      cam.position.copy(look).addScaledVector(dir, d);
      cam.lookAt(look);
      cam.updateMatrixWorld();
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const p of pts) {
        v.copy(p).project(cam);
        if (v.z > 1 || v.z < -1) return null;
        x0 = Math.min(x0, v.x);
        x1 = Math.max(x1, v.x);
        y0 = Math.min(y0, v.y);
        y1 = Math.max(y1, v.y);
      }
      return { x0, x1, y0, y1 };
    };
    const fits = (d: number) => {
      const s = span(d);
      return !!s && s.x1 - s.x0 <= maxW && s.y1 - s.y0 <= maxH;
    };
    let d = 10;
    const right = new Vector3();
    const up = new Vector3();
    for (let pass = 0; pass < 3; pass++) {
      let lo = o.minD ?? 4;
      let hi = 60;
      if (fits(lo)) hi = lo;
      else for (let i = 0; i < 22; i++) (fits((lo + hi) / 2) ? (hi = (lo + hi) / 2) : (lo = (lo + hi) / 2));
      d = hi;
      const s = span(d);
      if (!s) break;
      // re-center inside the safe area
      const ty = Math.tan((BASE_FOV * Math.PI) / 360);
      right.setFromMatrixColumn(cam.matrixWorld, 0);
      up.setFromMatrixColumn(cam.matrixWorld, 1);
      look.addScaledVector(right, ((s.x0 + s.x1) / 2) * ty * cam.aspect * d * 0.9);
      look.addScaledVector(up, ((s.y0 + s.y1) / 2 - targetY) * ty * d * 0.9);
    }
    return { pos: look.clone().addScaledVector(dir, d), look: look.clone() };
  }

  /** The over-the-shoulder battle camera: behind the attacker, ~25° off, the defender deep in the frame. */
  private battleShot(att: Actor | null, tgt: Actor | null, T: P3): Shot {
    const U = this.U;
    const m = this.battleSide === 'near' ? 1 : -1;
    const boxes: Box[] = [tgt ? this.boxOf(tgt) : { ...T, w: 0.5 * U, h: 0.5 * U }];
    if (att) boxes.push(this.boxOf(att));
    return this.fit(boxes, -0.44 * m, 0.1, { fill: 0.86 });
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

  /** Where a summoned figure flies to at the end: onto its card on the field (as the board will draw it). */
  private landingPose(c: CardRef, side: 'near' | 'far', size: number, art: ArtData | null, bm: BoardModule | null) {
    const st = this.stage;
    const r = c.rect;
    if (r) {
      const px = (2 * st.halfH) / (st.canvas.clientHeight || window.innerHeight);
      const fp = bm?.fieldPose?.({ left: r.x - r.w / 2, top: r.y - r.h / 2, width: r.w, height: r.h }, c.def, art);
      if (fp && Number.isFinite(fp.x) && Number.isFinite(fp.size)) {
        const w = st.toWorld(fp.x, fp.y);
        return { x: w.x, y: w.y, z: 0, size: fp.size * px, scaleY: fp.scaleY ?? 1, rotX: fp.rotX ?? 0, keep: true };
      }
      const s = r.h * 1.25 * px;
      const w = st.toWorld(r.x, r.y + r.h * 0.3);
      return { x: w.x, y: w.y + s * 0.42, z: 0, size: s, scaleY: c.def ? 0.85 : 1, rotX: c.def ? -0.35 : 0, keep: true };
    }
    const a = this.anchor(c, side);
    return { x: a.x, y: a.y, z: -0.5, size: size * 0.3, scaleY: 1, rotX: 0, keep: false };
  }

  /** A monster arrives: (a cut-in for the big ones,) its entrance, light, its name, then it lands on its card. */
  private async summon(c: CardRef): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const info = card(c.name);
    const prof = profileFor(info, c.name);
    const [art, bm] = await Promise.all([this.art(c.name), boardModule()]);
    const col = this.colors(prof, art);
    const tier = prof.tier;
    const side = this.side(c.controller);
    const big = isBig(info, prof);
    const C = big && art ? 0.62 : 0;
    const entr = prof.entrance;
    const fusionish = entr === 'fusion' || entr === 'ritual';
    const E = [1.35, 1.55, 1.85, 2.15][tier] + (fusionish ? 0.3 : 0);
    const LAND = 0.42;
    const D = C + E + LAND;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.4 + tier * 0.08;
    this.dimTarget = 0.84;
    this.focus.set(0.5, 0.5);
    this.stage.backdrop.u.uColor.value.set(((col.main >> 16) & 255) / 900, ((col.main >> 8) & 255) / 900, (col.main & 255) / 900);
    const r = rand(prof.seed);
    const from = this.anchor(c, side);
    const size = (1.3 + tier * 0.1) * U;
    const restY = 0;
    const ground = restY - size * 0.46;
    const at = (t: number, fn: () => void) => tl.at(C + t, fn);
    const span = (a: number, b: number, fn: (k: number, dt: number) => void) => tl.span(C + a, C + b, fn);
    const sub = !info ? '' : info.kind === 'monster' ? `${'★'.repeat(Math.min(12, info.level ?? 0))}  ATK ${info.atk ?? '?'} / DEF ${info.def ?? '?'}` : '';
    const how = entr === 'fusion' ? 'Fusion Summon' : entr === 'ritual' ? 'Ritual Summon' : (info?.level ?? 0) >= 5 ? 'Tribute Summon' : '';

    // the cut-in: a slanted band, the art racing across it, the name slamming in
    if (C && art) {
      const ci = tl.own(new CutIn(art.art, c.name, [how, sub.replace(/★+\s*/, '')].filter(Boolean).join('  ·  '), col.main, GOLD));
      tl.span(0, C, (k) => {
        ci.u.uK.value = k;
        ci.u.uAspect.value = st.camera.aspect;
      });
      tl.at(0, () => (swell(0.7), whoosh(0.35, 500, 3200, 0.2)));
      tl.at(C - 0.07, () => {
        st.pulse('flash', 0.7);
        this.flash(0xffffff, 0.5);
        st.hitStop(0.085);
        boom(0.45);
      });
      tl.at(C, () => (ci.u.uOpacity.value = 0));
    }

    // camera: hold at rest while the card leaves its zone, swing to a framed low (near) / high (far) angle, drift
    const yaw = prof.camYaw * 0.32;
    const pitch = side === 'near' ? -0.1 - prof.camPitch * 0.06 : 0.14 + prof.camPitch * 0.06;
    const boxes: Box[] = [
      { x: 0, y: restY, z: 0, w: size * 0.42, h: size * 0.5 },
      { x: 0, y: ground, z: 0, w: 1.05 * U, h: 0.12 * U },
    ];
    const s0 = this.fit(boxes, yaw, pitch, { fill: 0.8 + tier * 0.03 });
    const s1 = this.fit(boxes, -yaw * 0.5, pitch * 0.6, { fill: 0.88 + tier * 0.04 });
    let sStart: Shot | null = null;
    span(0, 0.45, (k) => this.setShot((sStart ??= this.shot()), s0, easeInOut(k)));
    span(0.45, E, (k) => this.setShot(s0, s1, easeInOut(k)));
    let sEnd: Shot | null = null;
    span(E, E + LAND, (k) => this.setShot((sEnd ??= this.shot()), REST, easeInOut(k)));

    // the card flies up from its zone and flips
    const flyer = tl.own(new CardPanel(art?.full ?? null, 0.9 * U, col.main));
    flyer.u.uOpacity.value = 0;
    span(0, 0.32, (k) => {
      const e = easeOut(k);
      flyer.mesh.position.set(lerp(from.x, 0, e), lerp(from.y, ground + 0.4 * U, e), lerp(0, 1.2, e));
      flyer.mesh.rotation.set(-0.5 * e, Math.PI * 2 * e, 0);
      flyer.u.uOpacity.value = 1 - easeIn(k);
      flyer.u.uTint.value = k;
    });
    if (!C) at(0, () => (tier >= 2 ? swell(0.6) : whoosh(0.3, 400, 2000, 0.15)));

    // the circle on the ground
    const star = entr === 'fusion' ? 6 : entr === 'ritual' ? 5 : 0;
    const ring = tl.own(new Ring(2.7 * U, col.main, prof.glyphs, { star }));
    ring.mesh.rotation.x = -1.2;
    ring.mesh.position.set(0, ground, 0);
    ring.spinSpeed = 0.6 + prof.spin;
    ring.u.uOpacity.value = 0;
    const ring2 = tl.own(new Ring(1.9 * U, col.accent, prof.glyphs + 7, { inner: 0.55, outer: 0.7 }));
    ring2.mesh.rotation.x = -1.2;
    ring2.mesh.position.set(0, ground, 0.01);
    ring2.spinSpeed = -(0.8 + prof.spin);
    ring2.u.uOpacity.value = 0;
    span(0.15, 0.55, (k) => {
      ring.mesh.scale.setScalar(easeOut(k));
      ring2.mesh.scale.setScalar(easeOut(k));
      ring.u.uOpacity.value = k;
      ring2.u.uOpacity.value = k;
    });
    span(E - 0.35, E, (k) => {
      ring.u.uOpacity.value = 1 - k;
      ring2.u.uOpacity.value = 1 - k;
    });

    // light shafts behind the monster
    const showAt = 0.42;
    this.shafts(tl, { x: 0, y: ground, z: 0 }, 4.2 * U, col.main, C + showAt - 0.1, C + E, tier >= 2 ? 3 : 2, 0.6 + tier * 0.1);

    // the monster
    const fig = art ? tl.own(this.figure(art, size, prof, col.main)) : null;
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
    const q = this.q;
    span(0.2, E - 0.3, (_k, dt) => {
      // a column of light rising from the circle
      emit(55 * q * (1 + tier), dt, () => {
        const a = Math.random() * Math.PI * 2;
        const rr = (0.4 + Math.random() * 0.8) * U;
        P.emit({ x: Math.cos(a) * rr, y: ground + Math.sin(a) * rr * 0.35, z: 0.2, vy: (1.2 + Math.random() * 1.5) * U, life: 0.9, size: 0.09 * U, color: Math.random() < 0.5 ? col.main : col.light, drag: 0.6 });
      });
    });
    // the landing beat: ground shock + the board can show the monster as summoned
    const landAt = showAt + 0.5;
    const shock = tl.own(new Glow(4.4 * U, 4.4 * U, 'shock', col.main, col.light));
    shock.mesh.position.set(0, ground, 0.05);
    shock.mesh.rotation.x = -1.2;
    span(landAt, landAt + 0.55, (k) => {
      shock.u.uK.value = easeOut(k);
      shock.u.uOpacity.value = 1 - k * 0.3;
    });
    switch (entr) {
      case 'descend':
        span(showAt, showAt + 0.5, (k) => {
          if (!fig) return;
          const e = backOut(k);
          fig.mesh.position.y = lerp(3.2 * U, restY, e);
          fig.u.uOpacity.value = clamp01(k * 3);
          fig.u.uReveal.value = 1;
          fig.u.uTint.value = 1 - k;
        });
        span(showAt, showAt + 0.5, (_k, dt) => emit(80 * q, dt, () => P.emit({ x: (Math.random() - 0.5) * 2.4 * U, y: 3 * U, vy: -6 * U, life: 0.5, size: 0.07 * U, color: col.light, drag: 0 })));
        at(landAt - 0.05, () => {
          st.shake(0.4 + prof.shake * 0.6);
          boom(0.4 + tier * 0.15);
          P.emit({ x: 0, y: ground, burst: 4 * U, life: 0.7, size: 0.12 * U, color: col.accent }, Math.round(70 * q));
        });
        break;
      case 'erupt':
        at(showAt - 0.1, () => {
          st.shake(0.5 + prof.shake * 0.5);
          boom(0.5);
          P.emit({ x: 0, y: ground, r: 0.4 * U, vy: 4 * U, burst: 3 * U, gravity: 9 * U, life: 1.1, size: 0.14 * U, color: mix(col.main, 0x7a5a3a, 0.5), drag: 0.3 }, Math.round(90 * q));
        });
        span(showAt, showAt + 0.45, (k) => {
          if (!fig) return;
          fig.mesh.position.y = lerp(ground - 1.2 * U, restY, backOut(k));
          fig.u.uOpacity.value = clamp01(k * 4);
          fig.u.uReveal.value = clamp01(k * 1.4);
        });
        break;
      case 'materialize':
        span(0.15, showAt + 0.15, (_k, dt) =>
          emit(160 * q, dt, () => {
            const a = Math.random() * Math.PI * 2;
            const rr = (1.4 + Math.random()) * U;
            P.emit({ x: Math.cos(a) * rr, y: restY + Math.sin(a) * rr, life: 0.55, size: 0.08 * U, color: Math.random() < 0.5 ? col.accent : col.light, drag: 0, pull: { x: 0, y: restY, strength: 22 * U, swirl: 6 * U } });
          }),
        );
        at(0.15, () => zap(0.5));
        span(showAt + 0.1, showAt + 0.55, (k) => {
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
        portal.u.uOpacity.value = 0;
        span(0.2, showAt + 0.2, (k) => (portal.mesh.scale.setScalar(easeOut(k)), (portal.u.uOpacity.value = k)));
        span(E - 0.6, E - 0.2, (k) => (portal.u.uOpacity.value = 1 - k));
        span(showAt, showAt + 0.6, (k) => {
          if (!fig) return;
          fig.u.uOpacity.value = clamp01(k * 2);
          fig.u.uReveal.value = 1;
          fig.u.uDark.value = 1 - k;
          fig.mesh.scale.setScalar(size * lerp(0.2, 1, easeOut(k)));
          fig.mesh.position.z = lerp(-1, 0, k);
        });
        span(0.2, showAt + 0.4, (_k, dt) =>
          emit(90 * q, dt, () => {
            const a = Math.random() * Math.PI * 2;
            P.emit({ x: Math.cos(a) * 1.2 * U, y: restY + Math.sin(a) * 1.2 * U, life: 0.6, size: 0.1 * U, color: mix(col.main, 0x9a3cff, 0.5), drag: 0, pull: { x: 0, y: restY, strength: 10 * U, swirl: 14 * U } });
          }),
        );
        break;
      }
      case 'splash':
        span(showAt - 0.1, showAt + 0.5, (_k, dt) => emit(200 * q, dt, () => P.emit({ x: (Math.random() - 0.5) * 0.9 * U, y: ground, vx: (Math.random() - 0.5) * 2 * U, vy: (4 + Math.random() * 3) * U, gravity: 10 * U, life: 1, size: 0.1 * U, color: Math.random() < 0.6 ? 0x7fd8ff : col.light, drag: 0.2 })));
        at(showAt, () => whoosh(0.7, 300, 1200, 0.25));
        span(showAt, showAt + 0.5, (k) => {
          if (!fig) return;
          fig.mesh.position.y = lerp(ground, restY, easeOut(k));
          fig.u.uOpacity.value = clamp01(k * 3);
          fig.u.uReveal.value = clamp01(k * 1.3);
        });
        break;
      case 'fusion':
      case 'ritual': {
        const orbs = entr === 'fusion' ? [col.main, col.accent] : [col.main, col.accent, col.light];
        const heads = orbs.map((oc) => {
          const g = tl.own(new Glow(1.1 * U, 1.1 * U, 'flare', oc, 0xffffff));
          g.mesh.position.z = 0.4;
          return g;
        });
        span(0.1, showAt + 0.2, (k, dt) =>
          orbs.forEach((oc, i) => {
            const a = (i / orbs.length) * Math.PI * 2 + k * 9;
            const rr = (1 - easeIn(k)) * 1.3 * U;
            const x = Math.cos(a) * rr;
            const y = restY + Math.sin(a) * rr * 0.6;
            heads[i].mesh.position.x = x;
            heads[i].mesh.position.y = y;
            heads[i].u.uOpacity.value = clamp01(k * 4);
            emit(70 * q, dt, () => P.emit({ x, y, burst: 0.3 * U, life: 0.4, size: 0.16 * U, color: oc, drag: 3 }));
          }),
        );
        at(showAt + 0.2, () => {
          for (const h of heads) h.u.uOpacity.value = 0;
          st.pulse('flash', 0.6);
          this.flash(col.light, 0.6);
          boom(0.6);
          chime(r());
          P.emit({ x: 0, y: restY, burst: 5 * U, life: 0.8, size: 0.13 * U, color: col.light }, Math.round(120 * q));
        });
        span(showAt + 0.2, showAt + 0.7, (k) => {
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
        span(showAt, showAt + 0.55, (k) => {
          if (!fig) return;
          fig.mesh.position.y = lerp(ground - 0.2 * U, restY, easeOut(k));
          fig.u.uOpacity.value = 1;
          fig.u.uReveal.value = easeOut(k);
        });
        at(showAt, () => chime(r()));
    }
    at(landAt, () => {
      if (tier >= 2) {
        st.shake(0.3 + prof.shake * 0.5);
        st.pulse('chroma', 0.4);
        this.flash(col.main, 0.25 + tier * 0.08);
      }
    });
    // name plate
    at(showAt + 0.2, () => this.ui.banner({ title: c.name, sub: [how, sub].filter(Boolean).join(' · '), color: col.main, big: tier >= 2, dur: E - showAt - 0.15, pos: 'bottom' }));

    // ...then it flies onto its card on the field (the board's figure takes over there)
    let pose: ReturnType<Director['landingPose']> | null = null;
    span(E, E + LAND, (k, dt) => {
      if (!fig) return;
      pose ??= this.landingPose(c, side, size, art, bm);
      const e = easeInOut(k);
      fig.mesh.position.set(lerp(0, pose.x, e), lerp(restY, pose.y, e), lerp(0, pose.z, e));
      const s = lerp(size, pose.size, e);
      fig.mesh.scale.set(s, s * lerp(1, pose.scaleY, e), s);
      fig.mesh.rotation.x = lerp(0, pose.rotX, e);
      fig.u.uOpacity.value = pose.keep ? 1 : 1 - easeIn(k);
      fig.shadowAmt = 1 - e;
      emit(60 * q, dt, () => P.emit({ x: fig.mesh.position.x, y: fig.mesh.position.y, r: s * 0.3, life: 0.35, size: 0.07 * U, color: col.light, drag: 2 }));
    });
    // the monster lands: its card appears in its zone as the figure arrives there
    tl.commit(C + E + LAND * 0.6);
    tl.at(
      D,
      () => {
        if (fig) fig.u.uOpacity.value = 0;
        try {
          bm?.markLanded?.(c.uid);
        } catch {
          /* the board is optional */
        }
        this.resetCam();
      },
      false,
    );
    return tl;
  }

  /** A face-down card slams onto the field (never shows what it is). */
  private async set(c: CardRef): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const tl = new Timeline(0.6, st);
    this.bgTarget = 0.15;
    this.dimTarget = 0.35;
    const at = this.anchor(c, this.side(c.controller));
    this.focusAt(at);
    const panel = tl.own(new CardPanel(cardBack(), 0.8 * U, 0xd08a3a));
    if (c.def) panel.mesh.rotation.z = Math.PI / 2;
    panel.u.uOpacity.value = 0;
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
    ring.u.uOpacity.value = 0;
    tl.span(0.3, 0.6, (k) => (ring.mesh.scale.setScalar(lerp(0.3, 1.2, easeOut(k))), (ring.u.uOpacity.value = 1 - k)));
    tl.span(0.42, 0.6, (k) => (panel.u.uOpacity.value = 1 - k));
    return tl;
  }

  /** Points the dim's pool of light at a world point (seen from the resting camera). */
  private focusAt(p: { x: number; y: number }) {
    const st = this.stage;
    this.focus.set(clamp01(0.5 + p.x / (2 * st.halfW)), clamp01(0.5 + p.y / (2 * st.halfH)));
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
    this.bgTarget = 0.4;
    this.dimTarget = 0.75;
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
      tl.at(0.35, () => (st.pulse('flash', 0.3), this.flash(col.light, 0.3)));
      fig.u.uOpacity.value = 0;
      fig.mesh.scale.setScalar(have.size);
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
      this.shafts(tl, { x: 0, y: -0.65 * U, z: 0 }, 3.6 * U, col.main, 0.3, 1.1, 2, 0.6);
    }
    tl.at(0.35, () => {
      st.particles.emit({ x: 0, y: 0.1 * U, burst: 3 * U, life: 0.6, size: 0.1 * U, color: col.accent }, 60);
      st.pulse('flash', 0.3);
      this.ui.banner({ title: c.name, sub: 'Flip Summon', color: col.main, dur: 0.7, pos: 'bottom' });
    });
    return tl;
  }

  /**
   * A Spell or Trap. Spells rise from their zone and open in a green rune burst;
   * traps flip up and slam toward the camera ("TRAP!", the screen's edge cracks).
   * Iconic cards play their own preset on top (SPELL_PRESETS).
   */
  private async activate(c: CardRef, what: 'spell' | 'trap'): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const info = card(c.name);
    const prof = profileFor(info, c.name);
    const art = await this.art(c.name);
    const base = what === 'spell' ? SPELL : TRAP;
    const accent = art ? brighten(art.palette[0]) : 0xffffff;
    const preset = SPELL_PRESETS[c.name];
    const side = this.side(c.controller);
    const X = preset ? preset.dur : 0;
    const open = what === 'spell' ? 0.36 : 0.3;
    const D = 1.3 + X;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.45;
    this.dimTarget = 0.82;
    this.focus.set(0.5, 0.52);
    this.stage.backdrop.u.uColor.value.set(what === 'spell' ? 0.02 : 0.08, what === 'spell' ? 0.08 : 0.02, what === 'spell' ? 0.06 : 0.07);
    const from = this.anchor(c, side);
    const H = 2.1 * U;
    const cy = 0.15 * U;
    const panel = tl.own(new CardPanel(art?.full ?? null, H, base));
    panel.u.uOpacity.value = 0;
    const ring = tl.own(new Ring(3.1 * U, base, prof.glyphs, { inner: 0.6, outer: 0.95, star: what === 'trap' ? 3 : 4 }));
    ring.mesh.position.set(0, cy, -0.6);
    ring.spinSpeed = what === 'spell' ? 0.8 : -1.2;
    ring.u.uOpacity.value = 0;
    // a gentle push toward the card (the field stays where it is, for presets that strike it)
    const cardBox: Box[] = [{ x: 0, y: cy, z: 0.8, w: H * 0.36, h: H * 0.52 }];
    // presets that strike the field keep both rows in frame
    if (preset) cardBox.push({ x: 0, y: (side === 'near' ? 1 : -1) * 1.5 * U, z: 0, w: 1.4 * U, h: 0.5 * U }, { x: 0, y: (side === 'near' ? -1 : 1) * 1.3 * U, z: 0, w: 1.4 * U, h: 0.3 * U });
    const shot = this.fit(cardBox, prof.camYaw * 0.08, 0.02, { fill: preset ? 0.92 : 0.72 });
    let s0: Shot | null = null;
    tl.span(0, 0.5, (k) => this.setShot((s0 ??= this.shot()), shot, easeInOut(k)));
    let s1: Shot | null = null;
    tl.span(D - 0.35, D, (k) => this.setShot((s1 ??= this.shot()), REST, easeInOut(k)));
    if (what === 'spell') {
      tl.at(0, () => chime(0.7));
      tl.span(0, open, (k) => {
        const e = easeOut(k);
        panel.mesh.position.set(lerp(from.x, 0, e), lerp(from.y, cy, e), lerp(0, 0.8, e));
        panel.mesh.scale.setScalar(lerp(0.3, 1, e));
        panel.mesh.rotation.set(lerp(-1, 0, e), lerp(Math.PI, 0, e), 0);
        panel.u.uOpacity.value = clamp01(k * 3);
      });
    } else {
      // trap: it flips up off the field and slams toward the camera
      tl.at(0, () => zap(0.4));
      tl.span(0, open, (k) => {
        const e = easeIn(k);
        panel.mesh.position.set(lerp(from.x, 0, easeOut(k)), lerp(from.y, cy, easeOut(k)), lerp(0, 2.2, e));
        panel.mesh.scale.setScalar(lerp(0.3, 1.08, e));
        panel.mesh.rotation.set(lerp(-1.45, 0.1, easeOut(k)), 0, lerp(0.3, -0.05, k));
        panel.u.uOpacity.value = clamp01(k * 3);
      });
      tl.span(open, open + 0.25, (k) => {
        const e = easeOut(k);
        panel.mesh.position.z = lerp(2.2, 0.8, e);
        panel.mesh.scale.setScalar(lerp(1.08, 1, e));
        panel.mesh.rotation.x = lerp(0.1, 0, e);
        panel.mesh.rotation.z = lerp(-0.05, 0, e);
      });
      tl.at(open, () => {
        st.hitStop(0.06);
        st.shake(0.7);
        st.punch(5);
        st.pulse('chroma', 0.7);
        boom(0.5);
        zap(0.3);
        this.flash(TRAP, 0.5);
        this.ui.banner({ title: 'TRAP!', color: TRAP, big: true, dur: 0.75, pos: 'top' });
        // the screen's edge cracks like glass
        this.crackAt.set(side === 'near' ? 0.88 : 0.12, 0.8);
      });
      tl.span(open, open + 0.18, (k) => {
        this.front.u.uCrack.value = easeOut(k);
        this.front.u.uCrackOp.value = 1;
        this.front.u.uCrackAt.value.copy(this.crackAt);
      });
      tl.span(open + 0.18, open + 0.75, (k) => (this.front.u.uCrackOp.value = 1 - easeIn(k)));
    }
    tl.span(open - 0.15, open + 0.25, (k) => (ring.mesh.scale.setScalar(easeOut(k) * 1.05), (ring.u.uOpacity.value = k)));
    tl.span(open, open + 0.5, (k) => (panel.u.uSheen.value = lerp(-0.4, 1.8, k)));
    this.shafts(tl, { x: 0, y: cy - H * 0.6, z: 0 }, 4.4 * U, base, open - 0.1, D - 0.3, 3, 0.55);
    // the rune burst
    const burst = tl.own(new Glow(4 * U, 4 * U, 'flare', base, accent));
    burst.mesh.position.set(0, cy, 0.2);
    burst.u.uK.value = 0.6;
    tl.span(open, open + 0.5, (k) => {
      burst.u.uOpacity.value = k < 0.12 ? k / 0.12 : 1 - easeOut((k - 0.12) / 0.88);
      burst.mesh.scale.setScalar(lerp(0.4, 1.2, easeOut(k)));
    });
    const rune = tl.own(new Ring(4.2 * U, base, prof.glyphs + 11, { inner: 0.8, outer: 0.9 }));
    rune.mesh.position.set(0, cy, 0.3);
    rune.u.uOpacity.value = 0;
    rune.spinSpeed = 2;
    tl.span(open, open + 0.5, (k) => (rune.mesh.scale.setScalar(lerp(0.3, 1.3, easeOut(k))), (rune.u.uOpacity.value = 1 - easeIn(k))));
    tl.at(open, () => {
      st.particles.emit({ x: 0, y: cy, burst: 5 * U, life: 0.8, size: 0.09 * U, color: base }, Math.round(70 * this.q));
      st.particles.emit({ x: 0, y: cy, burst: 3 * U, life: 0.9, size: 0.12 * U, color: accent }, Math.round(40 * this.q));
      st.pulse('flash', 0.25);
      this.ui.banner({ title: c.name, sub: info ? `${info.sub} ${what === 'spell' ? 'Spell' : 'Trap'}` : '', color: base, dur: D - open - 0.3, pos: 'bottom' });
    });
    if (preset) {
      const t0 = open + 0.35;
      // the card steps back to make room for its effect
      tl.span(t0 - 0.1, t0 + 0.25, (k) => {
        const e = easeInOut(k);
        panel.mesh.scale.setScalar(lerp(1, 0.68, e));
        panel.mesh.position.z = lerp(0.8, -0.4, e);
        panel.u.uOpacity.value = lerp(1, 0.85, e);
      });
      preset.play({ d: this, st, tl, U, t0, t1: t0 + X + 0.35, panel, cy, side, color: base, accent, opp: (side === 'near' ? 1 : -1) * 1.5 * U, own: (side === 'near' ? -1 : 1) * 1.5 * U });
    }
    const z1 = preset ? -0.4 : 0.8;
    const sc1 = preset ? 0.68 : 1;
    tl.span(D - 0.35, D, (k) => {
      panel.mesh.position.set(lerp(0, from.x, easeIn(k)), lerp(cy, from.y, easeIn(k)), lerp(z1, 0, k));
      panel.mesh.scale.setScalar(lerp(sc1, 0.3, easeIn(k)));
      panel.u.uOpacity.value = (preset ? 0.85 : 1) * (1 - easeIn(k));
      ring.u.uOpacity.value = 1 - k;
    });
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
    this.bgTarget = 0.4;
    this.dimTarget = 0.75;
    let fig = have?.fig ?? null;
    const at = have ? { x: have.x, y: have.y } : { x: 0, y: 0.1 * U };
    if (!fig && art) {
      fig = tl.own(this.figure(art, 1.5 * U, prof, col.main));
      fig.mesh.position.set(at.x, at.y, 0);
      fig.u.uOpacity.value = 0;
      tl.span(0, 0.25, (k) => (fig!.u.uOpacity.value = k));
      tl.span(D - 0.25, D, (k) => (fig!.u.uOpacity.value = 1 - k));
      this.shafts(tl, { x: at.x, y: at.y - 0.7 * U, z: 0 }, 3.6 * U, col.main, 0, D, 2, 0.6);
    }
    const ring = tl.own(new Ring(1.8 * U, col.main, prof.glyphs));
    ring.mesh.position.set(at.x, at.y - 0.7 * U, 0);
    ring.mesh.rotation.x = -1.1;
    ring.spinSpeed = 2;
    ring.u.uOpacity.value = 0;
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
    this.bgTarget = 0.5;
    this.dimTarget = 0.75;
    const ring = tl.own(new Ring(3 * U, 0x4ad8ff, 77, { inner: 0.5, outer: 0.95, star: 7 }));
    ring.spinSpeed = 1.5;
    ring.u.uOpacity.value = 0;
    tl.span(0, 0.3, (k) => (ring.mesh.scale.setScalar(easeOut(k)), (ring.u.uOpacity.value = k)));
    tl.span(0.9, 1.2, (k) => (ring.u.uOpacity.value = 1 - k));
    this.shafts(tl, { x: 0, y: -1.2 * U, z: -0.5 }, 4 * U, 0x4ad8ff, 0, 1.2, 3, 0.6);
    tl.at(0.1, () => {
      chime(0.9);
      st.pulse('flash', 0.3);
      st.particles.emit({ x: 0, y: 0, burst: 4 * U, life: 0.8, size: 0.1 * U, color: 0x9affff }, 60);
      this.ui.banner({ title: name.replace(/ \(Skill Card\)$/, ''), sub: `Skill · ${this.side(p) === 'near' ? 'you' : 'opponent'}`, color: 0x4ad8ff, big: true, dur: 0.9, pos: 'mid' });
    });
    return tl;
  }

  /** The attack is declared: both fighters take the stage, the camera goes over the attacker's shoulder, the attacker winds up. */
  private async attack(a: CardRef, t: CardRef | null, _defender: Pid): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    if (!this.actors.size) this.battleSide = this.side(a.controller);
    const att = await this.actor(a, 'att');
    const tgt = t ? await this.actor(t, 'def') : null;
    const col = this.colors(att.prof, att.art);
    const sig = SIG_ATTACKS[att.name];
    const D = 0.72;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.45;
    this.dimTarget = 0.86;
    this.focus.set(0.5, 0.5);
    this.stage.backdrop.u.uColor.value.set(0.05, 0.03, 0.09);
    tl.span(0, 0.36, (k) => {
      this.enter(att, k);
      if (tgt) this.enter(tgt, k);
    });
    const T = tgt ? this.center(tgt) : this.directPoint();
    const shot = this.battleShot(att, tgt, T);
    let s0: Shot | null = null;
    tl.span(0, 0.5, (k) => this.setShot((s0 ??= this.shot()), shot, easeInOut(k)));
    // light behind the attacker
    this.shafts(tl, { x: att.x, y: att.y - att.size * 0.46, z: att.z }, 3.8 * U, col.main, 0.15, D + 3, 2, 0.5);
    // direct attack: the defending duelist's spot lights up as the target
    if (!tgt) {
      const mark = tl.own(new Ring(2.4 * U, 0xff4a4a, 13, { inner: 0.8, outer: 0.92 }));
      mark.mesh.position.set(T.x, T.y, T.z);
      mark.spinSpeed = 1;
      mark.u.uOpacity.value = 0;
      tl.span(0.2, 0.6, (k) => (mark.mesh.scale.setScalar(easeOut(k)), (mark.u.uOpacity.value = k * 0.8)));
      tl.span(0.6, D, (k) => (mark.u.uOpacity.value = 0.8 * (1 - k)));
    }
    // wind-up: the attacker leans back while energy converges on it
    const M = this.muzzle(att);
    const charge = tl.own(new Glow(1.2 * U * (sig?.charge ?? 1), 1.2 * U * (sig?.charge ?? 1), 'flare', col.main, col.light));
    charge.mesh.position.set(M.x, M.y, M.z);
    tl.span(0.4, D, (k, dt) => {
      att.lean = -0.3 * easeOut(k);
      att.oz = -0.25 * easeOut(k);
      this.place(att);
      charge.u.uOpacity.value = easeIn(k) * 0.7;
      charge.mesh.scale.setScalar(lerp(0.3, 1, easeOut(k)));
      const n = Math.floor(140 * this.q * dt + Math.random());
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = (0.9 + Math.random() * 0.6) * U;
        st.particles.emit({ x: M.x + Math.cos(ang) * rr, y: M.y + Math.sin(ang) * rr, z: M.z, life: 0.4, size: 0.08 * U, color: Math.random() < 0.5 ? col.main : col.light, drag: 0, pull: { x: M.x, y: M.y, strength: 20 * U, swirl: 5 * U } });
      }
    });
    tl.at(0.4, () => (att.prof.tier >= 2 ? swell(0.6) : whoosh(0.45, 200, 1600, 0.15)));
    sig?.windup?.({ d: this, st, tl, U, at: att, M, col, t0: 0.3, t1: D });
    tl.at(0.3, () => this.ui.banner({ title: `${att.prof.attackName}!`, sub: a.name, color: col.main, big: true, dur: 1.2, pos: 'bottom' }));
    return tl;
  }

  /** The blow lands: wind-up release, the attacker's own attack style, impact, and a clash when the defender survives. */
  private async hit(a: CardRef | null, t: CardRef | null, defender: Pid, dmg?: { player: Pid; amount: number }): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    if (!this.actors.size && a) this.battleSide = this.side(a.controller);
    const att = a ? (this.actors.get(a.uid) ?? (await this.actor(a, 'att'))) : null;
    const tgt = t ? (this.actors.get(t.uid) ?? (await this.actor(t, 'def'))) : null;
    for (const act of [att, tgt]) if (act && !act.entered) this.enter(act, 1);
    const prof = att?.prof ?? profileFor(undefined, 'unknown');
    const col = this.colors(prof, att?.art ?? null);
    const tcol = tgt ? this.colors(tgt.prof, tgt.art) : { main: 0xff4a4a, accent: 0xffa07a, light: 0xffe0d0 };
    const sig = att ? SIG_ATTACKS[att.name] : undefined;
    const M = att ? this.muzzle(att) : { x: 0, y: -1.2 * U, z: 1.5 };
    const T = tgt ? this.center(tgt) : this.directPoint();
    // will the defender survive this? (its destruction is already queued when it won't)
    const dies = (uid: number) => this.queue.some((q) => q.cue.kind === 'destroy' && q.cue.card.uid === uid);
    const clash = !!tgt && !dies(tgt.uid);
    const attLoses = clash && !!att && (dies(att.uid) || (dmg ? this.side(dmg.player) === att.side : this.queue.some((q) => q.cue.kind === 'damage' && this.side(q.cue.player) === att.side)));
    const W = 0.18;
    const travel = 0.22 + (1 - prof.speed) * 0.14;
    const hitAt = W + travel;
    const P = clash ? { x: lerp(M.x, T.x, 0.58), y: lerp(M.y, T.y, 0.58), z: lerp(M.z, T.z, 0.58) } : T;
    const D = hitAt + (clash ? 0.85 : 0.55);
    const tl = new Timeline(D, st);
    this.bgTarget = 0.45;
    this.dimTarget = 0.86;
    const w = prof.tier >= 3 ? 2.4 : prof.tier === 2 ? 1.6 : 1;
    const ctx: HitCtx = { d: this, st, tl, U, A: M, T: P, col, prof, s: W, travel, att, q: this.q, w: w * (sig?.width ?? 1) };
    // release the wind-up
    if (att) {
      tl.span(0, W, (k) => {
        att.lean = lerp(-0.3, 0.16, easeIn(k));
        att.oz = lerp(-0.25, 0.15, easeIn(k));
        this.place(att);
      });
      tl.span(hitAt, hitAt + 0.35, (k) => {
        att.lean = lerp(0.16, 0, easeOut(k));
        att.oz = lerp(0.15, 0, easeOut(k));
        this.place(att);
      });
    }
    STYLES[sig?.style ?? prof.style](ctx, 1);
    if (prof.style2 && !sig) STYLES[prof.style2](ctx, 0.55);
    sig?.travel?.(ctx);
    // the camera: hold over the shoulder; a direct attack rushes in toward the duelist
    const base = this.shot();
    if (!tgt) {
      const rush: Shot = { pos: base.pos.clone().lerp(new Vector3(T.x, T.y, T.z), 0.35), look: base.look.clone().lerp(new Vector3(T.x, T.y, T.z), 0.5) };
      tl.span(W, hitAt + 0.05, (k) => this.setShot(base, rush, easeIn(k)));
      tl.span(hitAt + 0.05, D, (k) => this.setShot(rush, base, easeInOut(k)));
      this.front.u.uSpeed.value = 0;
      tl.span(W, hitAt, (k) => (this.front.u.uSpeed.value = easeIn(k)));
      tl.span(hitAt, hitAt + 0.3, (k) => {
        this.front.u.uSpeed.value = 1 - k;
        this.front.u.uRed.value = Math.max(this.front.u.uRed.value, 0.6 * (1 - easeIn(k)));
        this.front.u.uCrack.value = easeOut(clamp01(k * 4)) * 1.2;
        this.front.u.uCrackOp.value = 1 - easeIn(k);
        this.front.u.uCrackAt.value.set(0.5, 0.62);
      });
    } else {
      const push: Shot = { pos: base.pos.clone().lerp(base.look, 0.03), look: base.look.clone() };
      tl.span(W, D, (k) => this.setShot(base, push, easeOut(k)));
    }
    const debris = [tcol.main, tcol.accent];
    this.impact(tl, hitAt, P, { color: col.main, light: col.light, debris: clash ? [col.main, tcol.main] : debris, power: clamp01(0.45 + prof.tier * 0.18 + (tgt ? 0 : 0.2)), ground: tgt ? tgt.y - tgt.size * 0.46 : T.y - 0.8 * U });
    tl.at(hitAt, () => {
      boom(0.35 + prof.tier * 0.15 + (tgt ? 0 : 0.25));
      // the battle damage lands with the blow
      if (dmg) this.ui.number({ text: `-${dmg.amount}`, color: 0xff4a4a, side: this.side(dmg.player) === 'near' ? 'bottom' : 'top', size: 1 + Math.min(1, dmg.amount / 3000) * 1.2 });
    });
    tl.commit(hitAt);
    if (dmg) {
      const k = Math.min(1, dmg.amount / 3000);
      tl.span(hitAt, hitAt + 0.45, (x) => (this.front.u.uRed.value = (tgt ? 0.25 + k * 0.3 : 0.55) * (1 - easeOut(x))));
    }
    void defender;
    if (tgt && !clash) {
      // the defender takes it: knocked back, white-hot
      tl.span(hitAt, hitAt + 0.45, (k) => {
        const kick = Math.sin(Math.min(1, k * 1.6) * Math.PI) * (1 - k * 0.5);
        tgt.oz = -0.7 * kick;
        tgt.oy = 0.12 * U * kick;
        tgt.lean = 0.35 * kick;
        if (tgt.fig) tgt.fig.u.uTint.value = 1 - easeOut(k);
        if (tgt.back) tgt.back.u.uTint.value = 1 - easeOut(k);
        this.place(tgt);
      });
    }
    if (tgt && clash) {
      // both push: the defender answers at the midpoint, sparks fly, then the loser is thrown back
      const tc = this.muzzle(tgt);
      const layers = [
        tl.own(new Ribbon(16, tcol.main, 1)),
        tl.own(new Ribbon(16, tcol.light, 0)),
      ];
      const ww = 0.12 * U;
      tl.span(W * 0.5, hitAt + 0.3, (k) => {
        const reach = easeOut(clamp01(k * 2.2));
        const pts = [tc, { x: lerp(tc.x, P.x, reach), y: lerp(tc.y, P.y, reach), z: lerp(tc.z, P.z, reach) }];
        layers[0].set(pts, (s) => ww * 2 * (0.6 + 0.4 * s));
        layers[1].set(pts, ww * 0.6);
        for (const l of layers) l.u.uOpacity.value = k > 0.85 ? (1 - k) / 0.15 : 1;
      });
      const loser = attLoses ? att : tgt;
      const winner = attLoses ? tgt : att;
      tl.span(hitAt, hitAt + 0.3, (k, dt) => {
        for (const f of [att, tgt]) {
          if (!f) continue;
          f.ox = noise(k * 30 + f.uid) * 0.04 * U;
          this.place(f);
        }
        const n = Math.floor(220 * this.q * dt + Math.random());
        for (let i = 0; i < n; i++) st.particles.emit({ x: P.x, y: P.y, z: P.z + 0.3, burst: 5 * U, life: 0.35, size: 0.07 * U, color: i % 2 ? col.light : tcol.light, drag: 3, gravity: 4 * U });
        if (Math.random() < dt * 14) st.shake(0.35);
      });
      const knock = hitAt + 0.3;
      if (loser) {
        const Lp = this.center(loser);
        this.impact(tl, knock, Lp, { color: (winner ? (winner === att ? col : tcol) : col).main, light: 0xffffff, debris: [loser === att ? col.main : tcol.main], power: 0.55, ground: loser.y - loser.size * 0.46, quiet: true });
        tl.span(knock, knock + 0.45, (k) => {
          const kick = Math.sin(Math.min(1, k * 1.6) * Math.PI) * (1 - k * 0.5);
          loser.ox = 0;
          loser.oz = (loser === att ? 0.6 : -0.7) * kick;
          loser.lean = (loser === att ? -0.4 : 0.35) * kick;
          if (loser.fig) loser.fig.u.uTint.value = 0.8 * (1 - easeOut(k));
          this.place(loser);
        });
        tl.at(knock, () => boom(0.4));
      }
      tl.at(
        D,
        () => {
          for (const f of [att, tgt]) if (f) ((f.ox = 0), (f.oz = 0), (f.lean = 0), this.place(f));
        },
        false,
      );
    }
    return tl;
  }

  private async damage(p: Pid, amount: number): Promise<Timeline> {
    const st = this.stage;
    const tl = new Timeline(0.6, st);
    this.bgTarget = this.actors.size ? 0.45 : 0.2;
    this.dimTarget = this.actors.size ? 0.8 : 0.3;
    const k = Math.min(1, amount / 3000);
    tl.at(0, () => {
      this.ui.number({ text: `-${amount}`, color: 0xff4a4a, side: this.side(p) === 'near' ? 'bottom' : 'top', size: 1 + k * 1.2 });
      st.shake(0.25 + k * 0.6);
      st.pulse('chroma', 0.3 + k * 0.4);
    });
    tl.commit(0);
    tl.span(0, 0.45, (x) => (this.front.u.uRed.value = (0.3 + k * 0.4) * (1 - easeOut(x))));
    return tl;
  }

  /** A monster is destroyed: a freeze, cracks of light run over it, then it bursts into pieces of its own art. */
  private async destroy(c: CardRef): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const D = 1.4;
    const tl = new Timeline(D, st);
    this.bgTarget = this.actors.size ? 0.45 : 0.25;
    this.dimTarget = this.actors.size ? 0.86 : 0.6;
    let act = this.actors.get(c.uid) ?? null;
    let own: Figure | null = null;
    const prof = act?.prof ?? profileFor(card(c.name), c.name);
    if (!act) {
      const art = await this.art(c.name);
      if (!art) {
        tl.commit(0);
        return tl;
      }
      own = tl.own(this.figure(art, 1.2 * U, prof, this.colors(prof, art).main));
      const at = this.anchor(c, this.side(c.controller));
      own.mesh.position.set(at.x, at.y + 0.3 * U, 0.3);
      this.focusAt(at);
      tl.span(0, 0.12, (k) => (own!.u.uOpacity.value = k));
    }
    // a face-down card destroyed in battle shows what it was as it breaks
    if (act && !act.fig && c.name) {
      const art = await this.art(c.name);
      if (art) {
        if (act.back) this.stage.remove(act.back);
        act.back = null;
        act.fig = this.stage.add(this.figure(art, act.size, prof, this.colors(prof, art).main));
        act.fig.mesh.scale.setScalar(act.size);
        act.art = art;
        this.place(act);
      }
    }
    const col = this.colors(prof, act?.art ?? null);
    const fig = act?.fig ?? own;
    const BREAK = 0.48;
    tl.at(0, () => {
      st.hitStop(0.15, 0.03);
      whoosh(0.5, 3000, 400, 0.15);
      zap(0.2);
    });
    if (fig) {
      const crack = tl.own(new Crack(fig, col.light, { u: 0.5 + (Math.random() - 0.5) * 0.3, v: 0.55 }));
      const home = { x: fig.mesh.position.x, y: fig.mesh.position.y };
      tl.span(0.04, BREAK, (k) => {
        crack.u.uCrack.value = easeOut(k);
        fig.u.uTint.value = 0.15 + 0.25 * Math.sin(k * 20) ** 2;
        // trembling: smooth noise, growing toward the break
        fig.mesh.position.x = home.x + noise(k * 25 + 3) * 0.03 * U * k;
        fig.mesh.position.y = home.y + noise(k * 25 + 9) * 0.02 * U * k;
      });
      tl.at(BREAK, () => {
        crack.u.uOpacity.value = 0;
        fig.u.uOpacity.value = 0;
        const sh = tl.own(new Shards(fig, col.light, 5, 6, 7 * U));
        const p = fig.mesh.position;
        sh.burst(p.x, p.y - 0.1 * U, 3 * U, { x: 0, y: 0.4 * U });
        sh.life = D - BREAK;
        const P = st.particles;
        const q = this.q;
        P.emit({ x: p.x, y: p.y, z: p.z + 0.2, r: 0.4 * U, burst: 4 * U, vy: 1.5 * U, gravity: 5 * U, life: 1, size: 0.08 * U, size1: 0.02 * U, color: col.main, drag: 1.2 }, Math.round(70 * q));
        P.emit({ x: p.x, y: p.y, z: p.z + 0.2, r: 0.4 * U, burst: 3 * U, vy: 1 * U, gravity: 3 * U, life: 1.1, size: 0.06 * U, color: 0xffc070, drag: 1.5 }, Math.round(50 * q));
        // smoke: slow, wide, dim puffs
        P.emit({ x: p.x, y: p.y - 0.2 * U, z: p.z, r: 0.5 * U, burst: 0.8 * U, vy: 0.6 * U, life: 1.1, size: 0.55 * U, size1: 0.9 * U, color: 0x2a2630, drag: 1.5 }, Math.round(16 * q));
        st.pulse('flash', 0.4);
        st.pulse('chroma', 0.6);
        this.flash(col.light, 0.35);
        st.shake(0.7);
        st.punch(3);
        boom(0.5);
      });
      tl.commit(BREAK);
      const flare = tl.own(new Glow(3 * U, 3 * U, 'flare', col.main, col.light));
      flare.mesh.position.set(home.x, home.y, fig.mesh.position.z + 0.4);
      tl.span(BREAK, BREAK + 0.4, (k) => (flare.u.uOpacity.value = 1 - easeOut(k)));
    } else {
      tl.span(0, 0.5, (k) => {
        if (act?.back) act.back.u.uOpacity.value = 1 - k;
      });
      tl.at(0.3, () => {
        const p = act ? this.center(act) : { x: 0, y: 0, z: 0 };
        st.particles.emit({ x: p.x, y: p.y, burst: 3.5 * U, life: 0.9, size: 0.1 * U, color: col.main, gravity: 3 * U, drag: 1.5 }, 60);
        st.shake(0.4);
        boom(0.35);
      });
      tl.commit(0.3);
    }
    tl.at(
      D,
      () => {
        if (act) {
          this.dropActor(act);
          this.actors.delete(act.uid);
          act = null;
        }
      },
      false,
    );
    return tl;
  }

  private async victory(winner: Pid | 'draw'): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const tl = new Timeline(1.6, st);
    this.bgTarget = 0.5;
    this.dimTarget = 0.8;
    const color = winner === 'draw' ? 0xc0c0ff : winner === this.viewer ? 0xffd75a : 0xff5a5a;
    const ring = tl.own(new Ring(3.2 * U, color, 99, { inner: 0.7, outer: 0.95, star: 8 }));
    ring.spinSpeed = 1.2;
    ring.u.uOpacity.value = 0;
    tl.span(0, 0.5, (k) => (ring.mesh.scale.setScalar(easeOut(k)), (ring.u.uOpacity.value = k)));
    tl.span(1.1, 1.6, (k) => (ring.u.uOpacity.value = 1 - k));
    this.shafts(tl, { x: 0, y: -1.6 * U, z: -0.5 }, 5 * U, color, 0, 1.6, 3, 0.7);
    tl.at(0.1, () => {
      boom(0.7);
      st.pulse('flash', 0.5);
      this.flash(color, 0.4);
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
    this.dimTarget = 0.9;
    this.focus.set(0.5, 0.5);
    st.backdrop.u.uColor.value.set(0.35, 0.08, 0.55);
    const purple = 0x9a3cff;
    const magenta = 0xff4fd8;
    const gold = 0xffc94a;
    // everything stays inside the safe frame at the resting camera
    const safe = this.safe();
    const topY = st.halfH * (1 - 2 * safe.top);
    const botY = -st.halfH * (1 - 2 * safe.bottom);
    let s0: Shot | null = null;
    tl.span(0, 0.6, (k) => this.setShot((s0 ??= this.shot()), REST, easeInOut(k)));
    tl.span(0.6, D, (k) => {
      st.camBase.set(Math.sin(k * 3) * 0.5, lerp(0, 0.2, k), 10 - 0.5 * easeInOut(k));
      st.camLook.set(0, 0, 0);
    });
    tl.at(0, () => drone(D - 0.3));
    tl.span(0, 1.2, (k) => (st.backdrop.u.uVortex.value = easeInOut(k)));
    tl.span(D - 0.8, D, (k) => (st.backdrop.u.uVortex.value = 1 - k));
    // the eye
    const eyeSize = Math.min(2.6 * U, st.halfW * 1.8);
    const eye = tl.own(new Ring(eyeSize, gold, 4242, { inner: 0.9, outer: 0.97, eye: true }));
    eye.mesh.position.set(0, topY - eyeSize * 0.3, -1);
    eye.spinSpeed = 0.3;
    eye.u.uOpacity.value = 0;
    tl.span(0.4, 1.7, (k) => {
      eye.u.uEye.value = Math.max(0.001, easeOut(k));
      eye.u.uOpacity.value = clamp01(k * 2);
    });
    tl.at(1.0, () => (st.pulse('flash', 0.5), this.flash(magenta, 0.45), st.shake(0.8), boom(0.9)));
    tl.span(D - 1.0, D - 0.2, (k) => (eye.u.uEye.value = Math.max(0.001, 1 - easeIn(k))));
    // the vortex
    const center = { x: 0, y: lerp(botY, topY, 0.42) };
    const vortex = tl.own(new Glow(4.2 * U, 4.2 * U, 'vortex', purple, magenta));
    vortex.mesh.position.set(center.x, center.y, -0.9);
    tl.span(0.8, 1.8, (k) => (vortex.u.uOpacity.value = k * 0.9));
    tl.span(D - 1.0, D - 0.2, (k) => (vortex.u.uOpacity.value = 0.9 * (1 - k)));
    const ring = tl.own(new Ring(3.2 * U, purple, 666, { inner: 0.82, outer: 0.92, star: 7 }));
    ring.mesh.position.set(center.x, center.y, -0.8);
    ring.spinSpeed = -2.5;
    ring.u.uOpacity.value = 0;
    tl.span(0.8, 1.8, (k) => (ring.u.uOpacity.value = k * 0.5));
    tl.span(D - 1.0, D - 0.2, (k) => (ring.u.uOpacity.value = 0.5 * (1 - k)));
    tl.span(0.8, D - 1.1, (_k, dt) => {
      const n = Math.floor((st.quality === 'full' ? 240 : 110) * dt + Math.random());
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = (1.8 + Math.random() * 1.2) * U;
        st.particles.emit({ x: center.x + Math.cos(a) * rr, y: center.y + Math.sin(a) * rr, life: 1.1, size: 0.12 * U, color: Math.random() < 0.6 ? purple : magenta, drag: 0.2, pull: { x: center.x, y: center.y, strength: 6 * U, swirl: 9 * U } });
      }
    });
    // the soul: the sealed card (or the loser's last monster) is dragged in
    const loserSide = this.side(sr.loser);
    const soulName = sr.sealed ?? [...this.actors.values()].find((x) => x.side === loserSide && x.name)?.name ?? '';
    const art = soulName ? await this.art(soulName) : null;
    if (art) {
      const prof = profileFor(card(soulName), soulName);
      const soulSize = Math.min(1.4 * U, (topY - botY) * 0.36);
      const fig = tl.own(this.figure(art, soulSize, prof, magenta));
      const start = { x: 0, y: loserSide === 'near' ? botY + soulSize * 0.55 : center.y + soulSize * 0.2 };
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
        fig.mesh.scale.setScalar(soulSize * (1 - e * 0.9));
        fig.u.uDark.value = clamp01(k * 2);
        fig.u.uShatter.value = clamp01((k - 0.55) * 2.2);
        const n = Math.floor(80 * dt + Math.random());
        for (let i = 0; i < n; i++) st.particles.emit({ x: fig.mesh.position.x, y: fig.mesh.position.y, burst: 0.6 * U, life: 0.6, size: 0.1 * U, color: magenta, pull: { x: center.x, y: center.y, strength: 8 * U, swirl: 10 * U } });
      });
    }
    // the winner's fighters step out of the way
    tl.span(0, 0.5, (k) => {
      for (const a of this.actors.values()) if (a.side !== loserSide) this.setOpacity(a, 1 - k);
    });
    // whatever was still on the loser's side goes dark and breaks
    tl.span(2.0, 3.4, (k) => {
      for (const a of this.actors.values()) {
        if (a.side !== loserSide) continue;
        if (a.fig) {
          a.fig.u.uDark.value = 1;
          a.fig.u.uShatter.value = easeOut(k);
        }
        if (a.back) a.back.u.uOpacity.value = 1 - k;
      }
    });
    tl.at(4.9, () => (st.pulse('flash', 0.7), this.flash(0xffffff, 0.6), boom(1), st.shake(1)));
    // overkill: the number ticks up, then lands
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const n = Math.round((sr.excess * i) / steps);
      if (i < steps) tl.at(1.2 + i * 0.06, () => this.ui.caption(`OVERKILL  +${n.toLocaleString()}`, 0.08, 'overkill tick'));
    }
    tl.at(1.2 + steps * 0.06, () => (this.ui.caption(`OVERKILL  +${sr.excess.toLocaleString()}`, 1.3, 'overkill land'), st.shake(0.4)));
    tl.at(2.3, () => this.ui.caption(`${sr.loserName} has been sent to the Shadow Realm!`, 3.2, 'shadow'));
    if (sr.sealed) tl.at(4.0, () => this.ui.caption(`${sr.sealed} is sealed away until ${sr.loserName} wins a duel.`, 2.2, 'sealed'));
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

// ---------------------------------------------------------------- types and tables
interface P3 {
  x: number;
  y: number;
  z: number;
}

/** A box to frame: center and half extents. */
interface Box extends P3 {
  w: number;
  h: number;
}

interface Shot {
  pos: Vector3;
  look: Vector3;
}

const REST: Shot = { pos: new Vector3(0, 0, 10), look: new Vector3(0, 0, 0) };
/** HUD room in a duel (fractions of the screen height): Life Points on top, Life Points and the hand below. */
const SAFE_TOP = 0.11;
const SAFE_BOTTOM = 0.2;
const GOLD = 0xffc94a;

/** Big monsters get the cut-in: level 7+, Fusion/Ritual, or an iconic signature at tier 2+. */
function isBig(info: ReturnType<typeof card>, prof: ArtProfile): boolean {
  if (!info || info.kind !== 'monster') return false;
  return (info.level ?? 0) >= 7 || prof.entrance === 'fusion' || prof.entrance === 'ritual' || (SIGNATURE_CARDS.includes(prof.name) && prof.tier >= 2);
}

/** Smooth 1D noise in -1..1 (trembling, clash jitter). */
function noise(t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n: number) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
}

/** board.ts, loaded on demand: the field figures' pose (to land summons on) and the hand-off. */
interface BoardModule {
  fieldPose?: (rect: { left: number; top: number; width: number; height: number }, def: boolean, art: ArtData | null) => { x: number; y: number; size: number; scaleY?: number; rotX?: number } | null;
  markLanded?: (uid: number) => void;
}
let boardMod: Promise<BoardModule | null> | null = null;
function boardModule(): Promise<BoardModule | null> {
  return (boardMod ??= import('./board').then((m) => m as unknown as BoardModule).catch(() => null));
}

// ---------------------------------------------------------------- attack styles
interface HitCtx {
  d: Director;
  st: Stage;
  tl: Timeline;
  U: number;
  /** where the attack leaves the attacker */
  A: P3;
  /** where it lands (the defender, or the clash point) */
  T: P3;
  col: Colors;
  prof: ArtProfile;
  /** when it leaves (after the wind-up's release) */
  s: number;
  travel: number;
  att: Actor | null;
  /** particle budget */
  q: number;
  /** width by tier: 1, 1.6, 2.4 */
  w: number;
}

type StyleFn = (c: HitCtx, power: number) => void;

const rate = (r: number, dt: number) => Math.floor(r * dt + Math.random());
const P3lerp = (a: P3, b: P3, k: number): P3 => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k) });

function bez(a: P3, b: P3, bend: number, k: number): P3 {
  const mx = (a.x + b.x) / 2 + bend;
  const my = (a.y + b.y) / 2 + Math.abs(bend) * 0.3;
  const u = 1 - k;
  return { x: u * u * a.x + 2 * u * k * mx + k * k * b.x, y: u * u * a.y + 2 * u * k * my + k * k * b.y, z: lerp(a.z, b.z, k) };
}

/** The attacker lunges at its target and back. */
function lunge(c: HitCtx, reach: number) {
  const { tl, att, A, T, s, travel } = c;
  if (!att) return;
  const home = { x: att.ox, y: att.oy };
  tl.span(s, s + travel, (k) => {
    const e = easeIn(k);
    att.ox = home.x + (T.x - A.x) * reach * e;
    att.oy = home.y + (T.y - A.y) * reach * e;
    att.oz = (T.z - A.z) * reach * e;
    c.d['place'](att);
  });
  tl.span(s + travel + 0.12, s + travel + 0.45, (k) => {
    const e = 1 - easeOut(k);
    att.ox = home.x + (T.x - A.x) * reach * e;
    att.oy = home.y + (T.y - A.y) * reach * e;
    att.oz = (T.z - A.z) * reach * e;
    c.d['place'](att);
  });
}

/** A volumetric beam: soft outer glow, colored body, white-hot core, spiral ribbons, a muzzle flare. */
function beamFx(c: HitCtx, power: number, o: { main?: number; light?: number; accent?: number; spirals?: number; widthMul?: number; off?: P3 } = {}) {
  const { tl, U, A, T, col, s, travel } = c;
  const main = o.main ?? col.main;
  const light = o.light ?? col.light;
  const accent = o.accent ?? col.accent;
  const off = o.off ?? { x: 0, y: 0, z: 0 };
  const a = { x: A.x + off.x, y: A.y + off.y, z: A.z + off.z };
  const w = 0.11 * U * Math.pow(c.w, 0.85) * power * (o.widthMul ?? 1);
  const layers: [Ribbon, number, number][] = [
    [tl.own(new Ribbon(24, main, 1)), 2.1, 0.32],
    [tl.own(new Ribbon(24, main, 1)), 1.3, 1],
    [tl.own(new Ribbon(24, light, 1)), 0.55, 0.8],
    [tl.own(new Ribbon(24, 0xffffff, 0)), 0.22, 0.85],
  ];
  const nSp = o.spirals ?? (c.w > 1.5 ? 3 : 2);
  const spirals = Array.from({ length: nSp }, (_, i) => tl.own(new Ribbon(48, i % 2 ? accent : light, 1)));
  const end = s + travel + 0.28;
  const pts = [a, T];
  const len = Math.hypot(T.x - a.x, T.y - a.y);
  for (const [r] of layers) r.u.uHead.value = 0;
  for (const r of spirals) r.u.uHead.value = 0;
  tl.span(s, end + 0.2, (k, dt) => {
    const t = (k * (end + 0.2 - s)) / 1;
    const pulse = 1 + 0.12 * Math.sin(t * 50);
    for (const [r, mul, op] of layers) {
      r.set(pts, (x) => w * mul * pulse * (0.75 + 0.25 * Math.min(1, x * 6)));
      r.u.uOpacity.value = op;
    }
    for (let i = 0; i < spirals.length; i++) {
      const ph = (i / spirals.length) * Math.PI * 2 + t * 18;
      const turns = len / (0.9 * U);
      spirals[i].set(
        Array.from({ length: 24 }, (_, j) => {
          const u = j / 23;
          const ang = ph + u * turns * Math.PI * 2;
          const rr = w * 1.1 * (0.6 + 0.4 * Math.sin(u * 9 + t * 6));
          // perpendicular in screen plane: (-dy, dx)
          const dx = (T.x - a.x) / (len || 1);
          const dy = (T.y - a.y) / (len || 1);
          return { x: lerp(a.x, T.x, u) - dy * Math.cos(ang) * rr, y: lerp(a.y, T.y, u) + dx * Math.cos(ang) * rr, z: lerp(a.z, T.z, u) + Math.sin(ang) * rr };
        }),
        w * 0.22,
      );
    }
    void dt;
  });
  tl.span(s, s + travel, (k) => {
    const h = Math.pow(k, 1.6) * 1.05;
    for (const [r] of layers) r.u.uHead.value = h;
    for (const r of spirals) r.u.uHead.value = h;
  });
  tl.span(end, end + 0.2, (k) => {
    for (const [r, , op] of layers) ((r.u.uTail.value = easeIn(k)), (r.u.uOpacity.value = op * (1 - k)));
    for (const r of spirals) ((r.u.uTail.value = easeIn(k)), (r.u.uOpacity.value = 1 - k));
  });
  const ms = 0.9 * U * Math.sqrt(Math.min(2.4, c.w * power));
  const muzzle = tl.own(new Glow(ms, ms, 'flare', main, light));
  muzzle.mesh.position.set(a.x, a.y, a.z + 0.1);
  muzzle.u.uK.value = 0.6;
  tl.span(s, end + 0.2, (k) => (muzzle.u.uOpacity.value = 0.75 * (1 - easeIn(k))));
  tl.at(s, () => zap(travel + 0.3));
  tl.span(s, end, (_k, dt) => {
    for (let i = 0; i < rate(90 * power * c.q, dt); i++) c.st.particles.emit({ x: a.x, y: a.y, z: a.z, burst: 2 * U, life: 0.3, size: 0.1 * U, color: light, drag: 4 });
  });
}

/** A glowing orb flying from A to T along a bend, with a trail. */
function orbFx(c: HitCtx, t0: number, t1: number, bend: number, size: number, color: number, light: number, trail = 140) {
  const { tl, U, A, T, st } = c;
  const g = tl.own(new Glow(size, size, 'flare', color, light));
  g.u.uK.value = 0.3;
  tl.span(t0, t1, (k, dt) => {
    const p = bez(A, T, bend, easeIn(k));
    g.mesh.position.set(p.x, p.y, p.z + 0.2);
    g.u.uOpacity.value = 1;
    for (let j = 0; j < rate(trail * c.q, dt); j++) st.particles.emit({ x: p.x, y: p.y, z: p.z, r: size * 0.12, burst: 0.4 * U, life: 0.3, size: size * 0.18, color: j % 2 ? color : light, drag: 4 });
  });
  tl.at(t1, () => (g.u.uOpacity.value = 0));
}

const STYLES: Record<AttackStyle, StyleFn> = {
  beam(c, power) {
    beamFx(c, power);
  },
  barrage(c, power) {
    const { U, col, prof, s, travel } = c;
    const n = Math.max(1, Math.min(6, Math.round(prof.count * power)));
    const size = (n === 1 ? 1.1 : 0.62) * U * Math.sqrt(c.w) * Math.max(0.6, power);
    for (let i = 0; i < n; i++) {
      const delay = (i / n) * travel * 0.45;
      const bend = (prof.spread - 0.5 + (i - (n - 1) / 2) * 0.6) * 1.6 * U * (0.5 + prof.arc);
      orbFx(c, s + delay, s + travel, bend, size, i % 2 ? col.accent : col.main, col.light);
    }
    c.tl.at(s, () => chime(prof.hue * 0.5 + 0.5));
  },
  slash(c, power) {
    const { st, tl, U, T, col, prof, s, travel } = c;
    lunge(c, 0.7 * power);
    const n = Math.max(1, Math.min(4, Math.round(prof.count * 0.6 * power)));
    for (let i = 0; i < n; i++) {
      const rib = tl.own(new Ribbon(24, i % 2 ? col.light : col.main, 0));
      const glow = tl.own(new Ribbon(24, col.main, 1));
      const ang = prof.spin * Math.PI + (i * Math.PI) / n;
      const R = 1.0 * U;
      const pts = Array.from({ length: 11 }, (_, j) => {
        const a = ang - 1 + (j / 10) * 2;
        return { x: T.x + Math.cos(a) * R - Math.cos(ang) * R * 0.6, y: T.y + Math.sin(a) * R - Math.sin(ang) * R * 0.6, z: T.z + 0.5 };
      });
      rib.set(pts, (k) => 0.12 * U * c.w * Math.sin(k * Math.PI));
      glow.set(pts, (k) => 0.32 * U * c.w * Math.sin(k * Math.PI));
      for (const r of [rib, glow]) r.u.uHead.value = 0;
      glow.u.uOpacity.value = 0.6;
      const t0 = s + travel - 0.06 + i * 0.07;
      tl.span(t0, t0 + 0.1, (k) => (rib.u.uHead.value = glow.u.uHead.value = k * 1.1));
      tl.span(t0 + 0.12, t0 + 0.4, (k) => (rib.u.uTail.value = glow.u.uTail.value = easeIn(k)));
      tl.at(t0, () => {
        whoosh(0.15, 3000, 800, 0.2);
        st.particles.emit({ x: T.x, y: T.y, z: T.z + 0.4, burst: 3 * U, life: 0.3, size: 0.07 * U, color: col.light, drag: 3 }, Math.round(24 * c.q));
      });
    }
  },
  claw(c, power) {
    const { st, tl, U, T, col, s, travel } = c;
    lunge(c, 0.62 * power);
    for (let i = 0; i < 3; i++) {
      const rib = tl.own(new Ribbon(14, i === 1 ? col.light : col.main, 0));
      const glow = tl.own(new Ribbon(14, 0xff3a3a, 1));
      const dx = (i - 1) * 0.3 * U;
      const pts = [
        { x: T.x - 0.7 * U + dx, y: T.y + 0.8 * U, z: T.z + 0.5 },
        { x: T.x + 0.55 * U + dx, y: T.y - 0.7 * U, z: T.z + 0.5 },
      ];
      rib.set(pts, (k) => 0.1 * U * c.w * Math.sin(k * Math.PI));
      glow.set(pts, (k) => 0.26 * U * c.w * Math.sin(k * Math.PI));
      glow.u.uOpacity.value = 0.55;
      for (const r of [rib, glow]) r.u.uHead.value = 0;
      const t0 = s + travel - 0.08 + i * 0.04;
      tl.span(t0, t0 + 0.09, (k) => (rib.u.uHead.value = glow.u.uHead.value = k * 1.1));
      tl.span(t0 + 0.15, t0 + 0.45, (k) => (rib.u.uOpacity.value = 1 - k, (glow.u.uOpacity.value = 0.55 * (1 - k))));
    }
    tl.at(s + travel - 0.05, () => (whoosh(0.2, 2500, 600, 0.25), st.particles.emit({ x: T.x, y: T.y, z: T.z + 0.4, burst: 2.5 * U, life: 0.4, size: 0.08 * U, color: 0xff5050 }, Math.round(30 * c.q))));
  },
  lightning(c, power) {
    const { st, tl, U, T, col, prof, s, travel } = c;
    const n = Math.max(1, Math.min(6, Math.round((1 + prof.count * 0.6) * power)));
    for (let i = 0; i < n; i++) {
      const core = tl.own(new Ribbon(18, 0xffffff, 0));
      const glow = tl.own(new Ribbon(18, i % 2 ? col.light : col.main, 1));
      const top = { x: T.x + (Math.random() - 0.5) * 1.8 * U, y: T.y + 3.4 * U };
      const t0 = s + travel * 0.3 + (i / n) * travel * 0.8;
      let seed = Math.random() * 100;
      const reroll = () => {
        seed += 1.7;
        const pts = Array.from({ length: 10 }, (_, j) => {
          const k = j / 9;
          const jit = j === 0 || j === 9 ? 0 : noise(seed + j * 3.1) * 0.35 * U;
          return { x: lerp(top.x, T.x, k) + jit, y: lerp(top.y, T.y, k), z: T.z + 0.4 };
        });
        core.set(pts, (k) => 0.045 * U * c.w * (1.4 - k * 0.6));
        glow.set(pts, (k) => 0.2 * U * c.w * (1.4 - k * 0.6));
      };
      reroll();
      core.u.uOpacity.value = glow.u.uOpacity.value = 0;
      let acc = 0;
      tl.span(t0, t0 + 0.3, (k, dt) => {
        acc += dt;
        if (acc > 0.045) ((acc = 0), reroll());
        const o = k < 0.8 ? 1 - 0.4 * Math.max(0, Math.sin(k * 60)) : 1 - (k - 0.8) / 0.2;
        core.u.uOpacity.value = o;
        glow.u.uOpacity.value = o * 0.8;
      });
      tl.at(t0, () => {
        zap(0.25);
        st.shake(0.25);
        c.d['flash'](col.light, 0.18);
        st.particles.emit({ x: T.x, y: T.y, z: T.z + 0.4, burst: 3 * U, life: 0.3, size: 0.08 * U, color: col.light }, Math.round(25 * c.q));
      });
    }
  },
  flame(c, power) {
    const { st, tl, U, A, T, col, prof, s, travel } = c;
    const bend = (prof.arc - 0.5) * 2 * U;
    tl.at(s, () => whoosh(travel + 0.2, 200, 900, 0.3));
    orbFx(c, s, s + travel, bend, 1.1 * U * Math.sqrt(c.w) * power, 0xff6a1a, 0xffe08a, 60);
    tl.span(s, s + travel, (k, dt) => {
      const p = bez(A, T, bend, easeIn(k));
      for (let j = 0; j < rate(240 * power * c.q, dt); j++) st.particles.emit({ x: p.x, y: p.y, z: p.z, r: 0.15 * U * power, vy: 0.8 * U, burst: 0.4 * U, life: 0.45, size: 0.26 * U * power, size1: 0.05 * U, color: j % 3 === 0 ? 0xffe08a : j % 3 === 1 ? 0xff6a1a : col.main, drag: 2 });
    });
    tl.at(s + travel, () => st.particles.emit({ x: T.x, y: T.y, z: T.z + 0.3, burst: 5 * U, vy: 1.5 * U, life: 1, size: 0.25 * U, size1: 0.02, color: 0xff7a2a, drag: 2.5 }, Math.round(110 * power * c.q)));
  },
  torrent(c, power) {
    const { st, tl, U, A, T, col, s, travel } = c;
    beamFx(c, power * 0.8, { main: 0x2a8aff, light: 0xbfefff, accent: col.main, spirals: 2 });
    tl.at(s, () => whoosh(travel + 0.3, 300, 700, 0.3));
    tl.span(s, s + travel + 0.15, (_k, dt) => {
      for (let j = 0; j < rate(200 * power * c.q, dt); j++) {
        const p = P3lerp(A, T, Math.random());
        st.particles.emit({ x: p.x, y: p.y, z: p.z, r: 0.12 * U, vy: 0.6 * U, burst: 0.6 * U, gravity: 3 * U, life: 0.4, size: 0.12 * U, color: j % 2 ? 0x8fe0ff : col.main, drag: 1 });
      }
    });
    tl.at(s + travel, () => st.particles.emit({ x: T.x, y: T.y, z: T.z, vy: 3 * U, burst: 3 * U, gravity: 8 * U, life: 0.8, size: 0.12 * U, color: 0xbfefff, drag: 0.5 }, Math.round(90 * power * c.q)));
  },
  shadow(c, power) {
    const { tl, U, T, col, prof, s, travel, st } = c;
    const n = Math.max(2, Math.min(6, Math.round((2 + prof.count) * power)));
    for (let i = 0; i < n; i++) {
      const rib = tl.own(new Ribbon(22, i % 2 ? mix(col.main, 0x9a3cff, 0.5) : 0xff4fd8, 1));
      const x0 = T.x + (i - (n - 1) / 2) * 0.4 * U;
      const ph = Math.random() * 6;
      tl.span(s - 0.1, s + travel + 0.45, (k) => {
        const reach = easeOut(clamp01(k * 1.6));
        rib.set(
          Array.from({ length: 10 }, (_, j) => {
            const q = j / 9;
            return { x: lerp(x0, T.x, q * reach) + Math.sin(q * 6 + ph + k * 10) * 0.22 * U * (1 - q), y: lerp(T.y - 1.9 * U, T.y, q * reach), z: T.z + 0.4 };
          }),
          (q) => 0.2 * U * c.w * (1 - q * 0.8),
        );
        rib.u.uOpacity.value = k > 0.8 ? (1 - k) * 5 : 1;
      });
    }
    tl.at(s, () => (whoosh(0.8, 120, 500, 0.3), drone(1.2)));
    tl.span(s - 0.1, s + travel + 0.4, (_k, dt) => {
      for (let j = 0; j < rate(60 * power * c.q, dt); j++) st.particles.emit({ x: T.x + (Math.random() - 0.5) * 1.6 * U, y: T.y - 1 * U, z: T.z, vy: 1.5 * U, life: 0.8, size: 0.22 * U, color: 0x6a1aaa, drag: 1 });
    });
  },
  quake(c, power) {
    const { st, tl, U, A, T, col, s, travel } = c;
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const k0 = i / (steps - 1);
      const p = P3lerp(A, T, k0);
      const ring = tl.own(new Glow(2.6 * U, 2.6 * U, 'shock', mix(col.main, 0xc08a4a, 0.5), 0xffe0b0));
      ring.mesh.position.set(p.x, p.y - 0.6 * U, p.z);
      ring.mesh.rotation.x = -1.2;
      const t0 = s + (i / steps) * travel;
      tl.span(t0, t0 + 0.4, (k) => ((ring.u.uK.value = easeOut(k)), (ring.u.uOpacity.value = 1 - k * 0.3)));
      tl.at(t0, () => (st.shake(0.3 * power), boom(0.25)));
    }
    tl.at(s + travel, () => st.particles.emit({ x: T.x, y: T.y - 0.6 * U, z: T.z, r: 0.5 * U, vy: 5 * U, burst: 2 * U, gravity: 12 * U, life: 1, size: 0.18 * U, color: 0x9a7a5a, drag: 0.3 }, Math.round(70 * power * c.q)));
  },
  swarm(c, power) {
    const { st, tl, U, A, T, col, s, travel } = c;
    tl.at(s, () => whoosh(travel + 0.3, 2000, 4000, 0.12));
    tl.span(s - 0.1, s + travel * 0.7, (_k, dt) => {
      for (let j = 0; j < rate(220 * power * c.q, dt); j++) st.particles.emit({ x: A.x, y: A.y, z: A.z, r: 0.3 * U, burst: 1.5 * U, life: travel + 0.4, size: 0.08 * U, color: j % 2 ? col.main : col.accent, drag: 0.5, pull: { x: T.x, y: T.y, strength: 16 * U, swirl: (Math.random() - 0.5) * 18 * U } });
    });
  },
  gale(c, power) {
    const { st, tl, U, A, T, col, s, travel } = c;
    for (let i = 0; i < 3; i++) {
      const rib = tl.own(new Ribbon(40, i === 1 ? col.light : col.main, 1));
      tl.span(s - 0.05, s + travel + 0.3, (k) => {
        const head = clamp01(k * 1.4);
        rib.set(
          Array.from({ length: 24 }, (_, j) => {
            const q = (j / 23) * head;
            const ang = q * 14 + (i * Math.PI * 2) / 3 + k * 8;
            const rr = 0.4 * U * (1 - q * 0.5) * power;
            const p = P3lerp(A, T, q);
            return { x: p.x + Math.cos(ang) * rr, y: p.y + Math.sin(ang) * rr * 0.5, z: p.z + Math.sin(ang) * rr * 0.5 };
          }),
          (q) => 0.1 * U * c.w * (0.4 + q),
        );
        rib.u.uOpacity.value = k > 0.8 ? (1 - k) * 5 : 1;
      });
    }
    tl.at(s, () => whoosh(travel + 0.4, 500, 3500, 0.3));
    tl.span(s, s + travel, (k, dt) => {
      const p = P3lerp(A, T, k);
      for (let j = 0; j < rate(60 * power * c.q, dt); j++) st.particles.emit({ x: p.x, y: p.y, z: p.z, burst: 1.2 * U, life: 0.7, size: 0.08 * U, color: 0xffffff, drag: 1, gravity: -0.5 * U });
    });
  },
  ram(c, power) {
    const { st, tl, U, A, T, col, s, travel } = c;
    lunge(c, 0.88 * power);
    tl.span(s, s + travel, (k, dt) => {
      const p = P3lerp(A, T, easeIn(k) * 0.88);
      for (let j = 0; j < rate(150 * power * c.q, dt); j++) st.particles.emit({ x: p.x, y: p.y, z: p.z, r: 0.4 * U, life: 0.35, size: 0.12 * U, color: j % 2 ? col.main : col.light, drag: 3 });
    });
    tl.span(s, s + travel, (k) => (c.d['front'].u.uSpeed.value = Math.max(c.d['front'].u.uSpeed.value, 0.6 * easeIn(k))));
    tl.at(s, () => whoosh(travel, 300, 2500, 0.3));
  },
};

// ---------------------------------------------------------------- signature attacks
interface WindupCtx {
  d: Director;
  st: Stage;
  tl: Timeline;
  U: number;
  at: Actor;
  M: P3;
  col: Colors;
  t0: number;
  t1: number;
}
interface SigAttack {
  style?: AttackStyle;
  /** beam/projectile width multiplier */
  width?: number;
  /** wind-up flare size multiplier */
  charge?: number;
  windup?: (w: WindupCtx) => void;
  travel?: (c: HitCtx) => void;
}

const SIG_ATTACKS: Record<string, SigAttack> = {
  'Dark Magician': {
    style: 'beam',
    width: 1.1,
    charge: 1.3,
    windup({ tl, U, M, t0, t1 }) {
      // the staff draws a pentagram of dark light
      const ring = tl.own(new Ring(2.2 * U, 0xb070ff, 5555, { inner: 0.78, outer: 0.92, star: 5 }));
      ring.mesh.position.set(M.x, M.y, M.z + 0.05);
      ring.spinSpeed = 3;
      ring.u.uOpacity.value = 0;
      tl.span(t0, t1, (k) => ((ring.u.uOpacity.value = easeOut(k)), ring.mesh.scale.setScalar(lerp(0.4, 1, easeOut(k)))));
      tl.span(t1, t1 + 0.6, (k) => (ring.u.uOpacity.value = 1 - k));
    },
    travel(c) {
      beamFx(c, 0.6, { main: 0x2a0a5a, light: 0xff4fd8, accent: 0xb070ff, spirals: 3, widthMul: 1.6 });
    },
  },
  'Blue-Eyes White Dragon': {
    style: 'beam',
    width: 1.25,
    charge: 1.6,
    windup({ tl, st, U, M, t0, t1 }) {
      tl.span(t0, t1, (k, dt) => {
        if (Math.random() < dt * 10 * k) st.particles.emit({ x: M.x, y: M.y, z: M.z, burst: 3 * U, life: 0.25, size: 0.06 * U, color: 0xffffff, drag: 4 }, 12);
      });
    },
    travel(c) {
      c.tl.at(c.s, () => (c.st.pulse('flash', 0.25), c.d['flash'](0x9fdcff, 0.15), c.st.shake(0.5)));
    },
  },
  'Red-Eyes Black Dragon': {
    style: 'flame',
    width: 1.5,
    charge: 1.3,
    travel(c) {
      c.tl.at(c.s + c.travel, () => {
        c.st.particles.emit({ x: c.T.x, y: c.T.y, z: c.T.z + 0.3, burst: 7 * c.U, vy: 2 * c.U, life: 1.2, size: 0.3 * c.U, size1: 0.05 * c.U, color: 0xff3a1a, drag: 2.2 }, Math.round(120 * c.q));
        c.d['flash'](0xff6a1a, 0.4);
      });
    },
  },
  'Summoned Skull': {
    style: 'lightning',
    width: 1.3,
    windup({ tl, U, M, t0, t1, at }) {
      // an electric field crackles around the fiend
      const ring = tl.own(new Ring(at.size * 1.4, 0xfff27a, 777, { inner: 0.86, outer: 0.93 }));
      ring.mesh.position.set(M.x, at.y, M.z - 0.2);
      ring.spinSpeed = 5;
      ring.u.uOpacity.value = 0;
      tl.span(t0, t1, (k) => (ring.u.uOpacity.value = 0.8 * Math.abs(Math.sin(k * 23)) * easeOut(k)));
      tl.span(t1, t1 + 0.5, (k) => (ring.u.uOpacity.value = 0.8 * (1 - k)));
      void U;
    },
  },
  Kuriboh: {
    style: 'ram',
    travel(c) {
      // kuri kuri: a hop and a shower of sparkles
      for (let i = 0; i < 6; i++) {
        const g = c.tl.own(new Glow(0.6 * c.U, 0.6 * c.U, 'star', 0xffe08a, 0xffffff));
        const a = (i / 6) * Math.PI * 2;
        c.tl.span(c.s + c.travel, c.s + c.travel + 0.5, (k) => {
          g.mesh.position.set(c.T.x + Math.cos(a) * c.U * easeOut(k), c.T.y + Math.sin(a) * c.U * easeOut(k), c.T.z + 0.5);
          g.u.uOpacity.value = 1 - k;
        });
      }
      c.tl.at(c.s + c.travel, () => chime(0.95));
    },
  },
};

// ---------------------------------------------------------------- Spell & Trap presets
interface PresetCtx {
  d: Director;
  st: Stage;
  tl: Timeline;
  U: number;
  t0: number;
  t1: number;
  panel: CardPanel;
  cy: number;
  side: 'near' | 'far';
  color: number;
  accent: number;
  /** y of the opponent's / own side of the field (resting camera) */
  opp: number;
  own: number;
}
interface Preset {
  /** extra seconds the preset adds */
  dur: number;
  play(c: PresetCtx): void;
}

/** Lightning from the sky onto a point. */
function bolt(c: PresetCtx, x: number, y: number, t: number, color: number) {
  const { tl, U, st } = c;
  const core = tl.own(new Ribbon(14, 0xffffff, 0));
  const glow = tl.own(new Ribbon(14, color, 1));
  let seed = Math.random() * 99;
  const reroll = () => {
    seed += 2.3;
    const pts = Array.from({ length: 9 }, (_, j) => ({ x: x + (j === 0 || j === 8 ? 0 : noise(seed + j * 2.7) * 0.35 * U), y: lerp(y + 4.5 * U, y, j / 8), z: 0.6 }));
    core.set(pts, 0.07 * U);
    glow.set(pts, 0.3 * U);
  };
  reroll();
  core.u.uOpacity.value = glow.u.uOpacity.value = 0;
  let acc = 0;
  tl.span(t, t + 0.3, (k, dt) => {
    acc += dt;
    if (acc > 0.05) ((acc = 0), reroll());
    core.u.uOpacity.value = glow.u.uOpacity.value = k < 0.75 ? 1 : (1 - k) / 0.25;
  });
  const ring = tl.own(new Glow(2.4 * U, 2.4 * U, 'shock', color, 0xffffff));
  ring.mesh.position.set(x, y, 0.3);
  ring.mesh.rotation.x = -1.1;
  tl.span(t, t + 0.4, (k) => ((ring.u.uK.value = easeOut(k)), (ring.u.uOpacity.value = 1 - k * 0.3)));
  tl.at(t, () => {
    zap(0.3);
    st.shake(0.45);
    st.pulse('chroma', 0.5);
    c.d['flash'](color, 0.3);
    st.particles.emit({ x, y, z: 0.4, burst: 3.5 * U, vy: 1 * U, gravity: 6 * U, life: 0.6, size: 0.09 * U, color: 0xffffff }, Math.round(30 * c.d['q']));
  });
}

const SPELL_PRESETS: Record<string, Preset> = {
  'Mirror Force': {
    dur: 0.7,
    play(c) {
      const { tl, U, t0, own, opp } = c;
      const dome = tl.own(new Glow(3.6 * U, 3.6 * U, 'dome', 0x7affff, 0xffffff));
      dome.mesh.position.set(0, own * 0.55, 1.2);
      tl.span(t0, t0 + 0.3, (k) => ((dome.u.uOpacity.value = easeOut(k)), dome.mesh.scale.setScalar(lerp(0.3, 1, backOut(k)))));
      // incoming attacks strike the barrier and are thrown back as a spray of rays
      const hitT = t0 + 0.35;
      tl.span(t0, hitT, (k) => (dome.u.uK.value = 0));
      tl.span(hitT, hitT + 0.5, (k) => (dome.u.uK.value = k * 1.1));
      for (let i = 0; i < 5; i++) {
        const r = tl.own(new Ribbon(12, i % 2 ? 0xffffff : 0x7affff, 1));
        const ang = -0.9 + (i / 4) * 1.8;
        const from = { x: 0, y: own * 0.55 + Math.sign(opp) * 1.6 * U, z: 1.3 };
        const to = { x: Math.sin(ang) * 3 * U, y: opp * 1.3, z: 0.3 };
        r.u.uHead.value = 0;
        r.set([from, to], 0.14 * U);
        tl.span(hitT, hitT + 0.22, (k) => (r.u.uHead.value = easeOut(k) * 1.05));
        tl.span(hitT + 0.25, c.t1, (k) => (r.u.uTail.value = easeIn(k)));
      }
      tl.at(hitT, () => (c.st.shake(0.7), c.st.hitStop(0.07), c.st.pulse('flash', 0.5), boom(0.6), chime(0.95)));
      tl.span(c.t1 - 0.3, c.t1, (k) => (dome.u.uOpacity.value = 1 - k));
    },
  },
  Raigeki: {
    dur: 0.7,
    play(c) {
      for (let i = 0; i < 5; i++) bolt(c, (i - 2) * 0.55 * c.U + (Math.random() - 0.5) * 0.2 * c.U, c.opp, c.t0 + i * 0.1, 0xfff27a);
    },
  },
  'Dark Hole': {
    dur: 0.8,
    play(c) {
      const { tl, U, st, t0, t1 } = c;
      const v = tl.own(new Glow(6 * U, 6 * U, 'vortex', 0x6a2aff, 0xff4fd8));
      v.mesh.position.set(0, c.cy, -1.2);
      tl.span(t0 - 0.2, t0 + 0.3, (k) => (v.u.uOpacity.value = easeOut(k)));
      tl.span(t1 - 0.35, t1, (k) => (v.u.uOpacity.value = 1 - k));
      tl.span(t0, t1 - 0.3, (_k, dt) => {
        for (let i = 0; i < rate(200 * c.d['q'], dt); i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = (2 + Math.random() * 1.5) * U;
          st.particles.emit({ x: Math.cos(a) * rr, y: c.cy + Math.sin(a) * rr, life: 0.9, size: 0.1 * U, color: Math.random() < 0.5 ? 0x9a3cff : 0xff4fd8, drag: 0.2, pull: { x: 0, y: c.cy, strength: 9 * U, swirl: 10 * U } });
        }
        if (Math.random() < dt * 8) st.shake(0.35);
      });
      tl.at(t0, () => (drone(1.2), boom(0.6)));
      tl.at(t1 - 0.3, () => (st.pulse('flash', 0.5), st.pulse('chroma', 0.7), boom(0.8)));
    },
  },
  'Pot of Greed': {
    dur: 0.6,
    play(c) {
      const { tl, U, t0, own } = c;
      for (let i = 0; i < 8; i++) {
        const g = tl.own(new Glow(0.7 * U, 0.7 * U, 'star', 0xffd75a, 0xffffff));
        const a = (i / 8) * Math.PI * 2 + 0.3;
        tl.span(t0 + i * 0.03, t0 + 0.6, (k) => {
          g.mesh.position.set(Math.cos(a) * 1.4 * U * easeOut(k), c.cy + Math.sin(a) * 1.6 * U * easeOut(k), 1);
          g.u.uOpacity.value = Math.sin(k * Math.PI);
        });
      }
      // draw two: two cards fly out to the hand
      for (let i = 0; i < 2; i++) {
        const p = tl.own(new CardPanel(cardBack(), 0.9 * U, 0xffd75a));
        p.u.uOpacity.value = 0;
        const t = t0 + 0.2 + i * 0.14;
        tl.span(t, t + 0.45, (k) => {
          const e = easeIn(k);
          p.mesh.position.set(lerp(0, (i - 0.5) * 1.2 * U, e), lerp(c.cy, own * 1.4, e), lerp(1, 2, e));
          p.mesh.rotation.z = (i - 0.5) * 0.5 * e;
          p.u.uOpacity.value = k < 0.8 ? 1 : (1 - k) * 5;
        });
        tl.at(t, () => whoosh(0.25, 800, 2400, 0.15));
      }
      tl.at(t0, () => (chime(0.8), chime(0.95)));
    },
  },
  'Monster Reborn': {
    dur: 0.7,
    play(c) {
      const { tl, U, t0, t1 } = c;
      const ankh = tl.own(new Glow(2 * U, 2.6 * U, 'ankh', 0xffe9a0, 0xffffff));
      tl.span(t0, t0 + 0.6, (k) => {
        ankh.mesh.position.set(0, lerp(c.own * 1.2, c.cy + 0.2 * U, easeOut(k)), 1.4);
        ankh.u.uOpacity.value = easeOut(k);
      });
      tl.span(t1 - 0.3, t1, (k) => (ankh.u.uOpacity.value = 1 - k));
      c.d['shafts'](tl, { x: 0, y: c.own * 1.2, z: 1 }, 5 * U, 0xffe9a0, t0, t1, 1, 0.9);
      tl.span(t0, t1, (_k, dt) => {
        for (let i = 0; i < rate(80 * c.d['q'], dt); i++) c.st.particles.emit({ x: (Math.random() - 0.5) * 1.6 * U, y: c.own, z: 1, vy: 3 * U, life: 0.9, size: 0.08 * U, color: 0xffe9a0, drag: 0.4 });
      });
      tl.at(t0 + 0.6, () => (chime(0.9), c.st.pulse('flash', 0.4)));
    },
  },
  'Swords of Revealing Light': {
    dur: 0.8,
    play(c) {
      const { tl, U, t0, t1, st } = c;
      for (let i = 0; i < 3; i++) {
        const g = tl.own(new Glow(0.9 * U, 2.2 * U, 'sword', 0xfff1a8, 0xffffff));
        const x = (i - 1) * 1.05 * U;
        const t = t0 + i * 0.12;
        const yEnd = c.opp * 0.95;
        tl.span(t, t + 0.25, (k) => {
          g.mesh.position.set(x, lerp(yEnd + 4 * U, yEnd, easeIn(k)), 0.8);
          g.u.uOpacity.value = 1;
        });
        tl.at(t + 0.25, () => {
          st.shake(0.4);
          boom(0.35);
          c.d['flash'](0xfff1a8, 0.25);
          st.particles.emit({ x, y: yEnd - 1 * U, z: 0.8, burst: 2.5 * U, vy: 1.5 * U, gravity: 6 * U, life: 0.6, size: 0.08 * U, color: 0xffffff }, Math.round(30 * c.d['q']));
        });
        tl.span(t1 - 0.3, t1, (k) => (g.u.uOpacity.value = 1 - k));
      }
    },
  },
  Polymerization: {
    dur: 0.7,
    play(c) {
      const { tl, U, t0, st } = c;
      const cols = [0xff6a3a, 0x3a9aff];
      const orbs = cols.map((col) => tl.own(new Glow(1.2 * U, 1.2 * U, 'flare', col, 0xffffff)));
      tl.span(t0, t0 + 0.55, (k, dt) => {
        orbs.forEach((g, i) => {
          const a = i * Math.PI + k * 10;
          const r = (1 - easeIn(k)) * 1.5 * U;
          g.mesh.position.set(Math.cos(a) * r, c.cy + Math.sin(a) * r * 0.7, 1.2);
          g.u.uOpacity.value = 1;
          for (let j = 0; j < rate(60 * c.d['q'], dt); j++) st.particles.emit({ x: g.mesh.position.x, y: g.mesh.position.y, z: 1.2, burst: 0.3 * U, life: 0.4, size: 0.14 * U, color: cols[i], drag: 3 });
        });
      });
      const star = tl.own(new Ring(3.4 * U, 0xffd75a, 6006, { inner: 0.7, outer: 0.9, star: 6 }));
      star.mesh.position.set(0, c.cy, 1.1);
      star.spinSpeed = 2;
      star.u.uOpacity.value = 0;
      tl.at(t0 + 0.55, () => {
        for (const g of orbs) g.u.uOpacity.value = 0;
        st.pulse('flash', 0.6);
        c.d['flash'](0xffd75a, 0.4);
        boom(0.5);
        st.particles.emit({ x: 0, y: c.cy, z: 1.2, burst: 5 * U, life: 0.8, size: 0.12 * U, color: 0xffd75a }, Math.round(90 * c.d['q']));
      });
      tl.span(t0 + 0.5, c.t1, (k) => ((star.u.uOpacity.value = Math.sin(k * Math.PI)), star.mesh.scale.setScalar(lerp(0.5, 1.1, easeOut(k)))));
    },
  },
};

export type { Quality };
export const ATTACK_STYLES = Object.keys(STYLES) as AttackStyle[];
/** Spells and traps with their own preset, and monsters with a signature attack. */
export const SPELL_PRESET_CARDS = Object.keys(SPELL_PRESETS);
export const SIGNATURE_ATTACK_CARDS = Object.keys(SIG_ATTACKS);
export { css };
