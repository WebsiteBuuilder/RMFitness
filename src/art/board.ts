// Monsters standing on the field: every face-up monster gets its 3D figure (its
// art pushed out by the relief map, background cut away, lit as a solid) standing
// on its card for as long as it stays there, on a glowing base disc with a soft
// contact shadow. One small canvas under the duel's controls, drawn at 60 fps
// (20 while a cinematic plays, 30 when the stage's governor is on its lowest
// tier) and only while a figure is on the field; not at all while a cinematic's
// full dim covers the duel. Positions come from the cards on
// screen ([data-uid]), so Classic and Touch both work unchanged.
//
// Kept cheap for phones: card positions are measured only when the layout may
// have moved (resize, scroll, a new field, a slow 500 ms refresh), not every
// frame; nothing is allocated per frame; nothing is drawn while the tab is hidden
// or the WebGL context is lost. While a cinematic plays, only the figures it is
// about step aside (cross-fading back when it is over); the rest keep standing.
import { Object3D, PerspectiveCamera, Scene, type Vector3, type WebGLRenderer } from "three";
import { card } from "../eds/db";
import { artFor, type ArtData } from "./depth";
import { profileFor } from "./profile";
import { ContactShadow, Figure, Glow, Particles, type Emit, clamp01, dprCap, easeOut, figureFoot, lerp, makeRenderer, prewarmRenderer, rimColor, setRgb, stageTier, type Footprint } from "./stage";
// (the duel screen waits on this before it makes the figures' WebGL context)
export { whenQuiet } from "./stage";
import { artBusy, artFocus, onArtChange } from "./cues";
import { tuneFor } from "./overrides";
import { FIN, finishGlow } from "./finish";
import { figureHeld, pressQuiet } from "./hold";
import { boardHolo, flickerAt, HOLO_COLOR, HOLO_CORE, HOLO_GOLD, HOLO_GOLD_RGB, HOLO_RGB, HUM_GAP_MS, type BoardHolo } from "./holo";
import { calmMotion, getHolo, getIdle, isLean, onArtSettings } from "./settings";
import { GLANCE_S, glanceEnvelope, idlePoseInto, idleStyleFor, moteStyleFor, newIdlePose, presenceMotes, presenceOf, wornAmount, MOTE_SHAPE, type IdleMood, type IdlePose, type IdleStyle, type MoteStyle, type Presence } from "./idleLife";
import { holoHum, holoLock } from "./sfx";
import { unmapRect } from "./cam";

export interface BoardMonster {
  uid: number;
  name: string;
  def: boolean;
  /** it may attack now (its controller's Battle Phase): a soft glow pulse */
  ready?: boolean;
  /** an attack or a card effect is aimed at it: it recoils with a red flash */
  hit?: boolean;
  /** its controller's LP: a drop makes it flinch */
  lp?: number;
  /** its finish (TIERS index, the owner's card leveling): Ultra Rare and up glow in it */
  finish?: number;
  /** an attack is aimed at it (battle-worn if it is still standing after) */
  attacked?: boolean;
  /** its duelist's Ace: a gold aura */
  ace?: boolean;
  /** its duelist's LP are in danger: quick, tense breaths */
  danger?: boolean;
}

/** Where a field figure stands on screen. Every length is in viewport CSS px. */
export interface FieldPose {
  /** the feet: the card's center x and the foot line y */
  cx: number;
  foot: number;
  /** center of the figure's square mesh (before tilt) */
  x: number;
  y: number;
  /** side of the square Figure mesh (its geometry is a 1×1 plane: mesh.scale = size, scale.y = size·scaleY) */
  size: number;
  /** the subject's visible width and height */
  w: number;
  h: number;
  /** 1, or 0.85 kneeling in Defense */
  scaleY: number;
  /** tilt around the foot point, radians (negative leans back) */
  rotX: number;
  /** the foot point in the figure's local uv (0..1, v up) */
  footU: number;
  footV: number;
}

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Lean back (radians, around the feet): standing, and kneeling in Defense. */
const STAND_TILT = -0.1;
const KNEEL_TILT = -0.45;

const FALLBACK_FOOT: Footprint = { u: 0.5, v: 0.08, w: 0.5, top: 0.92, left: 0.2, right: 0.8, relief: 0.5 };
/** A field figure is never wider than this share of its zone, so neighbours never crowd each other. */
const MAX_ZONE_W = 0.95;
/**
 * ...but its art square is never smaller than this share of its zone's height (the card's long
 * side): a wide subject (wings, a crowd of sisters) fitted to the zone's width shrank to a blob.
 */
const MIN_ZONE_H = 1.15;
/** (the minimum size still keeps a wide subject within this share of its zone's width, so neighbours only touch) */
const MIN_GROW_W = 1.2;
/** A standing figure is never taller than this share of its card's long side: it stays on its own row, clear of the turn row and the row beyond. */
const MAX_FIG_H = 0.72;
/** Relief cap for figures on the far (opponent's) side, seen from above: deep relief turned them into lumps. */
const FAR_RELIEF = 0.7;

/** Writes the field pose for a card on screen into `out` (no allocation). */
function poseInto(out: FieldPose, r: RectLike, def: boolean, f: Footprint) {
  // the card's own width (a Defense card lies on its side)
  const cw = Math.min(r.width, r.height);
  // the subject (not the whole art square) is ~1.2× the card's width tall (1.0× in Defense)
  const subjH = Math.max(0.55, Math.min(1, f.top - f.v));
  // per-card size (overrides.ts), then no wider than its zone
  const subjW = Math.max(0.2, f.right - f.left);
  const fit = Math.min(((cw * (def ? 1.0 : 1.2)) / subjH) * (f.scale ?? 1), (r.width * MAX_ZONE_W) / subjW);
  const scaleY = def ? 0.85 : 1;
  const grown = Math.max(fit, Math.min(Math.max(r.width, r.height) * MIN_ZONE_H, (r.width * MIN_GROW_W) / subjW));
  // (and never wider than its own zone: neighbours stand apart instead of merging)
  const size = Math.min(grown, (Math.max(r.width, r.height) * MAX_FIG_H) / (Math.max(0.3, f.top - f.v) * scaleY), (r.width * 1.05) / subjW);
  out.cx = r.left + r.width / 2;
  // feet a little above the card's middle-low, clear of the ATK label at its bottom edge
  out.foot = r.top + r.height * (def ? 0.6 : 0.56);
  out.size = size;
  out.scaleY = scaleY;
  out.rotX = def ? KNEEL_TILT : STAND_TILT;
  out.footU = f.u;
  out.footV = f.v;
  out.x = out.cx - (f.u - 0.5) * size;
  out.y = out.foot + (f.v - 0.5) * size * scaleY;
  out.w = (f.right - f.left) * size;
  out.h = (f.top - f.v) * size * scaleY;
  return out;
}

/**
 * Where the board will stand this monster's figure, for a card at `rect`
 * (getBoundingClientRect of its [data-uid] element), so a summon cinematic can end
 * exactly on it. `art` null uses a generic footprint.
 */
export function fieldPose(rect: RectLike, def: boolean, art: ArtData | null): FieldPose {
  return poseInto({ cx: 0, foot: 0, x: 0, y: 0, size: 0, w: 0, h: 0, scaleY: 1, rotX: 0, footU: 0.5, footV: 0.08 }, rect, def, art ? figureFoot(art) : FALLBACK_FOOT);
}

const landed = new Map<number, number>();
/** QUICK_MS: a figure that a cinematic just landed on its card fades in this fast instead of re-revealing. */
const QUICK_MS = 150;
const LANDED_WINDOW_MS = 2000;

/** A cinematic has just put this monster on its card: its board figure appears without a second reveal. */
export function markLanded(uid: number) {
  landed.set(uid, performance.now());
  if (landed.size > 32) landed.delete(landed.keys().next().value!);
}

interface Piece {
  uid: number;
  name: string;
  def: boolean;
  /** finish (TIERS index) */
  finish: number;
  fig: Figure | null;
  /** pivot at the feet: tilt and sway turn around it */
  pivot: Object3D;
  disc: ContactShadow | null;
  seed: number;
  depth: number;
  /** the figure's relief amount on the near side, and capped for the far side */
  relief: number;
  reliefFar: number;
  glow: number;
  /** 0..1 how far it has appeared */
  show: number;
  /** null until it first shows; then whether it fades in quickly (landed by a cinematic) */
  quick: boolean | null;
  /** 0..1 stepped aside for a cinematic about this monster (0) or standing (1) */
  vis: number;
  leaving: boolean;
  /** smoothed 0..1 Defense (kneel) amount */
  kneel: number;
  /** the card on screen, as last measured (cw 0 = not on screen) */
  cw: number;
  pose: FieldPose;
  /** reactions: may attack (glow pulse, smoothed), a hit to play, its controller's LP */
  ready: boolean;
  pulse: number;
  hitPending: boolean;
  wasHit: boolean;
  /** 0..1 progress of the recoil, or -1 */
  hitT: number;
  lp: number;
  /** when the next idle flourish starts (ms), its kind (0 hop, 1 lean left, 2 lean right), its progress 0..1 or -1 */
  flourishAt: number;
  flourishKind: number;
  flourishT: number;
  /** comes in as a hologram (Hologram summons on; decided when it is placed) */
  holo: boolean;
  holoStarted: boolean;
  /** silences its arrival hum (it leaves, or the field closes, mid-arrival) */
  stopHum: (() => void) | null;
  /** a small projector beam out of its card while it arrives as a hologram */
  beam: Glow | null;
  /** the phone asks for reduced motion: no flicker or tearing */
  calm: boolean;
  /** idle life (idleLife.ts): how it moves, its Attribute's motes, its presence, its moods */
  style: IdleStyle;
  motes: MoteStyle | null;
  presence: Presence;
  moteAcc: number;
  wasAttacked: boolean;
  /** when it last survived an attack (ms), or -1 */
  wornAt: number;
  danger: boolean;
  /** a glance at a monster that just arrived: when (ms, -1 none) and at which */
  glanceAt: number;
  glanceUid: number;
  /** its base ring is tinted red (danger) */
  ringRed: boolean;
  /** the others still have to glance at it (it just arrived) */
  announce: boolean;
  /** smoothed glance direction -1..1 */
  glanceDir: number;
  idle: IdlePose;
  mood: IdleMood;
}

const DEF_GLOW = 0x4a8aff;
const ACE_GLOW = 0xffc84a;
const DANGER_RING = 0xff3a2a;
/** With idle life off: exactly the plain breath and turn the figures always had. */
function plainPose(out: IdlePose, t: number, seed: number): IdlePose {
  const b = Math.sin(t * 1.9 + seed) * 0.006;
  out.sx = 1 + b;
  out.sy = (1 + b) * (1 + b * 0.5);
  out.lift = 0;
  out.float = 0;
  out.turn = Math.sin(t * 0.45 + seed) * 0.14;
  out.roll = 0;
  out.lean = 0;
  out.dark = 0;
  out.aura = 0;
  return out;
}
/** One scratch emit (and swirl) reused for every mote: nothing allocated per mote. */
const EMIT: Emit = { x: 0, y: 0, color: 0 };
const PULL = { x: 0, y: 0, strength: 0, swirl: 0 };
/** Attribute motes: one pool drawn behind the figures and one in front (share of motes in front). */
const MOTE_POOL = 140;
const MOTE_FRONT = 0.4;
const HIT_FLASH = 0xff2a1a;
/** Idle flourishes (a hop or a lean) come every FLOURISH_MIN_MS..+FLOURISH_SPREAD_MS per figure. */
const FLOURISH_MIN_MS = 6000;
const FLOURISH_SPREAD_MS = 4000;
const FLOURISH_S = 0.7;
const HIT_S = 0.6;
/** Card positions are re-measured at least this often (ms). */
const REMEASURE_MS = 500;
/** After the field changes, cards may still be sliding into place: measure every frame for this long (ms). */
const SETTLE_MS = 600;
/** A figure steps aside for its cinematic this fast, and comes back this fast (per second). */
const ASIDE_RATE = 7;
const BACK_RATE = 4;

export class BoardLayer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(30, 1, 1, 5000);
  private pieces = new Map<number, Piece>();
  /** the field it found when it opened (a resumed duel, a view switch) appears plainly: only new arrivals are holograms */
  private born = performance.now();
  private lastHum = 0;
  /** scratch for the field holograms (no allocation per frame) */
  private hb: BoardHolo = { holo: 0, line: -1, reveal: 1 };
  /** idle life on (the duel menu's "Monster idle life", and not Reduce motion) */
  private idleOn = getIdle() && !calmMotion();
  private unsubIdle: () => void;
  /** Attribute motes behind and in front of the figures (made with the first one that needs them) */
  private motesBack: Particles | null = null;
  private motesFront: Particles | null = null;
  /** a mote was emitted into the back / front pool this frame */
  private emittedBack = false;
  private emittedFront = false;
  private calmQ: MediaQueryList | null = typeof matchMedia !== "undefined" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  private raf = 0;
  /** the timer that asks for the next frame when the board draws below 60 fps */
  private timer = 0;
  private last = 0;
  private unsub: () => void;
  /** something on the board moved in the frame just drawn (Balanced and Lite stop drawing once nothing does) */
  private busy = true;
  private w = 0;
  private h = 0;
  private dead = false;
  private lost = false;
  private opacity = "";
  private dirty = true;
  private measuredAt = 0;
  private settleUntil = 0;
  private ro: ResizeObserver | null = null;
  /**
   * True while the cinematic's dim covers the duel almost completely (set by the art
   * stage): the figures stay as last drawn and the board draws nothing, so only one
   * WebGL canvas renders; it draws again the frame the dim lifts.
   */
  covered: () => boolean = () => false;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = makeRenderer(canvas, "low-power");
    this.resize();
    window.addEventListener("resize", this.onResize);
    window.addEventListener("scroll", this.markDirty, { capture: true, passive: true });
    document.addEventListener("visibilitychange", this.onVisibility);
    canvas.addEventListener("webglcontextlost", this.onLost, false);
    canvas.addEventListener("webglcontextrestored", this.onRestored, false);
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(this.markDirty);
      this.ro.observe(document.body);
    }
    void prewarmRenderer(this.renderer, this.camera, ["figure", "shadow", "glow", "motes"], () => !this.dead && !this.lost);
    // a cinematic starting or ending: no polling, just a wake-up
    this.unsub = onArtChange(this.onArt);
    // (dev builds: the field layer, for the browser checks)
    if (import.meta.env.DEV) (window as unknown as { __board?: BoardLayer }).__board = this;
    this.unsubIdle = onArtSettings(this.onIdleSetting);
    this.calmQ?.addEventListener?.("change", this.onIdleSetting);
  }

  private onArt = () => {
    this.dirty = true;
    this.start();
  };

  resize() {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.renderer.setPixelRatio(dprCap());
    this.renderer.setSize(this.w, this.h, false);
    // 1 world unit = 1 CSS pixel on the card plane.
    this.camera.aspect = this.w / this.h;
    this.camera.position.set(0, 0, this.h / 2 / Math.tan((15 * Math.PI) / 180));
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.setMotePx();
    this.dirty = true;
  }

  private onIdleSetting = () => {
    this.idleOn = getIdle() && !calmMotion();
    if (!this.idleOn) (this.motesBack?.clear(), this.motesFront?.clear());
  };

  /** Mote sizes are in CSS px on the card plane. */
  private setMotePx() {
    const px = this.camera.position.z * this.renderer.getPixelRatio();
    for (const m of [this.motesBack, this.motesFront]) if (m) m.mat.uniforms.uPx.value = px;
  }

  private ensureMotes() {
    if (this.motesBack) return;
    this.motesBack = new Particles(MOTE_POOL, true);
    this.motesFront = new Particles(MOTE_POOL, true);
    // behind every figure (over the base discs), and over every figure
    this.motesBack.points.renderOrder = -2;
    this.motesFront.points.renderOrder = 1e6;
    this.scene.add(this.motesBack.points, this.motesFront.points);
    this.setMotePx();
  }

  /** The face-up monsters now on the field. */
  sync(list: BoardMonster[]) {
    this.dirty = true;
    this.settleUntil = performance.now() + SETTLE_MS;
    const want = new Map(list.map((m) => [m.uid, m]));
    for (const p of this.pieces.values()) {
      const m = want.get(p.uid);
      if (!m || m.name !== p.name) {
        p.leaving = true;
        p.stopHum?.();
        p.stopHum = null;
      }
      else {
        p.def = m.def;
        p.ready = !!m.ready;
        p.finish = m.finish ?? 0;
        if ((m.hit && !p.wasHit) || (m.lp !== undefined && m.lp < p.lp)) p.hitPending = true;
        p.wasHit = !!m.hit;
        // the attack on it is over and it still stands: battle-worn for a while
        if (p.wasAttacked && !m.attacked) p.wornAt = performance.now();
        p.wasAttacked = !!m.attacked;
        p.danger = !!m.danger;
        if (p.presence !== 2 && m.ace) p.presence = 2;
        if (m.lp !== undefined) p.lp = m.lp;
      }
    }
    for (const m of list) {
      const have = this.pieces.get(m.uid);
      if (have && !have.leaving) continue;
      if (have) this.drop(have);
      const info = card(m.name);
      const prof = profileFor(info, m.name);
      const piece: Piece = {
        uid: m.uid,
        name: m.name,
        def: m.def,
        fig: null,
        pivot: new Object3D(),
        disc: null,
        seed: prof.seed % 1000,
        depth: 0.18 + prof.depth * 0.22,
        relief: 0,
        reliefFar: 0,
        glow: prof.colors[0],
        show: 0,
        quick: null,
        vis: artFocus().has(m.uid) ? 0 : 1,
        leaving: false,
        kneel: m.def ? 1 : 0,
        cw: 0,
        pose: { cx: 0, foot: 0, x: 0, y: 0, size: 0, w: 0, h: 0, scaleY: 1, rotX: 0, footU: 0.5, footV: 0.08 },
        ready: !!m.ready,
        pulse: 0,
        hitPending: false,
        wasHit: !!m.hit,
        hitT: -1,
        lp: m.lp ?? Infinity,
        flourishAt: performance.now() + FLOURISH_MIN_MS + (prof.seed % 4000),
        flourishKind: prof.seed % 3,
        flourishT: -1,
        holo: getHolo() && performance.now() - this.born > 1200,
        holoStarted: false,
        stopHum: null,
        beam: null,
        calm: calmMotion(),
        finish: m.finish ?? 0,
        style: idleStyleFor(info?.race, info?.level ?? 4),
        motes: moteStyleFor(info?.attribute),
        presence: presenceOf(info?.level, info?.atk, !!m.ace),
        moteAcc: Math.random(),
        wasAttacked: !!m.attacked,
        wornAt: -1,
        danger: !!m.danger,
        glanceAt: -1,
        glanceUid: 0,
        // the others glance at it once it stands solid (not at the field a resumed duel opens on)
        announce: performance.now() - this.born > 1200,
        ringRed: false,
        glanceDir: 0,
        idle: newIdlePose(),
        mood: { braced: false, worn: 0, tense: false, kneel: 0, presence: 0, glance: 0 },
      };
      this.pieces.set(m.uid, piece);
      artFor(m.name)
        .then((art) => {
          if (this.dead || this.pieces.get(m.uid) !== piece || piece.leaving) return;
          const rim = art.palette[0] ?? piece.glow;
          const fig = new Figure(art, 1, 40, piece.glow, piece.depth, { rim, edge: prof.tier >= 2 ? 0.8 : 0 });
          piece.fig = fig;
          piece.relief = fig.u.uDepthAmt.value as number;
          piece.reliefFar = piece.depth * Math.min(tuneFor(art.id).relief ?? 1, FAR_RELIEF);
          fig.detail = 2;
          fig.u.uCut.value = 1;
          fig.u.uReveal.value = 0;
          // the board draws its own shadow + base disc flat on the card, not the figure's
          fig.shadowAmt = 0;
          fig.shadow.mesh.visible = false;
          const disc = new ContactShadow(piece.glow, 1);
          disc.mesh.renderOrder = -3;
          rimColor(piece.glow, disc.u.uRing.value as Vector3);
          piece.disc = disc;
          piece.pivot.visible = false;
          piece.pivot.add(fig.mesh);
          this.scene.add(piece.pivot, disc.mesh);
          this.dirty = true;
          this.start();
        })
        .catch(() => {
          /* no picture: the card simply has no figure */
        });
    }
    this.start();
  }

  private dropBeam(p: Piece) {
    if (!p.beam) return;
    p.beam.dispose();
    p.beam = null;
  }

  private drop(p: Piece) {
    p.stopHum?.();
    this.dropBeam(p);
    p.fig?.dispose();
    p.disc?.dispose();
    p.pivot.removeFromParent();
    this.pieces.delete(p.uid);
  }

  private start() {
    if (this.raf || this.timer || this.dead || this.lost || document.hidden) return;
    if (!this.pieces.size) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  /**
   * The next frame in `ms`. Below 60 fps the wait is a timer, not a frame callback per vsync:
   * a frame callback every vsync makes the browser run style and layout for the whole duel
   * screen on every one of them, even the frames the board skips.
   */
  private later(ms: number) {
    if (ms <= 17) this.raf = requestAnimationFrame(this.tick);
    else this.timer = window.setTimeout(this.onTimer, ms - 10);
  }

  private onTimer = () => {
    this.timer = 0;
    if (!this.raf && !this.dead && !this.lost && !document.hidden) this.raf = requestAnimationFrame(this.tick);
  };

  private halt() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.raf = 0;
    this.timer = 0;
  }

  private markDirty = () => {
    this.dirty = true;
    this.start();
  };

  private onResize = () => this.resize();

  private onVisibility = () => {
    if (document.hidden) this.halt();
    else {
      this.dirty = true;
      this.start();
    }
  };

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    this.halt();
  };

  private onRestored = () => {
    // three.js rebuilds its GL state; textures and buffers re-upload on next draw.
    this.lost = false;
    void prewarmRenderer(this.renderer, this.camera, ["figure", "shadow", "glow", "motes"], () => !this.dead && !this.lost);
    this.dirty = true;
    this.start();
  };

  private setOpacity(v: "0" | "1") {
    if (this.opacity === v) return;
    this.opacity = v;
    this.canvas.style.opacity = v;
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (this.dead || this.lost) return;
    // Under a full dim: draw nothing once the figures the cinematic is about have stepped aside
    // (the cinematic's end wakes the board through onArt; a slow check backs that up).
    if (this.covered() && this.asideDone()) {
      if (this.pieces.size) this.later(250);
      return;
    }
    // (never negative: a frame stamped before the moment the loop was restarted would step everything backward)
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    const settling = this.dirty || now < this.settleUntil;
    // a finger just went down: the tap's answer paints first, the figures wait a beat
    const hush = !this.dirty && pressQuiet(now);
    if (!hush) {
      this.last = now;
      if (this.dirty || now < this.settleUntil || now - this.measuredAt > REMEASURE_MS) this.measure(now);
      this.busy = false;
      this.step(dt, now);
      this.renderer.render(this.scene, this.camera);
    }
    if (!this.pieces.size) return;
    // Balanced and Lite: once nothing moves (every figure has arrived and stands still, no hit,
    // no hologram, no fade), the last frame stays on screen and the board sleeps until the field
    // changes, a cinematic starts or ends, or the layout moves. Full keeps the slow sway.
    if (!hush && !settling && !this.busy && !this.idleOn && isLean()) return;
    // 60 fps while things arrive; 20 under a cinematic (the stage needs the GPU); 30/10 on the
    // stage governor's lowest tier; then 20 fps for idle life and 15 for the slow sway
    const lean = isLean();
    const ms = hush ? 50 : artBusy() ? 50 : stageTier() === 0 ? (settling ? 33 : 100) : settling ? 16 : this.idleOn ? 50 : lean ? 33 : 66;
    this.later(ms);
  };

  /** Every figure a cinematic is about has finished stepping aside (none is left half drawn under the dim). */
  private asideDone() {
    const focus = artFocus();
    for (const p of this.pieces.values()) if (p.fig && focus.has(p.uid) && p.vis > 0) return false;
    return true;
  }

  /** Reads where each figure's card is on screen (the only layout reads). */
  private measure(now: number) {
    this.dirty = false;
    this.measuredAt = now;
    for (const p of this.pieces.values()) {
      if (!p.fig) continue;
      const el = document.querySelector(`[data-uid="${p.uid}"]`);
      if (!el) {
        p.cw = 0;
        continue;
      }
      // (where the card rests: the Duel Disk camera carries this canvas along with the field)
      const r = unmapRect(el.getBoundingClientRect());
      p.cw = r.width > 0 ? Math.min(r.width, r.height) : 0;
      if (p.cw > 0) {
        poseInto(p.pose, r, p.def, p.fig.foot);
        // the opponent's side (the card above the screen's middle)
        p.fig.u.uDepthAmt.value = r.top + r.height / 2 < this.h / 2 ? p.reliefFar : p.relief;
      }
    }
  }

  private step(dt: number, now: number) {
    this.setOpacity("1");
    const focus = artFocus();
    for (const p of this.pieces.values()) {
      const fig = p.fig;
      // the monster a cinematic is about steps aside for it, and cross-fades back after
      p.vis = focus.has(p.uid) ? Math.max(0, p.vis - dt * ASIDE_RATE) : Math.min(1, p.vis + dt * BACK_RATE);
      // (anything still on its way somewhere keeps the board drawing)
      if (p.leaving || (p.vis > 0 && p.vis < 1)) this.busy = true;
      if (p.leaving) {
        p.show -= dt * 4;
        if (p.show <= 0 || !fig) {
          this.drop(p);
          continue;
        }
      } else if (fig && p.cw > 0 && !(p.show === 0 && figureHeld(p.uid, now))) {
        if (p.quick === null) {
          const at = landed.get(p.uid);
          p.quick = at !== undefined && now - at < LANDED_WINDOW_MS;
          if (p.quick) landed.delete(p.uid);
        }
        p.show = Math.min(1, p.show + dt * (p.quick ? 1000 / QUICK_MS : 1.4));
        if (p.show < 1) this.busy = true;
      }
      if (!fig || !p.disc) continue;
      fig.update(dt);
      p.disc.update(dt);
      if (p.cw <= 0) {
        p.pivot.visible = false;
        p.disc.mesh.visible = false;
        continue;
      }
      p.pivot.visible = p.vis > 0;
      p.disc.mesh.visible = p.vis > 0;
      const pose = p.pose;
      const k = easeOut(p.show);
      const t = fig.time;
      // kneeling eases in and out instead of snapping
      p.kneel += ((p.def ? 1 : 0) - p.kneel) * Math.min(1, dt * 6);
      if (Math.abs((p.def ? 1 : 0) - p.kneel) > 0.004) this.busy = true;
      else p.kneel = p.def ? 1 : 0;
      // reactions: a recoil when hit, an idle flourish now and then, a pulse when it may attack
      if (p.hitPending && p.show >= 1) {
        p.hitPending = false;
        p.hitT = 0;
      }
      let recoil = 0;
      let shake = 0;
      if (p.hitT >= 0) {
        p.hitT += dt / HIT_S;
        if (p.hitT >= 1) p.hitT = -1;
        else {
          const h = p.hitT;
          recoil = Math.sin(Math.min(1, h * 2.2) * Math.PI) * (1 - h * 0.5);
          shake = Math.sin(h * 46) * (1 - h) * (1 - h);
        }
      }
      // (Balanced and Lite: no idle flourishes, so a still field can stop drawing)
      if (p.flourishT < 0 && p.hitT < 0 && !p.leaving && p.show >= 1 && now >= p.flourishAt && !isLean()) {
        p.flourishT = 0;
        p.flourishKind = (p.flourishKind + 1 + (p.seed & 1)) % 3;
        if (p.def && p.flourishKind === 0) p.flourishKind = 1;
      }
      let hop = 0;
      let squash = 0;
      let lean = 0;
      if (p.flourishT >= 0) {
        p.flourishT += dt / FLOURISH_S;
        const f = p.flourishT;
        if (f >= 1) {
          p.flourishT = -1;
          p.flourishAt = now + FLOURISH_MIN_MS + Math.random() * FLOURISH_SPREAD_MS;
        } else if (p.flourishKind === 0) {
          // a small hop: crouch, spring up, land with a squash
          hop = Math.max(0, Math.sin(((f - 0.15) / 0.7) * Math.PI)) * (f > 0.15 && f < 0.85 ? 1 : 0);
          squash = f < 0.15 ? Math.sin((f / 0.15) * Math.PI) : f > 0.85 ? Math.sin(((f - 0.85) / 0.15) * Math.PI) : -hop * 0.4;
        } else lean = Math.sin(f * Math.PI) ** 2 * (p.flourishKind === 1 ? 1 : -1);
      }
      p.pulse += ((p.ready && !p.def ? 1 : 0) - p.pulse) * Math.min(1, dt * 4);
      if (p.pulse < 0.002) p.pulse = 0;
      // (a hit, a flourish, the may-attack pulse and a glance all move)
      if (p.hitPending || p.hitT >= 0 || p.flourishT >= 0 || p.pulse > 0 || (this.idleOn && p.glanceAt >= 0)) this.busy = true;
      // idle life: its Type's breathing, hover and sway, and its moods (idleLife.ts)
      const mood = p.mood;
      const live = this.idleOn;
      mood.braced = live && p.wasHit && !p.leaving;
      mood.worn = live && p.wornAt >= 0 ? wornAmount(now - p.wornAt) : 0;
      mood.tense = live && p.danger;
      mood.kneel = p.kneel;
      mood.presence = live ? p.presence : 0;
      let gl = 0;
      if (live && p.glanceAt >= 0 && now >= p.glanceAt) {
        const gk = (now - p.glanceAt) / 1000 / GLANCE_S;
        if (gk >= 1) p.glanceAt = -1;
        else {
          const o = this.pieces.get(p.glanceUid);
          const dx = o && o.cw > 0 ? o.pose.cx - pose.cx : 0;
          gl = glanceEnvelope(gk) * (dx > 4 ? 1 : dx < -4 ? -1 : 0);
        }
      }
      if (p.announce && p.show >= 1 && p.cw > 0 && !p.leaving) {
        p.announce = false;
        for (const o of this.pieces.values()) if (!o.leaving && o !== p && o.show >= 1) (o.glanceAt = now + (o.seed % 5) * 60), (o.glanceUid = p.uid);
      }
      p.glanceDir += (gl - p.glanceDir) * Math.min(1, dt * 8);
      mood.glance = p.glanceDir;
      const idle = live ? idlePoseInto(p.idle, p.style, mood, t, p.seed) : plainPose(p.idle, t, p.seed);
      const grow = p.quick ? 1 : lerp(0.75, 1, k);
      // the size the pose was measured for, kneeling or not (pose already includes the Defense size)
      // an Overframe monster stands a little taller than the rest, a Millennium one taller still
      const s = pose.size * grow * (p.finish >= FIN.MI ? 1.08 : p.finish >= FIN.OF ? 1.05 : 1);
      const sy = lerp(1, 0.85, p.kneel) * (1 - squash * 0.08) * idle.sy;
      const sx = (1 + squash * 0.05) * idle.sx;
      // pivot at the feet on the card; the figure hangs from it
      const fx = pose.cx - this.w / 2 + shake * p.cw * 0.05;
      const fy = this.h / 2 - pose.foot + (hop * 0.16 + idle.lift) * p.cw;
      p.pivot.position.set(fx, fy, 0);
      p.pivot.rotation.set(lerp(STAND_TILT, KNEEL_TILT, p.kneel) - recoil * 0.4 + Math.abs(lean) * 0.08 + idle.lean, idle.turn, lean * 0.13 + shake * 0.06 + idle.roll);
      fig.mesh.scale.set(s * sx, s * sy, s);
      fig.mesh.position.set(-(pose.footU - 0.5) * s * sx, -(pose.footV - 0.5) * s * sy, -fig.foot.relief * fig.u.uDepthAmt.value * 0.45 * s);
      // nearer rows (lower on screen) draw over farther ones
      const order = Math.round(pose.foot);
      fig.mesh.renderOrder = order;
      fig.wall.renderOrder = order - 0.5;
      const u = fig.u;
      // a monster arriving without a cinematic still comes in as a Duel Disk hologram (holographic
      // summon): projected light first, then a line of light climbs it and it locks solid
            const hb = !p.quick && !p.leaving && p.holo ? boardHolo(p.show, this.hb) : null;
      if (hb && hb.holo > 0) {
        this.busy = true;
        if (!p.holoStarted) {
          p.holoStarted = true;
          const hc = p.finish >= FIN.MI ? HOLO_GOLD_RGB : HOLO_RGB;
          (u.uHoloCol.value as Vector3).set(hc[0], hc[1], hc[2]);
          u.uHoloScroll.value = p.calm ? 0 : 1;
          // a small projector beam out of its card (one quad, gone when it locks)
          p.beam = new Glow(1, 1, "beam", p.finish >= FIN.MI ? HOLO_GOLD : HOLO_COLOR, HOLO_CORE);
          this.scene.add(p.beam.mesh);
          // (a softer lock band at card size: full strength it reads as a white bar)
          u.uHoloEdge.value = 0.4;
          // one hum for monsters arriving together, none for one hidden under a cinematic
          if (p.vis > 0 && now - this.lastHum > HUM_GAP_MS) {
            this.lastHum = now;
            p.stopHum = holoHum(0.6, 0);
          }
        }
        if (p.beam) {
          const b = p.beam;
          const bw = p.cw * 1.15;
          const bh = Math.max(pose.h * 1.15, p.cw * 1.2);
          b.mesh.scale.set(bw, bh, 1);
          b.mesh.position.set(pose.cx - this.w / 2, this.h / 2 - pose.foot + bh * 0.46, -2);
          b.mesh.renderOrder = Math.round(pose.foot) - 1;
          b.u.uTime.value = t;
          b.u.uOpacity.value = 0.75 * clamp01(p.show * 6) * (1 - clamp01((hb.line - 0.6) / 0.5)) * p.vis;
        }
        u.uHolo.value = hb.holo;
        u.uHoloLine.value = lerp(fig.foot.v - 0.04, Math.min(1.06, fig.foot.top + 0.05), clamp01((hb.line + 0.05) / 1.12));
        u.uFlick.value = p.calm || hb.line > 0 ? 0 : flickerAt(t, p.seed);
        // (no tearing at card size: it only reads as broken bars)
        u.uGlitch.value = 0;
      } else {
        if (p.beam) this.dropBeam(p);
        if (u.uHolo.value > 0 && !p.leaving) {
          // (one leaving mid-arrival fades out as it is, without snapping solid first)
          u.uHolo.value = 0;
          u.uFlick.value = 0;
          u.uGlitch.value = 0;
          // (its hum has run its course: let go of its nodes)
          p.stopHum = null;
          if (p.holoStarted && p.vis > 0 && now - this.lastHum > HUM_GAP_MS) {
            this.lastHum = now;
            holoLock(0);
          }
        }
      }
      u.uReveal.value = p.quick ? 1 : hb ? hb.reveal : k;
      u.uOpacity.value = (p.leaving ? Math.max(0, p.show) : p.quick ? k : 1) * p.vis;
      // a finished card glows in its finish: its rim light and base ring (Overframe turns through
      // the rainbow, Glossy rolls pink-violet-cyan, Royal breathes gold); one color per frame, no allocations
      const fg = p.finish >= FIN.UR ? finishGlow(p.finish, t + p.seed) : -1;
      setRgb(u.uGlow.value as Vector3, p.def ? DEF_GLOW : fg >= 0 ? fg : mood.presence === 2 ? ACE_GLOW : p.glow);
      if (fg >= 0) {
        rimColor(fg, u.uRim.value as Vector3);
        if (p.finish >= FIN.GL) rimColor(fg, p.disc.u.uRing.value as Vector3);
      }
      // in danger its base ring runs red, pulsing with its quick breaths
      if (p.finish < FIN.GL && mood.tense !== p.ringRed) {
        p.ringRed = mood.tense;
        // (a saturated red, not lifted toward white like the other ring colors)
        if (mood.tense) setRgb(p.disc.u.uRing.value as Vector3, DANGER_RING);
        else rimColor(p.glow, p.disc.u.uRing.value as Vector3);
      }
      u.uDark.value = p.kneel * 0.2 + idle.dark;
      u.uPulse.value = p.pulse * (0.3 + 0.25 * Math.sin(t * 4.2));
      setRgb(u.uFlash.value as Vector3, HIT_FLASH);
      (u.uFlash.value as Vector3).multiplyScalar(recoil * 0.9);
      // the base disc + shadow lies on the card under the feet (it stays put while the figure hops)
      const d = p.disc;
      const dsz = Math.max(p.cw * 0.55, fig.foot.w * s * 1.15);
      // (the shadow shrinks and pales under a hovering monster)
      const lift = (1 - hop * 0.35) * (1 - 0.3 * idle.float);
      d.mesh.position.set(pose.cx - this.w / 2, this.h / 2 - pose.foot - p.cw * 0.02, 1);
      d.mesh.scale.set(dsz * lift, dsz * 0.42 * lift, 1);
      d.u.uOpacity.value = clamp01(p.leaving ? p.show : k) * p.vis * (1 - 0.3 * idle.float);
      d.u.uRingAmt.value = (p.def ? 0.8 : 1.3) + (p.finish >= FIN.MI ? 1.9 + 0.4 * Math.sin(t * 2.6 + p.seed) : p.finish >= FIN.OF ? 1.6 : p.finish >= FIN.GL ? 0.9 : 0) + p.pulse * (0.6 + 0.6 * Math.sin(t * 4.2)) + recoil * 1.2;
      d.u.uDark.value = 1.5;
      // the projector's light on the base while the hologram forms
      if (hb && hb.holo > 0) d.u.uRingAmt.value += 1.6 * (1 - clamp01(hb.line)) + 2.4 * clamp01((hb.line - 0.8) / 0.25);
      // a boss's (or an Ace's) aura breathes in its base ring
      d.u.uRingAmt.value += idle.aura * 1.6 + (mood.tense ? 0.5 + Math.max(0, idle.sy - 1) * 60 : 0);
      // its Attribute's motes (only once it stands solid, not while a cinematic is about it)
      if (live && p.motes && !p.leaving && p.show >= 1 && p.vis >= 1 && !(hb && hb.holo > 0)) this.emitMotes(p, dt, idle.lift);
    }
    if (this.motesBack) {
      // (the last frame drawn when the field empties carries no motes frozen in the air)
      if (!this.pieces.size) (this.motesBack.clear(), this.motesFront!.clear());
      // nothing in the air and nothing new: no stepping, no upload, no draw
      this.stepPool(this.motesBack, this.emittedBack, dt);
      this.stepPool(this.motesFront!, this.emittedFront, dt);
      if (this.motesBack.active > 0 || this.motesFront!.active > 0) this.busy = true;
      this.emittedBack = this.emittedFront = false;
    }
  }

  /** A mote pool with nothing in the air and nothing new is not stepped, uploaded or drawn. */
  private stepPool(m: Particles, emitted: boolean, dt: number) {
    const busy = m.active > 0 || emitted;
    if (busy) m.update(dt);
    m.points.visible = busy && m.active > 0;
  }

  /** Motes off a monster's Attribute: embers, bubbles, leaves, dust, sparkles, smoke, gold dust. */
  private emitMotes(p: Piece, dt: number, lift: number) {
    const m = p.motes!;
    // (fewer on the cheapest tier, and while a cinematic plays)
    // (and fewer on a small phone, where each card is small and they would crowd it)
    const scale = (stageTier() === 0 ? 0.5 : 1) * (artBusy() ? 0.4 : 1) * presenceMotes(p.presence) * (p.def ? 0.6 : 1) * (p.cw < 60 ? 0.85 : 1);
    p.moteAcc += m.rate * scale * dt;
    if (p.moteAcc < 1) return;
    this.ensureMotes();
    const pose = p.pose;
    const cw = p.cw;
    const cx = pose.cx - this.w / 2;
    const base = this.h / 2 - pose.foot + lift * cw;
    const tall = Math.max(cw * 0.5, pose.h);
    while (p.moteAcc >= 1) {
      p.moteAcc -= 1;
      const front = Math.random() < MOTE_FRONT;
      const pool = front ? this.motesFront! : this.motesBack!;
      // an Ace mixes gold dust into its own motes
      const gold = p.presence === 2 && Math.random() < 0.35;
      const color = gold ? (Math.random() < 0.5 ? ACE_GLOW : 0xfff0b8) : Math.random() < 0.6 ? m.color : m.color2;
      // where it starts: low for embers, smoke and dust (they rise off it), anywhere on it otherwise
      // (smoke and dust rise off its feet; embers from its flanks; the rest anywhere on it)
      const low = m.kind === "smoke" || m.kind === "dust";
      const y = base + (low ? Math.random() * 0.45 : m.kind === "ember" ? 0.1 + Math.random() * 0.95 : 0.2 + Math.random() * 0.85) * tall;
      // (mostly round its edges, where they show against the dark mat rather than over its art)
      const side = Math.random() < 0.5 ? -1 : 1;
      const spread = (m.kind === "leaf" ? 0.85 : 0.7) * (0.45 + 0.55 * Math.sqrt(Math.random())) * side;
      const x = cx + spread * Math.max(cw * 0.55, pose.w * 0.6);
      const rise = m.rise * cw;
      const e = EMIT;
      e.x = x;
      e.y = y;
      e.z = front ? 8 : -8;
      e.vx = (Math.random() - 0.5) * 2 * m.drift * cw;
      e.vy = rise;
      // (it fades before it drifts over the row beyond: a little above the figure's head at most)
      const room = base + tall + cw * 0.45 - y;
      e.life = rise > 1 ? Math.max(0.5, Math.min(m.life, room / (rise * 1.15))) : m.life;
      // (a small phone's cards are small: the motes keep a readable size)
      const big = cw < 60 ? 1.2 : 1;
      e.size = m.size * cw * big;
      e.size1 = m.size1 * cw * big;
      e.color = color;
      e.kind = gold ? MOTE_SHAPE.divine : MOTE_SHAPE[m.kind];
      // embers and gold dust speed up as they rise; dust settles
      e.gravity = m.kind === "ember" || m.kind === "divine" ? -rise * 0.5 : m.kind === "dust" ? rise * 0.25 : 0;
      e.drag = m.swirl > 0 ? 0.9 : 0.25;
      if (m.swirl > 0) {
        PULL.x = cx;
        PULL.y = base + tall * 0.5;
        PULL.strength = cw * 0.2;
        PULL.swirl = cw * 0.45 * m.swirl * (p.seed & 1 ? 1 : -1);
        e.pull = PULL;
      } else e.pull = undefined;
      pool.emit(e);
      if (front) this.emittedFront = true;
      else this.emittedBack = true;
    }
  }

  dispose() {
    this.dead = true;
    this.halt();
    this.unsub();
    this.unsubIdle();
    this.calmQ?.removeEventListener?.("change", this.onIdleSetting);
    if (import.meta.env.DEV && (window as unknown as { __board?: BoardLayer }).__board === this) delete (window as unknown as { __board?: BoardLayer }).__board;
    this.motesBack?.dispose();
    this.motesFront?.dispose();
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("scroll", this.markDirty, { capture: true });
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("webglcontextlost", this.onLost, false);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored, false);
    this.ro?.disconnect();
    for (const p of this.pieces.values()) {
      p.stopHum?.();
      this.dropBeam(p);
      p.fig?.dispose();
      p.disc?.dispose();
    }
    this.pieces.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
