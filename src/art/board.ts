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
import { ContactShadow, Figure, clamp01, dprCap, easeOut, figureFoot, lerp, makeRenderer, prewarmRenderer, rimColor, setRgb, stageTier, type Footprint } from "./stage";
import { artBusy, artFocus, onArtChange } from "./cues";
import { tuneFor } from "./overrides";
import { FIN, finishGlow } from "./finish";
import { figureHeld, pressQuiet } from "./hold";

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
  const size = Math.max(fit, Math.min(Math.max(r.width, r.height) * MIN_ZONE_H, (r.width * MIN_GROW_W) / subjW));
  const scaleY = def ? 0.85 : 1;
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
}

const DEF_GLOW = 0x4a8aff;
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
  private raf = 0;
  private last = 0;
  private unsub: () => void;
  private frame = 0;
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
    void prewarmRenderer(this.renderer, this.camera, ["figure", "shadow"], () => !this.dead && !this.lost);
    // a cinematic starting or ending: no polling, just a wake-up
    this.unsub = onArtChange(this.onArt);
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
    this.dirty = true;
  }

  /** The face-up monsters now on the field. */
  sync(list: BoardMonster[]) {
    this.dirty = true;
    this.settleUntil = performance.now() + SETTLE_MS;
    const want = new Map(list.map((m) => [m.uid, m]));
    for (const p of this.pieces.values()) {
      const m = want.get(p.uid);
      if (!m || m.name !== p.name) p.leaving = true;
      else {
        p.def = m.def;
        p.ready = !!m.ready;
        p.finish = m.finish ?? 0;
        if ((m.hit && !p.wasHit) || (m.lp !== undefined && m.lp < p.lp)) p.hitPending = true;
        p.wasHit = !!m.hit;
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
        finish: m.finish ?? 0,
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

  private drop(p: Piece) {
    p.fig?.dispose();
    p.disc?.dispose();
    p.pivot.removeFromParent();
    this.pieces.delete(p.uid);
  }

  private start() {
    if (this.raf || this.dead || this.lost || document.hidden) return;
    if (!this.pieces.size) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private halt() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private markDirty = () => {
    this.dirty = true;
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
    void prewarmRenderer(this.renderer, this.camera, ["figure", "shadow"], () => !this.dead && !this.lost);
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
    // Under a full dim: draw nothing once the figures the cinematic is about have stepped aside.
    if (this.covered() && this.asideDone()) {
      if (this.pieces.size) this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const dt = Math.min(0.1, (now - this.last) / 1000);
    // 60 fps; 20 while a cinematic plays (the stage needs the GPU, and the bystanders
    // sway slowly under its dim); 30 on a phone the stage's governor put on its lowest tier
    // (and 15 for the slow idle sway once every figure has settled: a quarter of the GPU work and heat;
    // the sway is slow enough that it still reads as smooth)
    const settling = this.dirty || now < this.settleUntil;
    const every = artBusy() ? 3 : stageTier() === 0 ? (settling ? 2 : 6) : settling ? 1 : 4;
    // a finger just went down: the tap's answer paints first, the figures wait a beat
    const hush = !this.dirty && pressQuiet(now);
    if (!hush && (++this.frame % every === 0 || dt > 0.055)) {
      this.last = now;
      if (this.dirty || now < this.settleUntil || now - this.measuredAt > REMEASURE_MS) this.measure(now);
      this.step(dt, now);
      this.renderer.render(this.scene, this.camera);
    }
    if (this.pieces.size) this.raf = requestAnimationFrame(this.tick);
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
      const r = el.getBoundingClientRect();
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
      if (p.flourishT < 0 && p.hitT < 0 && !p.leaving && p.show >= 1 && now >= p.flourishAt) {
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
      const breath = 1 + Math.sin(t * 1.9 + p.seed) * 0.006;
      const grow = p.quick ? 1 : lerp(0.75, 1, k);
      // the size the pose was measured for, kneeling or not (pose already includes the Defense size)
      // an Overframe monster stands a little taller than the rest
      const s = pose.size * grow * breath * (p.finish >= FIN.OF ? 1.1 : 1);
      const sy = lerp(1, 0.85, p.kneel) * (1 - squash * 0.08);
      const sx = 1 + squash * 0.05;
      // pivot at the feet on the card; the figure hangs from it
      const fx = pose.cx - this.w / 2 + shake * p.cw * 0.05;
      const fy = this.h / 2 - pose.foot + hop * p.cw * 0.16;
      p.pivot.position.set(fx, fy, 0);
      p.pivot.rotation.set(lerp(STAND_TILT, KNEEL_TILT, p.kneel) - recoil * 0.4 + Math.abs(lean) * 0.08, Math.sin(t * 0.45 + p.seed) * 0.14, lean * 0.13 + shake * 0.06);
      fig.mesh.scale.set(s * sx, s * sy * (1 + (breath - 1) * 0.5), s);
      fig.mesh.position.set(-(pose.footU - 0.5) * s * sx, -(pose.footV - 0.5) * s * sy, -fig.foot.relief * fig.u.uDepthAmt.value * 0.45 * s);
      // nearer rows (lower on screen) draw over farther ones
      const order = Math.round(pose.foot);
      fig.mesh.renderOrder = order;
      fig.wall.renderOrder = order - 0.5;
      const u = fig.u;
      u.uReveal.value = p.quick ? 1 : k;
      u.uOpacity.value = (p.leaving ? Math.max(0, p.show) : p.quick ? k : 1) * p.vis;
      // a finished card glows in its finish: its rim light and base ring (Overframe turns through
      // the rainbow, Glossy rolls pink-violet-cyan, Royal breathes gold); one color per frame, no allocations
      const fg = p.finish >= FIN.UR ? finishGlow(p.finish, t + p.seed) : -1;
      setRgb(u.uGlow.value as Vector3, p.def ? DEF_GLOW : fg >= 0 ? fg : p.glow);
      if (fg >= 0) {
        rimColor(fg, u.uRim.value as Vector3);
        if (p.finish >= FIN.GL) rimColor(fg, p.disc.u.uRing.value as Vector3);
      }
      u.uDark.value = p.kneel * 0.2;
      u.uPulse.value = p.pulse * (0.3 + 0.25 * Math.sin(t * 4.2));
      setRgb(u.uFlash.value as Vector3, HIT_FLASH);
      (u.uFlash.value as Vector3).multiplyScalar(recoil * 0.9);
      // the base disc + shadow lies on the card under the feet (it stays put while the figure hops)
      const d = p.disc;
      const dsz = Math.max(p.cw * 0.55, fig.foot.w * s * 1.15);
      const lift = 1 - hop * 0.35;
      d.mesh.position.set(pose.cx - this.w / 2, this.h / 2 - pose.foot - p.cw * 0.02, 1);
      d.mesh.scale.set(dsz * lift, dsz * 0.42 * lift, 1);
      d.u.uOpacity.value = clamp01(p.leaving ? p.show : k) * p.vis;
      d.u.uRingAmt.value = (p.def ? 0.8 : 1.3) + (p.finish >= FIN.OF ? 1.6 : p.finish >= FIN.GL ? 0.9 : 0) + p.pulse * (0.6 + 0.6 * Math.sin(t * 4.2)) + recoil * 1.2;
      d.u.uDark.value = 1.5;
    }
  }

  dispose() {
    this.dead = true;
    this.halt();
    this.unsub();
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("scroll", this.markDirty, { capture: true });
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("webglcontextlost", this.onLost, false);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored, false);
    this.ro?.disconnect();
    for (const p of this.pieces.values()) {
      p.fig?.dispose();
      p.disc?.dispose();
    }
    this.pieces.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
