// The 3D art engine's director and cinematics (loaded on demand, ahead of the
// duel). The director plays cues one at a time; battle figures stay on stage
// between the attack, the hit and the destruction (an attack declared on its own
// holds its pose for the blow that follows a beat later, while the computer is
// already free to go on; a shatter starts in the hit's recoil), then fade when
// nothing more is coming. The duel is told it may go on as soon as the dim is
// nearly gone; leftover particles finish without holding anything up.
import { DataTexture, PerspectiveCamera, RGBAFormat, Vector2, Vector3, type Mesh, type PlaneGeometry } from 'three';
import { card } from '../eds/db';
import type { Pid } from '../eds/types';
import { cueUids, type CardRef, type Cue, type SummonHow, type Target } from './cues';
import { artFor, cardBack, type ArtData } from './depth';
import { ELEMENT_COLORS, profileFor, rand, SIGNATURE_CARDS, type ArtProfile, type AttackStyle } from './profile';
import { cueSting } from './cueSound';
import { boom, chime, drone, swell, whoosh, zap } from './sfx';
import { backOut, BASE_FOV, CardPanel, rimColor, clamp01, ContactShadow, Crack, CutIn, easeIn, easeInOut, easeOut, Figure, Glow, lerp, Ribbon, Ring, setRgb, Shards, Stage, Veil, type Emit, type Fx, type GlowMode, type Quality } from './stage';
import { characterName, classify, effectText, FX_FAMILIES, TERRAINS, type FxClass, type FxFamily, type Terrain } from './families';
import { SPELL_COLOR as SPELL, TRAP_COLOR as TRAP } from './profile';
import { FIN, finishGlow, finishId, finishOf, finishPalette } from './finish';
import { fullArtCard, goldArt, millenniumEyeCanvas } from './fullArt';

/** DOM text and flashes drawn over the canvas (crisper than text in WebGL). */
export interface Ui {
  banner(o: { title: string; sub?: string; color: number; big?: boolean; dur: number; pos?: 'top' | 'mid' | 'bottom'; /** the card's finish ('UR', 'GL', 'RO', 'OF'): its plate shows it */ finish?: string }): void;
  number(o: { text: string; color: number; side: 'top' | 'bottom'; size: number }): void;
  flash(color: number, strength: number): void;
  caption(text: string, dur: number, cls?: string): void;
  /** removes every banner, caption and number still showing (a new chain, or leaving) */
  clear?(): void;
}

/** The Life Points plate on one side of the screen (Classic and Touch both show one per duelist). */
function lpPlate(side: 'top' | 'bottom'): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const mid = window.innerHeight / 2;
  for (const n of document.querySelectorAll<HTMLElement>('.lp-count')) {
    const el = n.closest<HTMLElement>('.lp, .tlp') ?? n;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && (r.top + r.height / 2 < mid) === (side === 'top')) return el;
  }
  return null;
}

/** Plays a CSS beat on a duelist's Life Points plate ('art-lp-shake', 'art-lp-shatter'); returns where it is. */
export function lpBeat(side: 'top' | 'bottom', cls: string, ms = 400): DOMRect | null {
  const el = lpPlate(side);
  if (!el) return null;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
  return el.getBoundingClientRect();
}

/** Summed screen flash (WebGL flash layer + post flash) never goes past this: the subject stays readable. */
const FLASH_CAP = 0.38;

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
  /**
   * From this moment (cinematic seconds) the next cinematic of the same chain may
   * start while this one plays out underneath (a blow still recoiling as the
   * shatter begins). null: the next one waits for the end.
   */
  handoff: number | null = null;
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
  /** stands on its own card (struck by a Spell/Trap), facing the camera */
  field?: boolean;
}

type Role = 'att' | 'def';

/** A Millennium card's colors: its summon, its blows and its trail are all gold, whatever the monster. */
const MILL_COLS: Colors = { main: 0xe09a18, accent: 0xffc23a, light: 0xffd36a };

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
export function flowRate(cue: Cue, next: Queued | undefined, batch: number, oppBacklog = false): number {
  const r = chainRate(cue, next, batch);
  // the opponent's turn with more queued behind: it keeps moving
  return oppBacklog ? Math.max(OPP_BACKLOG_RATE, r) : r;
}

/** An opponent's cue with more cues queued behind it plays at least this fast. */
export const OPP_BACKLOG_RATE = 1.35;
/** Under Cinematics: All, the opponent's quick cues (spells, sets, skills, damage...) beyond this many queued are dropped. */
export const QUEUE_KEEP = 3;

/** Whose cue it is (null: it follows whatever caused it). */
export function cueOwner(c: Cue): Pid | null {
  switch (c.kind) {
    case 'summon':
    case 'set':
    case 'flip':
    case 'activate':
    case 'target':
      return c.card.controller;
    case 'skill':
      return c.player;
    case 'attack':
      return c.attacker.controller;
    case 'hit':
      return c.attacker?.controller ?? (c.defender === 0 ? 1 : 0);
    default:
      return null;
  }
}

function chainRate(cue: Cue, next: Queued | undefined, batch: number): number {
  const same = next && next.batch === batch ? next.cue.kind : null;
  if (cue.kind === 'attack') return same === 'hit' ? 1.6 : 1.25;
  if (cue.kind === 'hit') return same === 'destroy' ? 1.4 : 1.25;
  if (cue.kind === 'destroy') return same === 'damage' ? 1.6 : same ? 1.4 : 1.2;
  if (cue.kind === 'damage') return same ? 1.4 : 1.2;
  return 1;
}

/** Battle figures linger this long (s at 1x) after the last cinematic, then fade over FADE. */
const LINGER = 0.3;
const LINGER_AFTER_SHATTER = 0.1;
const FADE = 0.25;
const FAST_FADE = 0.15;
/** With a choice for the player waiting, the tail is short: this linger, then FAST_FADE. */
const HURRY_LINGER = 0.1;
/** Particles still drifting once the stage reported idle get at most this long (s; none when hurried). */
const PARTICLE_TAIL = 0.25;
/**
 * After an attack declaration with nothing queued behind it, the fighters hold
 * their pose this long (s at 1x, at least HOLD_MIN real seconds) waiting for the
 * blow, which usually arrives a beat later in its own chain (after the response
 * window). The computer is released at once, so the hold costs it nothing.
 */
const HOLD = 1.1;
const HOLD_MIN = 0.6;
/** Report the stage idle once the dim is under this (what is left is particles fading on their own). */
const IDLE_DIM = 0.1;

export class Director {
  stage: Stage;
  private queue: Queued[] = [];
  private current: Timeline | null = null;
  /** the chain (event batch) the current cinematic belongs to; -1 when none */
  private curBatch = -1;
  /** the chain the last cinematic belonged to (a new one clears the captions) */
  private lastBatch = -1;
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
  /** the stage is done for the duel (the dim is nearly gone): the board may show everything again */
  onIdle: (() => void) | null = null;
  onBusy: (() => void) | null = null;
  /** the computer may go on (the stage may still hold the fighters for a follow-up, or be fading out) */
  onSettle: (() => void) | null = null;
  /** a cinematic of chain `batch` started; it lasts `seconds` of real time */
  onCueStart: ((batch: number, seconds: number) => void) | null = null;
  /** the WebGL context was lost (everything was dropped and reported) */
  onLost: (() => void) | null = null;
  viewer: Pid = 0;
  /** cinematics still playing out under the current one (see Timeline.handoff) */
  private trailing: Timeline[] = [];
  /** the finished attack declaration, kept on stage while the fighters wait for the blow */
  private held: Timeline | null = null;
  /** seconds left of that hold */
  private holdLeft = 0;
  private curKind: Cue['kind'] | null = null;
  /** the kind of the last cinematic that ended (sets the linger after it) */
  private lastKind: Cue['kind'] | null = null;
  /** battle figures fading away under a new, unrelated cinematic */
  private outgoing: Actor[] = [];
  /** onSettle / onIdle already sent since the last push */
  private settledSent = true;
  private idleSent = true;
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
  /** camera roll (radians): the dutch-angle punch on impacts */
  private roll = 0;

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
    this.stage.onLost = () => {
      this.clear();
      this.onLost?.();
    };
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

  /**
   * The computer must wait: a cinematic is queued or playing, or the last one's
   * dim has not cleared yet. A hold for a follow-up blow, and the last particles
   * fading, do not count.
   */
  get busy() {
    return this.queue.length > 0 || this.current !== null || this.trailing.length > 0 || !this.settledSent;
  }

  /** Something is still drawn (busy, holding, or fading out). */
  get onStage() {
    return this.busy || this.actors.size > 0 || this.held !== null || this.outgoing.length > 0 || !this.idleSent;
  }

  /** Playback speed of what is on now (for the DOM banners' timing). */
  get rate() {
    return this.current?.rate ?? this.timeScale;
  }

  /** The Cinematics setting (the art stage keeps it current): under 'all' a long opponent backlog is trimmed. */
  cinematics = 'big';
  /** A choice for the player is waiting on the stage (the flow says): what is left fades out fast. */
  hurry: () => boolean = () => false;
  /** idleFor when the stage last reported idle (particles get PARTICLE_TAIL more) */
  private idleMark = -1;

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
    } else if (this.cinematics === 'all' && this.queue.length > QUEUE_KEEP) {
      // Everything plays under All, but an opponent's long chain (a spell, a set, a skill, a
      // flip... one after the other) keeps only its big beats past the first few.
      const v = this.viewer;
      this.queue = this.queue.filter((q, i) => i < QUEUE_KEEP || SLOW_KINDS.has(q.cue.kind) || q.cue.kind === 'destroy' || cueOwner(q.cue) === v);
      const left = new Set(this.queue.map((q) => q.batch));
      for (const b of [...before, batch]) if (!left.has(b) && b !== this.curBatch) this.onBatchEnd?.(b);
    }
    // Upload the pictures of every card this chain shows now, one texture per frame,
    // so no cinematic stalls the GPU uploading one mid-shot.
    for (const cue of cues) {
      const refs = cue.kind === 'attack' || cue.kind === 'hit' ? [cue.attacker, cue.target] : 'card' in cue ? [cue.card] : [];
      for (const r of refs) if (r?.name) void artFor(r.name).then((a) => this.stage.upload(a), () => {});
    }
    // From idle, the stage stays clear until the first cinematic is built (a chain with
    // nothing to draw never dims the screen for a few frames).
    if (!this.current && !this.held) this.dimTarget = 0;
    this.fastFade = false;
    this.settledSent = false;
    this.idleSent = false;
    this.onBusy?.();
    this.stage.start();
    if (!this.current) this.next();
  }

  private settle() {
    if (this.settledSent) return;
    this.settledSent = true;
    this.onSettle?.();
  }

  private idle() {
    this.settle();
    if (this.idleSent) return;
    this.idleSent = true;
    this.onIdle?.();
  }

  /** Linger before the battle figures fade (shorter at a faster Animation speed; none after a skip; a short one after a shatter, which is its own beat). */
  private get linger() {
    if (this.fastFade) return 0;
    if (this.hurry()) return HURRY_LINGER / this.timeScale;
    return (this.lastKind === 'destroy' ? LINGER_AFTER_SHATTER : LINGER) / this.timeScale;
  }

  /** Drops the attack declaration kept for a follow-up. */
  private dropHeld() {
    this.holdLeft = 0;
    if (!this.held) return;
    this.held.dispose();
    this.held = null;
  }

  /** The current cinematic plays out underneath while the next one of its chain starts. */
  private handOff() {
    const tl = this.current!;
    this.trailing.push(tl);
    this.current = null;
    this.next();
  }

  private finishTrailing() {
    for (const t of this.trailing) (t.finish(), t.dispose());
    this.trailing = [];
  }

  /** Tap: skip the whole current chain (every cue of the same event batch). */
  skip() {
    this.fastFade = true;
    const b = this.curBatch;
    if (b >= 0) this.queue = this.queue.filter((q) => q.batch !== b);
    this.finishTrailing();
    this.dropHeld();
    this.endCurrent(true);
    if (!this.current && !this.queue.length) this.stage.particles.clear();
  }

  /** Long press / double tap: skip everything queued, and whatever arrives until the queue has drained. */
  skipEverything() {
    this.skipAll = true;
    this.fastFade = true;
    const rest = [...new Set(this.queue.map((q) => q.batch))];
    this.queue = [];
    this.finishTrailing();
    this.dropHeld();
    this.endCurrent(true);
    for (const b of rest) this.onBatchEnd?.(b);
    this.stage.particles.clear();
  }

  /**
   * After a skip with nothing else to play: the stage goes blank this very frame
   * (no fast fade) and reports idle, so the board and the duel get the screen back
   * at once. False (nothing done) while a cinematic is still playing or queued.
   */
  hideNow(): boolean {
    if (this.current || this.queue.length || this.trailing.length) return false;
    this.dropHeld();
    for (const a of this.actors.values()) this.dropActor(a);
    this.actors.clear();
    for (const a of this.outgoing) this.dropActor(a);
    this.outgoing = [];
    this.stage.clear();
    this.ui.clear?.();
    this.bg = this.bgTarget = 0;
    this.dim = this.dimTarget = 0;
    this.veil.u.uDim.value = 0;
    this.front.u.uFlash.value = 0;
    this.stage.backdrop.u.uOpacity.value = 0;
    this.stage.backdrop.u.uTerrainAmt.value = 0;
    this.resetCam();
    this.stage.camera.up.set(0, 1, 0);
    // stop() clears the canvas: blank on the next composite
    this.stage.stop();
    this.skipAll = false;
    this.fastFade = false;
    this.idleFor = 0;
    this.idle();
    return true;
  }

  /**
   * The dim covers the duel almost completely (a cinematic is playing at full dim):
   * the field figures layer under it need not draw (board.ts).
   */
  get covering(): boolean {
    return this.current !== null && this.dim > 0.7 && this.dimTarget > 0.7;
  }

  /** Ends the cinematic on stage (finishing it first when skipped), reports a finished chain, starts the next. */
  private endCurrent(skipped: boolean) {
    const tl = this.current;
    if (!tl) return;
    if (skipped) tl.finish();
    // An attack declaration with nothing behind it: the fighters hold their pose for the blow.
    if (!skipped && this.curKind === 'attack' && !this.queue.length && !this.fastFade && !this.skipAll && this.actors.size) {
      this.dropHeld();
      this.held = tl;
      this.holdLeft = Math.max(HOLD / this.timeScale, HOLD_MIN);
    } else tl.dispose();
    this.current = null;
    this.lastKind = this.curKind;
    this.curKind = null;
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
    this.curKind = null;
    this.curBatch = -1;
    this.skipAll = false;
    this.finishTrailing();
    this.dropHeld();
    for (const b of rest) this.onBatchEnd?.(b);
    for (const a of this.actors.values()) this.dropActor(a);
    this.actors.clear();
    for (const a of this.outgoing) this.dropActor(a);
    this.outgoing = [];
    this.stage.clear();
    this.ui.clear?.();
    this.stage.camera.up.set(0, 1, 0);
    this.bg = this.bgTarget = 0;
    this.stage.backdrop.u.uOpacity.value = 0;
    this.stage.backdrop.u.uTerrainAmt.value = 0;
    this.stage.stop();
    this.settledSent = false;
    this.idleSent = false;
    this.idle();
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
    const ts = this.timeScale;
    const following = !this.current && this.held !== null && !this.fastFade;
    const lingering = !this.fastFade && this.actors.size > 0 && this.idleFor < this.linger;
    // Backdrop eases toward what the current cinematic wants.
    // (the battle figures' backdrop fades with them, not after them)
    const want = this.current || following ? this.bgTarget : lingering ? 0.6 : 0;
    this.bg = lerp(this.bg, want, 1 - Math.exp(-dt * (this.fastFade ? 20 : 7) * ts));
    if (this.fastFade && !this.current && this.bg < 0.03) this.bg = 0;
    this.stage.backdrop.u.uOpacity.value = this.bg * 0.7;
    this.veils(dt, following, lingering);
    // figures of an earlier battle fading under a new cinematic
    if (this.outgoing.length) {
      for (const a of this.outgoing) this.setOpacity(a, Math.max(0, (a.fig?.u.uOpacity.value ?? a.back?.u.uOpacity.value ?? 0) - dt * 6 * ts));
      this.outgoing = this.outgoing.filter((a) => {
        if ((a.fig?.u.uOpacity.value ?? a.back?.u.uOpacity.value ?? 0) > 0) return true;
        this.dropActor(a);
        return false;
      });
    }
    // a blow still playing out under the shatter
    for (let i = this.trailing.length - 1; i >= 0; i--) {
      const t = this.trailing[i];
      if (!t.update(dt)) {
        t.dispose();
        this.trailing.splice(i, 1);
      }
    }
    if (this.current) {
      const tl = this.current;
      this.watchdog += dt;
      if (!tl.update(dt) || this.watchdog > tl.duration / tl.rate + 3) this.endCurrent(false);
      else if (tl.handoff !== null && tl.t >= tl.handoff && this.queue[0]?.batch === this.curBatch) this.handOff();
      this.capFlash();
      return;
    }
    if (this.trailing.length) return;
    if (following) {
      // the fighters hold their pose for the blow; the computer goes on meanwhile
      this.settle();
      this.holdLeft -= dt;
      if (this.holdLeft > 0) return;
      this.dropHeld();
      this.idleFor = this.linger;
    }
    // Nothing playing: battle figures linger a moment, then fade away (at once after a skip).
    this.idleFor += dt;
    const linger = this.linger;
    if (this.actors.size && this.idleFor > linger) {
      const k = clamp01((this.idleFor - linger) / ((this.fastFade || this.hurry() ? FAST_FADE : FADE) / ts));
      for (const a of this.actors.values()) {
        if (a.fig) a.fig.u.uOpacity.value = Math.min(a.fig.u.uOpacity.value, 1 - k);
        if (a.back) a.back.u.uOpacity.value = Math.min(a.back.u.uOpacity.value, 1 - k);
      }
      if (k >= 1) {
        for (const a of this.actors.values()) this.dropActor(a);
        this.actors.clear();
      }
    }
    if (this.actors.size || this.outgoing.length) return;
    // The dim is nearly gone: the duel goes on now; particles finish on their own.
    if (this.dim < IDLE_DIM) {
      if (!this.idleSent) this.idleMark = this.idleFor;
      this.idle();
    }
    // once the duel has the screen back, drifting particles get a short tail (none with a choice waiting)
    const tailDone = this.idleSent && (this.hurry() || this.idleFor - this.idleMark > PARTICLE_TAIL);
    if (this.bg < 0.03 && this.dim < 0.03 && (!this.stage.particles.active || this.fastFade || tailDone || this.idleFor > 1.5)) {
      this.stage.particles.clear();
      this.stage.backdrop.u.uOpacity.value = 0;
    this.stage.backdrop.u.uTerrainAmt.value = 0;
      this.stage.stop();
      this.skipAll = false;
      this.fastFade = false;
      this.idle();
    }
  }

  /** Flash discipline: the colored flash layer and the post flash share one budget. */
  private capFlash() {
    const st = this.stage as unknown as { flash: number };
    const f = this.front.u.uFlash;
    const sum = f.value + st.flash * 0.85;
    if (sum > FLASH_CAP) {
      const k = FLASH_CAP / sum;
      f.value *= k;
      st.flash *= k;
    }
  }

  /** The dim eases toward what the cinematic wants; flashes and overlays decay; the camera drifts home when idle. */
  private veils(dt: number, following: boolean, lingering: boolean) {
    const want = this.current || following ? this.dimTarget : lingering ? 0.75 : 0;
    this.dim = lerp(this.dim, want, 1 - Math.exp(-dt * (this.fastFade || (!this.current && this.hurry()) ? 22 : 8) * (this.current ? 1 : this.timeScale)));
    if (want === 0 && this.dim < 0.01) this.dim = 0;
    const v = this.veil.u;
    v.uDim.value = this.dim;
    this.stage.dim = this.dim;
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
    // the dutch angle eases back level unless a cinematic holds it
    if (!this.current) this.roll *= Math.exp(-dt * 8);
    this.stage.camera.up.set(Math.sin(this.roll), Math.cos(this.roll), 0);
    if (!this.current && !following) {
      const c = 1 - Math.exp(-dt * (this.fastFade ? 20 : 6) * this.timeScale);
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
    this.retire(item.cue);
    this.idleFor = 0;
    this.fastFade = false;
    // a new chain: whatever the last one left on screen (captions, banners) goes
    if (item.batch !== this.lastBatch) this.ui.clear?.();
    this.lastBatch = item.batch;
    this.curBatch = item.batch;
    const placeholder = new Timeline(99, this.stage);
    placeholder.rate = this.timeScale;
    this.current = placeholder;
    this.curKind = item.cue.kind;
    const own = cueOwner(item.cue);
    // (an opponent cue with more queued behind it: shifted off already, so one left means two were waiting)
    // (a cue already sped up, like their everyday summon, is fast enough)
    const oppBacklog = this.queue.length >= 1 && own !== null && own !== this.viewer && item.scale < OPP_BACKLOG_RATE;
    const rate = this.timeScale * item.scale * flowRate(item.cue, this.queue[0], item.batch, oppBacklog);
    // Never draw a cinematic before its shaders are ready (a first-use link stalls for a whole second on some phones).
    const warm = Promise.race([this.stage.prewarm(), new Promise((ok) => setTimeout(ok, 2500))]);
    warm
      .then(() => (this.current === placeholder ? this.build(item.cue) : null))
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
        // the attack declaration held for this blow gives way to it
        if (this.held) this.dropHeld();
        this.current = tl;
        if (!this.skipAll) cueSting(item.cue);
        this.onCueStart?.(item.batch, tl.duration / rate);
        if (this.skipAll) this.endCurrent(true);
      })
      .catch((err) => {
        console.warn('art engine: cinematic failed', err);
        if (this.current === placeholder) this.endCurrent(false);
      });
  }

  /**
   * Before a new cinematic: battle figures already fading (or skipped away) stay
   * gone unless it is about them; fighters held for a blow give way to a new
   * battle or summon that is not about them. They fade out under it.
   */
  private retire(cue: Cue) {
    if (!this.actors.size || this.current) return;
    const fading = !this.held && (this.fastFade || this.idleFor > this.linger);
    const keep = new Set(cueUids(cue));
    const about = [...this.actors.keys()].some((u) => keep.has(u));
    const newScene = !!this.held && !about && (cue.kind === 'attack' || cue.kind === 'summon');
    if (!fading && !newScene) return;
    if (newScene) this.dropHeld();
    for (const a of [...this.actors.values()]) {
      if (keep.has(a.uid)) this.setOpacity(a, 1);
      else (this.actors.delete(a.uid), this.outgoing.push(a));
    }
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

  /** A finished card's figure (Ultra Rare and up) is rim-lit in its finish in every scene it is in. */
  private finishRim(fig: Figure, c: CardRef) {
    const fin = finishOf(c);
    if (fin < FIN.UR) return;
    rimColor(finishGlow(fin, c.uid * 0.37), fig.u.uRim.value as Vector3);
    fig.u.uRimAmt.value = fin >= FIN.MI ? 1.75 : fin >= FIN.OF ? 1.7 : fin >= FIN.GL ? 1.35 : 1.15;
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
      this.finishRim(a.fig, c);
    } else {
      a.back = this.stage.add(new CardPanel(cardBack(), size * 0.8, 0x4c4a50));
      if (c.def) a.back.mesh.rotation.z = Math.PI / 2;
      a.back.u.uOpacity.value = 0;
    }
    this.actors.set(c.uid, a);
    this.place(a);
    return a;
  }

  /** A monster on the field rising off its own card (a board-wide or targeted effect is about to strike it). */
  private async fieldActor(c: CardRef): Promise<Actor> {
    const have = this.actors.get(c.uid);
    if (have) return have;
    const prof = profileFor(card(c.name), c.name || 'face-down');
    const art = c.name && c.faceUp ? await this.art(c.name) : null;
    const side = this.side(c.controller);
    const at = this.anchor(c, side);
    const size = 0.95 * this.U;
    const a: Actor = { uid: c.uid, name: c.name, side, role: side === 'near' ? 'att' : 'def', prof, art, fig: null, back: null, x: at.x, y: at.y + size * 0.28, z: 0.35, size, ox: 0, oy: 0, oz: 0, lean: 0, entered: true, from: at, field: true };
    if (art) {
      a.fig = this.stage.add(this.figure(art, size, prof, this.colors(prof, art).main));
      a.fig.mesh.scale.setScalar(size);
      this.finishRim(a.fig, c);
    } else {
      a.back = this.stage.add(new CardPanel(cardBack(), size * 0.8, 0x4c4a50));
      if (c.def) a.back.mesh.rotation.z = Math.PI / 2;
    }
    this.setOpacity(a, 0);
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
    m.rotation.x = (a.field ? 0 : a.role === 'att' ? -0.06 : 0.04) + a.lean;
    m.rotation.y = a.field ? 0 : (a.role === 'att' ? 0.22 : -0.18) * t;
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
  /** Millennium's attack wind-up: the Eye opens behind the attacker and gold sand pours into the blow. */
  private millenniumWindup(tl: Timeline, att: Actor, M: P3, D: number) {
    const st = this.stage;
    const U = this.U;
    const eye = tl.own(new CardPanel(millenniumEyeCanvas(), 2.6 * U, 0x000000));
    // drawn before the figures: it hangs behind the attacker, never over it
    eye.mesh.renderOrder = -4;
    eye.mesh.position.set(M.x, M.y + 1.1 * U, M.z - 1.2);
    eye.u.uOpacity.value = 0;
    tl.span(0.15, D, (k) => {
      eye.u.uOpacity.value = 0.85 * clamp01(k * 2);
      eye.mesh.scale.set(1, Math.max(0.04, easeOut(k)), 1);
    });
    tl.at(0.15, () => (this.dimTarget = 0.92));
    tl.span(0.3, D, (_k, dt) => {
      const n = Math.floor(110 * this.q * dt + Math.random());
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = (1 + Math.random() * 0.7) * U;
        st.particles.emit({ x: M.x + Math.cos(a) * rr, y: M.y + Math.sin(a) * rr, z: M.z, life: 0.45, size: 0.06 * U, color: i % 4 ? 0xffd56a : 0xc8961e, drag: 0, pull: { x: M.x, y: M.y, strength: 22 * U, swirl: 10 * U } });
      }
    });
  }

  /** Millennium's blow: the Eye holds open over the attacker, a trail of gold follows the blow, and a ring of gold where it lands. */
  private millenniumBlow(tl: Timeline, M: P3, P: P3, W: number, hitAt: number) {
    const st = this.stage;
    const U = this.U;
    const q = this.q;
    // the Eye stays open over the attacker until the blow lands, then closes
    const held = tl.own(new CardPanel(millenniumEyeCanvas(), 2.6 * U, 0x000000));
    held.mesh.renderOrder = -4;
    held.mesh.position.set(M.x, M.y + 1.1 * U, M.z - 1.2);
    held.u.uOpacity.value = 0.85;
    tl.span(hitAt, hitAt + 0.35, (k) => {
      held.u.uOpacity.value = 0.85 * (1 - k);
      held.mesh.scale.set(1, Math.max(0.04, 1 - easeIn(k)), 1);
    });
    tl.span(W, hitAt, (k, dt) => {
      const n = Math.floor(240 * q * dt + Math.random());
      const e = easeIn(k);
      for (let i = 0; i < n; i++) {
        const f = e * Math.random();
        st.particles.emit({ x: lerp(M.x, P.x, f) + (Math.random() - 0.5) * 0.2 * U, y: lerp(M.y, P.y, f) + (Math.random() - 0.5) * 0.2 * U, z: lerp(M.z, P.z, f), life: 0.45, size: (0.05 + Math.random() * 0.05) * U, color: i % 5 ? 0xffd56a : 0xfff6d8, drag: 2 });
      }
    });
    const ring = tl.own(new Glow(4 * U, 4 * U, 'shock', 0xffd56a, 0xc8961e));
    ring.mesh.position.set(P.x, P.y, P.z + 0.2);
    ring.u.uOpacity.value = 0;
    tl.span(hitAt, hitAt + 0.6, (k) => {
      ring.u.uK.value = easeOut(k);
      ring.u.uOpacity.value = 0.4 * (1 - k);
    });
    tl.at(hitAt, () => {
      st.pulse('chroma', 0.2);
      this.flash(0xffc93a, 0.12);
      for (const [c, n] of [[0xffd56a, 26], [0xfff6d8, 12], [0xc8961e, 10]] as const) st.particles.emit({ x: P.x, y: P.y, z: P.z + 0.2, burst: 4.2 * U, life: 0.8, size: 0.1 * U, color: c, drag: 1.8 }, Math.round(n * q));
      chime(0.95);
    });
  }

  /**
   * Millennium's summon (S: the summon's start; E: its length before the landing): the Millennium Eye
   * opens behind the hanging card while gold sand spirals into it, a ring of hieroglyphs turns on the
   * ground, and when the card shatters a pillar of gold light holds the monster until it lands.
   */
  private millenniumEye(tl: Timeline, S: number, at: P3, ground: number, size: number, E: number) {
    const st = this.stage;
    const U = this.U;
    const q = this.q;
    // the Wedjat itself, drawn in gold (an additive panel: its black is see-through), opening
    // from a closed line, with a gold ring turning behind it
    const eye = tl.own(new CardPanel(millenniumEyeCanvas(), 3.2 * U, 0x000000));
    eye.mesh.renderOrder = -4;
    eye.mesh.position.set(at.x, at.y, at.z);
    eye.u.uOpacity.value = 0;
    const halo = tl.own(new Ring(2.6 * U, 0xffc93a, 4242, { inner: 0.86, outer: 0.95 }));
    halo.mesh.renderOrder = -5;
    halo.mesh.position.set(at.x, at.y, at.z - 0.05);
    halo.spinSpeed = 0.5;
    halo.u.uOpacity.value = 0;
    tl.span(S + 0.05, S + 0.45, (k) => {
      const e = easeOut(k);
      eye.u.uOpacity.value = clamp01(k * 2.5);
      eye.mesh.scale.set(lerp(0.8, 1, e), Math.max(0.04, e), 1);
      halo.u.uOpacity.value = 0.7 * e;
      halo.mesh.scale.setScalar(lerp(0.6, 1, e));
    });
    tl.at(S + 0.4, () => {
      st.pulse('flash', 0.18);
      boom(0.5);
    });
    // it closes as the card bursts, so it never sits over the monster
    tl.span(S + 0.75, S + 1.05, (k) => {
      eye.mesh.scale.set(1 + 0.2 * k, Math.max(0.04, 1 - easeIn(k)), 1);
      eye.u.uOpacity.value = 1 - easeIn(k);
      halo.u.uOpacity.value = 0.7 * (1 - k);
    });
    // gold sand pulled into the pupil
    tl.span(S + 0.05, S + 0.6, (_k, dt) => {
      const n = Math.floor(150 * q * dt + Math.random());
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = (1.6 + Math.random() * 0.8) * U;
        st.particles.emit({ x: at.x + Math.cos(a) * rr, y: at.y + Math.sin(a) * rr * 0.7, z: at.z + 0.3, life: 0.5, size: 0.07 * U, color: i % 5 ? 0xffd56a : 0xc8961e, drag: 0, pull: { x: at.x, y: at.y, strength: 18 * U, swirl: 9 * U } });
      }
    });
    // the ring of hieroglyphs on the ground
    const glyphs = tl.own(new Ring(3.8 * U, 0xffc93a, 777, { inner: 0.8, outer: 0.95 }));
    glyphs.mesh.rotation.x = -1.2;
    glyphs.mesh.position.set(0, ground, 0.02);
    glyphs.spinSpeed = 0.35;
    glyphs.u.uOpacity.value = 0;
    tl.span(S + 0.1, S + 0.6, (k) => {
      glyphs.mesh.scale.setScalar(lerp(0.5, 1, easeOut(k)));
      glyphs.u.uOpacity.value = k * 0.9;
    });
    tl.span(S + E - 0.4, S + E, (k) => (glyphs.u.uOpacity.value = 0.9 * (1 - k)));
    // the pillar of gold light, with gold dust rising through it
    this.shafts(tl, { x: 0, y: ground, z: -0.2 }, 5 * U, 0xffd56a, S + 0.6, S + E, 4, 0.9);
    tl.span(S + 0.6, S + E - 0.2, (_k, dt) => {
      const n = Math.floor(70 * q * dt + Math.random());
      for (let i = 0; i < n; i++) st.particles.emit({ x: (Math.random() - 0.5) * size * 0.9, y: ground + Math.random() * 0.3 * U, z: 0.25, vy: (1.4 + Math.random() * 1.6) * U, life: 0.9, size: (0.04 + Math.random() * 0.05) * U, color: i % 4 ? 0xffe9a8 : 0xc8961e, drag: 0.4 });
    });
  }

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
    const flare = tl.own(new Glow((1.25 + pw * 0.8) * U, (1.25 + pw * 0.8) * U, 'flare', o.color, o.light));
    flare.mesh.position.set(p.x, p.y, p.z + 0.5);
    flare.u.uK.value = 1;
    tl.span(at, at + 0.4, (k) => {
      flare.u.uOpacity.value = 0.5 * (k < 0.12 ? 1 : 1 - easeOut((k - 0.12) / 0.88));
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
      st.pulse('flash', 0.03 + 0.05 * pw);
      this.flash(o.light, 0.05 + 0.08 * pw);
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
    this.roll = 0;
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
      const panel = document.querySelector<HTMLElement>('.artlab-panel');
      const pr = panel?.getBoundingClientRect();
      // (a hidden or collapsed panel covers nothing)
      if (panel && pr && pr.height > 8 && pr.top < r.bottom && getComputedStyle(panel).visibility !== 'hidden') {
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
  private fit(boxes: Box[], yaw: number, pitch: number, o: { fill?: number; minD?: number; at?: number } = {}): Shot {
    const cam = this.probe;
    cam.aspect = this.stage.camera.aspect;
    cam.fov = BASE_FOV;
    cam.updateProjectionMatrix();
    const safe = this.safe();
    const fill = o.fill ?? 1;
    // `at`: where the boxes' center sits, as a fraction of the safe area's height from its top
    // (off center, they get only twice the room to the nearer edge)
    const at = Math.min(0.8, Math.max(0.2, o.at ?? 0.5));
    const maxW = 2 * 0.9 * fill;
    const maxH = 2 * (1 - safe.top - safe.bottom) * fill * 2 * Math.min(at, 1 - at);
    const yTop = 1 - 2 * safe.top;
    const targetY = yTop - at * (yTop - (-1 + 2 * safe.bottom));
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
  private battleShot(att: Actor | null, tgt: Actor | null, T: P3, yaw = 0.3, pitch = 0.1, fill = 0.86): Shot {
    const U = this.U;
    const m = this.battleSide === 'near' ? 1 : -1;
    // (much more than ~20° off its front and a relief figure shows its extrusion as streaky slices)
    yaw = Math.min(yaw, 0.35);
    // (the figure's painted subject fills ~90% of its box: framed on that, not on the empty margin)
    const boxes: Box[] = [tgt ? { ...this.boxOf(tgt), h: this.boxOf(tgt).h * 0.92 } : { ...T, w: 0.5 * U, h: 0.5 * U }];
    let ab: Box | null = null;
    if (att) {
      // the attacker from the hips up, with headroom over it (its feet may run off the frame;
      // its head, hat or horns never run off the top)
      const b = this.boxOf(att);
      ab = { ...b, y: b.y + b.h * 0.3, h: b.h * 0.8 };
      boxes.push(ab);
    }
    const shot = this.fit(boxes, -yaw * m, pitch, { fill });
    if (!att) return shot;
    // pull back until the attacker (in the foreground) takes at most ~55% of the frame's height
    // (measured on its painted subject, ~92% of its box)
    const full = { ...this.boxOf(att), h: this.boxOf(att).h * 0.92 };
    const cam = this.probe;
    const v = new Vector3();
    const dir = shot.pos.clone().sub(shot.look);
    const d0 = dir.length();
    dir.normalize();
    const tall = (d: number) => {
      cam.position.copy(shot.look).addScaledVector(dir, d);
      cam.lookAt(shot.look);
      cam.updateMatrixWorld();
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const sy of [-1, 1])
        for (const sx of [-1, 1]) {
          v.set(full.x + sx * full.w, full.y + sy * full.h, full.z).project(cam);
          if (v.z > 1 || v.z < -1) return 2;
          y0 = Math.min(y0, v.y);
          y1 = Math.max(y1, v.y);
        }
      return (y1 - y0) / 2;
    };
    let d = d0;
    for (let i = 0; i < 24 && tall(d) > 0.55; i++) d *= 1.06;
    return { pos: shot.look.clone().addScaledVector(dir, d), look: shot.look };
  }

  /**
   * Leans the camera toward `shot` on top of whatever the cinematic sets: the weight
   * eases in over [a, b] and back out over [c, d] (a preset framing its own subject
   * while the activation's push-in, drift and return keep running underneath).
   */
  private lean(tl: Timeline, shot: Shot, a: number, b: number, c: number, d: number) {
    tl.span(a, d, (k) => {
      const t = a + k * (d - a);
      const w = easeInOut(clamp01((t - a) / (b - a))) * (1 - easeInOut(clamp01((t - c) / (d - c))));
      this.stage.camBase.lerp(shot.pos, w);
      this.stage.camLook.lerp(shot.look, w);
    });
  }

  /**
   * What an effect strikes, framed: the boxes filling ~0.7 of the width (as far as the
   * safe area's height allows), their center ~40% down the safe area so a burst above them
   * (bolts, beams, shatter) still has room under the HUD.
   */
  private effectShot(boxes: Box[], yaw = 0, pitch = 0.05): Shot {
    return this.fit(boxes, yaw, pitch, { fill: 0.8, at: 0.42 });
  }

  /** The world y at depth `z` above `x` that sits at the safe area's top edge, seen from `shot`. */
  private skyY(shot: Shot, x: number, z: number): number {
    const cam = this.probe;
    cam.aspect = this.stage.camera.aspect;
    cam.fov = BASE_FOV;
    cam.updateProjectionMatrix();
    cam.position.copy(shot.pos);
    cam.lookAt(shot.look);
    cam.updateMatrixWorld();
    const ndcX = new Vector3(x, shot.look.y, z).project(cam).x;
    const dir = new Vector3(ndcX, 1 - 2 * this.safe().top - 0.02, 0.5).unproject(cam).sub(cam.position).normalize();
    if (Math.abs(dir.z) < 1e-4) return shot.look.y + 4 * this.U;
    return cam.position.y + dir.y * ((z - cam.position.z) / dir.z);
  }

  // ------------------------------------------------------------ cinematics
  private async build(cue: Cue): Promise<Timeline | null> {
    switch (cue.kind) {
      case 'summon':
        return this.summon(cue.card, cue.how ?? (cue.special ? 'special' : undefined));
      case 'set':
        return this.set(cue.card);
      case 'flip':
        return this.flip(cue.card);
      case 'activate':
        return cue.what === 'monster' ? this.monsterEffect(cue.card, cue.targets ?? [], cue.field ?? []) : this.activate(cue.card, cue.what, cue.targets ?? [], cue.field ?? []);
      case 'target':
        return this.targetBeat(cue.card, cue.targets);
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
      case 'leave':
        return this.leave(cue.card, cue.to);
      case 'heal':
        return cue.amount > 0 ? this.heal(cue.player, cue.amount) : null;
      case 'draw':
        return cue.count > 0 ? this.draw(cue.player, cue.count) : null;
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
  private async summon(c: CardRef, howIn?: SummonHow): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const info = card(c.name);
    const prof = profileFor(info, c.name);
    const [art, bm] = await Promise.all([this.art(c.name), boardModule()]);
    const col = finishOf(c) >= FIN.MI ? MILL_COLS : this.colors(prof, art);
    const tier = prof.tier;
    const side = this.side(c.controller);
    // the summon method: the engine's word, else what the card is (an Xyz is never Normal Summoned)
    const method: SummonHow | undefined = howIn ?? (info?.sub === 'Xyz' ? 'xyz' : info?.sub === 'Synchro' ? 'synchro' : info?.sub === 'Link' ? 'link' : undefined);
    const entr = method === 'fusion' ? 'fusion' : method === 'ritual' ? 'ritual' : method === 'xyz' ? 'portal' : method === 'synchro' || method === 'link' ? 'materialize' : method === 'special' && (prof.entrance === 'fusion' || prof.entrance === 'ritual') ? 'rise' : prof.entrance;
    const extra = method === 'xyz' || method === 'synchro' || method === 'link';
    const fusionish = entr === 'fusion' || entr === 'ritual' || extra;
    const big = isBig(info, prof) || extra || method === 'fusion' || method === 'ritual';
    // the card's finish (its owner's, Speed Duel card leveling): Overframe always gets the
    // cut-in and its own entrance, the card's frame shattering as the monster leaps out
    const fin = finishOf(c);
    const over = fin >= FIN.OF;
    // Millennium (above Overframe): the Millennium Eye opens over a darkened field before the
    // card shatters, and the monster rises in a pillar of gold over a ring of hieroglyphs
    const mill = fin >= FIN.MI;
    const finPal = finishPalette(fin);
    const C = (big || over) && art ? 0.62 : 0;
    const E = [1.35, 1.55, 1.85, 2.15][tier] + (fusionish ? 0.3 : 0) + (over ? 0.3 : 0) + (mill ? 0.35 : 0);
    const LAND = 0.42;
    // the summon starts under the cut-in's exit (no dead air between them)
    const S = C ? C - 0.3 : 0;
    const D = S + E + LAND;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.4 + tier * 0.08;
    this.dimTarget = mill ? 0.93 : 0.84;
    this.focus.set(0.5, 0.5);
    if (mill) this.stage.backdrop.u.uColor.value.set(0.09, 0.06, 0.02);
    else this.stage.backdrop.u.uColor.value.set(((col.main >> 16) & 255) / 900, ((col.main >> 8) & 255) / 900, (col.main & 255) / 900);
    const r = rand(prof.seed);
    const from = this.anchor(c, side);
    const size = (1.3 + tier * 0.1) * U;
    const restY = 0;
    const ground = restY - size * 0.46;
    const at = (t: number, fn: () => void) => tl.at(S + t, fn);
    const span = (a: number, b: number, fn: (k: number, dt: number) => void) => tl.span(S + a, S + b, fn);
    const sub = !info ? '' : info.kind === 'monster' ? `${'★'.repeat(Math.min(12, info.level ?? 0))}  ATK ${info.atk ?? '?'} / DEF ${info.def ?? '?'}` : '';
    const how = method ? SUMMON_LABEL[method] : entr === 'fusion' ? 'Fusion Summon' : entr === 'ritual' ? 'Ritual Summon' : (info?.level ?? 0) >= 5 ? 'Tribute Summon' : '';

    // the cut-in: a slanted band, the art racing across it, the name slamming in
    if (C && art) {
      const ci = tl.own(new CutIn(mill ? goldArt(art.art) : art.art, c.name, (over ? [mill ? '◈ MILLENNIUM ◈' : '✦ OVERFRAME ✦', how] : [how, sub.replace(/★+\s*/, '')]).filter(Boolean).join('  ·  '), mill ? 0x2a1a00 : over ? 0xff4fd0 : col.main, mill ? 0xffd56a : over ? 0x4fe0ff : GOLD));
      tl.span(0, C, (k) => {
        ci.u.uK.value = k;
        ci.u.uAspect.value = st.camera.aspect;
      });
      tl.at(0, () => (swell(0.7), whoosh(0.35, 500, 3200, 0.2)));
      tl.at(C - 0.07, () => {
        st.pulse('flash', 0.35);
        this.flash(0xffffff, 0.3);
        st.hitStop(0.085);
        boom(0.45);
      });
      tl.at(C, () => (ci.u.uOpacity.value = 0));
    }

    // camera: hold at rest while the card leaves its zone, swing to a framed low (near) / high (far) angle, drift
    // a big monster lands under a slow orbit (±~17°: the flat figure reads as 3D, never edge-on)
    const orbit = C > 0 || tier >= 2;
    const yaw = orbit ? (prof.camYaw >= 0 ? 0.3 : -0.3) : prof.camYaw * 0.32;
    const pitch = side === 'near' ? -0.1 - prof.camPitch * 0.06 : 0.14 + prof.camPitch * 0.06;
    const boxes: Box[] = [
      { x: 0, y: restY, z: 0, w: size * 0.42, h: size * 0.5 },
      { x: 0, y: ground, z: 0, w: 1.05 * U, h: 0.12 * U },
    ];
    // the figure never fills more than ~70% of the safe area's height: it reads as a creature, not a smear of pixels
    const s0 = this.fit(boxes, yaw, pitch, { fill: Math.min(0.68, 0.62 + tier * 0.02) });
    const s1 = this.fit(boxes, orbit ? -yaw * 0.85 : -yaw * 0.5, pitch * 0.6, { fill: Math.min(0.72, 0.66 + tier * 0.02) });
    let sStart: Shot | null = null;
    span(0, 0.45, (k) => this.setShot((sStart ??= this.shot()), s0, easeInOut(k)));
    span(0.45, E, (k) => this.setShot(s0, s1, easeInOut(k)));
    let sEnd: Shot | null = null;
    span(E, E + LAND, (k) => this.setShot((sEnd ??= this.shot()), REST, easeInOut(k)));

    // the card flies up from its zone and flips
    // an Overframe or Millennium card flies out as its full-art face
    const flyer = tl.own(new CardPanel(art ? (over ? fullArtCard(art.full, c.name, fin) : art.full) : null, 1.2 * U, col.main));
    flyer.u.uOpacity.value = 0;
    span(0, 0.32, (k) => {
      const e = easeOut(k);
      flyer.mesh.position.set(lerp(from.x, 0, e), lerp(from.y, ground + 0.4 * U, e), lerp(0, 1.2, e));
      flyer.mesh.rotation.set(-0.5 * e, Math.PI * 2 * e, 0);
      flyer.mesh.scale.setScalar(lerp(0.55, 1.35, e));
      // solid, in its own colors, while it flies (a pale fading card reads as a grey slab)
      flyer.u.uOpacity.value = 1;
      flyer.u.uTint.value = 0.35 * clamp01((k - 0.6) / 0.4);
      // a light sweep across its face as it turns toward the camera
      flyer.u.uSheen.value = lerp(-0.4, 1.8, clamp01((k - 0.35) / 0.65));
    });
    // a finished card's edge and sheen glow in its finish (gold, Glossy's prism, the Overframe rainbow)
    if (fin >= FIN.UR) span(0, over ? 0.62 : 0.5, (k) => setRgb(flyer.u.uGlow.value as Vector3, finishGlow(fin, k * 3)));
    if (over) {
      // Overframe: the card hangs in the air, shaking with rainbow light, the sheen racing
      // across it again and again... then the frame bursts and the monster leaps out of it
      span(0.32, 0.6, (k) => {
        const e = easeIn(k);
        flyer.mesh.position.x = Math.sin(k * 70) * 0.03 * U * e;
        flyer.mesh.rotation.z = Math.sin(k * 53) * 0.03 * e;
        flyer.mesh.scale.setScalar(1.35 * (1 + 0.06 * e));
        flyer.u.uSheen.value = -0.4 + ((k * 3) % 1) * 2.2;
        flyer.u.uTint.value = 0.35 * e;
      });
      span(0.32, 0.6, (_k, dt) => {
        const n = Math.floor(120 * this.q * dt + 0.5);
        const p = flyer.mesh.position;
        for (let i = 0; i < n; i++) {
          const a = r() * Math.PI * 2;
          st.particles.emit({ x: p.x + Math.cos(a) * 1.2 * U, y: p.y + Math.sin(a) * 1.4 * U, z: p.z, life: 0.4, size: 0.07 * U, color: finPal![i % finPal!.length], drag: 0, pull: { x: p.x, y: p.y, strength: 14 * U, swirl: 8 * U } });
        }
      });
      tl.at(S + 0.38, () => whoosh(0.5, 900, 4200, 0.45));
      tl.at(S + 0.6, () => {
        // the shards are pieces of the art, not of the card's printed name and stats
        if (art) flyer.retexture(art.art);
        this.panelShards(tl, flyer, mill ? 0xffd56a : 0xfff6c8, 3.4 * U);
        st.pulse('chroma', mill ? 0.15 : 0.7);
        st.pulse('flash', mill ? 0.12 : 0.4);
        this.flash(mill ? 0xffc93a : 0xffffff, mill ? 0.12 : 0.34);
        st.shake(0.55);
        st.hitStop(0.1);
        boom(0.8);
        chime(r());
        const p = flyer.mesh.position;
        finPal!.forEach((fc, i) => st.particles.emit({ x: p.x, y: p.y, z: p.z + 0.2, burst: (3.5 + i * 0.4) * U, life: 0.9, size: 0.11 * U, color: fc, drag: 1.6 }, Math.round(22 * this.q)));
        this.ui.caption(mill ? 'MILLENNIUM' : 'OVERFRAME', mill ? 1.3 : 1.1, mill ? 'art-over art-mill' : 'art-over');
      });
      // two rainbow shock rings out of the shatter
      [0, 0.12].forEach((d, i) => {
        const g = tl.own(mill ? new Glow(5.2 * U, 5.2 * U, 'shock', i ? 0xc8961e : 0xffd56a, i ? 0x6a4800 : 0xfff6d8) : new Glow(5.2 * U, 5.2 * U, 'shock', i ? 0x4fe0ff : 0xff4fd0, i ? 0xa24fff : 0xffb84f));
        g.mesh.position.set(0, restY, 0.3);
        g.u.uOpacity.value = 0;
        span(0.6 + d, 1.25 + d, (k) => {
          g.u.uK.value = easeOut(k);
          g.u.uOpacity.value = 1 - k;
        });
      });
      if (mill) this.millenniumEye(tl, S, { x: 0, y: restY + 0.45 * size, z: -0.6 }, ground, size, E);
    } else {
      // it dissolves into light as the monster's reveal starts (showAt, below)
      span(0.32, 0.5, (k) => {
        flyer.u.uOpacity.value = 1 - easeOut(k);
        flyer.u.uTint.value = lerp(0.35, 0.5, k);
        flyer.mesh.scale.setScalar(1.35 * (1 + 0.08 * easeOut(k)));
      });
      span(0.34, 0.5, (_k, dt) => {
        const n = Math.floor(160 * this.q * dt + 0.5);
        const p = flyer.mesh.position;
        for (let i = 0; i < n; i++) st.particles.emit({ x: p.x + (r() - 0.5) * 1.1 * U, y: p.y + (r() - 0.5) * 1.6 * U, z: p.z, vy: 1.2 * U, life: 0.5, size: 0.08 * U, color: finPal ? finPal[i % finPal.length] : i % 2 ? col.light : col.main, drag: 1.5 });
      });
    }
    if (!C) at(0, () => (tier >= 2 ? swell(0.6) : whoosh(0.3, 400, 2000, 0.15)));

    // the summon method's own shot (Xyz galaxy, Synchro rings, Link arrows, Tribute souls...)
    if (method && method !== 'normal') this.methodFx(tl, method, S, { x: 0, y: restY, z: 0 }, ground, size, col, info, r);

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
    const showAt = over ? 0.62 : 0.42;
    this.shafts(tl, { x: 0, y: ground, z: 0 }, 4.2 * U, col.main, S + showAt - 0.1, S + E, tier >= 2 ? 3 : 2, 0.6 + tier * 0.1);

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
          fig.u.uTint.value = 0.6 * (1 - k);
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
          fig.u.uTint.value = 0.6 * (1 - k);
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
          st.pulse('flash', 0.35);
          this.flash(col.light, 0.3);
          boom(0.6);
          chime(r());
          P.emit({ x: 0, y: restY, burst: 5 * U, life: 0.8, size: 0.13 * U, color: col.light }, Math.round(120 * q));
        });
        span(showAt + 0.2, showAt + 0.7, (k) => {
          if (!fig) return;
          fig.u.uOpacity.value = 1;
          fig.u.uReveal.value = 1;
          fig.u.uTint.value = 0.6 * (1 - k);
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
    // the finish shows on the monster: its rim light takes the finish's color (the Overframe
    // rainbow turning), and Glossy, Royal and Overframe glints rise around it
    if (fig && fin >= FIN.UR) {
      span(showAt, E + LAND, (k) => {
        const g = finishGlow(fin, S + showAt + k * (E + LAND - showAt));
        rimColor(g, fig.u.uRim.value as Vector3);
        fig.u.uRimAmt.value = mill ? 1.7 : over ? 1.8 : fin >= FIN.GL ? 1.4 : 1.15;
      });
    }
    if (finPal && fin >= FIN.GL) {
      at(showAt + 0.05, () => {
        finPal.forEach((fc, i) => P.emit({ x: 0, y: restY, z: 0.3, burst: (2.6 + i * 0.3) * U, life: 0.8, size: 0.09 * U, color: fc, drag: 2 }, Math.round((over ? 14 : 9) * q)));
        if (!over) chime(r());
      });
      span(showAt, E - 0.15, (_k, dt) =>
        emit((over ? 70 : 34) * q, dt, () => {
          const a = Math.random() * Math.PI * 2;
          P.emit({ x: Math.cos(a) * (0.5 + Math.random() * 0.6) * size, y: restY + (Math.random() - 0.4) * size, z: 0.35, vy: 0.9 * U, life: 0.7, size: (0.05 + Math.random() * 0.05) * U, color: finPal[(Math.random() * finPal.length) | 0], drag: 1 });
        }),
      );
    }
    // name plate (with the card's finish on it)
    at(showAt + 0.2, () => this.ui.banner({ title: c.name, sub: [how, sub].filter(Boolean).join(' · '), color: col.main, big: tier >= 2 || over, dur: E - showAt - 0.15, pos: 'bottom', finish: finishId(fin) || undefined }));

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
    tl.commit(S + E + LAND * 0.6);
    // the next cinematic of the chain starts as it lands (no dead air while it settles)
    tl.handoff = S + E + LAND * 0.6;
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

  /**
   * The summon method's shot, around the monster's reveal (`S`: the summon's start; its
   * reveal is ~0.42 s in): a Fusion swirl, Ritual flames, the Xyz galaxy and its
   * material orbs, Synchro rings with stars rising through them, Link arrows lighting,
   * Tribute souls rising and the light falling, or a Special Summon's gate.
   */
  private methodFx(tl: Timeline, method: SummonHow, S: number, c: P3, ground: number, size: number, col: Colors, info: ReturnType<typeof card>, r: () => number) {
    const st = this.stage;
    const U = this.U;
    const P = st.particles;
    const q = this.q;
    const show = S + 0.42;
    const own = <T extends Fx>(f: T) => tl.own(f);
    const fade = (g: { u: Record<string, { value: number }> }, a: number, b: number, c0: number, d: number, peak = 1) =>
      tl.span(a, d, (k) => {
        const t = a + k * (d - a);
        g.u.uOpacity.value = peak * clamp01((t - a) / Math.max(0.01, b - a)) * (1 - clamp01((t - c0) / Math.max(0.01, d - c0)));
      });
    switch (method) {
      case 'xyz': {
        // a galaxy turns behind it; the materials circle in as orbs and dive into its heart
        const gal = own(new Glow(5.2 * U, 5.2 * U, 'galaxy', 0x3a2aff, 0xffd75a));
        gal.mesh.position.set(c.x, c.y, -1.2);
        gal.mesh.rotation.x = -0.5;
        fade(gal, S + 0.05, S + 0.35, show + 0.6, show + 1.1, 0.95);
        const n = (info?.rank ?? 4) >= 7 ? 3 : 2;
        const orbs = Array.from({ length: n }, (_, i) => {
          const g = own(new Glow(0.9 * U, 0.9 * U, 'flare', i % 2 ? 0x7affff : 0xffd75a, 0xffffff));
          g.u.uOpacity.value = 0;
          return g;
        });
        tl.span(S + 0.05, show, (k, dt) =>
          orbs.forEach((g, i) => {
            const a = (i / n) * Math.PI * 2 + k * 8;
            const rr = (1 - easeIn(k)) * 2 * U;
            const x = c.x + Math.cos(a) * rr;
            const y = c.y + Math.sin(a) * rr * 0.45;
            g.mesh.position.set(x, y, Math.sin(a) * 0.6);
            g.u.uOpacity.value = Math.min(1, k * 5);
            for (let j = 0; j < rate(70 * q, dt); j++) P.emit({ x, y, z: 0, burst: 0.3 * U, life: 0.4, size: 0.1 * U, color: i % 2 ? 0x7affff : 0xffd75a, drag: 3 });
          }),
        );
        tl.at(show, () => {
          for (const g of orbs) g.u.uOpacity.value = 0;
          st.pulse('flash', 0.3);
          this.flash(0xffd75a, 0.2);
          boom(0.5);
          P.emit({ x: c.x, y: c.y, burst: 5 * U, life: 0.7, size: 0.1 * U, color: 0xffe9a0 }, Math.round(90 * q));
        });
        // the overlay ring: its materials orbit it as small lights
        const ring = own(new Ring(size * 1.25, 0xffd75a, 4242, { inner: 0.9, outer: 0.95 }));
        ring.mesh.position.set(c.x, c.y - size * 0.05, 0);
        ring.mesh.rotation.x = -1.25;
        ring.spinSpeed = 1.5;
        fade(ring, show, show + 0.2, show + 0.75, show + 1.05);
        for (let i = 0; i < n; i++) {
          const g = own(new Glow(0.45 * U, 0.45 * U, 'flare', 0xffd75a, 0xffffff));
          g.u.uOpacity.value = 0;
          tl.span(show, show + 1.05, (k) => {
            const a = (i / n) * Math.PI * 2 + k * 7;
            g.mesh.position.set(c.x + Math.cos(a) * size * 0.58, c.y - size * 0.05 + Math.sin(a) * size * 0.18, Math.sin(a) * size * 0.3);
            g.u.uOpacity.value = Math.min(1, k * 6) * (1 - easeIn(clamp01((k - 0.7) / 0.3)));
          });
        }
        tl.at(S + 0.05, () => (drone(0.9), swell(0.6)));
        break;
      }
      case 'synchro': {
        // the Tuner becomes rings of green light; the other materials, stars, rise through them
        const lv = Math.max(3, Math.min(10, info?.level ?? 6));
        const rings = Array.from({ length: 3 }, (_, i) => {
          const g = own(new Ring(1.9 * U, 0x7aff7a, 900 + i, { inner: 0.86, outer: 0.95 }));
          g.mesh.position.set(c.x, ground + (0.5 + i * 0.75) * U, 0);
          g.mesh.rotation.x = -1.25;
          g.spinSpeed = 3 * (i % 2 ? -1 : 1);
          g.u.uOpacity.value = 0;
          tl.span(S + 0.05 + i * 0.06, S + 0.25 + i * 0.06, (k) => ((g.u.uOpacity.value = k), g.mesh.scale.setScalar(easeOut(k))));
          tl.span(show, show + 0.35, (k) => ((g.u.uOpacity.value = 1 - k), g.mesh.scale.setScalar(1 + k * 0.6)));
          return g;
        });
        void rings;
        for (let i = 0; i < Math.min(8, lv); i++) {
          const g = own(new Glow(0.5 * U, 0.5 * U, 'star', 0xffffff, 0x7aff7a));
          const x = c.x + (r() - 0.5) * 0.5 * U;
          const t = S + 0.08 + i * 0.03;
          g.u.uOpacity.value = 0;
          tl.span(t, show, (k) => {
            g.mesh.position.set(x, lerp(ground, ground + 3 * U, easeIn(k)), 0.1);
            g.u.uOpacity.value = Math.sin(k * Math.PI) + 0.3;
          });
          tl.at(show, () => (g.u.uOpacity.value = 0));
        }
        // the gate: a pillar of light down through the rings
        const pillar = own(new Glow(1.5 * U, 6.5 * U, 'shaft', 0x7aff7a, 0xffffff));
        pillar.mesh.position.set(c.x, ground + 2.6 * U, -0.3);
        fade(pillar, show - 0.08, show, show + 0.2, show + 0.6, 1.2);
        tl.at(show - 0.05, () => (zap(0.4), boom(0.5), st.pulse('flash', 0.35), this.flash(0x9aff9a, 0.22), st.shake(0.4)));
        tl.at(S + 0.05, () => (whoosh(0.4, 300, 2400, 0.2), chime(0.6)));
        break;
      }
      case 'link': {
        // eight Link Arrows round it; its own light up one after another, then the circuit closes
        const rating = Math.max(1, Math.min(8, info?.linkRating ?? 2));
        const all = [0, 1, 2, 3, 4, 5, 6, 7];
        const lit: number[] = [];
        while (lit.length < rating) {
          const i = all[Math.floor(r() * all.length)];
          if (!lit.includes(i)) lit.push(i);
        }
        const R = 1.45 * U;
        const frame = own(new Ring(2 * R * 0.95, 0x4ad8ff, 5151, { inner: 0.9, outer: 0.95, star: 4 }));
        frame.mesh.position.set(c.x, c.y, -0.4);
        frame.mesh.rotation.z = Math.PI / 4;
        fade(frame, S + 0.05, S + 0.25, show + 0.4, show + 0.7, 0.8);
        all.forEach((i) => {
          const ang = (i / 8) * Math.PI * 2 + Math.PI / 2;
          const g = own(new Glow(0.55 * U, 0.55 * U, 'arrow', 0xff5a3a, 0xffd0a0));
          g.mesh.position.set(c.x + Math.cos(ang) * R, c.y + Math.sin(ang) * R, 0.2);
          g.mesh.rotation.z = ang - Math.PI / 2;
          const on = lit.indexOf(i);
          const tOn = S + 0.12 + Math.max(0, on) * 0.07;
          tl.span(S + 0.05, show + 0.7, (k) => {
            const t = S + 0.05 + k * (show + 0.65 - S);
            const base = 0.2 * clamp01((t - S - 0.05) / 0.15);
            const glow = on >= 0 && t >= tOn ? 1 : 0;
            g.u.uOpacity.value = Math.max(base, glow) * (1 - clamp01((t - show - 0.4) / 0.3));
          });
          if (on >= 0) {
            tl.at(tOn, () => (zap(0.12), P.emit({ x: g.mesh.position.x, y: g.mesh.position.y, z: 0.3, burst: 1.5 * U, life: 0.35, size: 0.08 * U, color: 0xffa070, drag: 3 }, Math.round(16 * q))));
            this.ray(tl, { x: g.mesh.position.x, y: g.mesh.position.y, z: 0.3 }, { x: c.x, y: c.y, z: 0.3 }, show - 0.18, 0.16, 0x4ad8ff, 0xffffff, 0.6);
          }
        });
        tl.at(show, () => (boom(0.45), st.pulse('flash', 0.3), this.flash(0x7adfff, 0.2)));
        break;
      }
      case 'tribute': {
        // the Tributes rise as souls; light falls where they went
        const n = (info?.level ?? 5) >= 7 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const x = c.x + (n === 1 ? 0 : (i - 0.5) * 1.2 * U);
          const g = own(new Glow(0.9 * U, 0.9 * U, 'flare', 0xfff0d0, 0xffffff));
          g.u.uOpacity.value = 0;
          tl.span(S + 0.02, S + 0.36, (k, dt) => {
            const y = lerp(ground + 0.2 * U, ground + 3.6 * U, easeIn(k));
            g.mesh.position.set(x + Math.sin(k * 8 + i) * 0.15 * U, y, 0.2);
            g.u.uOpacity.value = Math.min(1, k * 4) * (1 - easeIn(clamp01((k - 0.8) / 0.2)));
            for (let j = 0; j < rate(80 * q, dt); j++) P.emit({ x: g.mesh.position.x, y, z: 0.2, burst: 0.3 * U, vy: -0.6 * U, life: 0.45, size: 0.09 * U, color: 0xfff0d0, drag: 2 });
          });
        }
        const fall = own(new Glow(1.8 * U, 6 * U, 'shaft', col.light, 0xffffff));
        fall.mesh.position.set(c.x, ground + 2.8 * U, -0.4);
        fade(fall, show - 0.12, show - 0.02, show + 0.15, show + 0.55, 1);
        tl.at(S + 0.02, () => (whoosh(0.35, 300, 1800, 0.18), chime(0.3)));
        tl.at(show - 0.05, () => (boom(0.4), this.flash(0xfff0d0, 0.18)));
        break;
      }
      case 'special': {
        // a gate opens upright behind it
        const gate = own(new Ring(2.8 * U, col.main, 777, { inner: 0.66, outer: 0.93, star: 4 }));
        gate.mesh.position.set(c.x, c.y, -0.8);
        gate.spinSpeed = 2.5;
        gate.u.uOpacity.value = 0;
        tl.span(S + 0.05, S + 0.3, (k) => ((gate.u.uOpacity.value = k), gate.mesh.scale.set(easeOut(k), backOut(k), 1)));
        tl.span(show + 0.2, show + 0.5, (k) => (gate.u.uOpacity.value = 1 - k));
        tl.at(show, () => P.emit({ x: c.x, y: c.y, z: -0.6, burst: 4 * U, life: 0.6, size: 0.09 * U, color: col.light }, Math.round(60 * q)));
        tl.at(S + 0.05, () => zap(0.3));
        break;
      }
      case 'fusion': {
        // the materials swirl together in a vortex behind it
        const v = own(new Glow(5 * U, 5 * U, 'vortex', 0xb04aff, 0xff8a3a));
        v.mesh.position.set(c.x, c.y, -1.2);
        fade(v, S + 0.05, S + 0.3, show + 0.3, show + 0.7, 1);
        tl.span(S, show + 0.7, (k) => (v.mesh.rotation.z = k * 4));
        tl.at(S + 0.05, () => drone(0.6));
        break;
      }
      case 'ritual': {
        // flames rise round the circle as the offering burns
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const g = own(new Glow(0.7 * U, 1.2 * U, 'flame', 0x3a9aff, 0xffd070));
          g.mesh.position.set(c.x + Math.cos(a) * 1.25 * U, ground + Math.sin(a) * 0.45 * U + 0.4 * U, Math.sin(a) * 0.5);
          fade(g, S + 0.08 + i * 0.04, S + 0.2 + i * 0.04, show + 0.4, show + 0.75, 1);
        }
        tl.at(S + 0.08, () => (whoosh(0.4, 200, 900, 0.2), drone(0.6)));
        break;
      }
    }
  }

  /**
   * A card leaves without being destroyed (short and light): banished into a
   * dimensional rift, bounced back to its owner's hand, or shuffled into the Deck
   * (the Extra Deck for Fusion, Synchro, Xyz and Link Monsters).
   */
  private async leave(c: CardRef, to: 'hand' | 'deck' | 'banish' | 'extra'): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const P = st.particles;
    const D = to === 'hand' ? 0.55 : 0.7;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.12;
    this.dimTarget = 0.32;
    const side = this.side(c.controller);
    const near = side === 'near';
    const at = this.anchor(c, side);
    this.focusAt(at);
    const art = c.name && c.faceUp ? await this.art(c.name) : null;
    // (a battle figure of it still on stage goes with it)
    const act = this.actors.get(c.uid);
    if (act) tl.span(0, 0.2, (k) => this.setOpacity(act, Math.min(act.fig?.u.uOpacity.value ?? act.back?.u.uOpacity.value ?? 0, 1 - k)));
    const panel = tl.own(new CardPanel(art?.full ?? cardBack(), 0.85 * U, to === 'banish' ? 0xb07aff : 0x7adfff));
    panel.mesh.position.set(at.x, at.y, 0.3);
    if (c.def) panel.mesh.rotation.z = Math.PI / 2;
    panel.u.uOpacity.value = 0;
    tl.span(0, 0.08, (k) => (panel.u.uOpacity.value = k));
    if (to === 'banish') {
      const rift = tl.own(new Glow(1.3 * U, 2.3 * U, 'rift', 0xb07aff, 0xff7af0));
      rift.mesh.position.set(at.x, at.y, 0.1);
      tl.span(0, D, (k) => {
        rift.u.uK.value = k < 0.3 ? easeOut(k / 0.3) : k > 0.8 ? 1 - easeIn((k - 0.8) / 0.2) : 1;
        rift.u.uOpacity.value = 1;
      });
      tl.span(0.12, D - 0.1, (k) => {
        const e = easeIn(k);
        panel.mesh.scale.setScalar(1 - e * 0.9);
        panel.mesh.rotation.z = (c.def ? Math.PI / 2 : 0) + e * 2.5;
        panel.u.uOpacity.value = 1 - easeIn(clamp01((k - 0.5) / 0.5));
        panel.u.uTint.value = 0.4 * e;
      });
      tl.span(0.05, D - 0.15, (_k, dt) => {
        for (let i = 0; i < rate(120 * this.q, dt); i++) {
          const a = Math.random() * Math.PI * 2;
          P.emit({ x: at.x + Math.cos(a) * 1.1 * U, y: at.y + Math.sin(a) * 1.1 * U, z: 0.3, life: 0.4, size: 0.07 * U, color: i % 2 ? 0xb07aff : 0xffd8ff, drag: 0, pull: { x: at.x, y: at.y, strength: 16 * U, swirl: 7 * U } });
        }
      });
      tl.at(0, () => (drone(0.4), zap(0.2)));
      tl.at(D - 0.15, () => this.flash(0xb07aff, 0.08));
    } else if (to === 'hand') {
      const end = { x: at.x * 0.5, y: (near ? -1 : 1) * 3.5 * U, z: 1.2 };
      const trail = tl.own(new Ribbon(16, 0x9affff, 1));
      const hist: P3[] = [];
      tl.span(0.06, D, (k) => {
        const e = easeIn(k);
        const p = bez({ x: at.x, y: at.y, z: 0.3 }, end, (near ? 1 : -1) * 0.5 * U, e);
        panel.mesh.position.set(p.x, p.y + Math.sin(k * Math.PI) * 0.4 * U * (near ? 1 : -1), p.z);
        panel.mesh.rotation.x = -0.4 * e;
        panel.mesh.rotation.y = Math.PI * 2 * e;
        panel.u.uSheen.value = lerp(-0.4, 1.8, k);
        hist.push({ x: panel.mesh.position.x, y: panel.mesh.position.y, z: p.z - 0.05 });
        if (hist.length > 10) hist.shift();
        if (hist.length > 1) trail.set(hist, (q) => 0.1 * U * q);
      });
      tl.at(D, () => (trail.u.uOpacity.value = 0));
      tl.at(0.06, () => whoosh(0.35, 700, 2800, 0.15));
    } else {
      // it turns face-down and slides into the Deck (the Extra Deck sits on the other side), which riffles
      const deck = { x: (to === 'extra' ? -1 : 1) * (near ? 1 : -1) * 1.75 * U, y: (near ? -1 : 1) * 1.6 * U, z: 0.3 };
      const back = tl.own(new CardPanel(cardBack(), 0.85 * U, 0x7a9aff));
      back.u.uOpacity.value = 0;
      tl.span(0.06, 0.22, (k) => {
        panel.mesh.scale.set(1 - k, 1, 1);
        back.mesh.position.copy(panel.mesh.position);
        back.mesh.rotation.z = panel.mesh.rotation.z;
        back.mesh.scale.set(k, 1, 1);
        back.u.uOpacity.value = k > 0.5 ? 1 : 0;
        panel.u.uOpacity.value = k > 0.5 ? 0 : 1;
      });
      tl.span(0.22, D - 0.12, (k) => {
        const e = easeInOut(k);
        const p = bez({ x: at.x, y: at.y, z: 0.3 }, deck, 0.4 * U, e);
        back.mesh.position.set(p.x, p.y, p.z + 0.1);
        back.mesh.rotation.z = lerp(c.def ? Math.PI / 2 : 0, 0, e);
      });
      tl.span(D - 0.12, D, (k) => ((back.mesh.position.x = deck.x + Math.sin(k * Math.PI * 4) * 0.1 * U), (back.u.uOpacity.value = 1 - k)));
      tl.at(D - 0.12, () => (whoosh(0.15, 1800, 900, 0.12), P.emit({ x: deck.x, y: deck.y, z: 0.5, burst: 1.5 * U, life: 0.4, size: 0.06 * U, color: 0xbfd0ff, drag: 3 }, Math.round(20 * this.q))));
    }
    tl.commit(D * 0.7);
    tl.handoff = D - 0.15;
    return tl;
  }

  /** Life Points gained: green light rising on that duelist's side, the amount, their plate glowing. */
  private async heal(p: Pid, amount: number): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const D = 0.7;
    const tl = new Timeline(D, st);
    this.bgTarget = this.actors.size ? 0.4 : 0.05;
    this.dimTarget = this.actors.size ? 0.75 : 0.15;
    const near = this.side(p) === 'near';
    const y0 = (near ? -1 : 1) * 2.2 * U;
    const k = Math.min(1, amount / 3000);
    tl.span(0, D - 0.15, (_k, dt) => {
      for (let i = 0; i < rate((90 + 120 * k) * this.q, dt); i++) st.particles.emit({ x: (Math.random() - 0.5) * 3.6 * U, y: y0 - 0.4 * U, z: 0.6, vy: (1.6 + Math.random() * 1.5) * U, life: 0.6, size: 0.08 * U, color: Math.random() < 0.6 ? 0x5aff7a : 0xd8ffc8, drag: 0.6 });
    });
    for (let i = 0; i < 3; i++) {
      const g = tl.own(new Glow(0.5 * U, 0.5 * U, 'plus', 0x5aff7a, 0xd8ffc8));
      const x = (i - 1) * 1.1 * U;
      g.u.uOpacity.value = 0;
      tl.span(0.05 + i * 0.06, D, (q) => {
        g.mesh.position.set(x, y0 + q * 1.1 * U, 0.8);
        g.u.uOpacity.value = Math.sin(q * Math.PI);
      });
    }
    tl.at(0.05, () => {
      chime(0.95);
      this.ui.number({ text: `+${amount}`, color: 0x5aff7a, side: near ? 'bottom' : 'top', size: 1 + k * 0.8 });
      lpBeat(near ? 'bottom' : 'top', 'art-lp-heal', 600);
    });
    tl.commit(0.1);
    tl.handoff = 0.35;
    return tl;
  }

  /** Cards drawn by an effect: they slide off the Deck into the hand. */
  private async draw(p: Pid, count: number): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const n = Math.max(1, Math.min(5, count));
    const D = 0.45 + n * 0.08;
    const tl = new Timeline(D, st);
    this.bgTarget = this.actors.size ? 0.4 : 0.05;
    this.dimTarget = this.actors.size ? 0.75 : 0.15;
    const near = this.side(p) === 'near';
    const deck = { x: (near ? 1 : -1) * 1.75 * U, y: (near ? -1 : 1) * 1.6 * U, z: 0.3 };
    for (let i = 0; i < n; i++) {
      const pn = tl.own(new CardPanel(cardBack(), 0.8 * U, 0xffd75a));
      pn.u.uOpacity.value = 0;
      const t = i * 0.08;
      const end = { x: (i - (n - 1) / 2) * 0.55 * U, y: (near ? -1 : 1) * 3.4 * U, z: 1.2 };
      tl.span(t, t + 0.4, (k) => {
        const e = easeInOut(k);
        const q = bez(deck, end, -0.3 * U, e);
        pn.mesh.position.set(q.x, q.y, q.z);
        pn.mesh.rotation.z = (i - (n - 1) / 2) * 0.15 * e;
        pn.u.uOpacity.value = Math.min(1, k * 6) * (1 - easeIn(clamp01((k - 0.8) / 0.2)));
        pn.u.uSheen.value = lerp(-0.4, 1.8, k);
      });
      tl.at(t, () => whoosh(0.2, 900, 2600, 0.1));
    }
    tl.commit(D - 0.1);
    tl.handoff = D - 0.15;
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
    tl.handoff = 0.42;
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
          // never leave an earlier figure of this card behind on the stage
          if (have.fig && have.fig !== fig) this.stage.remove(have.fig);
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
        fig.u.uTint.value = 0.6 * (1 - k);
      });
      tl.at(0.4, () => this.ui.banner({ title: c.name, sub: 'Flip!', color: col.main, dur: 0.6, pos: this.side(c.controller) === 'near' ? 'bottom' : 'top' }));
      tl.handoff = 0.55;
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
        fig.u.uTint.value = 0.6 * (1 - k);
      });
      tl.span(0.85, 1.1, (k) => (fig.u.uOpacity.value = 1 - k));
      this.shafts(tl, { x: 0, y: -0.65 * U, z: 0 }, 3.6 * U, col.main, 0.3, 1.1, 2, 0.6);
    }
    tl.at(0.35, () => {
      st.particles.emit({ x: 0, y: 0.1 * U, burst: 3 * U, life: 0.6, size: 0.1 * U, color: col.accent }, 60);
      st.pulse('flash', 0.3);
      this.ui.banner({ title: c.name, sub: 'Flip Summon', color: col.main, dur: 0.7, pos: 'bottom' });
    });
    tl.handoff = 0.85;
    return tl;
  }

  /**
   * A Spell or Trap. Spells rise from their zone and open in a green rune burst;
   * traps flip up and slam toward the camera ("TRAP!", the screen's edge cracks).
   * Iconic cards play their own preset on top (SPELL_PRESETS); the monsters it
   * strikes rise off their cards first so the effect lands on them. A targeted card
   * sends a beam to its target and the effect resolves there.
   */
  private async activate(c: CardRef, what: 'spell' | 'trap', targets: Target[] = [], field: CardRef[] = []): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const info = card(c.name);
    const prof = profileFor(info, c.name);
    const art = await this.art(c.name);
    const base = what === 'spell' ? SPELL : TRAP;
    // its own preset, else the cinematic of its effect family
    const preset = presetFor(c.name) ?? familyPreset(c.name);
    const accent = preset?.accent ?? (art ? brighten(art.palette[0]) : 0xffffff);
    const side = this.side(c.controller);
    // who it strikes: the monsters it destroys in this update, else the preset's reach
    const foe = (f: CardRef) => f.controller !== c.controller;
    let victims = field.filter((f) => f.dies);
    if (!victims.length && preset?.scope) victims = field.filter((f) => preset.scope === 'all' || (preset.scope === 'own' ? !foe(f) : foe(f) && (preset.scope === 'opp' || !f.def)));
    if (preset?.family?.family === 'terrain') this.stage.backdrop.u.uTerrainAmt.value = 0;
    const monTargets = targets.filter((t) => t.card.faceUp && t.card.name && !victims.some((v) => v.uid === t.card.uid) && (field.some((f) => f.uid === t.card.uid) || card(t.card.name)?.kind === 'monster'));
    const figs: Actor[] = [];
    for (const v of [...victims, ...monTargets.map((t) => t.card)]) figs.push(await this.fieldActor(v));
    const hits = figs.slice(0, victims.length);
    const X = preset ? preset.dur : 0;
    const aimed = !preset && (targets.length > 0 || hits.length > 0);
    const open = what === 'spell' ? 0.36 : 0.3;
    const D = preset ? 1.3 + X : aimed ? 1.6 : 1.15;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.45;
    this.dimTarget = 0.82;
    this.focus.set(0.5, 0.52);
    this.stage.backdrop.u.uColor.value.set(what === 'spell' ? 0.02 : 0.08, what === 'spell' ? 0.08 : 0.02, what === 'spell' ? 0.06 : 0.07);
    const from = this.anchor(c, side);
    const struck = figs.length > 0 || targets.length > 0;
    const H = (struck ? 1.25 : 2.1) * U;
    // the stage's center; a card that strikes monsters hovers over its own zone instead, out of their way
    const mid = 0.15 * U;
    const cx = struck ? from.x * 0.5 : 0;
    const cy = struck ? lerp(from.y, 0, 0.25) : mid;
    const panel = tl.own(new CardPanel(art?.full ?? null, H, base));
    panel.u.uOpacity.value = 0;
    const ring = tl.own(new Ring(H * 1.48, base, prof.glyphs, { inner: 0.6, outer: 0.95, star: what === 'trap' ? 3 : 4 }));
    ring.mesh.position.set(cx, cy, -0.6);
    ring.spinSpeed = what === 'spell' ? 0.8 : -1.2;
    ring.u.uOpacity.value = 0;

    // the monsters it strikes rise off their cards
    tl.span(0.12, 0.45, (k) => {
      for (const a of figs) {
        a.oy = -0.3 * a.size * (1 - easeOut(k));
        this.setOpacity(a, Math.max(clamp01(k * 2), a.fig?.u.uOpacity.value ?? 0));
        this.place(a);
      }
    });
    // Spell/Trap targets: their cards light up where they lie
    const tPanels = new Map<number, CardPanel>();
    for (const t of targets) {
      if (figs.some((f) => f.uid === t.card.uid)) continue;
      const tart = t.card.faceUp && t.card.name ? await this.art(t.card.name) : null;
      const p = tl.own(new CardPanel(tart?.full ?? cardBack(), 0.78 * U, 0xffe08a));
      const at = this.anchor(t.card, this.side(t.card.controller));
      p.mesh.position.set(at.x, at.y, 0.2);
      if (t.card.def) p.mesh.rotation.z = Math.PI / 2;
      p.u.uOpacity.value = 0;
      tl.span(0.15, 0.4, (k) => (p.u.uOpacity.value = easeOut(k)));
      tPanels.set(t.card.uid, p);
    }
    const pointOf = (uid: number): P3 | null => {
      const a = figs.find((f) => f.uid === uid);
      if (a) return this.center(a);
      const p = tPanels.get(uid);
      return p ? { x: p.mesh.position.x, y: p.mesh.position.y, z: 0.3 } : null;
    };

    // the camera: a gentle push toward the card; whatever it strikes stays in frame
    const cardBox: Box[] = [{ x: cx, y: cy, z: 0.8, w: H * 0.36, h: H * 0.52 }];
    if (preset) cardBox.push({ x: 0, y: (side === 'near' ? 1 : -1) * 1.5 * U, z: 0, w: 1.4 * U, h: 0.5 * U }, { x: 0, y: (side === 'near' ? -1 : 1) * 1.3 * U, z: 0, w: 1.4 * U, h: 0.3 * U });
    for (const a of figs) cardBox.push(this.boxOf(a));
    for (const p of tPanels.values()) cardBox.push({ x: p.mesh.position.x, y: p.mesh.position.y, z: 0.2, w: 0.4 * U, h: 0.5 * U });
    const shot = this.fit(cardBox, prof.camYaw * 0.08, 0.02, { fill: preset || struck ? 0.92 : 0.72 });
    let s0: Shot | null = null;
    tl.span(0, 0.5, (k) => this.setShot((s0 ??= this.shot()), shot, easeInOut(k)));
    // once the card has opened, the camera leaves it for what it strikes: those framed big and a
    // little above the middle of the safe area, so the bursts over them stay in frame
    const struckBoxes: Box[] = [...figs.map((a) => this.boxOf(a)), ...[...tPanels.values()].map((p) => ({ x: p.mesh.position.x, y: p.mesh.position.y, z: 0.2, w: 0.4 * U, h: 0.5 * U }))];
    if (struckBoxes.length && (preset || aimed) && !preset?.ownCam) {
      const yaw0 = prof.camYaw * 0.08;
      const onto = this.effectShot(struckBoxes, yaw0, 0.05);
      const drift = this.effectShot(struckBoxes, yaw0 + (side === 'near' ? -0.1 : 0.1), 0.08);
      const a = Math.max(0.5, open + 0.12);
      const b = Math.min(D - 0.45, a + 0.42);
      tl.span(a, b, (k) => this.setShot(shot, onto, easeInOut(k)));
      tl.span(b, D - 0.35, (k) => this.setShot(onto, drift, easeInOut(k)));
    } else if (struck || preset) {
      // a slow drift while the effect plays (flat figures read as 3D when the camera moves)
      const drift = this.fit(cardBox, prof.camYaw * 0.08 + (side === 'near' ? -0.12 : 0.12), 0.05, { fill: 0.94 });
      tl.span(0.5, D - 0.35, (k) => this.setShot(shot, drift, easeInOut(k)));
    }
    let s1: Shot | null = null;
    tl.span(D - 0.35, D, (k) => this.setShot((s1 ??= this.shot()), REST, easeInOut(k)));
    if (what === 'spell') {
      tl.at(0, () => chime(0.7));
      tl.span(0, open, (k) => {
        const e = easeOut(k);
        panel.mesh.position.set(lerp(from.x, cx, e), lerp(from.y, cy, e), lerp(0, 0.8, e));
        panel.mesh.scale.setScalar(lerp(0.3, 1, e));
        panel.mesh.rotation.set(lerp(-1, 0, e), lerp(Math.PI, 0, e), 0);
        panel.u.uOpacity.value = clamp01(k * 3);
      });
    } else {
      // trap: it flips up off the field and slams toward the camera
      tl.at(0, () => zap(0.4));
      tl.span(0, open, (k) => {
        const e = easeIn(k);
        panel.mesh.position.set(lerp(from.x, cx, easeOut(k)), lerp(from.y, cy, easeOut(k)), lerp(0, 2.2, e));
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
        st.punch(4);
        st.pulse('chroma', 0.7);
        boom(0.5);
        zap(0.3);
        this.flash(TRAP, 0.35);
        this.ui.banner({ title: 'TRAP!', color: TRAP, big: true, dur: 0.75, pos: 'top' });
        // the screen's edge cracks like glass
        this.crackAt.set(side === 'near' ? 0.88 : 0.12, 0.8);
        setRgb(this.front.u.uCrackColor.value, 0xebf5ff);
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
    this.shafts(tl, { x: cx, y: cy - H * 0.6, z: 0 }, 4.4 * U, base, open - 0.1, D - 0.3, 3, 0.55);
    // the rune burst
    const burst = tl.own(new Glow(H * 1.9, H * 1.9, 'flare', base, accent));
    burst.mesh.position.set(cx, cy, 0.2);
    burst.u.uK.value = 0.6;
    tl.span(open, open + 0.5, (k) => {
      burst.u.uOpacity.value = 0.8 * (k < 0.12 ? k / 0.12 : 1 - easeOut((k - 0.12) / 0.88));
      burst.mesh.scale.setScalar(lerp(0.4, 1.2, easeOut(k)));
    });
    const rune = tl.own(new Ring(H * 2, base, prof.glyphs + 11, { inner: 0.8, outer: 0.9 }));
    rune.mesh.position.set(cx, cy, 0.3);
    rune.u.uOpacity.value = 0;
    rune.spinSpeed = 2;
    tl.span(open, open + 0.5, (k) => (rune.mesh.scale.setScalar(lerp(0.3, 1.3, easeOut(k))), (rune.u.uOpacity.value = 1 - easeIn(k))));
    tl.at(open, () => {
      st.particles.emit({ x: cx, y: cy, burst: 5 * U, life: 0.8, size: 0.09 * U, color: base }, Math.round(70 * this.q));
      st.particles.emit({ x: cx, y: cy, burst: 3 * U, life: 0.9, size: 0.12 * U, color: accent }, Math.round(40 * this.q));
      st.pulse('flash', 0.2);
      this.ui.banner({ title: c.name, sub: info ? `${info.sub} ${what === 'spell' ? 'Spell' : 'Trap'}` : '', color: base, dur: D - open - 0.3, pos: side === 'near' ? 'bottom' : 'top' });
    });
    // the card steps back to make room for its effect
    const back = !!preset || aimed;
    if (back) {
      const t0 = open + 0.3;
      tl.span(t0 - 0.1, t0 + 0.25, (k) => {
        const e = easeInOut(k);
        panel.mesh.scale.setScalar(lerp(1, 0.68, e));
        panel.mesh.position.z = lerp(0.8, -0.4, e);
        panel.u.uOpacity.value = lerp(1, 0.85, e);
      });
    }
    const cardPt: P3 = { x: cx, y: cy, z: 0.2 };
    if (preset) {
      const t0 = open + 0.35;
      const tpts = targets.map((t) => pointOf(t.card.uid)).filter((p): p is P3 => !!p);
      const spots: Spot[] = [];
      for (const t of targets) {
        const p = pointOf(t.card.uid);
        if (p) spots.push({ p, uid: t.card.uid, a: figs.find((f) => f.uid === t.card.uid) ?? null, panel: tPanels.get(t.card.uid) ?? null, destroyed: t.destroyed });
      }
      // a family cinematic aimed at its targets marks them with a beam first
      const fam = preset.family?.family;
      if (fam && !['equip', 'control', 'burn', 'token', 'terrain', 'negate'].includes(fam)) spots.forEach((x, i) => this.ray(tl, cardPt, x.p, open + 0.18 + i * 0.05, 0.2, base, accent, 0.8));
      preset.play({ d: this, st, tl, U, t0, t1: t0 + X + 0.35, panel, cy: mid, side, color: base, accent, opp: (side === 'near' ? 1 : -1) * 1.5 * U, own: (side === 'near' ? -1 : 1) * 1.5 * U, hits, pts: hits.map((a) => this.center(a)), targets: tpts, figs, card: cardPt, spots, art, seed: prof.seed });
    } else if (aimed) {
      // a beam from the card to each target; the effect resolves there
      const tB = open + 0.32;
      const list: { p: P3; uid: number; destroyed: boolean }[] = [];
      for (const t of targets) {
        const p = pointOf(t.card.uid);
        if (p) list.push({ p, uid: t.card.uid, destroyed: t.destroyed });
      }
      for (const a of hits) if (!list.some((x) => x.uid === a.uid)) list.push({ p: this.center(a), uid: a.uid, destroyed: true });
      list.forEach((x, i) => {
        const tt = tB + i * 0.07;
        this.ray(tl, cardPt, x.p, tt, 0.24, base, accent);
        this.resolveAt(tl, x.p, tt + 0.24, x.destroyed, base, accent, figs.find((f) => f.uid === x.uid) ?? null, tPanels.get(x.uid) ?? null);
      });
    }
    const z1 = back ? -0.4 : 0.8;
    const sc1 = back ? 0.68 : 1;
    tl.span(D - 0.35, D, (k) => {
      panel.mesh.position.set(lerp(cx, from.x, easeIn(k)), lerp(cy, from.y, easeIn(k)), lerp(z1, 0, k));
      panel.mesh.scale.setScalar(lerp(sc1, 0.3, easeIn(k)));
      panel.u.uOpacity.value = (back ? 0.85 : 1) * (1 - easeIn(k));
      ring.u.uOpacity.value = 1 - k;
    });
    // figures nothing destroys next sink back onto their cards instead of lingering after the camera resets
    // (read before the hand-off below: the next cue leaves the queue when it starts)
    let keep: Set<number> | null = null;
    const readKeep = () => (keep ??= new Set(this.queue.filter((q) => q.cue.kind === 'destroy').map((q) => (q.cue as { card: CardRef }).card.uid)));
    tl.at(D - 0.4, readKeep, false);
    tl.span(D - 0.3, D, (k) => {
      keep = readKeep();
      for (const a of figs) if (!keep.has(a.uid) && this.actors.get(a.uid) === a) this.setOpacity(a, Math.min(a.fig?.u.uOpacity.value ?? a.back?.u.uOpacity.value ?? 0, 1 - k));
    });
    tl.at(D, () => {
      for (const a of figs) if (keep && !keep.has(a.uid) && this.actors.get(a.uid) === a) (this.dropActor(a), this.actors.delete(a.uid));
      this.resetCam();
    }, false);
    // the effect has landed: what follows in the chain (a destruction) starts as the card flies home
    tl.handoff = D - 0.35;
    return tl;
  }

  /** A target picked after the card's activation already played: a beam from its zone and the effect resolving. */
  private async targetBeat(c: CardRef, targets: Target[]): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const info = card(c.name);
    const color = info?.kind === 'trap' ? TRAP : info?.kind === 'monster' ? GOLD : SPELL;
    const preset = presetFor(c.name);
    const accent = preset?.accent ?? 0xffffff;
    const D = 1.0;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.3;
    this.dimTarget = 0.6;
    const side = this.side(c.controller);
    const from = this.anchor(c, side);
    const src: P3 = { x: from.x, y: from.y, z: 0.5 };
    const glow = tl.own(new Glow(1.6 * U, 1.6 * U, 'flare', color, accent));
    glow.mesh.position.set(src.x, src.y, src.z);
    tl.span(0, 0.3, (k) => (glow.u.uOpacity.value = 0.7 * easeOut(k)));
    tl.span(0.6, D, (k) => (glow.u.uOpacity.value = 0.7 * (1 - k)));
    tl.at(0, () => chime(0.6));
    const boxes: Box[] = [{ x: src.x, y: src.y, z: 0.3, w: 0.5 * U, h: 0.5 * U }];
    let i = 0;
    for (const t of targets) {
      const mon = t.card.faceUp && !!t.card.name && card(t.card.name)?.kind === 'monster';
      const a = mon ? await this.fieldActor(t.card) : null;
      let panel: CardPanel | null = null;
      if (a) tl.span(0, 0.25, (k) => (this.setOpacity(a, Math.max(k, a.fig?.u.uOpacity.value ?? 0)), this.place(a)));
      else {
        const tart = t.card.faceUp && t.card.name ? await this.art(t.card.name) : null;
        const pp = tl.own(new CardPanel(tart?.full ?? cardBack(), 0.78 * U, 0xffe08a));
        panel = pp;
        const at = this.anchor(t.card, this.side(t.card.controller));
        pp.mesh.position.set(at.x, at.y, 0.2);
        if (t.card.def) pp.mesh.rotation.z = Math.PI / 2;
        pp.u.uOpacity.value = 0;
        tl.span(0, 0.2, (k) => (pp.u.uOpacity.value = k));
      }
      const p = a ? this.center(a) : { x: panel!.mesh.position.x, y: panel!.mesh.position.y, z: 0.3 };
      boxes.push({ ...p, w: 0.5 * U, h: 0.55 * U });
      const t0 = 0.2 + i++ * 0.07;
      this.ray(tl, src, p, t0, 0.22, color, accent);
      this.resolveAt(tl, p, t0 + 0.22, t.destroyed, color, accent, a, panel);
    }
    const shot = this.fit(boxes, 0, 0.03, { fill: 0.9 });
    let s0: Shot | null = null;
    tl.span(0, 0.3, (k) => this.setShot((s0 ??= this.shot()), shot, easeInOut(k)));
    let s1: Shot | null = null;
    tl.span(D - 0.3, D, (k) => this.setShot((s1 ??= this.shot()), REST, easeInOut(k)));
    tl.at(D, () => this.resetCam(), false);
    tl.handoff = D - 0.3;
    return tl;
  }

  /** A targeting beam: a glowing line racing from `a` to `b`, then fading from the tail. */
  private ray(tl: Timeline, a: P3, b: P3, t0: number, travel: number, color: number, light: number, width = 1) {
    const U = this.U;
    const layers: [Ribbon, number, number][] = [
      [tl.own(new Ribbon(16, color, 1)), 0.26 * width, 0.5],
      [tl.own(new Ribbon(16, light, 1)), 0.1 * width, 0.9],
      [tl.own(new Ribbon(16, 0xffffff, 0)), 0.035 * width, 1],
    ];
    const pts = [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 0.25 * U, z: Math.max(a.z, b.z) + 0.4 }, b];
    const curve = Array.from({ length: 12 }, (_, j) => bez3(pts, j / 11));
    for (const [r, w, op] of layers) {
      r.set(curve, (k) => w * U * (0.55 + 0.45 * Math.sin(k * Math.PI)));
      r.u.uHead.value = 0;
      r.u.uOpacity.value = op;
    }
    tl.span(t0, t0 + travel, (k) => {
      for (const [r] of layers) r.u.uHead.value = easeIn(k) * 1.05;
    });
    tl.span(t0 + travel + 0.12, t0 + travel + 0.4, (k) => {
      for (const [r, , op] of layers) ((r.u.uTail.value = easeIn(k)), (r.u.uOpacity.value = op * (1 - k)));
    });
    tl.at(t0, () => whoosh(travel + 0.1, 900, 3200, 0.14));
    tl.span(t0, t0 + travel, (k, dt) => {
      const p = bez3(pts, easeIn(k));
      for (let i = 0; i < rate(90 * this.q, dt); i++) this.stage.particles.emit({ x: p.x, y: p.y, z: p.z, burst: 0.5 * U, life: 0.35, size: 0.07 * U, color: i % 2 ? light : color, drag: 3 });
    });
  }

  /**
   * The effect resolving on its target: a destroy ray crashing down onto it (a card
   * shatters, a monster goes white-hot before its destruction), or an equip glow.
   */
  private resolveAt(tl: Timeline, p: P3, t: number, destroyed: boolean, color: number, light: number, a: Actor | null, panel: CardPanel | null) {
    const st = this.stage;
    const U = this.U;
    const P = st.particles;
    if (destroyed) {
      const core = tl.own(new Ribbon(10, 0xffffff, 0));
      const glow = tl.own(new Ribbon(10, color, 1));
      const pts = [
        { x: p.x, y: p.y + 3.2 * U, z: p.z + 0.4 },
        { x: p.x, y: p.y, z: p.z + 0.4 },
      ];
      core.set(pts, 0.06 * U);
      glow.set(pts, 0.32 * U);
      core.u.uHead.value = glow.u.uHead.value = 0;
      tl.span(t, t + 0.1, (k) => (core.u.uHead.value = glow.u.uHead.value = easeIn(k) * 1.05));
      tl.span(t + 0.16, t + 0.45, (k) => ((core.u.uTail.value = glow.u.uTail.value = easeIn(k)), (glow.u.uOpacity.value = 1 - k)));
      const ring = tl.own(new Glow(2.2 * U, 2.2 * U, 'shock', color, light));
      ring.mesh.position.set(p.x, p.y - 0.3 * U, p.z);
      ring.mesh.rotation.x = -1.15;
      tl.span(t + 0.1, t + 0.5, (k) => ((ring.u.uK.value = easeOut(k)), (ring.u.uOpacity.value = 1 - k * 0.3)));
      tl.at(t + 0.1, () => {
        zap(0.3);
        boom(0.35);
        st.shake(0.45);
        st.pulse('chroma', 0.45);
        this.flash(light, 0.2);
        P.emit({ x: p.x, y: p.y, z: p.z + 0.3, burst: 3.5 * U, vy: 1 * U, gravity: 5 * U, life: 0.6, size: 0.08 * U, color: light }, Math.round(40 * this.q));
      });
      if (a) this.strike(tl, a, t + 0.1);
      if (panel) tl.at(t + 0.12, () => void this.panelShards(tl, panel, color, 2.6 * U), false);
    } else {
      const ring = tl.own(new Ring(1.5 * U, color, 3131, { inner: 0.72, outer: 0.92, star: 4 }));
      ring.mesh.position.set(p.x, p.y - 0.45 * U, p.z);
      ring.mesh.rotation.x = -1.15;
      ring.spinSpeed = 2.5;
      ring.u.uOpacity.value = 0;
      tl.span(t, t + 0.25, (k) => (ring.mesh.scale.setScalar(easeOut(k)), (ring.u.uOpacity.value = k)));
      tl.span(t + 0.4, t + 0.75, (k) => (ring.u.uOpacity.value = 1 - k));
      const halo = tl.own(new Glow(1.8 * U, 1.8 * U, 'flare', color, light));
      halo.mesh.position.set(p.x, p.y, p.z + 0.2);
      tl.span(t, t + 0.7, (k) => (halo.u.uOpacity.value = 0.6 * Math.sin(k * Math.PI)));
      tl.at(t, () => (chime(0.85), P.emit({ x: p.x, y: p.y - 0.4 * U, z: p.z + 0.2, r: 0.4 * U, vy: 1.8 * U, life: 0.8, size: 0.08 * U, color: light, drag: 0.8 }, Math.round(45 * this.q))));
      if (a) tl.span(t, t + 0.6, (k) => void (a.fig && (a.fig.u.uTint.value = 0.28 * Math.sin(k * Math.PI))));
      if (panel) tl.span(t, t + 0.6, (k) => (panel.u.uTint.value = 0.5 * Math.sin(k * Math.PI)));
    }
  }

  /** A struck figure: white-hot and jolted back (its destruction follows). */
  /**
   * A struck figure's tint goes toward its attribute's color with its painted detail kept
   * (never a flat white blob); its uTint then says how much.
   */
  private hurtTint(f: Figure | null, prof: ArtProfile) {
    if (!f) return;
    setRgb(f.u.uTintCol.value, (ELEMENT_COLORS[prof.element] ?? ELEMENT_COLORS.LIGHT)[0]);
    f.u.uTintKeep.value = 1;
  }

  private strike(tl: Timeline, a: Actor, t: number, power = 1) {
    tl.at(t, () => this.hurtTint(a.fig, a.prof));
    tl.span(t, t + 0.4, (k) => {
      const kick = Math.sin(Math.min(1, k * 1.8) * Math.PI) * (1 - k * 0.5);
      a.oz = -0.4 * kick * power;
      a.lean = 0.25 * kick * power;
      a.ox = noise(k * 30 + a.uid) * 0.03 * this.U * (1 - k);
      if (a.fig) a.fig.u.uTint.value = Math.max(0.08, 0.45 * (1 - easeOut(k))) * power;
      if (a.back) a.back.u.uTint.value = 0.65 * (1 - easeOut(k)) * power;
      this.place(a);
    });
  }

  /** A card (panel) breaking into pieces of itself. */
  private panelShards(tl: Timeline, panel: CardPanel, color: number, power: number, gravity = 9 * this.U) {
    const m = panel.mesh;
    const g = m.geometry as PlaneGeometry;
    const like = {
      mesh: { position: m.position, rotation: m.rotation, scale: { x: g.parameters.width * m.scale.x, y: g.parameters.height * m.scale.y } } as unknown as Mesh,
      u: { uArt: panel.u.uMap, uDepth: { value: solidTex() }, uMatte: { value: 1 } },
    };
    const sh = tl.own(new Shards(like, color, 4, 5, gravity));
    sh.burst(m.position.x, m.position.y - 0.1 * this.U, power, { x: 0, y: 0.3 * this.U });
    sh.life = 0.9;
    panel.u.uOpacity.value = 0;
    this.stage.particles.emit({ x: m.position.x, y: m.position.y, z: m.position.z + 0.2, r: 0.3 * this.U, burst: 2.5 * this.U, life: 0.6, size: 0.06 * this.U, color, drag: 2 }, Math.round(36 * this.q));
    return sh;
  }

  /**
   * A monster uses its effect: it rises glowing (off its own card when it is on the
   * field), then its effect family plays from it (families.ts): what it destroys,
   * banishes, revives, burns or powers up.
   */
  private async monsterEffect(c: CardRef, targets: Target[] = [], field: CardRef[] = []): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const info = card(c.name);
    const prof = profileFor(info, c.name);
    const art = await this.art(c.name);
    const col = this.colors(prof, art);
    const cls: FxClass = info && info.kind === 'monster' && !info.vanilla ? classify(info) : { family: 'aura' };
    const fx = FAMILY_FX[cls.family];
    const side = this.side(c.controller);
    // what it strikes: what dies in this update, else (board-wide families) the side it reaches
    const foe = (f: CardRef) => f.controller !== c.controller;
    let victims = field.filter((f) => f.dies && f.uid !== c.uid);
    const scoped = ['destroyAll', 'powerDown', 'powerUp', 'position', 'bounce', 'banish', 'toDeck', 'lock'].includes(cls.family);
    if (!victims.length && scoped && cls.scope) victims = field.filter((f) => f.uid !== c.uid && (cls.scope === 'all' || (cls.scope === 'own' ? !foe(f) : foe(f) && (cls.scope === 'opp' || !f.def))));
    const monTargets = targets.filter((t) => t.card.uid !== c.uid && t.card.faceUp && t.card.name && !victims.some((v) => v.uid === t.card.uid) && (field.some((f) => f.uid === t.card.uid) || card(t.card.name)?.kind === 'monster'));
    const figs: Actor[] = [];
    for (const v of [...victims, ...monTargets.map((t) => t.card)]) figs.push(await this.fieldActor(v));
    const hits = figs.slice(0, victims.length);
    const T0 = 0.45;
    const D = T0 + fx.dur + 0.5;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.4;
    this.dimTarget = 0.78;
    this.stage.backdrop.u.uColor.value.set(((col.main >> 16) & 255) / 1100, ((col.main >> 8) & 255) / 1100, (col.main & 255) / 1100);
    if (cls.family === 'terrain') this.stage.backdrop.u.uTerrainAmt.value = 0;
    // the monster: where it fights; else up off its own card; else (the 3D Card Viewer) center stage
    let self = this.actors.get(c.uid) ?? null;
    const own: Actor[] = [];
    let fig: Figure | null = self?.fig ?? null;
    let at: P3;
    if (self) at = this.center(self);
    else if (c.rect && c.faceUp && c.name) {
      self = await this.fieldActor(c);
      own.push(self);
      const me = self;
      tl.span(0, 0.3, (k) => ((me.oy = -0.3 * me.size * (1 - easeOut(k))), this.setOpacity(me, clamp01(k * 2)), this.place(me)));
      fig = me.fig;
      at = this.center(me);
    } else {
      const crowd = figs.length > 0 || targets.length > 0;
      at = { x: 0, y: (crowd ? (side === 'near' ? -0.9 : 0.9) : 0.1) * U, z: 0 };
      if (art) {
        const f = tl.own(this.figure(art, (crowd ? 1.15 : 1.5) * U, prof, col.main));
        f.mesh.position.set(at.x, at.y, 0);
        f.u.uOpacity.value = 0;
        tl.span(0, 0.25, (k) => (f.u.uOpacity.value = k));
        tl.span(D - 0.25, D, (k) => (f.u.uOpacity.value = 1 - k));
        this.shafts(tl, { x: at.x, y: at.y - 0.7 * U, z: 0 }, 3.6 * U, col.main, 0, D, 2, 0.6);
        fig = f;
      }
    }
    // the monsters it reaches rise off their cards
    tl.span(0.12, 0.45, (k) => {
      for (const a of figs) {
        a.oy = -0.3 * a.size * (1 - easeOut(k));
        this.setOpacity(a, Math.max(clamp01(k * 2), a.fig?.u.uOpacity.value ?? 0));
        this.place(a);
      }
    });
    // Spell/Trap targets light up where they lie
    const spots: Spot[] = [];
    for (const t of targets) {
      if (t.card.uid === c.uid) continue;
      const a = figs.find((f) => f.uid === t.card.uid) ?? null;
      let panel: CardPanel | null = null;
      if (!a) {
        const tart = t.card.faceUp && t.card.name ? await this.art(t.card.name) : null;
        const pp = tl.own(new CardPanel(tart?.full ?? cardBack(), 0.78 * U, 0xffe08a));
        const pa = this.anchor(t.card, this.side(t.card.controller));
        pp.mesh.position.set(pa.x, pa.y, 0.2);
        if (t.card.def) pp.mesh.rotation.z = Math.PI / 2;
        pp.u.uOpacity.value = 0;
        tl.span(0.15, 0.4, (k) => (pp.u.uOpacity.value = easeOut(k)));
        panel = pp;
      }
      spots.push({ p: a ? this.center(a) : { x: panel!.mesh.position.x, y: panel!.mesh.position.y, z: 0.3 }, uid: t.card.uid, a, panel, destroyed: t.destroyed });
    }
    const ring = tl.own(new Ring(1.8 * U, col.main, prof.glyphs));
    ring.mesh.position.set(at.x, at.y - 0.7 * U, 0);
    ring.mesh.rotation.x = -1.1;
    ring.spinSpeed = 2;
    ring.u.uOpacity.value = 0;
    tl.span(0, 0.3, (k) => (ring.u.uOpacity.value = k));
    tl.span(D - 0.3, D, (k) => (ring.u.uOpacity.value = 1 - k));
    tl.at(0.05, () => chime(0.5));
    const f0 = fig;
    tl.span(0.05, T0 + 0.2, (k, dt) => {
      if (f0) f0.u.uTint.value = 0.35 * Math.sin(k * Math.PI);
      for (let i = 0; i < rate(90 * this.q, dt); i++) {
        const a = Math.random() * Math.PI * 2;
        st.particles.emit({ x: at.x + Math.cos(a) * 0.7 * U, y: at.y - 0.6 * U, vy: 2.2 * U, life: 0.7, size: 0.09 * U, color: Math.random() < 0.5 ? col.main : col.accent, drag: 0.5 });
      }
    });
    const label = FX_FAMILIES.find((f) => f.id === cls.family)?.label ?? 'Effect';
    tl.at(0.2, () => this.ui.banner({ title: c.name, sub: `Effect · ${label}`, color: col.main, dur: D - 0.5, pos: side === 'near' ? 'bottom' : 'top' }));
    // its effect, from the monster
    for (const s of spots) if (!['equip', 'control', 'burn', 'token', 'terrain', 'negate'].includes(cls.family)) this.ray(tl, { ...at, z: 0.5 }, s.p, T0 - 0.15, 0.2, col.main, col.light, 0.8);
    const opp = (side === 'near' ? 1 : -1) * 1.5 * U;
    playFamily({ d: this, st, tl, U, t0: T0, t1: T0 + fx.dur, side, cy: 0.15 * U, opp, own: -opp, src: { ...at, z: 0.6 }, hits, spots, cls, text: info ? effectText(info) : '', art, seed: prof.seed });
    // the camera: the monster and what it reaches (its row when it names nothing)
    const boxes: Box[] = [{ x: at.x, y: at.y, z: 0.3, w: 0.6 * U, h: 0.7 * U }];
    for (const a of figs) boxes.push(this.boxOf(a));
    for (const s of spots) if (s.panel) boxes.push({ ...s.p, w: 0.4 * U, h: 0.5 * U });
    if (!figs.length && !spots.length && cls.family !== 'terrain') boxes.push({ x: 0, y: opp, z: 0, w: 1.4 * U, h: 0.5 * U }, { x: 0, y: -opp, z: 0, w: 1.4 * U, h: 0.4 * U });
    const shot = this.fit(boxes, prof.camYaw * 0.08, 0.03, { fill: 0.9 });
    const drift = this.fit(boxes, prof.camYaw * 0.08 + (side === 'near' ? -0.1 : 0.1), 0.06, { fill: 0.92 });
    let s0: Shot | null = null;
    tl.span(0, 0.4, (k) => this.setShot((s0 ??= this.shot()), shot, easeInOut(k)));
    tl.span(0.4, D - 0.35, (k) => this.setShot(shot, drift, easeInOut(k)));
    let s1: Shot | null = null;
    tl.span(D - 0.35, D, (k) => this.setShot((s1 ??= this.shot()), REST, easeInOut(k)));
    // figures nothing destroys next sink back onto their cards
    let keep: Set<number> | null = null;
    const readKeep = () => (keep ??= new Set(this.queue.filter((q) => q.cue.kind === 'destroy').map((q) => (q.cue as { card: CardRef }).card.uid)));
    tl.at(D - 0.4, readKeep, false);
    const gone = [...figs, ...own];
    tl.span(D - 0.3, D, (k) => {
      keep = readKeep();
      for (const a of gone) if (!keep.has(a.uid) && this.actors.get(a.uid) === a) this.setOpacity(a, Math.min(a.fig?.u.uOpacity.value ?? a.back?.u.uOpacity.value ?? 0, 1 - k));
    });
    tl.at(
      D,
      () => {
        for (const a of gone) if (keep && !keep.has(a.uid) && this.actors.get(a.uid) === a) (this.dropActor(a), this.actors.delete(a.uid));
        this.resetCam();
      },
      false,
    );
    tl.handoff = D - 0.35;
    return tl;
  }

  /**
   * A Skill: its sigil in its duelist's colors with their emblem over it, the banner
   * naming the Skill and whose it is, then its effect family plays from the sigil.
   */
  private async skill(p: Pid, name: string): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const info = card(name);
    const prof = profileFor(info, name);
    const cls: FxClass = info ? classify(info) : { family: 'aura' };
    const fx = FAMILY_FX[cls.family];
    const who = characterName(info?.character);
    const fl = flourishOf(who, prof.seed);
    const T0 = 0.55;
    const D = T0 + fx.dur + 0.45;
    const tl = new Timeline(D, st);
    const side = this.side(p);
    this.bgTarget = 0.5;
    this.dimTarget = 0.78;
    this.stage.backdrop.u.uColor.value.set(((fl.color >> 16) & 255) / 1200, ((fl.color >> 8) & 255) / 1200, (fl.color & 255) / 1200);
    if (cls.family === 'terrain') this.stage.backdrop.u.uTerrainAmt.value = 0;
    const cy = 0.15 * U;
    const ring = tl.own(new Ring(3 * U, fl.color, prof.glyphs, { inner: 0.5, outer: 0.95, star: fl.star }));
    ring.mesh.position.set(0, cy, -0.5);
    ring.spinSpeed = fl.spin;
    ring.u.uOpacity.value = 0;
    tl.span(0, 0.3, (k) => (ring.mesh.scale.setScalar(easeOut(k)), (ring.u.uOpacity.value = k)));
    tl.span(T0 + 0.1, D, (k) => (ring.u.uOpacity.value = 1 - easeIn(k) * 0.9));
    // the duelist's emblem flares over the sigil
    const em = fl.mode === 'eye' ? null : tl.own(new Glow(1.6 * U, 1.6 * U, fl.mode, fl.color, fl.light));
    const eye = fl.mode === 'eye' ? tl.own(new Ring(1.8 * U, fl.color, 7, { eye: true, inner: 0.9, outer: 0.95 })) : null;
    const emb = (em ?? eye)!;
    emb.mesh.position.set(0, cy + 0.15 * U, 0.4);
    emb.u.uOpacity.value = 0;
    tl.span(0.05, 0.4, (k) => {
      emb.u.uOpacity.value = easeOut(k);
      emb.mesh.scale.setScalar(lerp(1.8, 1, backOut(k)));
      if (eye) eye.u.uEye.value = easeOut(k);
      if (em && fl.mode === 'die') em.u.uK.value = 1 + Math.floor(k * 17) % 6;
    });
    tl.span(T0, T0 + 0.3, (k) => (emb.u.uOpacity.value = 1 - easeIn(k)));
    // a slash of the duelist's color across the screen behind the banner
    const slash = tl.own(new Ribbon(6, fl.color, 1));
    slash.set([{ x: -3.5 * U, y: cy - 0.5 * U, z: 0.2 }, { x: 3.5 * U, y: cy + 0.3 * U, z: 0.2 }], 0.5 * U);
    slash.u.uHead.value = 0;
    tl.span(0.08, 0.3, (k) => (slash.u.uHead.value = easeOut(k) * 1.05));
    tl.span(T0 - 0.1, T0 + 0.2, (k) => ((slash.u.uTail.value = easeIn(k)), (slash.u.uOpacity.value = 1 - k)));
    this.shafts(tl, { x: 0, y: -1.2 * U, z: -0.5 }, 4 * U, fl.color, 0, D, 3, 0.55);
    tl.at(0.1, () => {
      chime(0.9);
      whoosh(0.3, 600, 2600, 0.2);
      st.pulse('flash', 0.3);
      st.particles.emit({ x: 0, y: cy, burst: 4 * U, life: 0.8, size: 0.1 * U, color: fl.light }, Math.round(60 * this.q));
      const label = FX_FAMILIES.find((f) => f.id === cls.family)?.label;
      this.ui.banner({ title: name.replace(/ \(Skill Card\)$/, ''), sub: [who || 'Skill', `Skill · ${side === 'near' ? 'you' : 'opponent'}`, label].filter(Boolean).join(' · '), color: fl.color, big: true, dur: D - 0.4, pos: 'mid' });
    });
    const opp = (side === 'near' ? 1 : -1) * 1.5 * U;
    playFamily({ d: this, st, tl, U, t0: T0, t1: T0 + fx.dur, side, cy, opp, own: -opp, src: { x: 0, y: cy, z: 0.6 }, hits: [], spots: [], cls, text: info ? effectText(info) : '', art: null, seed: prof.seed });
    const shot = this.fit([{ x: 0, y: 0, z: 0, w: 1.6 * U, h: 2 * U }], 0, 0.02, { fill: 0.95 });
    let s0: Shot | null = null;
    tl.span(0, 0.4, (k) => this.setShot((s0 ??= this.shot()), shot, easeInOut(k)));
    let s1: Shot | null = null;
    tl.span(D - 0.35, D, (k) => this.setShot((s1 ??= this.shot()), REST, easeInOut(k)));
    tl.at(D, () => this.resetCam(), false);
    tl.handoff = D - 0.3;
    return tl;
  }

  /** The attack is declared: both fighters take the stage, the camera goes over the attacker's shoulder, the attacker winds up. */
  private async attack(a: CardRef, t: CardRef | null, _defender: Pid): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    if (!this.actors.size) this.battleSide = this.side(a.controller);
    const att = await this.actor(a, 'att');
    const tgt = t ? await this.actor(t, 'def') : null;
    const col = finishOf(a) >= FIN.MI ? MILL_COLS : this.colors(att.prof, att.art);
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
    // camera: down low over the attacker's shoulder, then a slow push-in through the wind-up
    const low = this.battleShot(att, tgt, T, 0.32, -0.05, 0.9);
    const push = this.battleShot(att, tgt, T, 0.35, -0.02, 0.97);
    let s0: Shot | null = null;
    tl.span(0, 0.42, (k) => this.setShot((s0 ??= this.shot()), low, easeInOut(k)));
    tl.span(0.42, D, (k) => this.setShot(low, push, easeOut(k)));
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
    const goldBlow = finishOf(a) >= FIN.MI;
    const charge = tl.own(new Glow(1.2 * U * (sig?.charge ?? 1), 1.2 * U * (sig?.charge ?? 1), 'flare', goldBlow ? 0xffc93a : col.main, goldBlow ? 0xffe9a8 : col.light));
    charge.mesh.position.set(M.x, M.y, M.z);
    tl.span(0.4, D, (k, dt) => {
      att.lean = -0.3 * easeOut(k);
      att.oz = -0.25 * easeOut(k);
      this.place(att);
      // kept soft so the glow at the muzzle never blows out the attacker's face
      charge.u.uOpacity.value = easeIn(k) * 0.42;
      charge.mesh.scale.setScalar(lerp(0.3, 0.8, easeOut(k)));
      const n = Math.floor(140 * this.q * dt + Math.random());
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rr = (0.9 + Math.random() * 0.6) * U;
        st.particles.emit({ x: M.x + Math.cos(ang) * rr, y: M.y + Math.sin(ang) * rr, z: M.z, life: 0.4, size: 0.08 * U, color: Math.random() < 0.5 ? col.main : col.light, drag: 0, pull: { x: M.x, y: M.y, strength: 20 * U, swirl: 5 * U } });
      }
    });
    tl.at(0.4, () => (att.prof.tier >= 2 ? swell(0.6) : whoosh(0.45, 200, 1600, 0.15)));
    sig?.windup?.({ d: this, st, tl, U, at: att, M, col, t0: 0.3, t1: D });
    const mill = finishOf(a) >= FIN.MI;
    if (mill) this.millenniumWindup(tl, att, M, D);
    tl.at(0.3, () => this.ui.banner({ title: `${att.prof.attackName}!`, sub: mill ? `◈ ${a.name} ◈` : a.name, color: mill ? 0xffd56a : col.main, big: true, dur: 1.2, pos: 'bottom', finish: mill ? 'MI' : undefined }));
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
    const col = a && finishOf(a) >= FIN.MI ? MILL_COLS : this.colors(prof, att?.art ?? null);
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
    // (the blow's camera: see below)
    const lunges = ['slash', 'claw', 'ram'].includes(sig?.style ?? prof.style);
    // (a clash holds both fighters on screen for the whole exchange: framed tighter)
    const whip = this.battleShot(att, tgt, T, lunges ? 0.22 : 0.16, 0.07, clash ? 1 : tgt ? 0.95 : 0.95);
    // monster against monster: the numbers that decide it, up early (its text has faded in well
    // before the blow lands) and held a little past the impact
    if (a && t && t.faceUp && t.name) {
      const ai = card(a.name);
      const ti = card(t.name);
      const av = ai?.atk;
      const tv = t.def ? ti?.def : ti?.atk;
      if (typeof av === 'number' && typeof tv === 'number') {
        const fireAt = Math.max(0.02, W * 0.5);
        tl.at(fireAt, () => {
          const title = `${av}  vs  ${tv}`;
          this.ui.banner({ title, sub: t.def ? 'ATK · DEF' : 'ATK · ATK', color: av > tv ? col.main : tcol.main, dur: hitAt - fireAt + (clash ? 0.75 : 0.6), pos: 'mid' });
          // the plate goes in the gap between the two fighters (never on the defender's chin)
          if (att && tgt) this.placeBetween(title, att, tgt, whip);
        });
      }
    }
    STYLES[sig?.style ?? prof.style](ctx, 1);
    if (prof.style2 && !sig) STYLES[prof.style2](ctx, 0.55);
    sig?.travel?.(ctx);
    // the camera: a whip-pan with the blow, a dutch-angle punch on impact, then it settles;
    // every shot is fitted to the safe area, so attacker and target both stay framed
    const base = this.shot();
    const m = this.battleSide === 'near' ? 1 : -1;
    const settle = this.battleShot(att, tgt, T, 0.3, 0.09, clash ? 0.98 : 0.92);
    tl.span(W * 0.5, hitAt, (k) => this.setShot(base, whip, easeInOut(k)));
    tl.span(hitAt + 0.08, D, (k) => this.setShot(whip, settle, easeInOut(k)));
    const rollTo = 0.085 * m * (tgt ? 1 : 1.3);
    tl.span(hitAt, hitAt + 0.06, (k) => (this.roll = rollTo * easeOut(k)));
    tl.span(hitAt + 0.06, D, (k) => (this.roll = rollTo * (1 - easeInOut(k))));
    if (!tgt) {
      this.front.u.uSpeed.value = 0;
      tl.span(W, hitAt, (k) => (this.front.u.uSpeed.value = easeIn(k)));
      // the defending duelist takes it: their side cracks red and their Life Points plate shakes
      const defSide: 'top' | 'bottom' = this.side(defender) === 'near' ? 'bottom' : 'top';
      const crackAt = new Vector2(0.5, defSide === 'top' ? 0.86 : 0.14);
      tl.at(hitAt, () => {
        const r = lpBeat(defSide, 'art-lp-shake', 450);
        const cv = st.canvas.getBoundingClientRect();
        if (r && cv.height > 0) crackAt.set(clamp01((r.left + r.width / 2 - cv.left) / cv.width), clamp01(1 - (r.top + r.height / 2 - cv.top) / cv.height));
        setRgb(this.front.u.uCrackColor.value, 0xff6a5a);
        this.dimTarget = 0.62;
      });
      tl.span(hitAt, hitAt + 0.5, (k) => {
        this.front.u.uSpeed.value = 1 - clamp01(k * 1.6);
        this.front.u.uRed.value = Math.max(this.front.u.uRed.value, 0.24 * (1 - easeIn(k)));
        this.front.u.uCrack.value = easeOut(clamp01(k * 3)) * 1.7;
        this.front.u.uCrackOp.value = 1 - easeIn(k);
        this.front.u.uCrackAt.value.copy(crackAt);
      });
    }
    const debris = [tcol.main, tcol.accent];
    // a Millennium blow lands in gold
    const mill = !!a && finishOf(a) >= FIN.MI;
    if (mill) this.millenniumBlow(tl, M, P, W, hitAt);
    this.impact(tl, hitAt, P, { color: mill ? 0xffc93a : col.main, light: mill ? 0xffe9a8 : col.light, debris: clash ? [col.main, tcol.main] : debris, power: clamp01(0.45 + prof.tier * 0.18 + (tgt ? 0 : 0.2)) * (mill ? 0.6 : 1), ground: tgt ? tgt.y - tgt.size * 0.46 : T.y - 0.8 * U });
    tl.at(hitAt, () => {
      boom(0.35 + prof.tier * 0.15 + (tgt ? 0 : 0.25));
      // the battle damage lands with the blow
      // (big: it has to read in the ~0.9 s it pops and flies to the Life Points)
      if (dmg) this.damageNumber(this.side(dmg.player) === 'near' ? 'bottom' : 'top', `-${dmg.amount}`, (tgt ? 1.45 : 1.6) + Math.min(1, dmg.amount / 3000) * 0.7);
    });
    tl.commit(hitAt);
    if (dmg) {
      const k = Math.min(1, dmg.amount / 3000);
      // a direct hit keeps its red wash; monster against monster only tints the edges a
      // little, so both fighters stay readable through the blow
      tl.span(hitAt, hitAt + 0.45, (x) => (this.front.u.uRed.value = (tgt ? Math.min(0.12, 0.06 + k * 0.06) : 0.22) * (1 - easeOut(x))));
    }
    if (tgt && !clash) {
      // the defender takes it: knocked back, flaring in its attribute's color
      tl.at(hitAt, () => this.hurtTint(tgt.fig, tgt.prof));
      tl.span(hitAt, hitAt + 0.45, (k) => {
        const kick = Math.sin(Math.min(1, k * 1.6) * Math.PI) * (1 - k * 0.5);
        tgt.oz = -0.7 * kick;
        tgt.oy = 0.12 * U * kick;
        tgt.lean = 0.35 * kick;
        if (tgt.fig) tgt.fig.u.uTint.value = 0.5 * (1 - easeOut(k));
        if (tgt.back) tgt.back.u.uTint.value = 0.62 * (1 - easeOut(k));
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
        tl.at(knock, () => this.hurtTint(loser.fig, loser.prof));
        tl.span(knock, knock + 0.45, (k) => {
          const kick = Math.sin(Math.min(1, k * 1.6) * Math.PI) * (1 - k * 0.5);
          loser.ox = 0;
          loser.oz = (loser === att ? 0.6 : -0.7) * kick;
          loser.lean = (loser === att ? -0.4 : 0.35) * kick;
          if (loser.fig) loser.fig.u.uTint.value = 0.55 * (1 - easeOut(k));
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
      // the loser's shatter starts while it is still thrown back
      if (loser && dies(loser.uid)) tl.handoff = knock + 0.15;
    }
    // the defender's shatter starts in the recoil
    if (tgt && !clash) tl.handoff = hitAt + 0.2;
    // otherwise (a clash both survive, a direct hit) what follows starts as the blow settles
    tl.handoff ??= Math.max(hitAt + 0.3, D - 0.3);
    return tl;
  }

  /**
   * A damage number that pops where the blow landed, then flies into the Life Points
   * plate of the side that took it (toward that edge of the screen when there is none),
   * and the plate shakes as it arrives.
   */
  /**
   * Moves the banner just shown (by its title) into the gap between the defender (above) and
   * the attacker (below) as `shot` frames them; with no room between them, above the defender
   * or, failing that, over the attacker's chest: never on either fighter's face.
   */
  private placeBetween(title: string, att: Actor, tgt: Actor, shot: Shot) {
    if (typeof document === 'undefined') return;
    const all = document.querySelectorAll<HTMLElement>('.art-banner');
    const el = all[all.length - 1];
    if (!el || !el.textContent?.includes(title)) return;
    const cv = this.stage.canvas.getBoundingClientRect();
    const host = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    if (!host || cv.height <= 0) return;
    const cam = this.probe;
    cam.aspect = this.stage.camera.aspect;
    cam.fov = BASE_FOV;
    cam.updateProjectionMatrix();
    cam.position.copy(shot.pos);
    cam.lookAt(shot.look);
    cam.updateMatrixWorld();
    const v = new Vector3();
    // screen extent (fractions of the canvas height from its top) of a fighter's figure
    const ext = (a: Actor) => {
      const b = this.boxOf(a);
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const sy of [-0.92, 0.92]) {
        v.set(b.x, b.y + sy * b.h, b.z).project(cam);
        const f = (1 - v.y) / 2;
        y0 = Math.min(y0, f);
        y1 = Math.max(y1, f);
      }
      return { top: y0, bottom: y1 };
    };
    const d = ext(tgt);
    const a = ext(att);
    const safe = this.safe();
    const h = (el.offsetHeight || 56) / cv.height;
    const pad = 6 / cv.height;
    let y: number;
    if (a.top - d.bottom >= h + pad) y = (a.top + d.bottom) / 2;
    else if (d.top - safe.top >= h + 2 * pad) y = d.top - h / 2 - pad;
    else y = Math.max(d.bottom + h / 2 + pad, a.top + (a.bottom - a.top) * 0.45);
    y = Math.min(1 - safe.bottom - h / 2, Math.max(safe.top + h / 2, y));
    el.style.top = `${Math.round(cv.top - host.top + y * cv.height - (el.offsetHeight || 56) / 2)}px`;
    el.style.bottom = 'auto';
  }

  private damageNumber(side: 'top' | 'bottom', text: string, size: number) {
    this.ui.number({ text, color: 0xff4a4a, side, size });
    if (typeof document === 'undefined') return;
    const all = document.querySelectorAll<HTMLElement>('.art-number');
    const el = all[all.length - 1];
    if (!el) return;
    // it pops in at 2.2x: kept narrow enough to stay on screen through the pop (narrower still
    // when the Shadow Realm opens right after it, under the eye and the overkill count)
    const shadow = this.queue.some((q) => q.cue.kind === 'win' && !!q.cue.shadow);
    const maxW = (this.stage.canvas.clientWidth || window.innerWidth) * (shadow ? 0.4 : 0.62);
    if (el.offsetWidth > maxW) el.style.setProperty('--s', (size * (maxW / el.offsetWidth)).toFixed(3));
    const a = el.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const plate = lpPlate(side)?.getBoundingClientRect();
    const tx = plate ? plate.left + plate.width / 2 - ax : 0;
    const ty = plate ? plate.top + plate.height / 2 - ay : side === 'top' ? -ay + 24 : window.innerHeight - ay - 24;
    el.style.setProperty('--tx', `${Math.round(tx)}px`);
    el.style.setProperty('--ty', `${Math.round(ty)}px`);
    el.classList.add('art-fly');
    // (the number lives 0.9 s at the cinematic's speed; it reaches the plate at ~80% of that)
    const speed = Math.max(0.1, this.stage.speed * this.rate);
    if (plate) setTimeout(() => lpBeat(side, 'art-lp-shake', 420), (0.9 * 0.8 * 1000) / speed);
  }

  private async damage(p: Pid, amount: number): Promise<Timeline> {
    const st = this.stage;
    const tl = new Timeline(0.6, st);
    this.bgTarget = this.actors.size ? 0.45 : 0.2;
    this.dimTarget = this.actors.size ? 0.8 : 0.3;
    const k = Math.min(1, amount / 3000);
    tl.at(0, () => {
      this.damageNumber(this.side(p) === 'near' ? 'bottom' : 'top', `-${amount}`, 1 + k * 1.2);
      st.shake(0.25 + k * 0.6);
      st.pulse('chroma', 0.3 + k * 0.4);
    });
    tl.commit(0);
    tl.span(0, 0.45, (x) => (this.front.u.uRed.value = (0.3 + k * 0.4) * (1 - easeOut(x))));
    tl.handoff = 0.3;
    return tl;
  }

  /**
   * A monster is destroyed: a freeze, cracks of light run over it, then it goes the
   * way of its attribute (FIRE burns to embers, WATER splashes, DARK dissolves into
   * smoke, LIGHT shatters into motes, EARTH crumbles, WIND blows away, DIVINE bursts
   * in gold). A card with no figure shatters as a card. Monsters a Spell/Trap struck
   * together (Raigeki, Dark Hole...) break together.
   */
  private async destroy(c: CardRef): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    // (the burst at BREAK, then ~0.8 s of pieces and embers: no empty tail after them)
    const D = 1.3;
    const tl = new Timeline(D, st);
    this.bgTarget = this.actors.size ? 0.45 : 0.25;
    this.dimTarget = this.actors.size ? 0.86 : 0.6;
    // (the board waits on the break: it stays at 0.48 s)
    const BREAK = 0.48;
    const RECOIL = 0.12;
    // the others struck by the same card go with it
    const group: CardRef[] = [c];
    if (this.actors.get(c.uid)?.field) {
      while (this.queue[0] && this.queue[0].batch === this.curBatch && this.queue[0].cue.kind === 'destroy' && this.actors.get(this.queue[0].cue.card.uid)?.field) {
        const q = this.queue.shift()!;
        if (q.cue.kind === 'destroy') group.push(q.cue.card);
      }
    }
    const done: Actor[] = [];
    let first = true;
    for (const g of group) {
      let act = this.actors.get(g.uid) ?? null;
      const prof = act?.prof ?? profileFor(card(g.name), g.name);
      let fig: Figure | null = act?.fig ?? null;
      let panel: CardPanel | null = act?.back ?? null;
      if (!act) {
        const art = await this.art(g.name);
        // (no place on the board, as in the 3D Card Viewer: center stage)
        const at = g.rect ? this.anchor(g, this.side(g.controller)) : { x: 0, y: -0.2 * U };
        if (group.length === 1) this.focusAt(at);
        if (art) {
          const f = tl.own(this.figure(art, 1.2 * U, prof, this.colors(prof, art).main));
          f.mesh.position.set(at.x, at.y + 0.3 * U, 0.3);
          f.mesh.scale.setScalar(1.2 * U);
          tl.span(0, 0.12, (k) => (f.u.uOpacity.value = k));
          fig = f;
        } else {
          // no art: the card itself shatters
          const p = tl.own(new CardPanel(g.name ? null : cardBack(), 1.1 * U, 0xffc070));
          p.mesh.position.set(at.x, at.y, 0.3);
          if (g.def) p.mesh.rotation.z = Math.PI / 2;
          tl.span(0, 0.12, (k) => (p.u.uOpacity.value = k));
          panel = p;
        }
      } else if (!fig && g.name) {
        // a face-down card destroyed in battle shows what it was as it breaks
        const art = await this.art(g.name);
        if (art) {
          if (act.back) this.stage.remove(act.back);
          act.back = null;
          panel = null;
          act.fig = this.stage.add(this.figure(art, act.size, prof, this.colors(prof, art).main));
          act.fig.mesh.scale.setScalar(act.size);
          act.art = art;
          this.place(act);
          fig = act.fig;
        }
      }
      if (act) done.push(act);
      const col = this.colors(prof, act?.art ?? null);
      const lag = first ? 0 : 0.04 * done.length;
      if (fig) {
        const f = fig;
        const crack = tl.own(new Crack(f, col.light, { u: 0.5 + (Math.random() - 0.5) * 0.3, v: 0.55 }));
        // (Stage.add puts every mesh in the scene: the cracks belong on the figure, moving with it)
        f.mesh.add(crack.mesh);
        const home = { x: f.mesh.position.x, y: f.mesh.position.y, z: f.mesh.position.z, rx: f.mesh.rotation.x };
        const a = act;
        // where a battle recoil left it (the blow's recoil may still be writing these as this starts)
        let from: { lean: number; oz: number } | null = null;
        const B = BREAK + lag;
        // 0..RECOIL: struck, it leans back flaring in its attribute's color (its painted detail
        // kept: never a white blob); then cracks run over it and it starts coming apart
        // (pieces part a hair, the light leaks through) until the burst at B
        this.hurtTint(f, prof);
        tl.span(0, B, (k) => {
          const t = k * B;
          const r = clamp01(t / RECOIL);
          const c = clamp01((t - RECOIL) / (B - RECOIL));
          const lean = t < RECOIL ? easeOut(r) * 0.3 : lerp(0.3, 0.14, easeInOut(c));
          const back = t < RECOIL ? easeOut(r) * 0.25 : lerp(0.25, 0.12, easeInOut(c));
          if (a && a.fig === f) {
            from ??= { lean: a.lean, oz: a.oz };
            a.lean = lerp(from.lean, lean, t < RECOIL ? easeOut(r) : 1);
            a.oz = lerp(from.oz, -back, t < RECOIL ? easeOut(r) : 1);
            this.place(a);
          } else {
            f.mesh.rotation.x = home.rx + lean;
            f.mesh.position.set(home.x, home.y, home.z - back);
          }
          crack.u.uCrack.value = easeOut(c);
          f.u.uTint.value = t < RECOIL ? 0.45 * easeOut(r) : lerp(0.45, 0.08, easeOut(c)) + 0.1 * Math.sin(c * 20) ** 2 * c;
          f.u.uShatter.value = 0.045 * easeIn(c);
          // trembling: smooth noise, growing toward the break
          f.mesh.position.x += noise(k * 25 + 3) * 0.03 * U * c;
          f.mesh.position.y += noise(k * 25 + 9) * 0.02 * U * c;
        });
        tl.at(BREAK + lag, () => (crack.u.uOpacity.value = 0));
        this.breakAs(tl, f, prof.element, col, BREAK + lag, D, first);
      } else if (panel) {
        const p = panel;
        tl.span(0.04, BREAK + lag, (k) => {
          p.u.uTint.value = 0.2 + 0.3 * Math.sin(k * 20) ** 2;
          p.mesh.position.x += noise(k * 25 + 3) * 0.004 * U * k;
        });
        tl.at(BREAK + lag, () => {
          this.panelShards(tl, p, 0xffc070, 3 * U);
          if (first) (st.shake(0.5), boom(0.4), st.pulse('chroma', 0.5));
        });
      }
      first = false;
    }
    // monsters an effect struck break where the effect left them: framed big and a little above
    // the middle of the safe area (at the resting camera they sit under the top HUD and their
    // burst runs off the screen); the camera goes home as the pieces fall
    const struck = done.filter((a) => a.field);
    if (struck.length) {
      const onto = this.effectShot(struck.map((a) => ({ ...this.boxOf(a), x: a.x + a.ox, y: a.y + a.oy })), 0, 0.05);
      let s0: Shot | null = null;
      tl.span(0, 0.3, (k) => this.setShot((s0 ??= this.shot()), onto, easeInOut(k)));
      tl.span(0.3, D - 0.4, () => this.setShot(onto, onto, 1));
      let s1: Shot | null = null;
      tl.span(D - 0.4, D, (k) => this.setShot((s1 ??= this.shot()), REST, easeInOut(k)));
      tl.at(D, () => this.resetCam(), false);
    }
    tl.at(0, () => {
      st.hitStop(0.15, 0.03);
      whoosh(0.5, 3000, 400, 0.15);
      zap(0.2);
    });
    tl.commit(BREAK);
    // the rest of the chain goes on once it has burst; the pieces fall under it
    tl.handoff = BREAK + 0.3;
    tl.at(
      D,
      () => {
        for (const a of done) {
          this.dropActor(a);
          this.actors.delete(a.uid);
        }
      },
      false,
    );
    return tl;
  }

  /** The break itself, by attribute. `loud`: the one that shakes the screen (several break at once). */
  private breakAs(tl: Timeline, fig: Figure, el: string, col: Colors, at: number, D: number, loud: boolean) {
    const st = this.stage;
    const U = this.U;
    const P = st.particles;
    const q = this.q;
    const shards = (color: number, cols: number, rows: number, gravity: number, power: number, push = { x: 0, y: 0.4 * U }) => {
      const sh = tl.own(new Shards(fig, color, cols, rows, gravity));
      const p = fig.mesh.position;
      sh.burst(p.x, p.y - 0.1 * U, power, push);
      sh.life = D - at;
      return sh;
    };
    const flare = (color: number, light: number, size: number, op = 0.8) => {
      const g = tl.own(new Glow(size * U, size * U, 'flare', color, light));
      g.mesh.position.set(fig.mesh.position.x, fig.mesh.position.y, fig.mesh.position.z + 0.4);
      tl.span(at, at + 0.4, (k) => (g.u.uOpacity.value = op * (1 - easeOut(k))));
    };
    tl.at(at, () => {
      if (el !== 'DARK') fig.u.uOpacity.value = 0;
      if (loud) {
        // (a beat of light, not a grey wash over the whole frame)
        st.pulse('flash', 0.14);
        st.pulse('chroma', 0.45);
        this.flash(col.light, 0.12);
        st.shake(0.7);
        st.punch(3);
        boom(0.5);
      }
    });
    const p = () => fig.mesh.position;
    switch (el) {
      case 'FIRE':
        tl.at(at, () => {
          shards(0xff7a2a, 4, 5, 3 * U, 2.4 * U, { x: 0, y: 0.8 * U });
          const o = p();
          P.emit({ x: o.x, y: o.y, z: o.z + 0.2, r: 0.5 * U, vy: 2.2 * U, gravity: -1.5 * U, burst: 1.2 * U, life: 1.2, size: 0.07 * U, size1: 0.01 * U, color: 0xffb040, drag: 1.5 }, Math.round(90 * q));
          P.emit({ x: o.x, y: o.y - 0.2 * U, z: o.z + 0.2, r: 0.4 * U, vy: 1.5 * U, burst: 0.8 * U, life: 0.55, size: 0.4 * U, size1: 0.08 * U, color: 0xff5a1a, drag: 2 }, Math.round(28 * q));
          zap(0.15);
        });
        tl.span(at, at + 0.8, (_k, dt) => {
          const o = p();
          for (let i = 0; i < rate(60 * q, dt); i++) P.emit({ x: o.x + (Math.random() - 0.5) * 0.8 * U, y: o.y - 0.4 * U, z: o.z, vy: 1.8 * U, life: 0.9, size: 0.05 * U, color: i % 2 ? 0xffd070 : 0xff5a1a, drag: 0.8 });
        });
        flare(0xff6a1a, 0xffe08a, 3);
        break;
      case 'WATER': {
        tl.at(at, () => {
          shards(0x7fd8ff, 4, 4, 8 * U, 2.6 * U);
          const o = p();
          P.emit({ x: o.x, y: o.y, z: o.z + 0.2, r: 0.4 * U, vy: 4 * U, burst: 2.5 * U, gravity: 10 * U, life: 0.9, size: 0.09 * U, color: 0x8fe0ff, drag: 0.4 }, Math.round(110 * q));
          P.emit({ x: o.x, y: o.y - 0.5 * U, z: o.z + 0.2, r: 0.6 * U, vy: 2.5 * U, burst: 1.2 * U, gravity: 8 * U, life: 0.8, size: 0.13 * U, color: 0xffffff, drag: 0.4 }, Math.round(40 * q));
          whoosh(0.5, 400, 1400, 0.25);
        });
        const crown = tl.own(new Glow(3 * U, 3 * U, 'shock', 0x2aa7ff, 0xbfefff));
        tl.at(at, () => crown.mesh.position.set(p().x, p().y - 0.5 * U, p().z), false);
        crown.mesh.rotation.x = -1.2;
        tl.span(at, at + 0.6, (k) => ((crown.u.uK.value = easeOut(k)), (crown.u.uOpacity.value = 1 - k * 0.3)));
        flare(0x2aa7ff, 0xbfefff, 2.4, 0.6);
        break;
      }
      case 'DARK':
        // it dissolves from the edges into smoke
        tl.span(at, at + 0.55, (k) => {
          fig.u.uDark.value = clamp01(k * 2);
          fig.u.uShatter.value = lerp(0.045, 1, easeIn(k));
          fig.u.uOpacity.value = 1 - easeIn(k);
        });
        tl.at(at, () => {
          const o = p();
          P.emit({ x: o.x, y: o.y - 0.1 * U, z: o.z, r: 0.5 * U, burst: 0.7 * U, vy: 0.9 * U, life: 1.3, size: 0.5 * U, size1: 1.1 * U, color: 0x2a1040, drag: 1.4 }, Math.round(26 * q));
          P.emit({ x: o.x, y: o.y, z: o.z + 0.2, r: 0.6 * U, burst: 1.2 * U, vy: 1.4 * U, life: 1, size: 0.08 * U, color: 0xb070ff, drag: 1, gravity: -1 * U }, Math.round(70 * q));
          drone(0.6);
        });
        tl.span(at, at + 0.5, (_k, dt) => {
          const o = p();
          for (let i = 0; i < rate(40 * q, dt); i++) P.emit({ x: o.x + (Math.random() - 0.5) * U, y: o.y + (Math.random() - 0.5) * U, z: o.z, vy: 0.8 * U, life: 1, size: 0.35 * U, size1: 0.8 * U, color: i % 2 ? 0x3a1460 : 0x1a0a24, drag: 1 });
        });
        break;
      case 'LIGHT':
        tl.at(at, () => {
          shards(0xfff6c0, 5, 6, 3 * U, 2.6 * U);
          const o = p();
          P.emit({ x: o.x, y: o.y, z: o.z + 0.2, r: 0.6 * U, vy: 1.2 * U, gravity: -0.8 * U, burst: 1.5 * U, life: 1.3, size: 0.1 * U, size1: 0.02 * U, color: 0xfff6c0, drag: 2 }, Math.round(120 * q));
          chime(0.95);
        });
        for (let i = 0; i < 5; i++) {
          const g = tl.own(new Glow(0.5 * U, 0.5 * U, 'star', 0xfff1a8, 0xffffff));
          const a = (i / 5) * Math.PI * 2;
          tl.span(at, at + 0.8, (k) => {
            const o = p();
            g.mesh.position.set(o.x + Math.cos(a) * 0.9 * U * easeOut(k), o.y + Math.sin(a) * 0.6 * U * easeOut(k) + k * 0.5 * U, o.z + 0.5);
            g.u.uOpacity.value = Math.sin(k * Math.PI);
          });
        }
        flare(0xfff1a8, 0xffffff, 2.6, 0.7);
        break;
      case 'EARTH':
        tl.at(at, () => {
          shards(0xc98a3c, 6, 6, 14 * U, 1.4 * U, { x: 0, y: -0.2 * U });
          const o = p();
          P.emit({ x: o.x, y: o.y - 0.5 * U, z: o.z, r: 0.6 * U, vy: 0.4 * U, burst: 0.8 * U, life: 1.1, size: 0.4 * U, size1: 0.9 * U, color: 0x5a4430, drag: 1.5 }, Math.round(22 * q));
          P.emit({ x: o.x, y: o.y, z: o.z + 0.2, r: 0.5 * U, vy: 1.5 * U, burst: 1.5 * U, gravity: 12 * U, life: 0.9, size: 0.09 * U, color: 0xa07a4a, drag: 0.3 }, Math.round(60 * q));
          boom(0.3);
        });
        break;
      case 'WIND': {
        const dir = fig.mesh.position.x >= 0 ? 1 : -1;
        tl.at(at, () => {
          shards(0xd9ffe9, 5, 6, 0.8 * U, 1.1 * U, { x: dir * 2.2 * U, y: 0.7 * U });
          whoosh(0.7, 800, 4000, 0.3);
        });
        tl.span(at, at + 0.7, (_k, dt) => {
          const o = p();
          for (let i = 0; i < rate(110 * q, dt); i++) P.emit({ x: o.x - dir * U + Math.random() * 0.6 * U, y: o.y + (Math.random() - 0.5) * 1.6 * U, z: o.z + 0.2, vx: dir * 3.5 * U, vy: 0.5 * U, life: 0.7, size: 0.09 * U, color: i % 2 ? 0xd9ffe9 : 0x55f0a0, drag: 0.5 });
        });
        break;
      }
      case 'DIVINE':
        tl.at(at, () => {
          shards(0xffd700, 5, 6, 4 * U, 3.4 * U);
          const o = p();
          P.emit({ x: o.x, y: o.y, z: o.z + 0.3, burst: 6 * U, life: 1.1, size: 0.12 * U, color: 0xffd75a, drag: 1.5 }, Math.round(150 * q));
        });
        flare(0xffd700, 0xfff6c0, 4.4, 0.9);
        this.shafts(tl, { x: fig.mesh.position.x, y: fig.mesh.position.y - 0.6 * U, z: fig.mesh.position.z }, 4.2 * U, 0xffd700, at, D, 3, 0.7);
        break;
      default:
        tl.at(at, () => {
          shards(col.light, 5, 6, 7 * U, 3 * U);
          const o = p();
          P.emit({ x: o.x, y: o.y, z: o.z + 0.2, r: 0.4 * U, burst: 4 * U, vy: 1.5 * U, gravity: 5 * U, life: 1, size: 0.08 * U, size1: 0.02 * U, color: col.main, drag: 1.2 }, Math.round(70 * q));
        });
        flare(col.main, col.light, 3);
    }
  }

  private async victory(winner: Pid | 'draw'): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    // short: the result window follows about 2 s after the Life Points hit 0
    const D = 1.1;
    const tl = new Timeline(D, st);
    this.bgTarget = 0.5;
    this.dimTarget = 0.8;
    const color = winner === 'draw' ? 0xc0c0ff : winner === this.viewer ? 0xffd75a : 0xff5a5a;
    const ring = tl.own(new Ring(3.2 * U, color, 99, { inner: 0.7, outer: 0.95, star: 8 }));
    ring.spinSpeed = 1.2;
    ring.u.uOpacity.value = 0;
    tl.span(0, 0.4, (k) => (ring.mesh.scale.setScalar(easeOut(k)), (ring.u.uOpacity.value = k)));
    tl.span(0.75, D, (k) => (ring.u.uOpacity.value = 1 - k));
    this.shafts(tl, { x: 0, y: -1.6 * U, z: -0.5 }, 5 * U, color, 0, D, 3, 0.7);
    // no linger after it: the fighters and the dim go at once
    tl.at(D, () => (this.fastFade = true), false);
    tl.at(0.1, () => {
      boom(0.7);
      st.pulse('flash', 0.5);
      this.flash(color, 0.4);
      st.particles.emit({ x: 0, y: 0, burst: 6 * U, life: 1.2, size: 0.12 * U, color, gravity: 2 * U }, 140);
    });
    return tl;
  }

  /** The overkill finish: the eye opens, the loser's Life Points plate shatters, the sealed monster is chained and dragged into the Shadow Realm. */
  private async shadowRealm(sr: import('./shadow').ShadowResult): Promise<Timeline> {
    const st = this.stage;
    const U = this.U;
    const D = 4.9;
    const tl = new Timeline(D, st);
    this.bgTarget = 1;
    this.dimTarget = 0.9;
    this.focus.set(0.5, 0.5);
    // (deep violet, not neon: the vortex and the motes bring the magenta)
    st.backdrop.u.uColor.value.set(0.2, 0.05, 0.34);
    const purple = 0x9a3cff;
    const magenta = 0xff4fd8;
    const gold = 0xffc94a;
    // everything is laid out inside the safe frame at the resting camera
    const safe = this.safe();
    const topY = st.halfH * (1 - 2 * safe.top);
    const botY = -st.halfH * (1 - 2 * safe.bottom);
    const eyeSize = Math.min(2.6 * U, st.halfW * 1.8);
    const eyeAt = { x: 0, y: topY - eyeSize * 0.3, z: -1 };
    // camera: home, a slow drift, then a creeping zoom into the eye as the soul goes in
    const all: Box[] = [{ x: 0, y: (topY + botY) / 2, z: 0, w: st.halfW * 0.8, h: (topY - botY) * 0.48 }];
    const wide = this.fit(all, 0, 0, { fill: 1 });
    const drift = this.fit(all, 0.12, 0.04, { fill: 1 });
    // the vortex's heart, where the soul goes in and its card stays sealed through the end
    const center = { x: 0, y: lerp(botY, topY, 0.42) };
    const cardH = Math.min(1.9 * U, (topY - botY) * 0.4);
    const into = this.fit([{ ...eyeAt, w: eyeSize * 0.4, h: eyeSize * 0.3 }, { x: center.x, y: center.y, z: 0.4, w: cardH * 0.4, h: cardH * 0.55 }], -0.05, 0.02, { fill: 0.92 });
    let s0: Shot | null = null;
    tl.span(0, 0.5, (k) => this.setShot((s0 ??= this.shot()), wide, easeInOut(k)));
    tl.span(0.5, 2.6, (k) => this.setShot(wide, drift, easeInOut(k)));
    tl.span(2.6, D - 0.5, (k) => this.setShot(drift, into, easeIn(k)));
    let s1: Shot | null = null;
    tl.span(D - 0.5, D, (k) => this.setShot((s1 ??= this.shot()), REST, easeInOut(k)));
    tl.at(0, () => drone(D - 0.3));
    tl.span(0, 0.9, (k) => (st.backdrop.u.uVortex.value = easeInOut(k)));
    tl.span(D - 0.6, D, (k) => (st.backdrop.u.uVortex.value = 1 - k));
    // the eye
    const eye = tl.own(new Ring(eyeSize, gold, 4242, { inner: 0.9, outer: 0.97, eye: true }));
    eye.mesh.position.set(eyeAt.x, eyeAt.y, eyeAt.z);
    eye.spinSpeed = 0.3;
    eye.u.uOpacity.value = 0;
    setRgb(eye.u.uColor.value, 0xffa82e);
    eye.u.uColor.value.multiplyScalar(0.68);
    tl.span(0.25, 1.15, (k) => {
      eye.u.uEye.value = Math.max(0.001, easeOut(k));
      eye.u.uOpacity.value = clamp01(k * 2);
    });
    tl.at(0.7, () => (st.pulse('flash', 0.3), this.flash(magenta, 0.3), st.shake(0.8), boom(0.9)));
    tl.span(D - 0.7, D - 0.15, (k) => (eye.u.uEye.value = Math.max(0.001, 1 - easeIn(k))));
    // the vortex
    const vortex = tl.own(new Glow(4.2 * U, 4.2 * U, 'vortex', purple, magenta));
    vortex.mesh.position.set(center.x, center.y, -0.9);
    tl.span(0.5, 1.3, (k) => (vortex.u.uOpacity.value = k * 0.55));
    tl.span(D - 0.7, D - 0.15, (k) => (vortex.u.uOpacity.value = 0.55 * (1 - k)));
    const ring = tl.own(new Ring(3.2 * U, purple, 666, { inner: 0.82, outer: 0.92, star: 7 }));
    ring.mesh.position.set(center.x, center.y, -0.8);
    ring.spinSpeed = -2.5;
    ring.u.uOpacity.value = 0;
    tl.span(0.5, 1.3, (k) => (ring.u.uOpacity.value = k * 0.5));
    tl.span(D - 0.7, D - 0.15, (k) => (ring.u.uOpacity.value = 0.5 * (1 - k)));
    tl.span(0.5, D - 0.8, (_k, dt) => {
      // (clamped: a few hundred additive magenta motes saturate the whole frame)
      const n = Math.floor(Math.min(120, (st.quality === 'full' ? 130 : 70) * this.q) * dt + Math.random());
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = (1.8 + Math.random() * 1.2) * U;
        st.particles.emit({ x: center.x + Math.cos(a) * rr, y: center.y + Math.sin(a) * rr, life: 1.1, size: 0.075 * U, color: Math.random() < 0.75 ? purple : magenta, drag: 0.2, pull: { x: center.x, y: center.y, strength: 6 * U, swirl: 9 * U } });
      }
    });
    // the loser's Life Points plate breaks apart
    const loserSide = this.side(sr.loser);
    const plateSide: 'top' | 'bottom' = loserSide === 'near' ? 'bottom' : 'top';
    const plate = tl.own(new CardPanel(lpPlateArt(sr.loserName), 0.62 * U, magenta));
    plate.mesh.scale.set(2.8, 0.82, 1);
    plate.u.uOpacity.value = 0;
    tl.at(
      0.85,
      () => {
        lpBeat(plateSide, 'art-lp-shatter', 1600);
        // centered in the safe area, just inside its edge on the loser's side (clear of the
        // Life Points bar and the hand), at most ~60% of the screen wide: placed through the
        // camera as it is now, not the resting one
        const cam = st.camera;
        cam.updateMatrixWorld();
        const sf = this.safe();
        const at = (nx: number, ny: number) => {
          const dir = new Vector3(nx, ny, 0.5).unproject(cam).sub(cam.position);
          const k = Math.abs(dir.z) < 1e-6 ? 0 : (0.6 - cam.position.z) / dir.z;
          return cam.position.clone().addScaledVector(dir, k);
        };
        const span = at(0.6, 0).distanceTo(at(-0.6, 0));
        const w0 = 0.62 * U * 0.686 * 2.8;
        const f = Math.min(1, span / w0);
        plate.mesh.scale.set(2.8 * f, 0.82 * f, 1);
        const hNdc = (2 * (0.62 * U * 0.82 * f)) / Math.max(1e-6, at(0, 1).distanceTo(at(0, -1)));
        const yN = plateSide === 'top' ? 1 - 2 * sf.top - hNdc / 2 - 0.04 : -1 + 2 * sf.bottom + hNdc / 2 + 0.04;
        plate.mesh.position.copy(at(0, yN));
        plate.u.uOpacity.value = 1;
      },
      false,
    );
    tl.span(0.85, 1.25, (k) => {
      plate.u.uTint.value = 0.5 * Math.sin(k * 30) ** 2;
      plate.mesh.position.x += noise(k * 40) * 0.01 * U;
    });
    tl.at(1.25, () => {
      this.panelShards(tl, plate, magenta, 2.4 * U, 6 * U);
      boom(0.6);
      st.shake(0.6);
      st.pulse('chroma', 0.6);
    });
    // the soul: the sealed card (or the loser's last monster) is chained and dragged in
    const soulName = sr.sealed ?? [...this.actors.values()].find((x) => x.side === loserSide && x.name)?.name ?? '';
    const art = soulName ? await this.art(soulName) : null;
    if (art) {
      const prof = profileFor(card(soulName), soulName);
      const soulSize = Math.min(1.4 * U, (topY - botY) * 0.36);
      const fig = tl.own(this.figure(art, soulSize, prof, magenta));
      fig.mesh.scale.setScalar(soulSize);
      const start = { x: 0, y: loserSide === 'near' ? botY + soulSize * 0.6 : center.y + soulSize * 0.2 };
      fig.mesh.position.set(start.x, start.y, 0.5);
      fig.u.uOpacity.value = 0;
      tl.span(1.0, 1.4, (k) => {
        fig.u.uOpacity.value = k;
        fig.u.uTint.value = 0.5 * (1 - k);
      });
      // chains of gold-and-violet links coil around it
      const links = Array.from({ length: st.quality === 'full' ? 16 : 10 }, (_, i) => {
        const l = tl.own(new Ring(soulSize * 0.26, i % 2 ? gold : 0xd8b0ff, 77 + i, { inner: 0.5, outer: 0.95 }));
        l.u.uOpacity.value = 0;
        return l;
      });
      const coil = (k: number, rot: number) => {
        const p = fig.mesh.position;
        const s = fig.mesh.scale.x / soulSize;
        links.forEach((l, i) => {
          const q = i / links.length;
          const ang = q * Math.PI * 5 + rot;
          const rr = soulSize * 0.42 * s * (1.25 - 0.25 * easeOut(k));
          l.mesh.position.set(p.x + Math.cos(ang) * rr, p.y + (q - 0.5) * soulSize * 0.8 * s, p.z + Math.sin(ang) * rr * 0.6 + 0.1);
          l.mesh.rotation.set(0, i % 2 ? Math.PI / 2.4 : 0, ang);
          l.mesh.scale.setScalar(s);
          l.u.uOpacity.value = clamp01(k * links.length - i) * (Math.sin(ang) > -0.3 ? 1 : 0.35);
        });
      };
      tl.span(1.35, 1.9, (k) => coil(k, 0));
      tl.at(1.9, () => (zap(0.4), st.shake(0.5), chime(0.2)));
      tl.span(2.0, 3.6, (k, dt) => {
        const e = easeIn(k);
        const ang = e * 9;
        const rr = (1 - e) * Math.hypot(start.x - center.x, start.y - center.y);
        const base = Math.atan2(start.y - center.y, start.x - center.x);
        fig.mesh.position.set(center.x + Math.cos(base + ang) * rr, center.y + Math.sin(base + ang) * rr, lerp(0.5, -0.8, e));
        fig.mesh.rotation.z = ang * 0.6;
        fig.mesh.scale.setScalar(soulSize * (1 - e * 0.9));
        fig.u.uDark.value = clamp01(k * 2);
        fig.u.uShatter.value = clamp01((k - 0.55) * 2.2);
        coil(1, ang * 0.6);
        for (const l of links) l.u.uOpacity.value *= 1 - clamp01((k - 0.6) * 2.5);
        const n = Math.floor(Math.min(45, 45 * this.q) * dt + Math.random());
        for (let i = 0; i < n; i++) st.particles.emit({ x: fig.mesh.position.x, y: fig.mesh.position.y, burst: 0.6 * U, life: 0.6, size: 0.065 * U, color: i % 2 ? purple : magenta, pull: { x: center.x, y: center.y, strength: 8 * U, swirl: 10 * U } });
      });
      // sealed: out of the flash its card comes back from the vortex, bound in the same chains
      // and lit magenta, and it stays there under the eye until the end
      const sealT = 3.6;
      tl.at(sealT, () => (fig.u.uOpacity.value = 0), false);
      const aura = tl.own(new Glow(cardH * 1.5, cardH * 1.5, 'flare', magenta, 0xffd0f4));
      aura.mesh.position.set(center.x, center.y, 0.2);
      const sealed = tl.own(new CardPanel(art.full, cardH, magenta));
      sealed.mesh.position.set(center.x, center.y, 0.4);
      sealed.u.uOpacity.value = 0;
      tl.span(sealT, sealT + 0.4, (k) => {
        sealed.mesh.scale.setScalar(lerp(0.15, 1, backOut(k)));
        sealed.mesh.rotation.y = (1 - easeOut(k)) * Math.PI;
        sealed.u.uOpacity.value = clamp01(k * 3);
        sealed.u.uTint.value = 0.7 * (1 - easeOut(k)) + 0.08;
      });
      tl.span(sealT + 0.3, D - 0.2, (k) => {
        sealed.u.uSheen.value = lerp(-0.4, 1.8, clamp01(k * 2.2));
        sealed.mesh.rotation.z = Math.sin(k * 7) * 0.025;
        aura.u.uOpacity.value = 0.7 * clamp01(k * 4) * (0.85 + 0.15 * Math.sin(k * 18));
      });
      const ls = cardH / soulSize;
      tl.span(sealT + 0.1, D - 0.2, (k) => {
        links.forEach((l, i) => {
          const q = i / links.length;
          const ang = q * Math.PI * 4 + k * 1.2;
          const rr = cardH * 0.42;
          l.mesh.position.set(center.x + Math.cos(ang) * rr, center.y + (q - 0.5) * cardH * 0.85, 0.4 + Math.sin(ang) * rr * 0.5 + 0.12);
          l.mesh.rotation.set(0, i % 2 ? Math.PI / 2.4 : 0, ang);
          l.mesh.scale.setScalar(ls * 0.8);
          l.u.uOpacity.value = clamp01(k * 6 * links.length - i * 1.5) * (Math.sin(ang) > -0.3 ? 1 : 0.35);
        });
      });
      tl.at(sealT + 0.15, () => (zap(0.35), chime(0.25)));
      tl.span(D - 0.2, D, (k) => {
        sealed.u.uOpacity.value = 1 - k;
        aura.u.uOpacity.value = 0.7 * (1 - k);
        for (const l of links) l.u.uOpacity.value *= 1 - k;
      });
    }
    // the winner's fighters step out of the way
    tl.span(0, 0.5, (k) => {
      for (const a of this.actors.values()) if (a.side !== loserSide) this.setOpacity(a, 1 - k);
    });
    // whatever was still on the loser's side goes dark and breaks
    tl.span(1.4, 2.6, (k) => {
      for (const a of this.actors.values()) {
        if (a.side !== loserSide) continue;
        if (a.fig) {
          a.fig.u.uDark.value = 1;
          a.fig.u.uShatter.value = easeOut(k);
        }
        if (a.back) a.back.u.uOpacity.value = 1 - k;
      }
    });
    tl.at(3.6, () => (st.pulse('flash', 0.4), this.flash(0xffffff, 0.3), boom(1), st.shake(1)));
    // overkill: the number ticks up, then lands
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const n = Math.round((sr.excess * i) / steps);
      if (i < steps) tl.at(0.75 + i * 0.05, () => this.ui.caption(`OVERKILL  +${n.toLocaleString()}`, 0.07, 'overkill tick'));
    }
    tl.at(0.75 + steps * 0.05, () => (this.ui.caption(`OVERKILL  +${sr.excess.toLocaleString()}`, 1.3, 'overkill land'), st.shake(0.4)));
    tl.at(1.6, () => this.ui.caption(`${sr.loserName} has been sent to the Shadow Realm!`, 2.6, 'shadow'));
    if (sr.sealed) tl.at(2.7, () => this.ui.caption(`${sr.sealed} is sealed away until ${sr.loserName} wins a duel.`, 2, 'sealed'));
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

/** A Life Points plate reading 0, drawn to shatter. */
function lpPlateArt(name: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 108;
  const g = c.getContext('2d');
  if (!g) return c;
  const bg = g.createLinearGradient(0, 0, 0, c.height);
  bg.addColorStop(0, '#2c0842');
  bg.addColorStop(1, '#0c001a');
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#ffc94a';
  g.lineWidth = 6;
  g.strokeRect(3, 3, c.width - 6, c.height - 6);
  g.fillStyle = '#ffd8f6';
  g.font = 'bold 20px system-ui, sans-serif';
  g.fillText(name.slice(0, 16), 14, 32);
  g.fillStyle = '#ff4a4a';
  g.font = 'italic 900 52px "Arial Black", Impact, sans-serif';
  g.fillText('LP 0', 14, 92);
  return c;
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
const SUMMON_LABEL: Record<SummonHow, string> = { normal: '', tribute: 'Tribute Summon', special: 'Special Summon', fusion: 'Fusion Summon', ritual: 'Ritual Summon', xyz: 'Xyz Summon', synchro: 'Synchro Summon', link: 'Link Summon' };

/** Big monsters get the cut-in: level 7+, Fusion/Ritual, or an iconic signature at tier 2+. */
function isBig(info: ReturnType<typeof card>, prof: ArtProfile): boolean {
  if (!info || info.kind !== 'monster') return false;
  return (info.level ?? 0) >= 7 || prof.entrance === 'fusion' || prof.entrance === 'ritual' || (SIGNATURE_CARDS.includes(prof.name) && prof.tier >= 2);
}

let solid: DataTexture | null = null;
/** A 1x1 opaque texture: a card's "depth" (the whole card is the subject when it shatters). */
function solidTex(): DataTexture {
  if (!solid) {
    solid = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
    solid.needsUpdate = true;
  }
  return solid;
}

/** A point on a quadratic curve through three points. */
function bez3(p: P3[], k: number): P3 {
  const u = 1 - k;
  const [a, b, c] = p;
  return { x: u * u * a.x + 2 * u * k * b.x + k * k * c.x, y: u * u * a.y + 2 * u * k * b.y + k * k * c.y, z: u * u * a.z + 2 * u * k * b.z + k * k * c.z };
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

/** The spiral ribbons wound round a beam stay a light accent (bright, they read as a white squiggle). */
const SPIRAL_OP = 0.5;

/** A volumetric beam: soft outer glow, colored body, white-hot core, spiral ribbons, a muzzle flare. */
function beamFx(c: HitCtx, power: number, o: { main?: number; light?: number; accent?: number; spirals?: number; widthMul?: number; off?: P3; hold?: number } = {}) {
  const { tl, U, A, T, col, s, travel } = c;
  const main = o.main ?? col.main;
  const light = o.light ?? col.light;
  const accent = o.accent ?? col.accent;
  const off = o.off ?? { x: 0, y: 0, z: 0 };
  const a = { x: A.x + off.x, y: A.y + off.y, z: A.z + off.z };
  const w = 0.11 * U * Math.pow(c.w, 0.85) * power * (o.widthMul ?? 1);
  const layers: [Ribbon, number, number][] = [
    // (a wide, soft outer glow gives the beam its volume)
    [tl.own(new Ribbon(24, main, 1)), 2.3, 0.45],
    [tl.own(new Ribbon(24, main, 1)), 1.3, 1],
    [tl.own(new Ribbon(24, light, 1)), 0.55, 0.8],
    [tl.own(new Ribbon(24, 0xffffff, 0)), 0.22, 0.85],
  ];
  const nSp = o.spirals ?? (c.w > 1.5 ? 3 : 2);
  const spirals = Array.from({ length: nSp }, (_, i) => tl.own(new Ribbon(80, i % 2 ? accent : light, 1)));
  // (how long the full beam holds after it reaches T)
  const end = s + travel + (o.hold ?? 0.28);
  const pts = [a, T];
  const len = Math.hypot(T.x - a.x, T.y - a.y);
  for (const [r] of layers) r.u.uHead.value = 0;
  for (const r of spirals) ((r.u.uHead.value = 0), (r.u.uOpacity.value = SPIRAL_OP));
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
        Array.from({ length: 40 }, (_, j) => {
          const u = j / 39;
          const ang = ph + u * turns * Math.PI * 2;
          const rr = w * 1.1 * (0.6 + 0.4 * Math.sin(u * 9 + t * 6));
          // perpendicular in screen plane: (-dy, dx)
          const dx = (T.x - a.x) / (len || 1);
          const dy = (T.y - a.y) / (len || 1);
          return { x: lerp(a.x, T.x, u) - dy * Math.cos(ang) * rr, y: lerp(a.y, T.y, u) + dx * Math.cos(ang) * rr, z: lerp(a.z, T.z, u) + Math.sin(ang) * rr };
        }),
        w * 0.14,
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
    for (const r of spirals) ((r.u.uTail.value = easeIn(k)), (r.u.uOpacity.value = SPIRAL_OP * (1 - k)));
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
        c.d['flash'](col.light, 0.1);
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
    // Burst Stream: a thick, volumetric beam (the base beam is ~0.3 U wide at tier 3; this is ~0.45 U)
    width: 1.8,
    charge: 1.6,
    windup({ tl, st, U, M, t0, t1 }) {
      tl.span(t0, t1, (k, dt) => {
        if (Math.random() < dt * 10 * k) st.particles.emit({ x: M.x, y: M.y, z: M.z, burst: 3 * U, life: 0.25, size: 0.06 * U, color: 0xffffff, drag: 4 }, 12);
      });
    },
    travel(c) {
      // (a light flash: the beam itself is the bright thing on screen)
      c.tl.at(c.s, () => (c.st.pulse('flash', 0.12), c.d['flash'](0x9fdcff, 0.1), c.st.shake(0.5)));
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
  /** the monsters it strikes (standing on their cards) and their centers */
  hits: Actor[];
  pts: P3[];
  /** where its chosen targets are (monsters or Spell/Trap cards) */
  targets: P3[];
  /** every figure on stage for it (strikes, then targets) */
  figs: Actor[];
  /** the activated card, in front of the camera */
  card: P3;
  /** its targets as they stand on stage (family cinematics) */
  spots?: Spot[];
  /** its art and seed (family cinematics lean their colors on them) */
  art?: ArtData | null;
  seed?: number;
}
interface Preset {
  /** extra seconds the preset adds */
  dur: number;
  /** its own accent color */
  accent?: number;
  /** which face-up monsters it strikes when the duel does not say (board-wide cards) */
  scope?: 'opp' | 'all' | 'oppAtk' | 'own';
  /** it moves its figures off their cards and frames them itself (the activation keeps its own drift) */
  ownCam?: boolean;
  /** a family cinematic (the card has no preset of its own) */
  family?: FxClass;
  play(c: PresetCtx): void;
}

const strike = (c: PresetCtx, a: Actor, t: number, power = 1) => c.d['strike'](c.tl, a, t, power);
/** The points it aims at: its targets, else what it strikes, else `fallback` (the viewer has no field). */
const aims = (c: PresetCtx, fallback: P3[]) => (c.targets.length ? c.targets : c.pts.length ? c.pts : fallback);
const figAt = (c: PresetCtx, p: P3) => c.figs.find((a) => Math.abs(a.x - p.x) < 1e-3 && Math.abs(a.y + a.oy - p.y) < 1e-3) ?? null;
const rowPts = (c: PresetCtx, y: number, n = 3): P3[] => Array.from({ length: n }, (_, i) => ({ x: (i - (n - 1) / 2) * 1.1 * c.U, y, z: 0.3 }));

/** The bolts already flashing the screen, per cinematic: only the first one does. */
const FLASHED = new WeakSet<Timeline>();

/**
 * Lightning from the sky onto a point: a thick jagged core in a wide glow, two forked
 * branches, a tight ground ring and a scorch mark that stays a moment. Only the first
 * bolt of a cinematic flashes the screen (several in a row would wash it grey).
 */
function bolt(c: PresetCtx, x: number, y: number, t: number, color: number, foot = y, top = Infinity) {
  const { tl, U, st } = c;
  // it strikes from the top of the frame (the safe area's), not from off screen
  const y0 = Math.max(y + 1.2 * U, Math.min(y + 4.5 * U, top));
  const N = 12;
  const core = tl.own(new Ribbon(18, 0xffffff, 0));
  const glow = tl.own(new Ribbon(18, color, 1));
  const forks = [0, 1].map(() => ({ core: tl.own(new Ribbon(8, 0xffffff, 0)), glow: tl.own(new Ribbon(8, color, 1)) }));
  // seeded by where and when it strikes: the same bolt every time
  let seed = (x / U) * 13.7 + (y / U) * 5.3 + t * 31;
  const reroll = () => {
    seed += 2.3;
    const pts = Array.from({ length: N }, (_, j) => ({ x: x + (j === 0 || j === N - 1 ? 0 : noise(seed + j * 2.7) * 0.4 * U), y: lerp(y0, y, j / (N - 1)), z: 0.6 }));
    core.set(pts, (q) => 0.16 * U * (0.55 + 0.45 * q));
    glow.set(pts, (q) => 0.6 * U * (0.6 + 0.4 * q));
    forks.forEach((f, i) => {
      // a branch splits off a third / half of the way down and runs out sideways
      const j0 = 3 + i * 2;
      const o = pts[j0];
      const dir = (i ? 1 : -1) * (0.8 + 0.3 * noise(seed + i * 9.1));
      const fp = Array.from({ length: 4 }, (_, k) => ({ x: o.x + dir * k * 0.28 * U + noise(seed + i * 5 + k * 1.9) * 0.1 * U, y: o.y - k * 0.42 * U, z: 0.6 }));
      f.core.set(fp, (q) => 0.07 * U * (1 - 0.6 * q));
      f.glow.set(fp, (q) => 0.28 * U * (1 - 0.5 * q));
    });
  };
  reroll();
  const all = [core, glow, ...forks.flatMap((f) => [f.core, f.glow])];
  for (const r of all) r.u.uOpacity.value = 0;
  let acc = 0;
  tl.span(t, t + 0.3, (k, dt) => {
    acc += dt;
    if (acc > 0.05) ((acc = 0), reroll());
    const o = k < 0.75 ? 1 : (1 - k) / 0.25;
    core.u.uOpacity.value = glow.u.uOpacity.value = o;
    // the branches flicker out first
    for (const f of forks) f.core.u.uOpacity.value = f.glow.u.uOpacity.value = k < 0.5 ? 0.9 : Math.max(0, (0.8 - k) / 0.3) * 0.9;
  });
  // a tight ground ring (a wide one reads as a horizontal halo across the frame)
  const ring = tl.own(new Glow(1.2 * U, 1.2 * U, 'shock', color, 0xffffff));
  ring.mesh.position.set(x, y, 0.3);
  ring.mesh.rotation.x = -1.1;
  tl.span(t, t + 0.4, (k) => ((ring.u.uK.value = easeOut(k)), (ring.u.uOpacity.value = 0.6 * (1 - k))));
  // the scorch where it struck, holding a moment after the bolt is gone
  const scorch = tl.own(new ContactShadow(color, 0.2));
  scorch.mesh.position.set(x, foot - 0.05 * U, 0.32);
  scorch.mesh.rotation.x = -1.2;
  scorch.mesh.scale.set(1.1 * U, 0.9 * U, 1);
  scorch.mesh.renderOrder = -2;
  scorch.u.uOpacity.value = 0;
  tl.span(t, t + 0.9, (k) => {
    const s = k * 0.9;
    scorch.u.uOpacity.value = s < 0.05 ? s / 0.05 : s < 0.65 ? 1 : Math.max(0, 1 - (s - 0.65) / 0.25);
    scorch.u.uRingAmt.value = 0.2 * Math.max(0, 1 - s / 0.6);
  });
  const first = !FLASHED.has(tl);
  FLASHED.add(tl);
  tl.at(t, () => {
    zap(0.3);
    st.shake(first ? 0.45 : 0.25);
    if (first) {
      st.pulse('chroma', 0.5);
      c.d['flash'](color, 0.22);
    } else c.d['flash'](color, 0.06);
    st.particles.emit({ x, y, z: 0.4, burst: 3.5 * U, vy: 1 * U, gravity: 6 * U, life: 0.6, size: 0.09 * U, color: 0xffffff }, Math.round(30 * c.d['q']));
  });
}

/** A whirling column (tornadoes, typhoons) on a point. */
function tornado(c: PresetCtx, p: P3, t0: number, t1: number, color: number, light: number) {
  const { tl, U, st } = c;
  for (let i = 0; i < 4; i++) {
    const rib = tl.own(new Ribbon(40, i % 2 ? light : color, 1));
    tl.span(t0, t1, (k) => {
      const grow = easeOut(clamp01(k * 2.5));
      rib.set(
        Array.from({ length: 28 }, (_, j) => {
          const q = j / 27;
          const ang = q * 16 + (i * Math.PI) / 2 + k * 22;
          const rr = (0.18 + q * 0.75) * U;
          return { x: p.x + Math.cos(ang) * rr, y: p.y - 0.5 * U + q * 2.6 * U * grow, z: p.z + 0.3 + Math.sin(ang) * rr * 0.5 };
        }),
        (q) => 0.07 * U * (0.4 + q),
      );
      rib.u.uOpacity.value = k > 0.8 ? (1 - k) * 5 : 1;
    });
  }
  tl.at(t0, () => whoosh(t1 - t0, 300, 2600, 0.3));
  tl.span(t0, t1, (_k, dt) => {
    for (let j = 0; j < rate(120 * c.d['q'], dt); j++) {
      const a = Math.random() * Math.PI * 2;
      st.particles.emit({ x: p.x + Math.cos(a) * 0.8 * U, y: p.y - 0.4 * U, z: p.z + 0.3, vy: 3 * U, life: 0.7, size: 0.07 * U, color: j % 2 ? light : color, drag: 0.5, pull: { x: p.x, y: p.y + 0.6 * U, strength: 6 * U, swirl: 14 * U } });
    }
  });
}

/** A wide energy sweep from the bottom of the frame onto `p` (Burst Stream, beams from a card). */
function sweep(c: PresetCtx, a: P3, b: P3, t: number, travel: number, color: number, light: number, width: number) {
  c.d['ray'](c.tl, a, b, t, travel, color, light, width);
}

const MIRROR_FORCE: Preset = {
  dur: 0.7,
  accent: 0x7affff,
  scope: 'oppAtk',
  play(c) {
    const { tl, U, t0, own, opp } = c;
    const dome = tl.own(new Glow(2.7 * U, 2.7 * U, 'dome', 0x7affff, 0xffffff));
    dome.mesh.position.set(0, own * 0.6, 0.9);
    tl.span(t0, t0 + 0.3, (k) => ((dome.u.uOpacity.value = 0.7 * easeOut(k)), dome.mesh.scale.setScalar(lerp(0.3, 1, backOut(k)))));
    // the attack strikes the barrier and is thrown back as rays onto every attacker
    const hitT = t0 + 0.35;
    tl.span(t0, hitT, () => (dome.u.uK.value = 0));
    tl.span(hitT, hitT + 0.5, (k) => (dome.u.uK.value = k * 1.1));
    const goal = c.pts.length ? c.pts : Array.from({ length: 5 }, (_, i) => ({ x: Math.sin(-0.9 + (i / 4) * 1.8) * 3 * U, y: opp * 1.3, z: 0.3 }));
    goal.forEach((to, i) => {
      const r = tl.own(new Ribbon(12, i % 2 ? 0xffffff : 0x7affff, 1));
      const from = { x: 0, y: own * 0.6 + Math.sign(opp) * 1.2 * U, z: 1 };
      r.u.uHead.value = 0;
      r.set([from, to], 0.14 * U);
      tl.span(hitT, hitT + 0.22, (k) => (r.u.uHead.value = easeOut(k) * 1.05));
      tl.span(hitT + 0.25, c.t1, (k) => (r.u.uTail.value = easeIn(k)));
    });
    for (const a of c.hits) strike(c, a, hitT + 0.2);
    // as the rays turn back, the camera follows them up onto the attackers
    if (c.hits.length) {
      const shot = c.d['effectShot'](c.hits.map((a) => c.d['boxOf'](a)), 0, 0.05);
      c.d['lean'](tl, shot, hitT - 0.05, hitT + 0.25, c.t1 - 0.3, c.t1);
    }
    tl.at(hitT, () => (c.st.shake(0.7), c.st.hitStop(0.07), c.st.pulse('flash', 0.14), boom(0.6), chime(0.95)));
    tl.span(c.t1 - 0.3, c.t1, (k) => (dome.u.uOpacity.value = 0.7 * (1 - k)));
  },
};

const RAIGEKI: Preset = {
  dur: 0.7,
  accent: 0xfff27a,
  scope: 'opp',
  play(c) {
    const { U, tl, t0, t1, d } = c;
    // the camera leaves the card and frames what the bolts strike (~60% of the safe area),
    // so the monsters read and every bolt starts inside the frame
    const boxes: Box[] = c.hits.length ? c.hits.map((a) => d['boxOf'](a)) : rowPts(c, c.opp, 3).map((p) => ({ ...p, w: 0.5 * U, h: 0.5 * U }));
    const shot = d['effectShot'](boxes, 0, 0.06);
    d['lean'](tl, shot, t0 - 0.3, t0 + 0.02, t1 - 0.3, t1);
    const top = (x: number) => d['skyY'](shot, x, 0.6);
    if (c.hits.length) {
      c.hits.forEach((a, i) => {
        const p = c.pts[i];
        bolt(c, p.x, p.y + a.size * 0.1, t0 + i * 0.1, 0xfff27a, p.y - a.size * 0.48, top(p.x));
        strike(c, a, t0 + i * 0.1);
      });
      // and a couple of strays between and beside them
      const xs = c.pts.map((p) => p.x);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const gy = Math.min(...c.hits.map((a) => a.y - a.size * 0.35));
      [lerp(x0, x1, 0.5) - 0.25 * U, x1 + 0.7 * U].forEach((x, i) => bolt(c, x, gy, t0 + 0.05 + i * 0.12, 0xfff27a, gy, top(x)));
    } else for (let i = 0; i < 5; i++) bolt(c, (i - 2) * 0.55 * U + noise(i * 3.1 + 0.7) * 0.1 * U, c.opp, t0 + i * 0.1, 0xfff27a, c.opp, top((i - 2) * 0.55 * U));
  },
};

const DARK_HOLE: Preset = {
  dur: 0.8,
  accent: 0xff4fd8,
  scope: 'all',
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
    // every monster is dragged toward the hole, twisting and darkening
    for (const a of c.hits) {
      const home = { x: a.ox, y: a.oy };
      tl.span(t0, t1 - 0.2, (k) => {
        const e = easeIn(k) * 0.45;
        a.ox = home.x + (0 - a.x) * e;
        a.oy = home.y + (c.cy - a.y) * e;
        a.lean = -0.4 * e;
        if (a.fig) ((a.fig.u.uDark.value = clamp01(k * 1.5)), (a.fig.mesh.rotation.z = (a.x > 0 ? 1 : -1) * e * 1.2));
        c.d['place'](a);
      });
    }
    tl.at(t0, () => (drone(1.2), boom(0.6)));
    tl.at(t1 - 0.3, () => (st.pulse('flash', 0.35), st.pulse('chroma', 0.7), boom(0.8)));
  },
};

const POT_OF_GREED: Preset = {
  dur: 0.6,
  accent: 0xffd75a,
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
};

const MONSTER_REBORN: Preset = {
  dur: 0.9,
  accent: 0xffe9a0,
  ownCam: true,
  play(c) {
    const { tl, U, t0, t1, st } = c;
    // the revived monster (its target), when the duel names it
    const tp = c.targets[0];
    const a = tp ? figAt(c, tp) : null;
    const rise = !!a?.fig;
    // the ankh rises to the middle of the stage; with no monster to raise it stands behind the card and lights it
    const ankh = tl.own(new Glow(2 * U, 2.6 * U, 'ankh', 0xffe9a0, 0xffffff));
    // drawn before the figures (with the shafts): the rising monster passes in front of it, never its stem over the monster
    ankh.mesh.renderOrder = -5;
    const peak = rise ? 0.5 : 0.38;
    tl.span(t0, t0 + 0.6, (k) => {
      const px = rise ? 0 : c.panel.mesh.position.x;
      const py = rise ? c.cy + 0.8 * U : c.panel.mesh.position.y + 0.3 * U;
      ankh.mesh.position.set(px, lerp(c.own * 1.2, py, easeOut(k)), rise ? -0.5 : -0.9);
      ankh.mesh.scale.setScalar(rise ? 1 : 1.75);
      ankh.u.uOpacity.value = peak * easeOut(k);
    });
    tl.span(t1 - 0.3, t1, (k) => (ankh.u.uOpacity.value = peak * (1 - k)));
    // the shafts climb from the graveyard's side of the field
    const gx = (c.side === 'near' ? 1 : -1) * 1.2 * U;
    const gy = c.own * 1.15;
    const sx = rise ? gx * 0.5 : 0;
    c.d['shafts'](tl, { x: sx, y: gy, z: 0.4 }, 5 * U, 0xffe9a0, t0, t1, rise ? 3 : 1, 0.75);
    let seed = 0;
    tl.span(t0, t1 - 0.25, (_k, dt) => {
      for (let i = 0; i < rate(70 * c.d['q'], dt); i++) c.st.particles.emit({ x: sx + noise(++seed * 1.7) * 0.8 * U, y: gy, z: 0.6, vy: 3 * U, life: 0.9, size: 0.08 * U, color: 0xffe9a0, drag: 0.4 });
    });
    if (a && a.fig) {
      const fig = a.fig;
      const size = a.size;
      const R0 = t0 + 0.12;
      const R1 = t0 + 0.72;
      const L = R1 + 0.25;
      const cy = c.cy - 0.05 * U;
      // hidden until the ankh calls it (the activation would raise it off its card)
      tl.span(0.1, R0, () => {
        a.ox = gx - a.x;
        a.oy = gy - a.y;
        a.oz = 0.6;
        fig.u.uOpacity.value = 0;
        c.d['place'](a);
      });
      // up from the graveyard through the shafts to the middle of the stage, coming into being as it climbs
      // (lit gold, its painted detail kept: never a white silhouette)
      tl.at(R0, () => (setRgb(fig.u.uTintCol.value, 0xffe9a0), (fig.u.uTintKeep.value = 1)));
      tl.span(R0, R1, (k) => {
        const e = easeInOut(k);
        a.ox = lerp(gx, 0, e) - a.x;
        a.oy = lerp(gy, cy, e) - a.y + Math.sin(k * Math.PI) * 0.25 * U;
        a.oz = lerp(0.6, 1.2, e);
        fig.mesh.scale.setScalar(size * lerp(0.75, 1.3, e));
        fig.u.uOpacity.value = clamp01(k * 3);
        fig.u.uReveal.value = easeOut(clamp01(k * 1.3));
        fig.u.uTint.value = 0.6;
        c.d['place'](a);
      });
      // it lands: the golden glow drains out of it in a flash and it stands there revived
      tl.span(R1, L, (k) => {
        fig.u.uReveal.value = 1;
        fig.u.uTint.value = 0.6 * (1 - easeOut(k));
      });
      tl.span(R1, t1 + 0.4, (k) => {
        a.oy = cy - a.y + Math.sin(k * Math.PI * 2) * 0.03 * U;
        fig.mesh.scale.setScalar(size * 1.3);
        c.d['place'](a);
      });
      const shock = tl.own(new Glow(3.2 * U, 3.2 * U, 'shock', 0xffe9a0, 0xffffff));
      shock.mesh.position.set(0, cy - size * 0.6, 1.2);
      shock.mesh.rotation.x = -1.2;
      tl.span(R1, R1 + 0.5, (k) => ((shock.u.uK.value = easeOut(k)), (shock.u.uOpacity.value = 0.8 * (1 - k))));
      tl.at(R1, () => {
        chime(0.9);
        st.pulse('flash', 0.22);
        c.d['flash'](0xffe9a0, 0.12);
        st.particles.emit({ x: 0, y: cy, z: 1.4, burst: 3.5 * U, life: 0.7, size: 0.09 * U, color: 0xffe9a0, drag: 2 }, Math.round(60 * c.d['q']));
      });
      // the camera rises with it and frames it in the middle
      const shot = c.d['fit']([{ x: 0, y: cy, z: 1.2 + size * 0.3, w: size * 0.62, h: size * 0.7 }], 0, 0.04, { fill: 0.62 });
      c.d['lean'](tl, shot, R0, R1, t1 - 0.3, t1);
    } else {
      // no monster to show: the card itself takes the ankh's light
      const panel = c.panel;
      tl.span(t0 + 0.35, t0 + 0.95, (k) => (panel.u.uSheen.value = lerp(-0.4, 1.8, k)));
      tl.span(t0 + 0.3, t1, (k) => (panel.u.uTint.value = 0.22 * Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5) * (1 - easeIn(clamp01((k - 0.7) / 0.3)))));
      tl.at(t0 + 0.6, () => (chime(0.9), st.pulse('flash', 0.2)));
    }
  },
};

const POLYMERIZATION: Preset = {
  dur: 0.7,
  accent: 0xffd75a,
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
      st.pulse('flash', 0.4);
      c.d['flash'](0xffd75a, 0.3);
      boom(0.5);
      st.particles.emit({ x: 0, y: c.cy, z: 1.2, burst: 5 * U, life: 0.8, size: 0.12 * U, color: 0xffd75a }, Math.round(90 * c.d['q']));
    });
    tl.span(t0 + 0.5, c.t1, (k) => ((star.u.uOpacity.value = Math.sin(k * Math.PI)), star.mesh.scale.setScalar(lerp(0.5, 1.1, easeOut(k)))));
  },
};

/** A pit opening under its victim; the monster sinks into it (Trap Hole family). */
const trapHole = (color: number, light: number): Preset => ({
  dur: 0.6,
  accent: light,
  play(c) {
    const { tl, U, t0, t1, st } = c;
    const where = aims(c, [{ x: 0, y: c.opp, z: 0.3 }]);
    for (const p of where) {
      const a = figAt(c, p);
      const foot = a ? a.y - a.size * 0.42 : p.y - 0.4 * U;
      const pit = tl.own(new Glow(2.6 * U, 2.6 * U, 'vortex', color, light));
      pit.mesh.position.set(p.x, foot, p.z - 0.1);
      pit.mesh.rotation.x = -1.2;
      tl.span(t0, t0 + 0.25, (k) => ((pit.u.uOpacity.value = easeOut(k)), pit.mesh.scale.setScalar(lerp(0.2, 1, backOut(k)))));
      tl.span(t1 - 0.25, t1, (k) => (pit.u.uOpacity.value = 1 - k));
      const rim = tl.own(new Ring(2.2 * U, light, 909, { inner: 0.86, outer: 0.95 }));
      rim.mesh.position.set(p.x, foot, p.z);
      rim.mesh.rotation.x = -1.2;
      rim.spinSpeed = 3;
      rim.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.25, (k) => (rim.u.uOpacity.value = k));
      tl.span(t1 - 0.25, t1, (k) => (rim.u.uOpacity.value = 1 - k));
      if (a) {
        const home = a.oy;
        tl.span(t0 + 0.15, t1 - 0.1, (k) => {
          a.oy = home - easeIn(k) * a.size * 0.35;
          a.ox = noise(k * 20 + a.uid) * 0.03 * U;
          if (a.fig) a.fig.u.uDark.value = clamp01(k * 1.4) * 0.8;
          c.d['place'](a);
        });
      }
      tl.at(t0, () => (boom(0.45), st.shake(0.5), st.particles.emit({ x: p.x, y: foot, z: p.z + 0.2, r: 0.5 * U, vy: 2.5 * U, burst: 1.5 * U, gravity: 8 * U, life: 0.8, size: 0.1 * U, color: light, drag: 0.5 }, Math.round(60 * c.d['q']))));
    }
  },
});

/** Barriers that stop an attack (Negate Attack, Waboku). */
const barrier = (color: number, light: number, vortex: boolean): Preset => ({
  dur: 0.6,
  accent: light,
  play(c) {
    const { tl, U, t0, t1, own, st } = c;
    const dome = tl.own(new Glow(3.8 * U, 3.8 * U, 'dome', color, light));
    dome.mesh.position.set(0, own * 0.55, 1.1);
    tl.span(t0, t0 + 0.3, (k) => ((dome.u.uOpacity.value = easeOut(k)), dome.mesh.scale.setScalar(lerp(0.3, 1, backOut(k)))));
    tl.span(t0 + 0.25, t1, (k) => (dome.u.uK.value = (k * 2.2) % 1.1));
    tl.span(t1 - 0.25, t1, (k) => (dome.u.uOpacity.value = 1 - k));
    if (vortex) {
      const v = tl.own(new Glow(2.6 * U, 2.6 * U, 'vortex', color, light));
      v.mesh.position.set(0, own * 0.55 - Math.sign(own) * 1.3 * U, 1.3);
      tl.span(t0 + 0.1, t0 + 0.4, (k) => (v.u.uOpacity.value = k));
      tl.span(t1 - 0.25, t1, (k) => (v.u.uOpacity.value = 1 - k));
    }
    tl.at(t0 + 0.2, () => (chime(0.9), st.shake(0.4), st.pulse('chroma', 0.4)));
  },
});

const SPELL_PRESETS: Record<string, Preset> = {
  'Mirror Force': MIRROR_FORCE,
  Raigeki: RAIGEKI,
  'Dark Hole': DARK_HOLE,
  'Pot of Greed': POT_OF_GREED,
  'Monster Reborn': MONSTER_REBORN,
  'Swords of Revealing Light': {
    dur: 0.8,
    accent: 0xfff1a8,
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
          c.d['flash'](0xfff1a8, 0.2);
          st.particles.emit({ x, y: yEnd - 1 * U, z: 0.8, burst: 2.5 * U, vy: 1.5 * U, gravity: 6 * U, life: 0.6, size: 0.08 * U, color: 0xffffff }, Math.round(30 * c.d['q']));
        });
        tl.span(t1 - 0.3, t1, (k) => (g.u.uOpacity.value = 1 - k));
      }
    },
  },
  Polymerization: POLYMERIZATION,
  // ---- Speed Duel staples
  'Dark Magic Attack': {
    dur: 0.8,
    accent: 0xb070ff,
    play(c) {
      const { tl, U, t0, t1, st } = c;
      // the staff's pentagram, then dark magic sweeps their back row
      const ring = tl.own(new Ring(3 * U, 0xb070ff, 5555, { inner: 0.78, outer: 0.92, star: 5 }));
      ring.mesh.position.set(0, c.cy, 1.2);
      ring.spinSpeed = 3;
      ring.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.3, (k) => ((ring.u.uOpacity.value = easeOut(k)), ring.mesh.scale.setScalar(lerp(0.4, 1, easeOut(k)))));
      tl.span(t1 - 0.3, t1, (k) => (ring.u.uOpacity.value = 1 - k));
      const row = c.opp * 1.25;
      const where = c.targets.length ? c.targets : rowPts(c, row, 3);
      where.forEach((p, i) => {
        const t = t0 + 0.25 + i * 0.1;
        sweep(c, c.card, p, t, 0.18, 0x6a1aaa, 0xff4fd8, 1.4);
        const blast = tl.own(new Glow(2 * U, 2 * U, 'flare', 0x9a3cff, 0xff4fd8));
        blast.mesh.position.set(p.x, p.y, p.z + 0.4);
        tl.span(t + 0.18, t + 0.55, (k) => ((blast.u.uOpacity.value = 0.8 * (1 - easeOut(k))), blast.mesh.scale.setScalar(lerp(0.5, 1.2, easeOut(k)))));
        tl.at(t + 0.18, () => (boom(0.4), st.shake(0.45), st.particles.emit({ x: p.x, y: p.y, z: p.z + 0.3, burst: 3.5 * U, life: 0.7, size: 0.1 * U, color: i % 2 ? 0xff4fd8 : 0xb070ff, drag: 2 }, Math.round(50 * c.d['q']))));
      });
      tl.at(t0, () => (drone(0.8), chime(0.4)));
    },
  },
  'Magic Jammer': {
    dur: 0.55,
    accent: 0x7affff,
    play(c) {
      const { tl, U, t0, st } = c;
      // a jamming wave rolls out, then a cross slashes the card it negates
      const p = c.targets[0] ?? { x: 0, y: c.opp * 0.9, z: 0.6 };
      for (let i = 0; i < 3; i++) {
        const w = tl.own(new Glow(2.2 * U, 2.2 * U, 'shock', 0x7affff, 0xff4fd8));
        w.mesh.position.set(p.x, p.y, p.z + 0.3);
        tl.span(t0 + i * 0.09, t0 + i * 0.09 + 0.4, (k) => ((w.u.uK.value = easeOut(k)), (w.u.uOpacity.value = 1 - k * 0.4)));
      }
      for (let i = 0; i < 2; i++) {
        const r = tl.own(new Ribbon(8, i ? 0xff4fd8 : 0x7affff, 1));
        const s = i ? 1 : -1;
        r.set(
          [
            { x: p.x - 0.8 * U, y: p.y + s * 0.8 * U, z: p.z + 0.6 },
            { x: p.x + 0.8 * U, y: p.y - s * 0.8 * U, z: p.z + 0.6 },
          ],
          (k) => 0.16 * U * Math.sin(k * Math.PI),
        );
        r.u.uHead.value = 0;
        const t = t0 + 0.25 + i * 0.08;
        tl.span(t, t + 0.1, (k) => (r.u.uHead.value = k * 1.1));
        tl.span(t + 0.3, c.t1, (k) => (r.u.uOpacity.value = 1 - k));
        tl.at(t, () => (zap(0.3), st.shake(0.35)));
      }
      tl.at(t0 + 0.3, () => c.d['ui'].banner({ title: 'Negated!', color: 0x7affff, big: true, dur: 0.6, pos: 'mid' }));
    },
  },
  'Wonder Wand': {
    dur: 0.55,
    accent: 0x9adfff,
    play(c) {
      const { tl, U, t0, st } = c;
      const p = aims(c, [{ x: 0, y: c.own, z: 0.4 }])[0];
      const wand = tl.own(new Glow(0.9 * U, 0.9 * U, 'star', 0x9adfff, 0xffffff));
      tl.span(t0, t0 + 0.3, (k) => {
        const q = bez3([c.card, { x: (c.card.x + p.x) / 2, y: (c.card.y + p.y) / 2 + 0.8 * U, z: 1.4 }, p], easeInOut(k));
        wand.mesh.position.set(q.x, q.y, q.z + 0.3);
        wand.u.uOpacity.value = 1;
        wand.mesh.rotation.z = k * 6;
      });
      tl.at(t0 + 0.3, () => (wand.u.uOpacity.value = 0));
      tl.span(t0, t0 + 0.3, (_k, dt) => {
        for (let i = 0; i < rate(100 * c.d['q'], dt); i++) st.particles.emit({ x: wand.mesh.position.x, y: wand.mesh.position.y, z: wand.mesh.position.z, burst: 0.6 * U, life: 0.5, size: 0.08 * U, color: i % 2 ? 0x9adfff : 0xffffff, drag: 2 });
      });
      c.d['resolveAt'](tl, p, t0 + 0.3, false, 0x9adfff, 0xffffff, figAt(c, p), null);
    },
  },
  Riryoku: {
    dur: 0.65,
    accent: 0x7affb0,
    play(c) {
      const { tl, U, t0, t1, st } = c;
      // power drains out of one monster and pours into another
      const src = c.targets[0] ?? { x: 0, y: c.opp, z: 0.4 };
      const dst = c.targets[1] ?? (c.figs.find((a) => a.side === c.side) ? c.d['center'](c.figs.find((a) => a.side === c.side)!) : { x: 0, y: c.own, z: 0.4 });
      tl.span(t0, t1 - 0.15, (_k, dt) => {
        for (let i = 0; i < rate(160 * c.d['q'], dt); i++) {
          const off = (Math.random() - 0.5) * 0.4 * U;
          st.particles.emit({ x: src.x + off, y: src.y + off, z: src.z + 0.3, life: 0.6, size: 0.09 * U, color: i % 3 ? 0x7affb0 : 0xff5a5a, drag: 0, pull: { x: dst.x, y: dst.y, strength: 18 * U, swirl: 4 * U } });
        }
      });
      sweep(c, src, dst, t0, 0.35, 0x2ad070, 0xd9ffe9, 0.8);
      const a = figAt(c, src);
      if (a) tl.span(t0, t1, (k) => void (a.fig && (a.fig.u.uDark.value = 0.6 * Math.sin(k * Math.PI))));
      c.d['resolveAt'](tl, dst, t0 + 0.4, false, 0x2ad070, 0xd9ffe9, figAt(c, dst), null);
      tl.at(t0, () => (drone(0.6), chime(0.5)));
    },
  },
  'Tribute Doll': {
    dur: 0.6,
    accent: 0xff5a3a,
    play(c) {
      const { tl, U, t0, t1, st } = c;
      // an altar of red light; the offering rises, then a golden column answers
      const y = c.own * 0.9;
      const altar = tl.own(new Ring(2.6 * U, 0xff3a3a, 6660, { inner: 0.7, outer: 0.92, star: 6 }));
      altar.mesh.position.set(0, y, 0.6);
      altar.mesh.rotation.x = -1.15;
      altar.spinSpeed = -2;
      altar.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.25, (k) => ((altar.u.uOpacity.value = k), altar.mesh.scale.setScalar(easeOut(k))));
      tl.span(t1 - 0.25, t1, (k) => (altar.u.uOpacity.value = 1 - k));
      tl.span(t0, t0 + 0.4, (_k, dt) => {
        for (let i = 0; i < rate(140 * c.d['q'], dt); i++) {
          const a = Math.random() * Math.PI * 2;
          st.particles.emit({ x: Math.cos(a) * U, y: y + Math.sin(a) * 0.35 * U, z: 0.7, vy: 2.5 * U, life: 0.7, size: 0.09 * U, color: i % 2 ? 0xff3a3a : 0xffb070, drag: 0.4 });
        }
      });
      c.d['shafts'](tl, { x: 0, y: y - 0.3 * U, z: 0.6 }, 4.5 * U, 0xffc94a, t0 + 0.3, t1, 2, 0.8);
      tl.at(t0 + 0.32, () => (boom(0.5), chime(0.7), st.shake(0.4), c.d['flash'](0xffc94a, 0.2)));
    },
  },
  'Book of Moon': {
    dur: 0.6,
    accent: 0xbfd8ff,
    play(c) {
      const { tl, U, t0, st } = c;
      const p = aims(c, [{ x: 0, y: c.opp, z: 0.4 }])[0];
      // a pale moon rises over the target; it turns face-down
      const moon = tl.own(new Glow(2.4 * U, 2.4 * U, 'flare', 0x9ab8ff, 0xffffff));
      const halo = tl.own(new Ring(2.4 * U, 0xbfd8ff, 3030, { inner: 0.82, outer: 0.9 }));
      tl.span(t0, t0 + 0.3, (k) => {
        moon.mesh.position.set(p.x, p.y + lerp(1.4, 0.4, easeOut(k)) * U, p.z + 0.6);
        halo.mesh.position.copy(moon.mesh.position);
        moon.u.uOpacity.value = 0.4 * easeOut(k);
        halo.u.uOpacity.value = easeOut(k);
      });
      tl.span(c.t1 - 0.25, c.t1, (k) => ((moon.u.uOpacity.value = 0.4 * (1 - k)), (halo.u.uOpacity.value = 1 - k)));
      const a = figAt(c, p);
      if (a) {
        const back = tl.own(new CardPanel(cardBack(), a.size * 0.8, 0xbfd8ff));
        back.mesh.position.set(p.x, p.y, p.z);
        back.u.uOpacity.value = 0;
        tl.span(t0 + 0.25, t0 + 0.45, (k) => {
          const m = a.fig?.mesh ?? a.back?.mesh;
          if (m) m.rotation.y = (Math.PI / 2) * easeIn(k);
          c.d['setOpacity'](a, 1 - easeIn(k));
        });
        tl.span(t0 + 0.45, t0 + 0.65, (k) => {
          back.mesh.rotation.set(0, (Math.PI / 2) * (1 - easeOut(k)), Math.PI / 2);
          back.u.uOpacity.value = 1;
        });
      }
      tl.at(t0 + 0.3, () => (chime(0.3), whoosh(0.3, 2400, 600, 0.15), st.particles.emit({ x: p.x, y: p.y, z: p.z + 0.4, burst: 2 * U, life: 0.7, size: 0.07 * U, color: 0xdfeaff, drag: 2 }, Math.round(40 * c.d['q']))));
    },
  },
  "Magician's Circle": {
    dur: 0.6,
    accent: 0xb070ff,
    play(c) {
      const { tl, U, t0, t1, st } = c;
      for (const y of [c.own * 0.9, c.opp * 0.9]) {
        const ring = tl.own(new Ring(2.8 * U, 0xb070ff, 5150, { inner: 0.72, outer: 0.93, star: 5 }));
        ring.mesh.position.set(0, y, 0.4);
        ring.mesh.rotation.x = -1.15;
        ring.spinSpeed = 1.8;
        ring.u.uOpacity.value = 0;
        tl.span(t0, t0 + 0.3, (k) => ((ring.u.uOpacity.value = easeOut(k)), ring.mesh.scale.setScalar(lerp(0.3, 1, backOut(k)))));
        tl.span(t1 - 0.25, t1, (k) => (ring.u.uOpacity.value = 1 - k));
        c.d['shafts'](tl, { x: 0, y: y - 0.3 * U, z: 0.4 }, 3.8 * U, 0xb070ff, t0 + 0.15, t1, 2, 0.6);
      }
      tl.at(t0 + 0.2, () => (chime(0.75), st.pulse('chroma', 0.3)));
    },
  },
  'Thousand Knives': {
    dur: 0.55,
    accent: 0xdfe8ff,
    play(c) {
      const { tl, U, t0, st } = c;
      const p = aims(c, [{ x: 0, y: c.opp, z: 0.4 }])[0];
      for (let i = 0; i < 12; i++) {
        const r = tl.own(new Ribbon(4, i % 3 ? 0xdfe8ff : 0xb070ff, 0));
        const a = { x: c.card.x + (Math.random() - 0.5) * 2.4 * U, y: c.card.y + (Math.random() - 0.5) * 1.2 * U, z: 1.4 };
        const b = { x: p.x + (Math.random() - 0.5) * 0.5 * U, y: p.y + (Math.random() - 0.5) * 0.5 * U, z: p.z + 0.4 };
        const t = t0 + i * 0.025;
        tl.span(t, t + 0.18, (k) => {
          const e = easeIn(k);
          const h = P3lerp(a, b, e);
          const tail = P3lerp(a, b, Math.max(0, e - 0.28));
          r.set([tail, h], (q) => 0.05 * U * q);
          r.u.uOpacity.value = 1;
        });
        tl.at(t + 0.18, () => (r.u.uOpacity.value = 0));
      }
      tl.at(t0, () => whoosh(0.3, 3000, 1200, 0.25));
      tl.at(t0 + 0.2, () => (zap(0.3), st.shake(0.5), st.particles.emit({ x: p.x, y: p.y, z: p.z + 0.4, burst: 3 * U, life: 0.4, size: 0.06 * U, color: 0xffffff, drag: 3 }, Math.round(60 * c.d['q']))));
      const a = figAt(c, p);
      if (a) strike(c, a, t0 + 0.2);
    },
  },
  'Wild Tornado': {
    dur: 0.65,
    accent: 0xd9ffe9,
    play(c) {
      const p = aims(c, [{ x: 0, y: c.opp * 1.2, z: 0.4 }])[0];
      tornado(c, p, c.t0, c.t1 - 0.05, 0x55f0a0, 0xd9ffe9);
      const a = figAt(c, p);
      if (a) strike(c, a, c.t0 + 0.3);
    },
  },
  'Mystical Space Typhoon': {
    dur: 0.55,
    accent: 0x9affd0,
    play(c) {
      const p = aims(c, [{ x: 0, y: c.opp * 1.2, z: 0.4 }])[0];
      tornado(c, p, c.t0, c.t1 - 0.05, 0x1fd39a, 0xe0fff4);
    },
  },
  'Burst Stream of Destruction': {
    // a 0.35 s charge at the dragon's mouth, then one thick volumetric beam, a flare where it lands
    dur: 1.15,
    accent: 0x9fdcff,
    scope: 'opp',
    play(c) {
      const { tl, U, t0, st } = c;
      const where = c.pts.length ? c.pts : rowPts(c, c.opp, 3);
      const src = { x: 0, y: c.own * 1.6, z: 1.6 };
      // one beam onto the middle of what it strikes (wide enough to swallow them all)
      const T = { x: where.reduce((s, p) => s + p.x, 0) / where.length, y: where.reduce((s, p) => s + p.y, 0) / where.length, z: where.reduce((s, p) => s + p.z, 0) / where.length };
      const spread = Math.max(...where.map((p) => Math.abs(p.x - T.x)));
      const CHARGE = 0.35;
      const travel = 0.14;
      const fire = t0 + CHARGE;
      const hitT = fire + travel;
      const r = rand(0xb5d);
      // the charge: the mouth swells while light converges on it
      const orb = tl.own(new Glow(2.2 * U, 2.2 * U, 'flare', 0x2a8aff, 0xeaf6ff));
      orb.mesh.position.set(src.x, src.y, src.z + 0.1);
      orb.u.uK.value = 0.6;
      tl.span(t0, fire, (k, dt) => {
        orb.u.uOpacity.value = 0.25 + 0.6 * easeIn(k);
        orb.mesh.scale.setScalar(lerp(0.25, 1, easeIn(k)) * (1 + 0.06 * Math.sin(k * 40)));
        for (let i = 0; i < rate(160 * c.d['q'], dt); i++) {
          const a = r() * Math.PI * 2;
          const rr = (1 + r() * 0.8) * U;
          st.particles.emit({ x: src.x + Math.cos(a) * rr, y: src.y + Math.sin(a) * rr * 0.7, z: src.z, life: 0.3, size: 0.07 * U, color: i % 2 ? 0x9fdcff : 0xffffff, drag: 0, pull: { x: src.x, y: src.y, strength: 26 * U, swirl: 4 * U } });
        }
      });
      tl.span(fire, fire + 0.5, (k) => (orb.u.uOpacity.value = 0.85 * (1 - easeOut(k))));
      tl.at(t0, () => (swell(0.6), st.shake(0.15)));
      tl.at(fire, () => (zap(0.7), st.pulse('flash', 0.2), st.shake(0.45)));
      // the beam itself: the attack beam's layers (glow, body, white core, spirals), ~2.5x wide
      const hc: HitCtx = { d: c.d, st, tl, U, A: src, T, col: { main: 0x2a8aff, accent: 0x9fdcff, light: 0xeaf6ff }, prof: profileFor(undefined, 'Burst Stream of Destruction'), s: fire, travel, att: null, q: c.d['q'], w: 1.6 };
      beamFx(hc, 1, { spirals: 2, widthMul: 2.5 * (1 + Math.min(1, spread / (2 * U)) * 0.4), hold: 0.55 });
      // the push-in rides the blast
      tl.at(fire, () => st.punch(4, 0.35));
      // impact: a wide flare where it lands, the struck light up and break
      const flare = tl.own(new Glow(3.4 * U, 3.4 * U, 'flare', 0x2a8aff, 0xffffff));
      flare.mesh.position.set(T.x, T.y, T.z + 0.4);
      flare.u.uK.value = 0.5;
      flare.u.uOpacity.value = 0;
      tl.span(hitT, hitT + 0.55, (k) => {
        flare.u.uOpacity.value = 0.85 * (k < 0.1 ? k / 0.1 : 1 - easeOut((k - 0.1) / 0.9));
        flare.mesh.scale.setScalar(lerp(0.5, 1.25, easeOut(k)));
      });
      const shock = tl.own(new Glow(3.6 * U, 3.6 * U, 'shock', 0x2a8aff, 0xbfefff));
      shock.mesh.position.set(T.x, T.y - 0.3 * U, T.z);
      shock.mesh.rotation.x = -1.2;
      tl.span(hitT, hitT + 0.5, (k) => ((shock.u.uK.value = easeOut(k)), (shock.u.uOpacity.value = 1 - k)));
      for (const a of c.hits) strike(c, a, hitT);
      tl.at(hitT, () => {
        boom(0.8);
        st.shake(0.8);
        st.hitStop(0.06);
        st.pulse('chroma', 0.6);
        c.d['flash'](0x9fdcff, 0.25);
        st.particles.emit({ x: T.x, y: T.y, z: T.z + 0.3, burst: 5 * U, life: 0.7, size: 0.09 * U, color: 0xbfefff, drag: 2.5 }, Math.round(90 * c.d['q']));
      });
    },
  },
  'Acid Trap Hole': trapHole(0x3aff6a, 0xd9ffb0),
  'Negate Attack': barrier(0x4ad8ff, 0xffffff, true),
  Waboku: barrier(0xffd75a, 0xfff6c0, false),
  Fissure: {
    dur: 0.55,
    accent: 0xffd28a,
    play(c) {
      const { tl, U, t0, st } = c;
      const p = aims(c, [{ x: 0, y: c.opp, z: 0.4 }])[0];
      // the ground splits in a line toward its victim
      for (let i = 0; i < 4; i++) {
        const q = P3lerp({ x: c.card.x, y: c.own * 0.6, z: 0.3 }, p, i / 3);
        const ring = tl.own(new Glow(2.2 * U, 2.2 * U, 'shock', 0xc98a3c, 0xffe0b0));
        ring.mesh.position.set(q.x, q.y - 0.4 * U, q.z);
        ring.mesh.rotation.x = -1.2;
        const t = t0 + i * 0.08;
        tl.span(t, t + 0.4, (k) => ((ring.u.uK.value = easeOut(k)), (ring.u.uOpacity.value = 1 - k * 0.3)));
        tl.at(t, () => (st.shake(0.35), boom(0.25)));
      }
      tl.at(t0 + 0.3, () => st.particles.emit({ x: p.x, y: p.y - 0.5 * U, z: p.z, r: 0.5 * U, vy: 4 * U, burst: 1.5 * U, gravity: 12 * U, life: 0.9, size: 0.14 * U, color: 0x9a7a5a, drag: 0.3 }, Math.round(60 * c.d['q'])));
      const a = figAt(c, p);
      if (a) strike(c, a, t0 + 0.3);
    },
  },
};

/** Speed Duel's versions of the classics play the classic's preset (and a few families share one). */
const PRESET_ALIASES: Record<string, string> = {
  'Quaking Mirror Force': 'Mirror Force',
  'Crystal Raigeki': 'Raigeki',
  'Pot of Avarice': 'Pot of Greed',
  'Jar of Greed': 'Pot of Greed',
  'Monster Rebirth': 'Monster Reborn',
  'Super Polymerization': 'Polymerization',
  // the Speed Duel decks' most played Spells and Traps share the classic that looks like them
  'Seven Tools of the Bandit': 'Magic Jammer',
  'Trap Jammer': 'Magic Jammer',
  'Dust Tornado': 'Mystical Space Typhoon',
  'Cosmic Cyclone': 'Mystical Space Typhoon',
  'Galaxy Cyclone': 'Mystical Space Typhoon',
  'Double Cyclone': 'Wild Tornado',
  'Diamond-Dust Cyclone': 'Wild Tornado',
  'Rope of Life': 'Monster Reborn',
  "Dragon's Rebirth": 'Monster Reborn',
  'Tornado Wall': 'Negate Attack',
};
const EXTRA_PRESETS: Record<string, Preset> = {
  'Chaos Trap Hole': trapHole(0x9a3cff, 0xfff1a8),
  'Adhesion Trap Hole': trapHole(0xffb030, 0xffe9a0),
  'Floodgate Trap Hole': trapHole(0x2a8aff, 0xbfefff),
  'Mirror Wall': {
    dur: 0.7,
    accent: 0xcff4ff,
    scope: 'oppAtk',
    play(c) {
      const { tl, U, t0, t1, st } = c;
      // a wall of mirror panes rises in front of the attackers (inside the shot that frames them); they see themselves and weaken
      const y = c.hits.length ? Math.min(...c.hits.map((a) => c.d['center'](a).y * Math.sign(c.opp))) * Math.sign(c.opp) - Math.sign(c.opp) * 0.9 * U : c.opp * 0.4;
      for (let i = 0; i < 5; i++) {
        const pane = tl.own(new Glow(1.3 * U, 1.9 * U, 'dome', 0x8fe3ff, 0xffffff));
        const x = (i - 2) * 0.95 * U;
        const t = t0 + Math.abs(i - 2) * 0.06;
        tl.span(t, t + 0.25, (k) => {
          pane.mesh.position.set(x, y - (1 - backOut(k)) * 1.2 * U, 0.9);
          pane.u.uOpacity.value = easeOut(k);
        });
        tl.span(t1 - 0.25, t1, (k) => (pane.u.uOpacity.value = 1 - k));
        tl.at(t + 0.2, () => (chime(0.6 + i * 0.05), st.particles.emit({ x, y, z: 1, burst: 1.2 * U, life: 0.5, size: 0.06 * U, color: 0xffffff, drag: 3 }, Math.round(16 * c.d['q']))));
      }
      // the glare bounces back onto every attacker: they darken and shrink a little (ATK halved)
      const hitT = t0 + 0.42;
      for (const a of c.hits) {
        const p = c.d['center'](a);
        sweep(c, { x: p.x * 0.6, y, z: 1 }, p, hitT, 0.12, 0x8fe3ff, 0xffffff, 0.5);
        tl.span(hitT + 0.1, t1, (k) => void (a.fig && (a.fig.u.uDark.value = 0.55 * Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5))));
      }
      tl.at(hitT, () => (zap(0.35), st.pulse('chroma', 0.35), c.d['flash'](0xcff4ff, 0.15)));
    },
  },
  'Spellbinding Circle': {
    dur: 0.65,
    accent: 0xc89aff,
    play(c) {
      const { tl, U, t0, t1, st } = c;
      // a rune circle opens under its target, then closes on it as a cage of light
      const p = aims(c, [{ x: 0, y: c.opp, z: 0.4 }])[0];
      const a = figAt(c, p);
      const foot = a ? a.y - a.size * 0.42 : p.y - 0.4 * U;
      const ring = tl.own(new Ring(2.4 * U, 0xc89aff, 7171, { inner: 0.7, outer: 0.93, star: 6 }));
      ring.mesh.position.set(p.x, foot, p.z);
      ring.mesh.rotation.x = -1.2;
      ring.spinSpeed = 2.4;
      ring.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.3, (k) => ((ring.u.uOpacity.value = easeOut(k)), ring.mesh.scale.setScalar(lerp(0.2, 1, backOut(k)))));
      tl.span(t1 - 0.25, t1, (k) => (ring.u.uOpacity.value = 1 - k));
      c.d['shafts'](tl, { x: p.x, y: foot, z: p.z }, 2.6 * U, 0xc89aff, t0 + 0.2, t1, 3, 0.5);
      const lock = tl.own(new Glow(1.2 * U, 1.2 * U, 'lock', 0xe6d4ff, 0xffffff));
      lock.u.uOpacity.value = 0;
      tl.span(t0 + 0.3, t0 + 0.5, (k) => {
        lock.mesh.position.set(p.x, p.y + lerp(0.9, 0.2, easeOut(k)) * U, p.z + 0.8);
        lock.u.uOpacity.value = easeOut(k);
      });
      tl.span(t1 - 0.2, t1, (k) => (lock.u.uOpacity.value = 1 - k));
      if (a) tl.span(t0 + 0.3, t1, (k) => void (a.fig && (a.fig.u.uDark.value = 0.4 * Math.min(1, k * 3))));
      tl.at(t0 + 0.45, () => (chime(0.55), zap(0.25), st.shake(0.3)));
    },
  },
  'Kunai with Chain': {
    dur: 0.55,
    accent: 0xdfe8ff,
    play(c) {
      const { tl, U, t0, st } = c;
      // the kunai flies out trailing its chain and wraps the attacker
      const p = aims(c, [{ x: 0, y: c.opp, z: 0.4 }])[0];
      const chain = tl.own(new Ribbon(24, 0xb8c4d8, 1));
      const blade = tl.own(new Glow(0.6 * U, 0.6 * U, 'arrow', 0xdfe8ff, 0xffffff));
      tl.span(t0, t0 + 0.25, (k) => {
        const e = easeIn(k);
        const pts = Array.from({ length: 16 }, (_, j) => {
          const q = (j / 15) * e;
          const b = P3lerp(c.card, p, q);
          return { x: b.x + Math.sin(q * 14) * 0.08 * U, y: b.y + Math.sin(q * Math.PI) * 0.6 * U, z: b.z + 0.4 };
        });
        chain.set(pts, 0.05 * U);
        const h = pts[pts.length - 1];
        blade.mesh.position.set(h.x, h.y, h.z + 0.1);
        blade.u.uOpacity.value = 1;
      });
      // the chain coils around it
      tl.span(t0 + 0.25, c.t1 - 0.1, (k) => {
        const pts = Array.from({ length: 22 }, (_, j) => {
          const q = j / 21;
          const ang = q * 12 + k * 4;
          return { x: p.x + Math.cos(ang) * 0.45 * U, y: p.y - 0.5 * U + q * 1 * U, z: p.z + 0.4 + Math.sin(ang) * 0.25 * U };
        });
        chain.set(pts, 0.05 * U);
        blade.u.uOpacity.value = 1 - k;
      });
      tl.span(c.t1 - 0.15, c.t1, (k) => (chain.u.uOpacity.value = 1 - k));
      tl.at(t0, () => whoosh(0.25, 2800, 900, 0.2));
      tl.at(t0 + 0.25, () => (zap(0.3), st.shake(0.4), st.particles.emit({ x: p.x, y: p.y, z: p.z + 0.4, burst: 2.5 * U, life: 0.4, size: 0.06 * U, color: 0xffffff, drag: 3 }, Math.round(40 * c.d['q']))));
      const a = figAt(c, p);
      if (a) strike(c, a, t0 + 0.25, 0.6);
    },
  },
  'Widespread Ruin': {
    dur: 0.6,
    accent: 0xffb050,
    play(c) {
      const { tl, U, t0, st } = c;
      // the ground under the strongest attacker erupts
      const p = aims(c, [{ x: 0, y: c.opp, z: 0.4 }])[0];
      const a = figAt(c, p);
      const foot = a ? a.y - a.size * 0.42 : p.y - 0.4 * U;
      for (let i = 0; i < 3; i++) shockAtP(c, { x: p.x, y: foot, z: p.z }, (1.6 + i * 0.8) * U, t0 + i * 0.07, 0xff7a2a, 0xffe0a0);
      const blast = tl.own(new Glow(2.6 * U, 3.2 * U, 'flame', 0xff5a1a, 0xffd070));
      blast.mesh.position.set(p.x, p.y, p.z + 0.5);
      blast.u.uOpacity.value = 0;
      tl.span(t0 + 0.12, t0 + 0.6, (k) => ((blast.u.uOpacity.value = Math.sin(k * Math.PI)), blast.mesh.scale.setScalar(lerp(0.4, 1.2, easeOut(k)))));
      tl.at(t0 + 0.12, () => (boom(0.7), st.shake(0.7), st.hitStop(0.05), c.d['flash'](0xff9a3a, 0.2), st.particles.emit({ x: p.x, y: foot, z: p.z + 0.2, r: 0.4 * U, vy: 5 * U, burst: 2 * U, gravity: 10 * U, life: 0.9, size: 0.12 * U, color: 0xffa040, drag: 0.4 }, Math.round(80 * c.d['q']))));
      if (a) strike(c, a, t0 + 0.15);
    },
  },
  Michizure: {
    dur: 0.6,
    accent: 0xb0ffd8,
    play(c) {
      const { tl, U, t0, t1, st } = c;
      // the fallen monster's ghost drags its killer down with it
      const p = aims(c, [{ x: 0, y: c.opp, z: 0.4 }])[0];
      const ghost = tl.own(new Glow(1.4 * U, 1.8 * U, 'flare', 0x6affc0, 0xe0fff0));
      ghost.u.uOpacity.value = 0;
      const from = { x: p.x * 0.3, y: c.own * 0.8, z: 0.8 };
      tl.span(t0, t0 + 0.35, (k) => {
        const q = bez3([from, { x: (from.x + p.x) / 2, y: (from.y + p.y) / 2 + 0.9 * U, z: 1.4 }, p], easeInOut(k));
        ghost.mesh.position.set(q.x, q.y, q.z + 0.3);
        ghost.u.uOpacity.value = 0.8 * Math.min(1, k * 3);
      });
      tl.span(t0 + 0.35, t1, (k) => (ghost.u.uOpacity.value = 0.8 * (1 - k)));
      const rift = tl.own(new Glow(2.2 * U, 2.2 * U, 'rift', 0x2aa070, 0xb0ffd8));
      rift.mesh.position.set(p.x, p.y - 0.45 * U, p.z);
      rift.mesh.rotation.x = -1.15;
      rift.u.uOpacity.value = 0;
      tl.span(t0 + 0.3, t1, (k) => (rift.u.uOpacity.value = Math.sin(k * Math.PI)));
      tl.at(t0, () => drone(0.7));
      tl.at(t0 + 0.35, () => (boom(0.45), st.shake(0.45), st.pulse('chroma', 0.4)));
      const a = figAt(c, p);
      if (a) strike(c, a, t0 + 0.35);
    },
  },
};

/** A flat ring on the ground at `p` that spreads out and fades (presets' version of shockAt). */
function shockAtP(c: PresetCtx, p: P3, size: number, t: number, color: number, light: number, dur = 0.45) {
  const g = c.tl.own(new Glow(size, size, 'shock', color, light));
  g.mesh.position.set(p.x, p.y, p.z);
  g.mesh.rotation.x = -1.15;
  c.tl.span(t, t + dur, (k) => ((g.u.uK.value = easeOut(k)), (g.u.uOpacity.value = 1 - k * 0.4)));
  c.tl.at(t + dur, () => (g.u.uOpacity.value = 0));
}

// ---------------------------------------------------------------- effect families
// A card with no preset of its own plays its effect family's cinematic (families.ts
// reads the family from its text): destroy, banish, revive, burn, ATK up... Each is
// short and seeded per card (colors, counts, which variant), so two cards of a family
// still look like themselves. Spells and Traps play it after the card opens; monster
// effects from the monster; Skills from the Skill's sigil.

/** A target of the effect as it stands on stage: a monster figure or a card lying in its zone. */
interface Spot {
  p: P3;
  uid: number;
  a: Actor | null;
  panel: CardPanel | null;
  destroyed: boolean;
}

interface FamCtx {
  d: Director;
  st: Stage;
  tl: Timeline;
  U: number;
  t0: number;
  t1: number;
  side: 'near' | 'far';
  /** the stage's middle height, and the two rows (resting camera) */
  cy: number;
  opp: number;
  own: number;
  /** where the effect comes from: the card, the monster, the Skill's sigil */
  src: P3;
  /** monsters it strikes (board-wide) and the targets it names */
  hits: Actor[];
  spots: Spot[];
  col: Colors;
  /** seeded by the card: the same card always plays the same way */
  r: () => number;
  cls: FxClass;
  text: string;
  q: number;
}

type FamFx = { dur: number; base: [number, number, number]; play: (c: FamCtx) => void };

/** The points it acts on: its spots, else what it strikes, else a spot on `row` (two when `wide`). */
function famAims(c: FamCtx, row: 'opp' | 'own', wide = false): { p: P3; s: Spot | null; a: Actor | null }[] {
  if (c.spots.length) return c.spots.map((s) => ({ p: s.p, s, a: s.a }));
  if (c.hits.length) return c.hits.map((a) => ({ p: c.d['center'](a), s: null, a }));
  const y = row === 'opp' ? c.opp : c.own;
  const xs = wide ? [-0.6, 0.6] : [0];
  return xs.map((x) => ({ p: { x: x * c.U, y, z: 0.3 }, s: null, a: null }));
}

/** An additive shape at `p` that fades in over [t0, t0 + fin] and out by t1. */
function glowAt(c: FamCtx, mode: GlowMode, p: P3, w: number, h: number, color: number, color2: number, t0: number, t1: number, peak = 1, fin = 0.15) {
  const g = c.tl.own(new Glow(w, h, mode, color, color2));
  g.mesh.position.set(p.x, p.y, p.z);
  g.u.uOpacity.value = 0;
  c.tl.span(t0, t1, (k) => {
    const t = k * (t1 - t0);
    g.u.uOpacity.value = peak * Math.min(1, t / fin) * (1 - easeIn(clamp01((t - (t1 - t0) * 0.7) / ((t1 - t0) * 0.3))));
  });
  return g;
}

/** A flat ring on the ground at `p` that spreads out and fades. */
function shockAt(c: FamCtx, p: P3, size: number, t: number, color: number, light: number, dur = 0.45, flat = true) {
  const g = c.tl.own(new Glow(size, size, 'shock', color, light));
  g.mesh.position.set(p.x, p.y, p.z);
  if (flat) g.mesh.rotation.x = -1.15;
  c.tl.span(t, t + dur, (k) => ((g.u.uK.value = easeOut(k)), (g.u.uOpacity.value = 1 - k * 0.4)));
  c.tl.at(t + dur, () => (g.u.uOpacity.value = 0));
  return g;
}

function sparks(c: FamCtx, p: P3, t: number, color: number, n: number, o: Partial<Emit> = {}) {
  c.tl.at(t, () => c.st.particles.emit({ x: p.x, y: p.y, z: p.z + 0.2, burst: 3 * c.U, life: 0.6, size: 0.08 * c.U, color, drag: 2.5, ...o }, Math.round(n * c.q)));
}

function stream(c: FamCtx, t0: number, t1: number, per: number, f: (i: number) => Emit) {
  let i = 0;
  c.tl.span(t0, t1, (_k, dt) => {
    for (let j = 0; j < rate(per * c.q, dt); j++) c.st.particles.emit(f(i++));
  });
}

/** A card flying from `a` to `b` along a bend (a back unless `face`), turning as it goes. */
function cardFly(c: FamCtx, a: P3, b: P3, t0: number, t1: number, o: { color?: number; size?: number; spin?: number; bend?: number; face?: HTMLCanvasElement | null; fade?: boolean } = {}) {
  const p = c.tl.own(new CardPanel(o.face ?? cardBack(), (o.size ?? 0.7) * c.U, o.color ?? c.col.main));
  p.u.uOpacity.value = 0;
  c.tl.span(t0, t1, (k) => {
    const e = easeInOut(k);
    const q = bez(a, b, o.bend ?? 0.4 * c.U, e);
    p.mesh.position.set(q.x, q.y, q.z);
    p.mesh.rotation.set(0, (o.spin ?? 0) * e, (o.spin ? 0.2 : 0) * Math.sin(e * Math.PI));
    p.u.uOpacity.value = Math.min(1, k * 6) * (o.fade === false ? 1 : 1 - easeIn(clamp01((k - 0.8) / 0.2)));
    p.u.uSheen.value = lerp(-0.4, 1.8, k);
  });
  c.tl.at(t1, () => (p.u.uOpacity.value = 0));
  return p;
}

/** Tints a figure toward `color` and back over [t0, t1] (its painted detail kept). */
function tintPulse(c: FamCtx, a: Actor | null, panel: CardPanel | null, t0: number, t1: number, color: number, amt = 0.35, dark = 0) {
  if (a?.fig) {
    const f = a.fig;
    c.tl.at(t0, () => (setRgb(f.u.uTintCol.value, color), (f.u.uTintKeep.value = 1)));
    c.tl.span(t0, t1, (k) => {
      f.u.uTint.value = amt * Math.sin(k * Math.PI);
      if (dark) f.u.uDark.value = dark * Math.sin(k * Math.PI);
    });
  }
  if (a?.back) {
    const b = a.back;
    c.tl.span(t0, t1, (k) => (b.u.uTint.value = amt * Math.sin(k * Math.PI)));
  }
  if (panel) c.tl.span(t0, t1, (k) => (panel.u.uTint.value = amt * Math.sin(k * Math.PI)));
}

/** The owner's hand: off the bottom edge (you) or the top (them). */
const handY = (c: FamCtx, near: boolean) => (near ? -1 : 1) * 3.4 * c.U;
/** The owner's Deck, beside their row. */
const deckAt = (c: FamCtx, near: boolean): P3 => ({ x: (near ? 1 : -1) * 1.2 * c.U, y: (near ? -1 : 1) * 1.35 * c.U, z: 0.3 });
const nearOf = (c: FamCtx, a: Actor | null, p: P3) => (a ? a.side === 'near' : c.side === 'near' ? p.y < c.cy + 0.3 * c.U : p.y < c.cy - 0.3 * c.U);
/** The first number the text gives before `word` ("draw 2 cards" → 2), clamped. */
function countIn(text: string, re: RegExp, lo: number, hi: number, dflt: number): number {
  const m = re.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

const FAMILY_FX: Record<FxFamily, FamFx> = {
  destroy: {
    dur: 0.6,
    base: [0xff5a3a, 0xffb070, 0xfff0d0],
    play(c) {
      const { tl, U, t0, col } = c;
      const kind = Math.floor(c.r() * 3);
      famAims(c, 'opp').forEach((x, i) => {
        const t = t0 + 0.12 + i * 0.08;
        const p = x.p;
        if (kind === 0) {
          // a lance of light from the sky
          const core = tl.own(new Ribbon(10, 0xffffff, 0));
          const glow = tl.own(new Ribbon(10, col.main, 1));
          const pts = [{ x: p.x + 0.4 * U, y: p.y + 3.4 * U, z: p.z + 0.4 }, { x: p.x, y: p.y, z: p.z + 0.4 }];
          core.set(pts, 0.07 * U);
          glow.set(pts, 0.36 * U);
          core.u.uHead.value = glow.u.uHead.value = 0;
          tl.span(t - 0.1, t, (k) => (core.u.uHead.value = glow.u.uHead.value = easeIn(k) * 1.05));
          tl.span(t + 0.1, t + 0.4, (k) => ((core.u.uTail.value = glow.u.uTail.value = easeIn(k)), (glow.u.uOpacity.value = 1 - k)));
        } else if (kind === 1) {
          // a blade of light slashing across it
          const arc = tl.own(new Ribbon(24, col.light, 1));
          const pts = Array.from({ length: 14 }, (_, j) => {
            const a = lerp(2.4, -0.6, j / 13);
            return { x: p.x + Math.cos(a) * 0.6 * U, y: p.y + Math.sin(a) * 0.6 * U - 0.1 * U, z: p.z + 0.5 };
          });
          arc.set(pts, (q) => 0.1 * U * Math.sin(q * Math.PI));
          arc.u.uHead.value = 0;
          tl.span(t - 0.12, t, (k) => (arc.u.uHead.value = easeIn(k) * 1.05));
          tl.span(t + 0.05, t + 0.3, (k) => ((arc.u.uTail.value = easeIn(k)), (arc.u.uOpacity.value = 1 - k)));
          tl.at(t - 0.12, () => whoosh(0.15, 2400, 600, 0.2));
        } else {
          // a sigil slamming down onto it
          const ring = tl.own(new Ring(1.9 * U, col.main, Math.floor(c.r() * 900), { inner: 0.55, outer: 0.92, star: 5 + Math.floor(c.r() * 3) }));
          ring.mesh.position.set(p.x, p.y + 1.6 * U, p.z + 0.4);
          ring.spinSpeed = 4;
          ring.u.uOpacity.value = 0;
          tl.span(t - 0.2, t, (k) => {
            ring.mesh.position.y = lerp(p.y + 1.6 * U, p.y - 0.2 * U, easeIn(k));
            ring.mesh.rotation.x = -1.15 * k;
            ring.u.uOpacity.value = k;
          });
          tl.span(t, t + 0.3, (k) => (ring.u.uOpacity.value = 1 - k));
        }
        shockAt(c, { x: p.x, y: p.y - 0.35 * U, z: p.z }, 2.2 * U, t, col.main, col.light);
        tl.at(t, () => {
          zap(0.3);
          boom(0.35);
          c.st.shake(0.45);
          c.st.pulse('chroma', 0.4);
          c.d['flash'](col.light, 0.16);
        });
        sparks(c, p, t, col.light, 40, { vy: 1 * U, gravity: 5 * U });
        if (x.a) c.d['strike'](tl, x.a, t);
        if (x.s?.panel && x.s.destroyed) tl.at(t + 0.02, () => void c.d['panelShards'](tl, x.s!.panel!, col.main, 2.6 * U), false);
      });
    },
  },
  destroyAll: {
    dur: 0.8,
    base: [0xff3a5a, 0xff9a40, 0xffe6c0],
    play(c) {
      const { tl, U, t0, col } = c;
      const aims = famAims(c, c.cls.scope === 'own' ? 'own' : 'opp', true).sort((a, b) => a.p.x - b.p.x);
      const ltr = c.r() < 0.5;
      const row = aims.reduce((s, x) => s + x.p.y, 0) / aims.length;
      // a nova bursts from the card; a wall of force sweeps the row; each one erupts in turn
      shockAt(c, c.src, 7 * U, t0, col.main, col.light, 0.6, false);
      const sweep = tl.own(new Ribbon(12, col.light, 1));
      let sx = 0;
      tl.span(t0 + 0.05, t0 + 0.55, (k) => {
        const x = (sx = lerp(ltr ? -2.4 : 2.4, ltr ? 2.4 : -2.4, easeInOut(k)) * U);
        sweep.set([{ x, y: row - 1 * U, z: 0.9 }, { x: x + (ltr ? -0.3 : 0.3) * U, y: row + 1.1 * U, z: 0.9 }], (q) => 0.22 * U * Math.sin(q * Math.PI));
        sweep.u.uOpacity.value = Math.sin(k * Math.PI);
      });
      stream(c, t0 + 0.05, t0 + 0.55, 200, () => ({ x: sx, y: row + (Math.random() - 0.5) * 2 * U, z: 0.6, vx: (ltr ? 3 : -3) * U, burst: 1 * U, life: 0.4, size: 0.08 * U, color: Math.random() < 0.5 ? col.main : col.light, drag: 1.5 }));
      tl.at(t0, () => (drone(0.6), whoosh(0.55, 300, 2600, 0.3), c.d['flash'](col.light, 0.12)));
      const order = ltr ? aims : [...aims].reverse();
      order.forEach((x, i) => {
        const t = t0 + 0.15 + (i / Math.max(1, order.length - 1)) * 0.35;
        // a pillar of force erupting under it
        const pil = glowAt(c, 'shaft', { x: x.p.x, y: x.p.y + 0.6 * U, z: x.p.z + 0.4 }, 1.3 * U, 3.4 * U, col.main, col.light, t - 0.04, t + 0.4, 1.3, 0.05);
        void pil;
        glowAt(c, 'flare', { ...x.p, z: x.p.z + 0.5 }, 2 * U, 2 * U, col.light, 0xffffff, t, t + 0.3, 0.8, 0.03);
        shockAt(c, { x: x.p.x, y: x.p.y - 0.35 * U, z: x.p.z }, 2 * U, t, col.main, col.light);
        sparks(c, x.p, t, col.light, 40, { vy: 2 * U, gravity: 6 * U });
        tl.at(t, () => (boom(0.3), c.st.shake(0.4)));
        if (x.a) c.d['strike'](tl, x.a, t);
        if (x.s?.panel && x.s.destroyed) tl.at(t, () => void c.d['panelShards'](tl, x.s!.panel!, col.main, 2.6 * U), false);
      });
      tl.at(t0 + 0.5, () => (boom(0.7), c.st.shake(0.8), c.st.pulse('chroma', 0.6), c.d['flash'](col.main, 0.2)));
    },
  },
  banish: {
    dur: 0.7,
    base: [0x9a5aff, 0xff7af0, 0xf0e0ff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      for (const x of famAims(c, 'opp')) {
        const p = x.p;
        const rift = glowAt(c, 'rift', { x: p.x, y: p.y, z: p.z - 0.2 }, 0.95 * U, 1.75 * U, col.main, col.accent, t0, t1, 1, 0.1);
        rift.mesh.rotation.z = (c.r() - 0.5) * 0.6;
        tl.span(t0, t1, (k) => (rift.u.uK.value = k < 0.3 ? easeOut(k / 0.3) : k > 0.8 ? 1 - easeIn((k - 0.8) / 0.2) : 1));
        stream(c, t0 + 0.05, t1 - 0.15, 160, () => {
          const a = Math.random() * Math.PI * 2;
          const rr = (0.8 + Math.random() * 0.8) * U;
          return { x: p.x + Math.cos(a) * rr, y: p.y + Math.sin(a) * rr, z: p.z, life: 0.45, size: 0.08 * U, color: Math.random() < 0.5 ? col.main : col.light, drag: 0, pull: { x: p.x, y: p.y, strength: 18 * U, swirl: 8 * U } };
        });
        const a = x.a;
        if (a) {
          tl.span(t0 + 0.15, t1 - 0.1, (k) => {
            const e = easeIn(k);
            const m = a.fig?.mesh ?? a.back?.mesh;
            if (m) m.scale.setScalar((a.fig ? a.size : 1) * (1 - e * 0.85));
            a.oz = -e * 0.8;
            if (a.fig) a.fig.u.uDark.value = e * 0.8;
            c.d['setOpacity'](a, 1 - easeIn(clamp01((k - 0.6) / 0.4)));
            c.d['place'](a);
          });
        }
        const pn = x.s?.panel;
        if (pn) tl.span(t0 + 0.15, t1 - 0.1, (k) => (pn.mesh.scale.setScalar(1 - easeIn(k) * 0.9), (pn.mesh.rotation.z = k * 2), (pn.u.uOpacity.value = 1 - easeIn(k))));
        tl.at(t0, () => (drone(0.5), zap(0.25)));
        tl.at(t1 - 0.12, () => (c.d['flash'](col.light, 0.12), sparks(c, p, t1 - 0.12, col.light, 30)));
      }
    },
  },
  bounce: {
    dur: 0.6,
    base: [0x4ad8ff, 0x9affff, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      for (const x of famAims(c, 'opp')) {
        const near = nearOf(c, x.a, x.p);
        const to = { x: x.p.x * 0.4, y: handY(c, near), z: 1.2 };
        const t = t0 + 0.12;
        // it turns back into its card, which hovers a moment, then is thrown back to its owner's hand
        const a = x.a;
        if (a) tl.span(t0, t + 0.15, (k) => (c.d['setOpacity'](a, 1 - k), (a.oy = k * 0.2 * U), c.d['place'](a)));
        if (x.s?.panel) tl.span(t0, t + 0.1, (k) => (x.s!.panel!.u.uOpacity.value = 1 - k));
        const hover = { x: x.p.x, y: x.p.y + 0.25 * U, z: x.p.z + 0.6 };
        const ghost = cardFly(c, x.p, hover, t, t + 0.3, { color: col.light, size: 0.8, spin: Math.PI, bend: 0, fade: false });
        tl.span(t, t + 0.3, (k) => (ghost.u.uTint.value = 0.5 * (1 - k)));
        tl.at(t + 0.3, () => (ghost.u.uOpacity.value = 0));
        const fly = cardFly(c, hover, to, t + 0.3, t1, { color: col.main, size: 0.8, spin: Math.PI * 2, bend: (c.r() - 0.5) * 1.2 * U });
        const trail = tl.own(new Ribbon(20, col.light, 1));
        const hist: P3[] = [];
        tl.span(t, t1, () => {
          const m = fly.mesh.position;
          hist.push({ x: m.x, y: m.y, z: m.z - 0.05 });
          if (hist.length > 12) hist.shift();
          if (hist.length > 1) trail.set(hist, (q) => 0.12 * U * q);
        });
        tl.at(t1, () => (trail.u.uOpacity.value = 0));
        shockAt(c, { x: x.p.x, y: x.p.y - 0.3 * U, z: x.p.z }, 1.8 * U, t0, col.main, col.light, 0.4);
        tl.at(t, () => whoosh(0.4, 600, 2800, 0.2));
      }
    },
  },
  toDeck: {
    dur: 0.75,
    base: [0x5a8aff, 0xb0c8ff, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const aims = famAims(c, 'opp');
      const near = nearOf(c, aims[0].a, aims[0].p);
      const deck = deckAt(c, near);
      // the Deck, a short stack, waiting
      const stack = [0, 1, 2].map((i) => {
        const p = tl.own(new CardPanel(cardBack(), 0.75 * U, col.main));
        p.mesh.position.set(deck.x, deck.y + i * 0.03 * U, deck.z + i * 0.02);
        p.u.uOpacity.value = 0;
        tl.span(t0, t0 + 0.15, (k) => (p.u.uOpacity.value = k));
        tl.span(t1 - 0.12, t1, (k) => (p.u.uOpacity.value = 1 - k));
        return p;
      });
      aims.forEach((x, i) => {
        const t = t0 + 0.1 + i * 0.06;
        const a = x.a;
        if (a) tl.span(t0, t + 0.15, (k) => c.d['setOpacity'](a, 1 - k));
        if (x.s?.panel) tl.span(t0, t + 0.1, (k) => (x.s!.panel!.u.uOpacity.value = 1 - k));
        cardFly(c, x.p, { ...deck, z: deck.z + 0.1 }, t, t + 0.4, { color: col.main, size: 0.75, spin: Math.PI * 3, bend: 0.5 * U });
      });
      // the shuffle: the stack riffles
      tl.span(t0 + 0.5, t1 - 0.1, (k) => stack.forEach((p, i) => (p.mesh.position.x = deck.x + Math.sin(k * Math.PI * 4 + i * 2) * 0.18 * U * (1 - k))));
      tl.at(t0 + 0.5, () => (whoosh(0.2, 1800, 900, 0.15), sparks(c, deck, t0 + 0.5, col.light, 20, { burst: 1.5 * U })));
    },
  },
  revive: {
    dur: 0.8,
    base: [0x3aff9a, 0xc0ffd8, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const p: P3 = c.spots[0]?.p ?? { x: 0, y: c.own * 0.85, z: 0.3 };
      const foot = { x: p.x, y: p.y - 0.4 * U, z: p.z };
      // the grave opens: a pit of light on the ground, spirits rising out of it
      const pit = glowAt(c, 'vortex', foot, 2.6 * U, 2.6 * U, col.main, col.accent, t0, t1, 1, 0.2);
      pit.mesh.rotation.x = -1.2;
      const ring = tl.own(new Ring(2.4 * U, col.light, Math.floor(c.r() * 999), { inner: 0.8, outer: 0.92, star: 6 }));
      ring.mesh.position.set(foot.x, foot.y, foot.z + 0.02);
      ring.mesh.rotation.x = -1.2;
      ring.spinSpeed = 2;
      ring.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.25, (k) => ((ring.u.uOpacity.value = k), ring.mesh.scale.setScalar(easeOut(k))));
      tl.span(t1 - 0.2, t1, (k) => (ring.u.uOpacity.value = 1 - k));
      c.d['shafts'](tl, foot, 3.6 * U, col.main, t0 + 0.15, t1, 3, 0.7);
      stream(c, t0 + 0.1, t1 - 0.1, 120, () => ({ x: foot.x + (Math.random() - 0.5) * 1.2 * U, y: foot.y, z: foot.z + 0.2, vy: (2 + Math.random() * 2) * U, life: 0.7, size: 0.09 * U, color: Math.random() < 0.6 ? col.main : col.light, drag: 0.4 }));
      // a card rises out of the grave and turns to the light
      const card = cardFly(c, { x: foot.x, y: foot.y - 0.6 * U, z: 0.1 }, { x: p.x, y: p.y + 0.5 * U, z: 0.9 }, t0 + 0.2, t1, { color: col.light, size: 0.9, spin: Math.PI * 2, bend: 0 });
      tl.span(t0 + 0.2, t1, (k) => (card.u.uTint.value = 0.4 * k));
      const ankh = glowAt(c, 'star', { x: p.x, y: p.y + 0.5 * U, z: 1.1 }, 1.6 * U, 1.6 * U, col.light, 0xffffff, t1 - 0.3, t1, 1, 0.08);
      ankh.mesh.rotation.z = 0.4;
      tl.at(t0, () => (drone(0.6), chime(0.6)));
      tl.at(t1 - 0.3, () => (chime(0.95), c.d['flash'](col.light, 0.15)));
    },
  },
  special: {
    dur: 0.65,
    base: [0xffc94a, 0xffe9a0, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const p: P3 = c.spots.find((s) => !s.destroyed)?.p ?? { x: (c.r() - 0.5) * 0.8 * U, y: c.own, z: 0.3 };
      // a gate of light opens upright on its row and a card drops through it
      const gate = tl.own(new Ring(2.2 * U, col.main, Math.floor(c.r() * 999), { inner: 0.62, outer: 0.92, star: 4 + Math.floor(c.r() * 4) }));
      gate.mesh.position.set(p.x, p.y + 0.4 * U, p.z - 0.2);
      gate.spinSpeed = c.r() < 0.5 ? 2 : -2;
      gate.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.25, (k) => ((gate.u.uOpacity.value = k), gate.mesh.scale.set(easeOut(k), backOut(k), 1)));
      tl.span(t1 - 0.2, t1, (k) => (gate.u.uOpacity.value = 1 - k));
      const core = glowAt(c, 'flare', { x: p.x, y: p.y + 0.4 * U, z: p.z }, 2.2 * U, 2.2 * U, col.main, col.light, t0 + 0.15, t1, 0.8);
      core.u.uK.value = 0.4;
      cardFly(c, { x: p.x, y: p.y + 2.4 * U, z: 0.8 }, { x: p.x, y: p.y + 0.3 * U, z: 0.2 }, t0 + 0.1, t0 + 0.45, { color: col.light, size: 0.85, bend: 0 });
      shockAt(c, { x: p.x, y: p.y - 0.4 * U, z: p.z }, 3 * U, t0 + 0.45, col.main, col.light);
      sparks(c, { ...p, y: p.y + 0.3 * U }, t0 + 0.45, col.light, 50);
      tl.at(t0 + 0.45, () => (boom(0.4), chime(0.8), c.st.shake(0.3)));
    },
  },
  fusion: {
    dur: 0.8,
    base: [0xb04aff, 0xff8a3a, 0xffe0ff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const p: P3 = { x: 0, y: c.cy + 0.2 * U, z: 0.6 };
      const v = glowAt(c, 'vortex', { ...p, z: -0.6 }, 4.4 * U, 4.4 * U, col.main, col.accent, t0, t1, 1, 0.2);
      v.mesh.rotation.z = c.r() * 6;
      // two (or three) materials spiral into one
      const n = 2 + (c.r() < 0.3 ? 1 : 0);
      const orbs = Array.from({ length: n }, (_, i) => {
        const g = tl.own(new Glow(1.1 * U, 1.1 * U, 'flare', i % 2 ? col.accent : col.main, 0xffffff));
        g.u.uOpacity.value = 0;
        return g;
      });
      tl.span(t0, t0 + 0.5, (k, dt) =>
        orbs.forEach((g, i) => {
          const a = (i / n) * Math.PI * 2 + k * 10;
          const rr = (1 - easeIn(k)) * 1.6 * U;
          g.mesh.position.set(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr * 0.7, p.z);
          g.u.uOpacity.value = Math.min(1, k * 5);
          for (let j = 0; j < rate(60 * c.q, dt); j++) c.st.particles.emit({ x: g.mesh.position.x, y: g.mesh.position.y, z: p.z, burst: 0.3 * U, life: 0.35, size: 0.12 * U, color: i % 2 ? col.accent : col.main, drag: 3 });
        }),
      );
      tl.at(t0 + 0.5, () => {
        for (const g of orbs) g.u.uOpacity.value = 0;
        c.st.pulse('flash', 0.3);
        c.d['flash'](col.light, 0.25);
        boom(0.55);
        chime(c.r());
      });
      const merged = glowAt(c, 'star', p, 2.6 * U, 2.6 * U, col.light, 0xffffff, t0 + 0.5, t1, 1, 0.05);
      tl.span(t0 + 0.5, t1, (k) => merged.mesh.scale.setScalar(lerp(0.4, 1.3, easeOut(k))));
      sparks(c, p, t0 + 0.5, col.light, 90, { burst: 5 * U });
      tl.at(t0, () => swell(0.5));
    },
  },
  ritual: {
    dur: 0.85,
    base: [0x3a9aff, 0xff5a2a, 0xe0f0ff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const foot: P3 = { x: 0, y: c.own * 0.55, z: 0.2 };
      const circle = tl.own(new Ring(3.2 * U, col.main, Math.floor(c.r() * 999), { inner: 0.7, outer: 0.92, star: 5 }));
      circle.mesh.position.set(foot.x, foot.y, foot.z);
      circle.mesh.rotation.x = -1.2;
      circle.spinSpeed = 0.8;
      circle.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.3, (k) => ((circle.u.uOpacity.value = k), circle.mesh.scale.setScalar(easeOut(k))));
      tl.span(t1 - 0.2, t1, (k) => (circle.u.uOpacity.value = 1 - k));
      // flames at the points of the star, lit one after another
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
        const fp = { x: foot.x + Math.cos(a) * 1.3 * U, y: foot.y + Math.sin(a) * 1.3 * U * 0.36 + 0.45 * U, z: foot.z + Math.sin(a) * 0.4 };
        glowAt(c, 'flame', fp, 0.8 * U, 1.3 * U, col.accent, 0xffd070, t0 + 0.15 + i * 0.06, t1, 1, 0.1);
        tl.at(t0 + 0.15 + i * 0.06, () => whoosh(0.15, 300, 900, 0.08));
      }
      c.d['shafts'](tl, foot, 4 * U, col.main, t0 + 0.45, t1, 3, 0.75);
      glowAt(c, 'flare', { x: foot.x, y: foot.y + 1 * U, z: 0.6 }, 2.4 * U, 2.4 * U, col.main, col.light, t0 + 0.45, t1, 0.8);
      tl.at(t0 + 0.45, () => (boom(0.5), chime(0.4), c.st.shake(0.4), c.d['flash'](col.light, 0.2)));
      tl.at(t0, () => drone(0.8));
    },
  },
  token: {
    dur: 0.6,
    base: [0x7affc8, 0xfff07a, 0xffffff],
    play(c) {
      const { U, t0, t1, col } = c;
      const n = countIn(c.text, /(\d)\s+["A-Za-z -]*Tokens?/, 1, 4, 2 + Math.floor(c.r() * 2));
      for (let i = 0; i < n; i++) {
        const to: P3 = { x: (i - (n - 1) / 2) * 0.9 * U, y: c.own * 0.75, z: 0.4 };
        const t = t0 + i * 0.08;
        cardFly(c, c.src, to, t, t + 0.35, { color: i % 2 ? col.accent : col.main, size: 0.6, spin: Math.PI * 2, bend: (i - (n - 1) / 2) * 0.5 * U, fade: false });
        glowAt(c, 'star', to, 1.2 * U, 1.2 * U, col.light, 0xffffff, t + 0.3, t1, 1, 0.05);
        sparks(c, to, t + 0.33, i % 2 ? col.accent : col.main, 24, { burst: 2 * U });
        c.tl.at(t + 0.33, () => chime(0.6 + i * 0.1));
      }
    },
  },
  search: {
    dur: 0.7,
    base: [0x4affd0, 0xa0fff0, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const near = c.side === 'near';
      const deck = deckAt(c, near);
      [0, 1, 2, 3].forEach((i) => {
        const p = tl.own(new CardPanel(cardBack(), 0.75 * U, col.main));
        p.mesh.position.set(deck.x, deck.y + i * 0.03 * U, deck.z + i * 0.02);
        p.u.uOpacity.value = 0;
        tl.span(t0, t0 + 0.12, (k) => (p.u.uOpacity.value = k));
        // the cards fan out as it looks through them
        tl.span(t0 + 0.1, t0 + 0.35, (k) => (p.mesh.rotation.z = (i - 1.5) * 0.18 * easeOut(k)));
        tl.span(t1 - 0.15, t1, (k) => (p.u.uOpacity.value = 1 - k));
      });
      const scan = glowAt(c, 'shaft', { x: deck.x, y: deck.y + 0.6 * U, z: deck.z + 0.2 }, 0.5 * U, 2 * U, col.light, col.light, t0 + 0.1, t0 + 0.45, 0.9);
      tl.span(t0 + 0.1, t0 + 0.45, (k) => (scan.mesh.position.x = deck.x + Math.sin(k * Math.PI * 2) * 0.4 * U));
      const got = cardFly(c, { ...deck, y: deck.y + 0.5 * U, z: deck.z + 0.3 }, { x: 0, y: handY(c, near), z: 1 }, t0 + 0.4, t1, { color: col.light, size: 0.85, bend: -0.6 * U });
      tl.span(t0 + 0.4, t1, (k) => (got.u.uTint.value = 0.3 * Math.sin(k * Math.PI)));
      tl.at(t0 + 0.4, () => (chime(0.85), whoosh(0.3, 800, 2600, 0.15)));
    },
  },
  draw: {
    dur: 0.6,
    base: [0xffd75a, 0xfff2b0, 0xffffff],
    play(c) {
      const { U, t0, t1, col } = c;
      const near = c.side === 'near';
      const n = countIn(c.text, /draw (\d)/i, 1, 3, 1 + Math.floor(c.r() * 2));
      const deck = deckAt(c, near);
      for (let i = 0; i < n; i++) {
        const t = t0 + 0.05 + i * 0.12;
        cardFly(c, deck, { x: (i - (n - 1) / 2) * 0.7 * U, y: handY(c, near), z: 1.2 }, t, Math.min(t1, t + 0.42), { color: col.main, size: 0.85, bend: -0.3 * U });
        c.tl.at(t, () => whoosh(0.2, 900, 2600, 0.12));
      }
      glowAt(c, 'star', deck, 1.4 * U, 1.4 * U, col.light, 0xffffff, t0, t0 + 0.4, 1, 0.05);
    },
  },
  heal: {
    dur: 0.6,
    base: [0x5aff7a, 0xc8ffb0, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const near = c.side === 'near';
      const y0 = c.own;
      // green light rising on its own side; crosses drifting up
      const n = 3 + Math.floor(c.r() * 3);
      for (let i = 0; i < n; i++) {
        const g = tl.own(new Glow(0.55 * U, 0.55 * U, 'plus', col.main, col.light));
        const x = (c.r() - 0.5) * 2.4 * U;
        const t = t0 + c.r() * 0.2;
        g.u.uOpacity.value = 0;
        tl.span(t, t1, (k) => {
          g.mesh.position.set(x, y0 - 0.3 * U + k * 1.6 * U, 0.8);
          g.u.uOpacity.value = Math.sin(k * Math.PI);
        });
      }
      stream(c, t0, t1 - 0.1, 140, () => ({ x: (Math.random() - 0.5) * 3 * U, y: y0 - 0.5 * U, z: 0.5, vy: (1.5 + Math.random() * 1.5) * U, life: 0.7, size: 0.08 * U, color: Math.random() < 0.6 ? col.main : col.light, drag: 0.5 }));
      const floor = glowAt(c, 'shaft', { x: 0, y: y0 + 0.6 * U, z: -0.4 }, 4 * U, 2.6 * U, col.main, col.light, t0, t1, 0.7);
      void floor;
      tl.at(t0 + 0.1, () => {
        chime(0.95);
        lpBeat(near ? 'bottom' : 'top', 'art-lp-heal', 600);
      });
    },
  },
  burn: {
    dur: 0.7,
    base: [0xff5a1a, 0xffb040, 0xfff0c0],
    play(c) {
      const { tl, U, t0, col } = c;
      const near = c.side === 'near';
      const n = 1 + Math.floor(c.r() * 3);
      // (it lands on the opponent's side, in frame; their Life Points plate takes it)
      const to: P3 = { x: 0, y: c.opp * 1.1, z: 0.5 };
      for (let i = 0; i < n; i++) {
        const t = t0 + i * 0.1;
        const a = { ...c.src, z: c.src.z + 0.3 };
        const end = { x: to.x + (i - (n - 1) / 2) * 0.5 * U, y: to.y, z: to.z };
        const g = tl.own(new Glow(0.9 * U, 0.9 * U, 'flare', col.main, col.light));
        g.u.uOpacity.value = 0;
        const bend = (i - (n - 1) / 2 + (c.r() - 0.5)) * 1.2 * U;
        tl.span(t, t + 0.35, (k, dt) => {
          const q = bez(a, end, bend, easeIn(k));
          g.mesh.position.set(q.x, q.y, q.z);
          g.u.uOpacity.value = 1;
          for (let j = 0; j < rate(150 * c.q, dt); j++) c.st.particles.emit({ x: q.x, y: q.y, z: q.z, burst: 0.5 * U, vy: 0.5 * U, life: 0.35, size: 0.13 * U, color: j % 2 ? col.main : col.accent, drag: 3 });
        });
        tl.at(t + 0.35, () => (g.u.uOpacity.value = 0));
        shockAt(c, end, 2 * U, t + 0.35, col.main, col.light, 0.4, false);
        sparks(c, end, t + 0.35, col.accent, 40, { burst: 4 * U });
        tl.at(t + 0.35, () => (boom(0.35), c.st.shake(0.4)));
      }
      tl.at(t0 + 0.05, () => whoosh(0.35, 400, 1800, 0.25));
      tl.at(t0 + 0.35, () => {
        lpBeat(near ? 'top' : 'bottom', 'art-lp-shake', 420);
        c.d['flash'](col.main, 0.15);
      });
      tl.span(t0 + 0.35, t0 + 0.7, (k) => (c.d['front'].u.uRed.value = Math.max(c.d['front'].u.uRed.value, 0.18 * (1 - k))));
    },
  },
  powerUp: {
    dur: 0.6,
    base: [0xffb020, 0xffe070, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const aims = famAims(c, c.cls.scope === 'opp' ? 'opp' : 'own', true);
      for (const x of aims) {
        const p = x.p;
        const ring = tl.own(new Ring(1.7 * U, col.main, Math.floor(c.r() * 999), { inner: 0.78, outer: 0.92 }));
        ring.mesh.position.set(p.x, p.y - 0.45 * U, p.z);
        ring.mesh.rotation.x = -1.15;
        ring.spinSpeed = 3;
        ring.u.uOpacity.value = 0;
        tl.span(t0, t0 + 0.2, (k) => ((ring.u.uOpacity.value = k), ring.mesh.scale.setScalar(easeOut(k))));
        tl.span(t1 - 0.2, t1, (k) => (ring.u.uOpacity.value = 1 - k));
        for (let i = 0; i < 3; i++) {
          const g = tl.own(new Glow(0.45 * U, 0.6 * U, 'arrow', col.main, col.light));
          const dx = (i - 1) * 0.45 * U;
          const t = t0 + 0.05 + i * 0.07;
          g.u.uOpacity.value = 0;
          tl.span(t, t1, (k) => {
            g.mesh.position.set(p.x + dx, p.y - 0.4 * U + easeOut(k) * 1.3 * U, p.z + 0.4);
            g.u.uOpacity.value = Math.sin(k * Math.PI);
          });
        }
        tintPulse(c, x.a, x.s?.panel ?? null, t0 + 0.1, t1, col.main, 0.32);
        stream(c, t0, t1 - 0.1, 70, () => ({ x: p.x + (Math.random() - 0.5) * 0.9 * U, y: p.y - 0.5 * U, z: p.z + 0.3, vy: 3 * U, life: 0.4, size: 0.07 * U, color: col.light, drag: 0.5 }));
      }
      tl.at(t0 + 0.1, () => (chime(0.7), swell(0.3)));
    },
  },
  powerDown: {
    dur: 0.6,
    base: [0x7a4aff, 0x4a2a9a, 0xd0c0ff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      for (const x of famAims(c, c.cls.scope === 'own' ? 'own' : 'opp', true)) {
        const p = x.p;
        for (let i = 0; i < 3; i++) {
          const g = tl.own(new Glow(0.45 * U, 0.6 * U, 'arrow', col.main, col.light));
          g.mesh.rotation.z = Math.PI;
          const dx = (i - 1) * 0.45 * U;
          const t = t0 + i * 0.06;
          g.u.uOpacity.value = 0;
          tl.span(t, t1, (k) => {
            g.mesh.position.set(p.x + dx, p.y + 1.1 * U - easeIn(k) * 1.3 * U, p.z + 0.4);
            g.u.uOpacity.value = Math.sin(k * Math.PI);
          });
        }
        // a weight pressing it down
        shockAt(c, { x: p.x, y: p.y - 0.45 * U, z: p.z }, 2 * U, t0 + 0.3, col.main, col.light);
        const a = x.a;
        if (a) tl.span(t0 + 0.25, t1, (k) => ((a.oy = -Math.sin(k * Math.PI) * 0.08 * U), c.d['place'](a)));
        tintPulse(c, a, x.s?.panel ?? null, t0 + 0.2, t1, col.main, 0.25, 0.5);
        stream(c, t0, t1 - 0.1, 60, () => ({ x: p.x + (Math.random() - 0.5) * 0.9 * U, y: p.y + 0.6 * U, z: p.z + 0.3, vy: -2.5 * U, life: 0.4, size: 0.07 * U, color: col.main, drag: 0.5 }));
      }
      tl.at(t0 + 0.3, () => (boom(0.3), drone(0.4), c.st.shake(0.3)));
    },
  },
  negate: {
    dur: 0.6,
    base: [0xff2a4a, 0xff9aa0, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const p: P3 = c.spots[0]?.p ?? { x: 0, y: c.cy + 0.2 * U, z: 0.9 };
      // the forbidden sign stamps down; an X of light cuts through it
      const ban = glowAt(c, 'ban', { ...p, z: p.z + 0.5 }, 1.3 * U, 1.3 * U, col.main, col.light, t0, t1, 0.9, 0.05);
      tl.span(t0, t0 + 0.15, (k) => ban.mesh.scale.setScalar(lerp(2, 1, easeIn(k))));
      for (const s of [-1, 1]) {
        const rib = tl.own(new Ribbon(8, col.light, 0));
        rib.set([{ x: p.x - 0.6 * U, y: p.y + s * 0.6 * U, z: p.z + 0.7 }, { x: p.x + 0.6 * U, y: p.y - s * 0.6 * U, z: p.z + 0.7 }], 0.06 * U);
        rib.u.uHead.value = 0;
        const t = t0 + 0.15 + (s + 1) * 0.04;
        tl.span(t, t + 0.1, (k) => (rib.u.uHead.value = k * 1.05));
        tl.span(t1 - 0.25, t1, (k) => ((rib.u.uTail.value = k), (rib.u.uOpacity.value = 1 - k)));
      }
      tl.at(t0 + 0.15, () => {
        c.st.hitStop(0.05);
        c.st.shake(0.5);
        c.st.pulse('chroma', 0.5);
        zap(0.4);
        boom(0.3);
        c.d['flash'](col.main, 0.2);
      });
      sparks(c, p, t0 + 0.2, col.light, 50, { burst: 4 * U });
      for (const s of c.spots) tintPulse(c, s.a, s.panel, t0 + 0.15, t1, 0x404050, 0.4, 0.4);
    },
  },
  equip: {
    dur: 0.6,
    base: [0x7affff, 0xffd75a, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const x = famAims(c, 'own')[0];
      const p = x.p;
      // a sigil leaves the card, flies to its bearer and closes round it
      const sig = tl.own(new Ring(0.8 * U, col.accent, Math.floor(c.r() * 999), { inner: 0.5, outer: 0.9, star: 4 }));
      sig.spinSpeed = 6;
      sig.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.3, (k) => {
        const q = bez(c.src, p, 0.5 * U, easeInOut(k));
        sig.mesh.position.set(q.x, q.y, q.z + 0.4);
        sig.u.uOpacity.value = 1;
      });
      tl.at(t0 + 0.3, () => (sig.u.uOpacity.value = 0));
      const band = tl.own(new Ring(2 * U, col.main, Math.floor(c.r() * 999), { inner: 0.82, outer: 0.92 }));
      band.mesh.position.set(p.x, p.y, p.z + 0.2);
      band.spinSpeed = 4;
      band.u.uOpacity.value = 0;
      tl.span(t0 + 0.3, t1, (k) => {
        band.mesh.rotation.x = 1.25;
        band.mesh.position.y = p.y + lerp(0.5, -0.2, k) * U;
        band.mesh.scale.setScalar(lerp(1.3, 0.75, easeOut(clamp01(k * 2))));
        band.u.uOpacity.value = Math.sin(k * Math.PI);
      });
      tintPulse(c, x.a, x.s?.panel ?? null, t0 + 0.3, t1, col.main, 0.3);
      sparks(c, p, t0 + 0.3, col.light, 40, { burst: 2.5 * U });
      tl.at(t0 + 0.3, () => (chime(0.75), zap(0.15)));
    },
  },
  terrain: {
    dur: 1.0,
    base: [0x4aff9a, 0xffffff, 0xffffff],
    play(c) {
      const { tl, U, t0, t1 } = c;
      const ter = c.cls.terrain ?? 'cosmos';
      const [a, b] = TERRAIN_COLORS[ter];
      const bd = c.st.backdrop.u;
      // the whole world behind the field becomes the place this card makes
      tl.at(t0 - 0.1, () => {
        bd.uTerrain.value = TERRAINS.indexOf(ter) + 1;
        setRgb(bd.uColor.value, a);
        setRgb(bd.uColor2.value, b);
        bd.uVortex.value = 0;
        c.d['bgTarget'] = 1;
      });
      tl.span(t0 - 0.1, t0 + 0.4, (k) => (bd.uTerrainAmt.value = easeOut(k)));
      tl.span(t1 - 0.1, t1 + 0.2, (k) => (bd.uTerrainAmt.value = 1 - easeIn(k)));
      // the ground: a wide disc of its color spreading from the card
      shockAt(c, { x: 0, y: c.own * 0.6, z: 0 }, 7 * U, t0, a, b, 0.8);
      const P: Record<Terrain, () => Emit> = {
        volcano: () => ({ x: (Math.random() - 0.5) * 5 * U, y: -2.4 * U, z: 0.5, vy: (2 + Math.random() * 2) * U, vx: (Math.random() - 0.5) * U, life: 1, size: 0.08 * U, color: Math.random() < 0.5 ? a : 0xffd060, drag: 0.3 }),
        ocean: () => ({ x: (Math.random() - 0.5) * 5 * U, y: -2.2 * U, z: 0.5, vy: (1 + Math.random()) * U, life: 1.1, size: 0.1 * U, size1: 0.14 * U, color: b, drag: 0.2 }),
        forest: () => ({ x: (Math.random() - 0.5) * 5 * U, y: 2.6 * U, z: 0.5, vy: -1.2 * U, vx: (Math.random() - 0.3) * 1.2 * U, life: 1.2, size: 0.11 * U, size1: 0.08 * U, color: Math.random() < 0.6 ? a : 0xb0e070, drag: 0.4 }),
        sky: () => ({ x: -3 * U, y: (Math.random() - 0.5) * 4 * U, z: 0.3, vx: (6 + Math.random() * 3) * U, life: 0.8, size: 0.06 * U, color: b, drag: 0 }),
        holy: () => ({ x: (Math.random() - 0.5) * 4 * U, y: 2.4 * U, z: 0.5, vy: -1 * U, life: 1.2, size: 0.09 * U, color: Math.random() < 0.5 ? a : 0xffffff, drag: 0.3 }),
        shadow: () => ({ x: (Math.random() - 0.5) * 5 * U, y: (Math.random() - 0.7) * 3 * U, z: 0.4, vx: (Math.random() - 0.5) * 0.6 * U, vy: 0.4 * U, life: 1.1, size: 0.2 * U, size1: 0.3 * U, color: a, drag: 0.2 }),
        arcane: () => {
          const ang = Math.random() * Math.PI * 2;
          return { x: Math.cos(ang) * 2.2 * U, y: c.cy + Math.sin(ang) * 2.2 * U, z: 0.5, life: 0.9, size: 0.08 * U, color: Math.random() < 0.5 ? a : b, drag: 0, pull: { x: 0, y: c.cy, strength: 4 * U, swirl: 10 * U } };
        },
        tech: () => ({ x: Math.round((Math.random() - 0.5) * 8) * 0.6 * U, y: -2.4 * U, z: 0.4, vy: 4 * U, life: 0.8, size: 0.06 * U, color: b, drag: 0 }),
        wasteland: () => ({ x: 3 * U, y: (Math.random() - 0.8) * 2.4 * U, z: 0.4, vx: -(3 + Math.random() * 2) * U, vy: 0.3 * U, life: 1, size: 0.12 * U, size1: 0.2 * U, color: a, drag: 0.4 }),
        cosmos: () => ({ x: (Math.random() - 0.5) * 6 * U, y: (Math.random() - 0.5) * 5 * U, z: 0.2, life: 0.9, size: 0.05 * U, size1: 0.09 * U, color: Math.random() < 0.7 ? 0xffffff : b, drag: 0 }),
      };
      stream(c, t0, t1, 130, P[ter]);
      tl.at(t0, () => (swell(0.6), drone(1), c.st.shake(0.2)));
      tl.at(t0 + 0.2, () => c.d['flash'](a, 0.12));
    },
  },
  aura: {
    dur: 0.6,
    base: [0x4ad8ff, 0xff7ad8, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const p: P3 = { x: c.src.x, y: c.src.y, z: c.src.z - 0.3 };
      // it hums: rings of its color pulsing out over the field, a sigil turning slowly
      for (let i = 0; i < 3; i++) shockAt(c, { x: p.x, y: c.cy - 0.2 * U, z: 0 }, (4.5 + i) * U, t0 + i * 0.15, i % 2 ? col.accent : col.main, col.light, 0.55);
      const sig = tl.own(new Ring(2.6 * U, col.main, Math.floor(c.r() * 999), { inner: 0.45 + c.r() * 0.2, outer: 0.92, star: Math.floor(c.r() * 5) + 3 }));
      sig.mesh.position.set(p.x, p.y, p.z);
      sig.spinSpeed = (c.r() - 0.5) * 2;
      sig.u.uOpacity.value = 0;
      tl.span(t0, t1, (k) => ((sig.u.uOpacity.value = 0.8 * Math.sin(k * Math.PI)), sig.mesh.scale.setScalar(lerp(0.8, 1.1, k))));
      stream(c, t0, t1, 90, () => {
        const a = Math.random() * Math.PI * 2;
        return { x: p.x + Math.cos(a) * 1.4 * U, y: p.y + Math.sin(a) * 1.4 * U, z: p.z + 0.3, vx: Math.cos(a) * 0.6 * U, vy: Math.sin(a) * 0.6 * U, life: 0.6, size: 0.07 * U, color: Math.random() < 0.5 ? col.main : col.light, drag: 0.5 };
      });
      tl.at(t0, () => (chime(0.5), swell(0.3)));
    },
  },
  protect: {
    dur: 0.6,
    base: [0x4ad8ff, 0xa0f0ff, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const aims = c.spots.length || c.hits.length ? famAims(c, 'own') : [{ p: { x: 0, y: c.own * 0.75, z: 0.8 }, s: null, a: null }];
      const big = !c.spots.length && !c.hits.length;
      for (const x of aims) {
        const w = (big ? 3.8 : 2) * U;
        const shield = glowAt(c, 'hex', { x: x.p.x, y: x.p.y, z: x.p.z + 0.6 }, w, w, col.main, col.light, t0, t1, 1, 0.12);
        tl.span(t0, t0 + 0.25, (k) => shield.mesh.scale.setScalar(lerp(0.3, 1, backOut(k))));
        tl.span(t0 + 0.2, t1, (k) => (shield.u.uK.value = (k * 2) % 1.1));
        // something strikes it and glances off
        const hitP = { x: x.p.x + (c.r() - 0.5) * 0.6 * U, y: x.p.y + w * 0.3, z: x.p.z + 0.7 };
        sparks(c, hitP, t0 + 0.3, col.light, 40, { vy: 2 * U, burst: 3 * U, gravity: 6 * U });
        tintPulse(c, x.a, x.s?.panel ?? null, t0, t1, col.main, 0.2);
      }
      tl.at(t0 + 0.05, () => chime(0.9));
      tl.at(t0 + 0.3, () => (zap(0.2), c.st.shake(0.3), c.st.pulse('chroma', 0.3)));
    },
  },
  position: {
    dur: 0.6,
    base: [0xffd75a, 0x7affff, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      for (const x of famAims(c, c.cls.scope === 'own' ? 'own' : 'opp')) {
        const p = x.p;
        const ring = tl.own(new Ring(1.9 * U, col.main, Math.floor(c.r() * 999), { inner: 0.84, outer: 0.92 }));
        ring.mesh.position.set(p.x, p.y, p.z + 0.4);
        ring.spinSpeed = -7;
        ring.u.uOpacity.value = 0;
        tl.span(t0, t1, (k) => (ring.u.uOpacity.value = Math.sin(k * Math.PI)));
        // two arrows chasing round it
        for (let i = 0; i < 2; i++) {
          const g = tl.own(new Glow(0.5 * U, 0.6 * U, 'arrow', col.light, 0xffffff));
          g.u.uOpacity.value = 0;
          tl.span(t0, t1, (k) => {
            const a = i * Math.PI + k * Math.PI * 2.5;
            g.mesh.position.set(p.x + Math.cos(a) * 0.85 * U, p.y + Math.sin(a) * 0.85 * U, p.z + 0.5);
            g.mesh.rotation.z = a;
            g.u.uOpacity.value = Math.sin(k * Math.PI);
          });
        }
        // it turns on its card
        const a = x.a;
        const m = a?.fig?.mesh ?? a?.back?.mesh ?? x.s?.panel?.mesh;
        if (m) {
          const z0 = m.rotation.z;
          tl.span(t0 + 0.1, t0 + 0.4, (k) => (m.rotation.z = z0 + (Math.PI / 2) * easeInOut(k)));
          tl.span(t1 - 0.15, t1, (k) => (m.rotation.z = z0 + (Math.PI / 2) * (1 - k)));
        }
      }
      tl.at(t0 + 0.1, () => whoosh(0.3, 700, 1500, 0.15));
    },
  },
  control: {
    dur: 0.8,
    base: [0xc04aff, 0xffd75a, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const x = famAims(c, 'opp')[0];
      const p = x.p;
      // an eye opens over its mind; a tether of light pulls it across
      const eye = tl.own(new Ring(1.6 * U, col.main, 31, { eye: true, inner: 0.9, outer: 0.95 }));
      eye.mesh.position.set(p.x, p.y + 1 * U, p.z + 0.5);
      eye.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.3, (k) => ((eye.u.uOpacity.value = k), (eye.u.uEye.value = easeOut(k))));
      tl.span(t1 - 0.2, t1, (k) => (eye.u.uOpacity.value = 1 - k));
      c.d['ray'](tl, c.src, p, t0 + 0.15, 0.25, col.main, col.light, 0.8);
      const a = x.a;
      const pull = c.own - p.y;
      if (a) {
        const home = a.oy;
        tl.span(t0 + 0.4, t1, (k) => ((a.oy = home + pull * 0.35 * easeInOut(k)), c.d['place'](a)));
      }
      tintPulse(c, a, x.s?.panel ?? null, t0 + 0.35, t1, col.main, 0.4);
      tl.at(t0 + 0.4, () => (drone(0.5), chime(0.3), c.d['flash'](col.main, 0.12)));
    },
  },
  chance: {
    dur: 0.8,
    base: [0xffd75a, 0xff7a3a, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const coin = /coin/i.test(c.text) || (!/di(c)?e/i.test(c.text) && c.r() < 0.5);
      const p: P3 = { x: 0, y: c.cy + 0.1 * U, z: 1.2 };
      const g = tl.own(new Glow(1.1 * U, 1.1 * U, coin ? 'coin' : 'die', coin ? 0xffc94a : 0xffffff, col.accent));
      g.u.uOpacity.value = 0;
      const face = 1 + Math.floor(c.r() * 6);
      // tossed up, spinning, and down again
      tl.span(t0, t1 - 0.2, (k) => {
        const h = Math.sin(k * Math.PI) * 1.3 * U;
        g.mesh.position.set(p.x, p.y - 0.4 * U + h, p.z);
        g.u.uOpacity.value = 1;
        if (coin) g.mesh.scale.set(Math.max(0.08, Math.abs(Math.cos(k * Math.PI * 7 * (1 - k * 0.3)))), 1, 1);
        else {
          g.mesh.rotation.z = (1 - easeOut(k)) * 9;
          g.u.uK.value = k < 0.85 ? 1 + Math.floor(k * 23) % 6 : face;
        }
      });
      tl.span(t1 - 0.2, t1, (k) => {
        g.mesh.scale.set(1, 1, 1);
        g.mesh.rotation.z = 0;
        g.u.uK.value = face;
        g.u.uOpacity.value = 1 - easeIn(k) * 0.6;
      });
      glowAt(c, 'flare', p, 2.4 * U, 2.4 * U, col.main, col.light, t1 - 0.2, t1, 0.7, 0.04);
      sparks(c, p, t1 - 0.2, col.light, 50, { burst: 3.5 * U });
      tl.at(t0, () => whoosh(0.4, 900, 2600, 0.15));
      tl.at(t1 - 0.2, () => (chime(0.9), c.st.shake(0.2)));
    },
  },
  discard: {
    dur: 0.6,
    base: [0x8a5aff, 0x5a3a9a, 0xd8c8ff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const near = c.side === 'near';
      const grave: P3 = { x: (near ? -1 : 1) * 1.75 * U, y: (near ? -1 : 1) * 1.45 * U, z: 0.3 };
      const pit = glowAt(c, 'vortex', grave, 1.8 * U, 1.8 * U, col.main, col.accent, t0, t1, 1, 0.1);
      pit.mesh.rotation.x = -0.9;
      const n = 1 + Math.floor(c.r() * 3);
      for (let i = 0; i < n; i++) {
        const t = t0 + i * 0.08;
        cardFly(c, { x: (i - (n - 1) / 2) * 0.6 * U, y: handY(c, near) * 0.85, z: 1 }, grave, t, t + 0.4, { color: col.main, size: 0.7, spin: Math.PI, bend: 0.4 * U });
      }
      stream(c, t0 + 0.2, t1, 80, () => ({ x: grave.x + (Math.random() - 0.5) * 0.6 * U, y: grave.y, z: grave.z, vy: 1.2 * U, life: 0.6, size: 0.12 * U, size1: 0.2 * U, color: col.accent, drag: 0.5 }));
      tl.at(t0 + 0.35, () => (drone(0.4), whoosh(0.2, 1200, 300, 0.12)));
    },
  },
  lock: {
    dur: 0.7,
    base: [0xc0c8d8, 0x4ad8ff, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const y = c.cls.scope === 'own' ? c.own : c.opp;
      // chains cross the field; a lock snaps shut on them
      const pts = (s: number) => Array.from({ length: 10 }, (_, j) => ({ x: lerp(-2.3, 2.3, j / 9) * U, y: y + s * lerp(-0.8, 0.8, j / 9) * U + Math.sin(j * 1.7) * 0.05 * U, z: 0.8 }));
      for (const s of [1, -1]) {
        const rib = tl.own(new Ribbon(20, col.main, 1));
        rib.set(pts(s), 0.13 * U);
        rib.u.uHead.value = 0;
        const t = t0 + (s > 0 ? 0 : 0.08);
        tl.span(t, t + 0.25, (k) => (rib.u.uHead.value = easeOut(k) * 1.05));
        tl.span(t1 - 0.2, t1, (k) => (rib.u.uOpacity.value = 1 - k));
        tl.at(t, () => whoosh(0.25, 2000, 800, 0.12));
      }
      const lk = glowAt(c, 'lock', { x: 0, y, z: 1.1 }, 1.2 * U, 1.2 * U, col.light, col.main, t0 + 0.3, t1, 1, 0.05);
      tl.span(t0 + 0.3, t0 + 0.42, (k) => lk.mesh.scale.setScalar(lerp(1.8, 1, easeIn(k))));
      tl.at(t0 + 0.42, () => (boom(0.35), zap(0.2), c.st.shake(0.45), c.d['flash'](col.light, 0.12)));
      sparks(c, { x: 0, y, z: 1.1 }, t0 + 0.42, col.light, 40);
      for (const h of c.hits) tintPulse(c, h, null, t0 + 0.3, t1, 0x606880, 0.3, 0.3);
    },
  },
  insight: {
    dur: 0.7,
    base: [0x4affd8, 0xffd75a, 0xffffff],
    play(c) {
      const { tl, U, t0, t1, col } = c;
      const y = c.opp;
      const eye = tl.own(new Ring(2.2 * U, col.main, 77, { eye: true, inner: 0.9, outer: 0.95 }));
      eye.mesh.position.set(0, y + 0.3 * U, 0.6);
      eye.u.uOpacity.value = 0;
      tl.span(t0, t0 + 0.3, (k) => ((eye.u.uOpacity.value = k), (eye.u.uEye.value = easeOut(k))));
      tl.span(t1 - 0.2, t1, (k) => ((eye.u.uOpacity.value = 1 - k), (eye.u.uEye.value = 1 - k)));
      // its gaze sweeps the field; the cards it sees glow back
      const beam = glowAt(c, 'shaft', { x: 0, y: y - 0.9 * U, z: 0.5 }, 1 * U, 2.4 * U, col.light, col.light, t0 + 0.2, t1, 0.8);
      tl.span(t0 + 0.2, t1, (k) => {
        beam.mesh.rotation.z = Math.sin(k * Math.PI * 2) * 0.6;
        beam.mesh.position.x = -Math.sin(k * Math.PI * 2) * 0.6 * U;
      });
      for (let i = 0; i < 3; i++) {
        const t = t0 + 0.3 + i * 0.1;
        glowAt(c, 'star', { x: (i - 1) * 1.1 * U, y: y + 1.6 * U * (c.side === 'near' ? 1 : -1) * 0.5, z: 0.8 }, 0.8 * U, 0.8 * U, col.accent, 0xffffff, t, t + 0.3, 1, 0.05);
      }
      tl.at(t0, () => (chime(0.4), drone(0.4)));
    },
  },
};

/** A Skill's duelist: their color, the emblem over the sigil, the sigil's star and turn. */
interface Flourish {
  color: number;
  light: number;
  mode: GlowMode | 'eye';
  star: number;
  spin: number;
}
const FLOURISHES: Record<string, Partial<Flourish>> = {
  'Yami Yugi': { color: 0xb04aff, light: 0xffd75a, mode: 'star', star: 3 },
  Yugi: { color: 0x9a6aff, light: 0xffe9a0, mode: 'star', star: 3 },
  Kaiba: { color: 0x4ad8ff, light: 0xffffff, mode: 'sword', star: 8 },
  'Seto Kaiba': { color: 0x4ad8ff, light: 0xffffff, mode: 'sword', star: 8 },
  Joey: { color: 0xff9a3a, light: 0xfff0c0, mode: 'die', star: 5 },
  'Joey Wheeler': { color: 0xff9a3a, light: 0xfff0c0, mode: 'die', star: 5 },
  Mai: { color: 0xff6ad8, light: 0xffe0f8, mode: 'star', star: 5 },
  'Mai Valentine': { color: 0xff6ad8, light: 0xffe0f8, mode: 'star', star: 5 },
  Pegasus: { color: 0xff3a5a, light: 0xffd75a, mode: 'eye', star: 4 },
  Ishizu: { color: 0xffd75a, light: 0xffffff, mode: 'eye', star: 6 },
  'Ishizu Ishtar': { color: 0xffd75a, light: 0xffffff, mode: 'eye', star: 6 },
  'Yami Marik': { color: 0xffb030, light: 0xff4ad8, mode: 'eye', star: 7 },
  Odion: { color: 0xd8a040, light: 0xfff0c0, mode: 'ankh', star: 6 },
  'Yami Bakura': { color: 0x8a3aff, light: 0xffd75a, mode: 'vortex', star: 5 },
  Bonz: { color: 0x7aff7a, light: 0xd8ffd8, mode: 'vortex', star: 6 },
  Keith: { color: 0x3a6aff, light: 0xff4a4a, mode: 'star', star: 5 },
  Weevil: { color: 0x9aff3a, light: 0xffffff, mode: 'hex', star: 6 },
  Rex: { color: 0x3aff9a, light: 0xffd060, mode: 'flame', star: 3 },
  Mako: { color: 0x1a9aff, light: 0xbfefff, mode: 'shock', star: 7 },
  'Jaden Yuki': { color: 0xff4a3a, light: 0xffe0a0, mode: 'flare', star: 5 },
  'Syrus Truesdale': { color: 0x3ad8ff, light: 0xffffff, mode: 'hex', star: 6 },
  'Zane Truesdale': { color: 0x9ad8ff, light: 0xffffff, mode: 'sword', star: 8 },
  'Chazz Princeton': { color: 0x404870, light: 0xd8d8ff, mode: 'vortex', star: 5 },
  'Alexis Rhodes': { color: 0x4a9aff, light: 0xffffff, mode: 'star', star: 6 },
  'Bastion Misawa': { color: 0xffd75a, light: 0xffffff, mode: 'hex', star: 6 },
  'Paradox Brothers': { color: 0xff7a3a, light: 0x7affff, mode: 'shock', star: 4 },
  Yubel: { color: 0xc04aff, light: 0xff4a8a, mode: 'eye', star: 5 },
  'The Supreme King': { color: 0xffb020, light: 0xff3a3a, mode: 'flare', star: 7 },
  Titan: { color: 0x8a2a3a, light: 0xff6a3a, mode: 'flame', star: 5 },
  Nightshroud: { color: 0x2a1a6a, light: 0xb0a0ff, mode: 'vortex', star: 7 },
  Camula: { color: 0xc01a4a, light: 0xffa0c0, mode: 'vortex', star: 5 },
  'Dr. Vellian Crowler': { color: 0xc0a040, light: 0xffffff, mode: 'hex', star: 8 },
  'Aster Phoenix': { color: 0xd8d8ff, light: 0xffd75a, mode: 'sword', star: 6 },
  'Tea Gardner': { color: 0xff8ad8, light: 0xffffff, mode: 'plus', star: 5 },
  'Espa Roba': { color: 0x7a4aff, light: 0xd8c8ff, mode: 'eye', star: 6 },
};

function flourishOf(who: string, seed: number): Flourish {
  const r = rand(seed ^ 0xf10);
  const PAL = [0x4ad8ff, 0xff6ad8, 0xffc94a, 0x7aff7a, 0xb04aff, 0xff7a3a, 0x3a9aff];
  const MODES: GlowMode[] = ['star', 'flare', 'hex', 'sword', 'shock'];
  const known = FLOURISHES[who] ?? {};
  const color = known.color ?? PAL[Math.floor(r() * PAL.length)];
  return { color, light: known.light ?? 0xffffff, mode: known.mode ?? MODES[Math.floor(r() * MODES.length)], star: known.star ?? 4 + Math.floor(r() * 4), spin: (r() < 0.5 ? -1 : 1) * (1 + r()) };
}

/** The colors each terrain paints (sky color, light color). */
const TERRAIN_COLORS: Record<Terrain, [number, number]> = {
  volcano: [0xff4a1a, 0xffc040],
  ocean: [0x1a6aff, 0x9ae8ff],
  forest: [0x2a9a3a, 0xd8ff8a],
  sky: [0x4a8aff, 0xf0f8ff],
  holy: [0xffe08a, 0xffffff],
  shadow: [0x6a2aaa, 0xff4ad8],
  arcane: [0x8a4aff, 0x7affff],
  tech: [0x1ad8ff, 0x7aff9a],
  wasteland: [0xc08a4a, 0xffe0a0],
  cosmos: [0x5a3aff, 0xffffff],
};

/** A family cinematic's colors for one card: the family's own, leaning toward the card's art and seeded. */
function famColors(fam: FxFamily, r: () => number, art: ArtData | null): Colors {
  const [m, a, l] = FAMILY_FX[fam].base;
  const p = art?.palette;
  const k = 0.18 + r() * 0.22;
  const hue = (x: number) => {
    // a small seeded hue turn (±20°): two cards of a family never match exactly
    const rr = (x >> 16) & 255;
    const gg = (x >> 8) & 255;
    const bb = x & 255;
    const t = (r() - 0.5) * 0.7;
    const cs = Math.cos(t);
    const sn = Math.sin(t);
    const w = 1 / 3;
    const sq = Math.sqrt(w);
    const m00 = cs + (1 - cs) * w;
    const m01 = w * (1 - cs) - sq * sn;
    const m02 = w * (1 - cs) + sq * sn;
    const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    return (ch(m00 * rr + m01 * gg + m02 * bb) << 16) | (ch(m02 * rr + m00 * gg + m01 * bb) << 8) | ch(m01 * rr + m02 * gg + m00 * bb);
  };
  return {
    main: brighten(p ? mix(hue(m), p[0], k) : hue(m)),
    accent: brighten(p ? mix(hue(a), p[1] ?? a, k) : hue(a)),
    light: brighten(mix(l, 0xffffff, 0.3), 220),
  };
}

/** Plays a card's effect family (no preset of its own) into `tl`. */
function playFamily(c: Omit<FamCtx, 'col' | 'r' | 'q'> & { art: ArtData | null; seed: number }) {
  const r = rand(c.seed ^ 0x5eed);
  const fam = c.cls.family;
  const ctx: FamCtx = { ...c, r, col: famColors(fam, r, c.art), q: c.d['q'] };
  FAMILY_FX[fam].play(ctx);
  // targets the effect destroys break where they lie even when its family is about something else
  if (fam !== 'destroy' && fam !== 'destroyAll')
    for (const s of c.spots) {
      if (!s.destroyed) continue;
      const t = c.t0 + Math.min(0.45, FAMILY_FX[fam].dur * 0.6);
      if (s.a) c.d['strike'](c.tl, s.a, t);
      if (s.panel) c.tl.at(t, () => void c.d['panelShards'](c.tl, s.panel!, ctx.col.main, 2.6 * c.U), false);
    }
  return ctx;
}

/** The preset a Spell/Trap without its own plays: its family's. */
function familyPreset(name: string): Preset | undefined {
  const info = card(name);
  if (!info) return undefined;
  const cls = classify(info);
  const fx = FAMILY_FX[cls.family];
  return {
    dur: fx.dur,
    accent: fx.base[1],
    // board-wide families reach the side their text names; boosts and shields default to its own monsters, curses to the opponent's
    scope: cls.family === 'destroyAll' || cls.family === 'position' || cls.family === 'bounce' || cls.family === 'banish' || cls.family === 'toDeck' ? cls.scope : cls.family === 'powerUp' || cls.family === 'protect' ? (cls.scope ?? 'own') : cls.family === 'powerDown' || cls.family === 'lock' ? (cls.scope ?? 'opp') : undefined,
    family: cls,
    play(c) {
      playFamily({ d: c.d, st: c.st, tl: c.tl, U: c.U, t0: c.t0, t1: c.t1, side: c.side, cy: c.cy, opp: c.opp, own: c.own, src: c.card, hits: c.hits, spots: c.spots ?? [], cls, text: effectText(info), art: c.art ?? null, seed: c.seed ?? 0 });
    },
  };
}

function presetFor(name: string): Preset | undefined {
  return SPELL_PRESETS[name] ?? EXTRA_PRESETS[name] ?? SPELL_PRESETS[PRESET_ALIASES[name] ?? ''];
}

export type { Quality };
export const ATTACK_STYLES = Object.keys(STYLES) as AttackStyle[];
/** Spells and traps with their own preset, and monsters with a signature attack. */
export const SPELL_PRESET_CARDS = [...Object.keys(SPELL_PRESETS), ...Object.keys(EXTRA_PRESETS), ...Object.keys(PRESET_ALIASES)];
export const SIGNATURE_ATTACK_CARDS = Object.keys(SIG_ATTACKS);
/** Whether a card plays its own preset (else its family's). */
export function hasOwnPreset(name: string): boolean {
  return !!presetFor(name);
}
export { FX_FAMILIES };
/** The effect families with a cinematic of their own (every family classify() can return). */
export const FAMILY_FX_IDS = Object.keys(FAMILY_FX) as FxFamily[];
/** The summon methods with their own shot ('normal' keeps the plain summon). */
export const SUMMON_METHODS_DRAWN = (Object.keys(SUMMON_LABEL) as SummonHow[]).filter((h) => h !== 'normal');
/** The cue kinds the director draws. */
export const CUE_KINDS_DRAWN: Cue['kind'][] = ['summon', 'set', 'flip', 'activate', 'target', 'skill', 'attack', 'hit', 'damage', 'destroy', 'win', 'leave', 'heal', 'draw'];
export { css };
