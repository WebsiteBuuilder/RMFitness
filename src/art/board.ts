// Monsters standing on the field: every face-up monster gets its 3D figure (its
// art pushed out by the depth map, background cut away) standing on its card for
// as long as it stays there. One small canvas under the duel's controls, drawn
// at ~30 fps and only while a figure is on the field. Positions come from the
// cards on screen ([data-uid]), so Classic and Touch both work unchanged.
//
// Kept cheap for phones: card positions are measured only when the layout may
// have moved (resize, scroll, a new field, a slow 500 ms refresh), not every
// frame; nothing is allocated per frame; and nothing at all is drawn while a
// cinematic plays (a 250 ms poll waits for it to end), while the tab is hidden,
// or while the WebGL context is lost.
import { PerspectiveCamera, Scene, type Vector3, type WebGLRenderer } from "three";
import { card } from "../eds/db";
import { artFor } from "./depth";
import { profileFor } from "./profile";
import { Figure, dprCap, easeOut, lerp, makeRenderer, prewarmRenderer, setRgb } from "./stage";
import { artBusy } from "./cues";

export interface BoardMonster {
  uid: number;
  name: string;
  def: boolean;
}

interface Piece {
  uid: number;
  name: string;
  def: boolean;
  fig: Figure | null;
  seed: number;
  depth: number;
  glow: number;
  /** 0..1 how far it has appeared */
  show: number;
  leaving: boolean;
  /** the card on screen, as last measured: center x, foot y, card width (0 = not on screen) */
  cx: number;
  foot: number;
  cw: number;
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
    void prewarmRenderer(this.renderer, this.camera, ["figure"]);
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
        seed: prof.seed % 1000,
        depth: 0.22 + prof.depth * 0.3,
        glow: prof.colors[0],
        show: 0,
        leaving: false,
        cx: 0,
        foot: 0,
        cw: 0,
      };
      this.pieces.set(m.uid, piece);
      artFor(m.name)
        .then((art) => {
          if (this.dead || this.pieces.get(m.uid) !== piece || piece.leaving)
            return;
          piece.fig = new Figure(art, 1, 32, piece.glow, piece.depth);
          piece.fig.u.uCut.value = 1;
          piece.fig.u.uReveal.value = 0;
          piece.fig.u.uDepthAmt.value = piece.depth;
          piece.fig.mesh.visible = false;
          this.scene.add(piece.fig.mesh);
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
    void prewarmRenderer(this.renderer, this.camera, ["figure"]);
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
      this.step(dt);
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
      // The card's own width (a Defense card lies on its side).
      p.cw = r.width > 0 ? Math.min(r.width, r.height) : 0;
      p.cx = r.left + r.width / 2;
      p.foot = r.top + r.height * 0.72;
    }
  }

  private step(dt: number) {
    this.setOpacity("1");
    for (const p of this.pieces.values()) {
      if (p.leaving) {
        p.show -= dt * 4;
        if (p.show <= 0 || !p.fig) {
          this.drop(p);
          continue;
        }
      } else if (p.fig) p.show = Math.min(1, p.show + dt * 1.4);
      const fig = p.fig;
      if (!fig) continue;
      fig.update(dt);
      const cw = p.cw;
      if (cw <= 0) {
        fig.mesh.visible = false;
        continue;
      }
      fig.mesh.visible = true;
      const size = cw * (p.def ? 1.35 : 1.7);
      const k = easeOut(p.show);
      const t = fig.time;
      const grow = lerp(0.6, 1, k);
      fig.mesh.scale.setScalar(size * grow);
      fig.mesh.position.set(
        p.cx - this.w / 2,
        this.h / 2 - (p.foot - size * 0.5 * grow) + Math.sin(t * 1.6 + p.seed) * cw * 0.03,
        cw * 0.4,
      );
      fig.mesh.rotation.set(-0.12, Math.sin(t * 0.8 + p.seed) * 0.25, 0);
      const u = fig.u;
      u.uReveal.value = k;
      u.uOpacity.value = p.leaving ? Math.max(0, p.show) : 1;
      setRgb(u.uGlow.value as Vector3, p.def ? DEF_GLOW : p.glow);
      u.uDark.value = p.def ? 0.25 : 0;
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
    for (const p of this.pieces.values()) p.fig?.dispose();
    this.pieces.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
