// Monsters standing on the field: every face-up monster gets its 3D figure (its
// art pushed out by the depth map, background cut away) standing on its card for
// as long as it stays there. One small canvas under the duel's controls, drawn
// at ~30 fps and only while a figure is on the field. Positions come from the
// cards on screen ([data-uid]), so Classic and Touch both work unchanged.
import { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { card } from "../eds/db";
import { artFor } from "./depth";
import { profileFor } from "./profile";
import { Figure, easeOut, lerp, rgb } from "./stage";
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
}

const DEF_GLOW = 0x4a8aff;

export class BoardLayer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(30, 1, 1, 5000);
  private pieces = new Map<number, Piece>();
  private raf = 0;
  private last = 0;
  private frame = 0;
  private w = 0;
  private h = 0;
  private dead = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: "low-power",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.resize();
  }

  resize() {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(this.w, this.h, false);
    // 1 world unit = 1 CSS pixel on the card plane.
    this.camera.aspect = this.w / this.h;
    this.camera.position.set(0, 0, this.h / 2 / Math.tan((15 * Math.PI) / 180));
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  /** The face-up monsters now on the field. */
  sync(list: BoardMonster[]) {
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
      };
      this.pieces.set(m.uid, piece);
      artFor(m.name)
        .then((art) => {
          if (this.dead || this.pieces.get(m.uid) !== piece || piece.leaving)
            return;
          piece.fig = new Figure(art, 1, 32, piece.glow, piece.depth);
          piece.fig.u.uCut.value = 1;
          piece.fig.u.uReveal.value = 0;
          this.scene.add(piece.fig.mesh);
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
    if (this.raf || this.dead) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (this.dead) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    // ~30 fps is plenty for idle figures and spares the battery.
    if (++this.frame % 2 === 0 || dt > 0.05) {
      this.last = now;
      this.step(dt);
      this.renderer.render(this.scene, this.camera);
    }
    if (this.pieces.size) this.raf = requestAnimationFrame(this.tick);
  };

  private step(dt: number) {
    // While a cinematic plays the figures step aside (the cinematic has its own).
    const hold = artBusy();
    this.canvas.style.opacity = hold ? "0" : "1";
    for (const p of [...this.pieces.values()]) {
      if (p.leaving) {
        p.show -= dt * 4;
        if (p.show <= 0 || !p.fig || hold) {
          this.drop(p);
          continue;
        }
      } else if (p.fig && !hold) p.show = Math.min(1, p.show + dt * 1.4);
      const fig = p.fig;
      if (!fig) continue;
      fig.update(dt);
      const el = document.querySelector(
        `[data-uid="${p.uid}"]`,
      ) as HTMLElement | null;
      const r = el?.getBoundingClientRect();
      if (!r || r.width === 0) {
        fig.mesh.visible = false;
        continue;
      }
      fig.mesh.visible = true;
      // The card's own width (a Defense card lies on its side).
      const cw = Math.min(r.width, r.height);
      const size = cw * (p.def ? 1.35 : 1.7);
      const k = easeOut(p.show);
      const t = fig.time;
      const cx = r.left + r.width / 2;
      const foot = r.top + r.height * 0.72;
      fig.mesh.scale.setScalar(size * lerp(0.6, 1, k));
      fig.mesh.position.set(
        cx - this.w / 2,
        this.h / 2 -
          (foot - size * 0.5 * lerp(0.6, 1, k)) +
          Math.sin(t * 1.6 + p.seed) * cw * 0.03,
        cw * 0.4,
      );
      fig.mesh.rotation.set(-0.12, Math.sin(t * 0.8 + p.seed) * 0.25, 0);
      fig.u.uReveal.value = k;
      fig.u.uOpacity.value = p.leaving ? Math.max(0, p.show) : 1;
      fig.u.uDepthAmt.value = p.depth;
      (fig.u.uGlow.value as ReturnType<typeof rgb>).copy(
        rgb(p.def ? DEF_GLOW : p.glow),
      );
      fig.u.uDark.value = p.def ? 0.25 : 0;
    }
  }

  dispose() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    for (const p of this.pieces.values()) p.fig?.dispose();
    this.pieces.clear();
    this.renderer.dispose();
  }
}
