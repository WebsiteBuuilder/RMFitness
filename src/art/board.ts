// Monsters standing on the field: every face-up monster gets its 3D figure (its
// art pushed out by the relief map, background cut away, lit as a solid) standing
// on its card for as long as it stays there, on a glowing base disc with a soft
// contact shadow. One small canvas under the duel's controls, drawn at ~30 fps
// and only while a figure is on the field. Positions come from the cards on
// screen ([data-uid]), so Classic and Touch both work unchanged.
//
// Kept cheap for phones: card positions are measured only when the layout may
// have moved (resize, scroll, a new field, a slow 500 ms refresh), not every
// frame; nothing is allocated per frame; and nothing at all is drawn while a
// cinematic plays (a 250 ms poll waits for it to end), while the tab is hidden,
// or while the WebGL context is lost.
import { Object3D, PerspectiveCamera, Scene, type Vector3, type WebGLRenderer } from "three";
import { card } from "../eds/db";
import { artFor, type ArtData } from "./depth";
import { profileFor } from "./profile";
import { ContactShadow, Figure, clamp01, dprCap, easeOut, footprint, lerp, makeRenderer, prewarmRenderer, rimColor, setRgb, type Footprint } from "./stage";
import { artBusy } from "./cues";

export interface BoardMonster {
  uid: number;
  name: string;
  def: boolean;
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

/** Writes the field pose for a card on screen into `out` (no allocation). */
function poseInto(out: FieldPose, r: RectLike, def: boolean, f: Footprint) {
  // the card's own width (a Defense card lies on its side)
  const cw = Math.min(r.width, r.height);
  // the subject (not the whole art square) is ~1.2× the card's width tall (1.0× in Defense)
  const subjH = Math.max(0.55, Math.min(1, f.top - f.v));
  const size = (cw * (def ? 1.0 : 1.2)) / subjH;
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
  return poseInto({ cx: 0, foot: 0, x: 0, y: 0, size: 0, w: 0, h: 0, scaleY: 1, rotX: 0, footU: 0.5, footV: 0.08 }, rect, def, art ? footprint(art) : FALLBACK_FOOT);
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
  fig: Figure | null;
  /** pivot at the feet: tilt and sway turn around it */
  pivot: Object3D;
  disc: ContactShadow | null;
  seed: number;
  depth: number;
  glow: number;
  /** 0..1 how far it has appeared */
  show: number;
  /** null until it first shows; then whether it fades in quickly (landed by a cinematic) */
  quick: boolean | null;
  leaving: boolean;
  /** smoothed 0..1 Defense (kneel) amount */
  kneel: number;
  /** the card on screen, as last measured (cw 0 = not on screen) */
  cw: number;
  pose: FieldPose;
}

const DEF_GLOW = 0x4a8aff;
/** Card positions are re-measured at least this often (ms). */
const REMEASURE_MS = 500;
/** After the field changes, cards may still be sliding into place: measure every frame for this long (ms). */
const SETTLE_MS = 600;
/** While a cinematic plays, check this often whether it is over (ms). */
const HOLD_POLL_MS = 250;

export class BoardLayer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(30, 1, 1, 5000);
  private pieces = new Map<number, Piece>();
  private raf = 0;
  private poll = 0;
  private last = 0;
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
    void prewarmRenderer(this.renderer, this.camera, ["figure", "shadow"]);
  }

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
      else p.def = m.def;
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
        glow: prof.colors[0],
        show: 0,
        quick: null,
        leaving: false,
        kneel: m.def ? 1 : 0,
        cw: 0,
        pose: { cx: 0, foot: 0, x: 0, y: 0, size: 0, w: 0, h: 0, scaleY: 1, rotX: 0, footU: 0.5, footV: 0.08 },
      };
      this.pieces.set(m.uid, piece);
      artFor(m.name)
        .then((art) => {
          if (this.dead || this.pieces.get(m.uid) !== piece || piece.leaving) return;
          const rim = art.palette[0] ?? piece.glow;
          const fig = new Figure(art, 1, 40, piece.glow, piece.depth, { rim, edge: prof.tier >= 2 ? 0.8 : 0 });
          piece.fig = fig;
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
    if (this.raf || this.poll || this.dead || this.lost || document.hidden) return;
    if (!this.pieces.size) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private halt() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.poll);
    this.raf = this.poll = 0;
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
    void prewarmRenderer(this.renderer, this.camera, ["figure", "shadow"]);
    this.dirty = true;
    this.start();
  };

  private setOpacity(v: "0" | "1") {
    if (this.opacity === v) return;
    this.opacity = v;
    this.canvas.style.opacity = v;
  }

  /** A cinematic is playing: the figures step aside (it has its own) and nothing is drawn. */
  private hold = () => {
    this.poll = 0;
    if (this.dead || this.lost || document.hidden) return;
    if (!artBusy()) {
      this.dirty = true;
      this.start();
      return;
    }
    this.setOpacity("0");
    for (const p of this.pieces.values()) if (p.leaving) this.drop(p);
    this.poll = window.setTimeout(this.hold, HOLD_POLL_MS);
  };

  private tick = (now: number) => {
    this.raf = 0;
    if (this.dead || this.lost) return;
    if (artBusy()) {
      this.hold();
      return;
    }
    const dt = Math.min(0.1, (now - this.last) / 1000);
    // ~30 fps is plenty for idle figures and spares the battery.
    if (++this.frame % 2 === 0 || dt > 0.05) {
      this.last = now;
      if (this.dirty || now < this.settleUntil || now - this.measuredAt > REMEASURE_MS) this.measure(now);
      this.step(dt, now);
      this.renderer.render(this.scene, this.camera);
    }
    if (this.pieces.size) this.raf = requestAnimationFrame(this.tick);
  };

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
      if (p.cw > 0) poseInto(p.pose, r, p.def, p.fig.foot);
    }
  }

  private step(dt: number, now: number) {
    this.setOpacity("1");
    for (const p of this.pieces.values()) {
      const fig = p.fig;
      if (p.leaving) {
        p.show -= dt * 4;
        if (p.show <= 0 || !fig) {
          this.drop(p);
          continue;
        }
      } else if (fig && p.cw > 0) {
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
      p.pivot.visible = true;
      p.disc.mesh.visible = true;
      const pose = p.pose;
      const k = easeOut(p.show);
      const t = fig.time;
      // kneeling eases in and out instead of snapping
      p.kneel += ((p.def ? 1 : 0) - p.kneel) * Math.min(1, dt * 6);
      const breath = 1 + Math.sin(t * 1.9 + p.seed) * 0.006;
      const grow = p.quick ? 1 : lerp(0.75, 1, k);
      // the size the pose was measured for, kneeling or not (pose already includes the Defense size)
      const s = pose.size * grow * breath;
      const sy = lerp(1, 0.85, p.kneel);
      // pivot at the feet on the card; the figure hangs from it
      const fx = pose.cx - this.w / 2;
      const fy = this.h / 2 - pose.foot;
      p.pivot.position.set(fx, fy, 0);
      p.pivot.rotation.set(lerp(STAND_TILT, KNEEL_TILT, p.kneel), Math.sin(t * 0.45 + p.seed) * 0.14, 0);
      fig.mesh.scale.set(s, s * sy * (1 + (breath - 1) * 0.5), s);
      fig.mesh.position.set(-(pose.footU - 0.5) * s, -(pose.footV - 0.5) * s * sy, -fig.foot.relief * fig.u.uDepthAmt.value * 0.45 * s);
      const u = fig.u;
      u.uReveal.value = p.quick ? 1 : k;
      u.uOpacity.value = p.leaving ? Math.max(0, p.show) : p.quick ? k : 1;
      setRgb(u.uGlow.value as Vector3, p.def ? DEF_GLOW : p.glow);
      u.uDark.value = p.kneel * 0.2;
      // the base disc + shadow lies on the card under the feet
      const d = p.disc;
      const dsz = Math.max(p.cw * 0.55, fig.foot.w * s * 1.15);
      d.mesh.position.set(fx, fy - p.cw * 0.02, 1);
      d.mesh.scale.set(dsz, dsz * 0.42, 1);
      d.u.uOpacity.value = clamp01(p.leaving ? p.show : k);
      d.u.uRingAmt.value = p.def ? 0.8 : 1.3;
      d.u.uDark.value = 1.5;
    }
  }

  dispose() {
    this.dead = true;
    this.halt();
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
